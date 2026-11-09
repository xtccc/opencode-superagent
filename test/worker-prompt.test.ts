import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { filterSessionTools } from "../src/context.js"
import { store } from "../src/state.js"
import {
  closeTicket,
  createTicket,
  linkTicketToWorker,
  resetTickets,
  updateTicket,
  type TicketState,
} from "../src/ticket.js"
import type { WorkerRecord, WorkerState } from "../src/worker-state.js"
import { FOLLOW_UP_PREFIX, runWorkerPrompt } from "../src/worker-prompt.js"

const ROUTER = "ses_router"
const WORKER = "ses_worker"
const THREAD = "telegram:42"

const base = {
  threadID: THREAD,
  title: "跟进已有 Worker",
  objective: "补一条提示词",
  acceptance: ["投递成功"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

interface Call {
  readonly kind: "prompt" | "interrupt"
  readonly sessionID: string
  readonly text?: string
  readonly delivery?: string
  readonly resume?: boolean
}

/** Minimal KV stand-in: enough for the ticket store the prompt guard reads. */
function memoryContext(options: { readonly promptFails?: boolean } = {}) {
  const data = new Map<string, Schema.Json>()
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (input: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(input.prefix)).sort()
        const start = input.after === undefined ? 0 : keys.indexOf(input.after) + 1
        const page = keys.slice(start, start + (input.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  const calls: Array<Call> = []
  const session = {
    prompt: (input: { sessionID: string; text: string; delivery?: string }) => {
      calls.push({ kind: "prompt", sessionID: input.sessionID, text: input.text, delivery: input.delivery })
      return options.promptFails === true
        ? Effect.fail(new Error("worker inbox unavailable"))
        : Effect.succeed({} as never)
    },
    interrupt: (input: { sessionID: string; resume?: boolean }) => {
      calls.push({ kind: "interrupt", sessionID: input.sessionID, resume: input.resume })
      return Effect.succeed({ interrupted: true })
    },
  }
  const ctx = { options: {}, storage, session } as unknown as Plugin.Context
  return { ctx, data, calls }
}

function worker(sessionID: string, state: WorkerState, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threadID: THREAD,
    threads: [THREAD],
    state,
    createdAt: 1_000,
    ...overrides,
  }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(exit.cause)
}

/** Create a ticket and bind it to the worker (open → in_progress), optionally moving it on. */
async function boundTicket(ctx: Plugin.Context, sessionID: string, state?: TicketState) {
  const created = await succeed(createTicket(ctx, base))
  await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID }))
  if (state !== undefined && state !== "in_progress") {
    await succeed(updateTicket(ctx, { ticketID: created.ticket.id, state }))
  }
  return created.ticket
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.workers.clear()
  store.threads.clear()
  store.pending.length = 0
})

describe("worker_prompt refuses closed work orders", () => {
  test("done, failed and cancelled tickets are rejected without prompt or interrupt", async () => {
    for (const outcome of ["done", "failed", "cancelled"] as const) {
      resetTickets()
      store.workers.clear()
      store.workers.set(WORKER, worker(WORKER, "running"))
      const h = memoryContext()
      const ticket = await boundTicket(h.ctx, WORKER)
      await succeed(closeTicket(h.ctx, { ticketID: ticket.id, outcome, summary: "closed for test" }))

      const message = await failure(
        runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "continue", interrupt: true }, ROUTER),
      )
      expect(message).toContain(`worker ${WORKER} ticket ${ticket.id} is closed (${outcome})`)
      expect(message).toContain("start a new worker instead")
      // The closed-ticket rule wins even when interrupt was requested.
      expect(h.calls).toEqual([])
    }
  })

  test("a superseded ticket is closed too", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    const ticket = await boundTicket(h.ctx, WORKER)
    await succeed(updateTicket(h.ctx, { ticketID: ticket.id, state: "superseded" }))
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "continue" }, ROUTER))
    expect(message).toContain("is closed (superseded)")
    expect(h.calls).toEqual([])
  })

  test("a tracked worker without a ticket is refused fail-closed", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "continue" }, ROUTER))
    expect(message).toContain(`worker ${WORKER} has no ticket`)
    expect(message).toContain("start a new worker instead")
    expect(h.calls).toEqual([])
  })
})

describe("worker_prompt refuses untrusted targets", () => {
  test("an unknown sessionID is refused", async () => {
    const h = memoryContext()
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: "ses_nobody", text: "hi" }, ROUTER))
    expect(message).toContain("ses_nobody is not tracked")
    expect(message).toContain("refusing to prompt")
    expect(h.calls).toEqual([])
  })

  test("the router session is refused", async () => {
    const h = memoryContext()
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: ROUTER, text: "hi" }, ROUTER))
    expect(message).toContain("cannot prompt the router session")
    expect(h.calls).toEqual([])
  })

  test("a non-router caller is refused", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    const ticket = await boundTicket(h.ctx, WORKER)
    expect(ticket.state).toBe("in_progress")
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "hi" }, WORKER))
    expect(message).toContain("worker_prompt is only available to the router session")
    expect(h.calls).toEqual([])
  })

  test("done, aborted and unknown worker states are refused", async () => {
    for (const state of ["done", "aborted", "mystery"] as Array<WorkerState>) {
      resetTickets()
      store.workers.clear()
      store.workers.set(WORKER, worker(WORKER, state))
      const h = memoryContext()
      await boundTicket(h.ctx, WORKER)
      const message = await failure(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "hi" }, ROUTER))
      expect(message).toContain(`worker ${WORKER} is ${state}`)
      expect(message).toContain("only running/idle workers")
      expect(h.calls).toEqual([])
    }
  })

  test("empty text is refused", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    await boundTicket(h.ctx, WORKER)
    const message = await failure(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "   " }, ROUTER))
    expect(message).toContain("non-empty text")
    expect(h.calls).toEqual([])
  })
})

describe("worker_prompt delivery semantics", () => {
  test("queue is the default and carries the router follow-up marker", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    const ticket = await boundTicket(h.ctx, WORKER)

    const result = await succeed(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "please continue" }, ROUTER))
    expect(result.output).toEqual({
      delivered: true,
      sessionID: WORKER,
      state: "running",
      ticketState: "in_progress",
      mode: "queue",
      text: `delivered queue prompt to worker ${WORKER} (state=running, ticket=${ticket.id} in_progress)`,
    })
    expect(h.calls).toEqual([
      {
        kind: "prompt",
        sessionID: WORKER,
        text: `${FOLLOW_UP_PREFIX} please continue`,
        delivery: "queue",
      },
    ])
  })

  test("steer is forwarded unchanged", async () => {
    store.workers.set(WORKER, worker(WORKER, "idle"))
    const h = memoryContext()
    await boundTicket(h.ctx, WORKER)

    const result = await succeed(
      runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "steer this", delivery: "steer" }, ROUTER),
    )
    expect(result.output.mode).toBe("steer")
    expect(result.output.state).toBe("idle")
    expect(h.calls).toEqual([
      { kind: "prompt", sessionID: WORKER, text: `${FOLLOW_UP_PREFIX} steer this`, delivery: "steer" },
    ])
  })

  test("open and blocked tickets still accept a prompt", async () => {
    // open: the transient state before the dispatch link moves it to in_progress.
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    const created = await succeed(createTicket(h.ctx, base))
    created.ticket.workerSessionID = WORKER
    const openResult = await succeed(runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "open ok" }, ROUTER))
    expect(openResult.output.ticketState).toBe("open")

    // blocked: still workable, so a follow-up is allowed.
    resetTickets()
    store.workers.clear()
    store.workers.set(WORKER, worker(WORKER, "idle"))
    const blocked = memoryContext()
    await boundTicket(blocked.ctx, WORKER, "blocked")
    const blockedResult = await succeed(runWorkerPrompt(blocked.ctx, { sessionID: WORKER, text: "blocked ok" }, ROUTER))
    expect(blockedResult.output.ticketState).toBe("blocked")
    expect(blocked.calls).toHaveLength(1)
  })

  test("interrupt steers first and then interrupts with resume=true", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext()
    await boundTicket(h.ctx, WORKER)

    const result = await succeed(
      runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "change direction", delivery: "queue", interrupt: true }, ROUTER),
    )
    expect(result.output.mode).toBe("interrupt+steer")
    // Queue was requested, but interrupt forces a steer delivery first.
    expect(h.calls).toEqual([
      { kind: "prompt", sessionID: WORKER, text: `${FOLLOW_UP_PREFIX} change direction`, delivery: "steer" },
      { kind: "interrupt", sessionID: WORKER, resume: true },
    ])
  })

  test("a prompt failure returns delivered=false and never interrupts", async () => {
    store.workers.set(WORKER, worker(WORKER, "running"))
    const h = memoryContext({ promptFails: true })
    await boundTicket(h.ctx, WORKER)

    const result = await succeed(
      runWorkerPrompt(h.ctx, { sessionID: WORKER, text: "do it", interrupt: true }, ROUTER),
    )
    expect(result.output.delivered).toBe(false)
    expect(result.output.text).toContain("failed to deliver")
    expect(result.output.text).toContain("worker inbox unavailable")
    expect(h.calls).toEqual([
      { kind: "prompt", sessionID: WORKER, text: `${FOLLOW_UP_PREFIX} do it`, delivery: "steer" },
    ])
  })
})

describe("worker_prompt tool visibility", () => {
  test("a tracked worker's toolset never includes worker_prompt", () => {
    store.workers.set(WORKER, worker(WORKER, "running"))

    const routerTools: Record<string, unknown> = { worker_prompt: {}, dispatch: {}, read: {} }
    filterSessionTools(ROUTER, routerTools)
    expect(Object.keys(routerTools)).toEqual(["worker_prompt", "dispatch"])

    const workerTools: Record<string, unknown> = { worker_prompt: {}, dispatch: {}, read: {} }
    filterSessionTools(WORKER, workerTools)
    expect(Object.keys(workerTools)).toEqual(["read"])
  })
})
