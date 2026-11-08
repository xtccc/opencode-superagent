import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { store, type WorkerState } from "../src/state.js"
import {
  createTicket,
  getTicket,
  linkTicketToWorker,
  requireDispatchTicket,
  resetTickets,
} from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const THREAD = "telegram:42"
const WORKER = "ses_worker_1"

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id", "现有测试全绿"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
function memoryContext() {
  const data = new Map<string, Schema.Json>()
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (options: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort()
        const start = options.after === undefined ? 0 : keys.indexOf(options.after) + 1
        const page = keys.slice(start, start + (options.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  return { storage, data } as unknown as Plugin.Context & { data: Map<string, Schema.Json> }
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

/** An in-progress ticket whose `workerSessionID` points at a worker in `state`. */
async function ticketWithWorker(state: WorkerState) {
  const ctx = memoryContext()
  const created = await succeed(createTicket(ctx, base))
  await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: WORKER }))
  store.workers.set(WORKER, {
    sessionID: WORKER,
    threadID: THREAD,
    threads: [THREAD],
    state,
    createdAt: 1,
  })
  return { ctx, ticketID: created.ticket.id }
}

beforeEach(() => {
  resetTickets()
  store.workers.clear()
})

// ── live workers block the gate ───────────────────────────────────────────────

describe("ticket gate refuses a live worker", () => {
  test("an idle worker blocks a re-dispatch", async () => {
    const { ctx, ticketID } = await ticketWithWorker("idle")
    const message = await failure(requireDispatchTicket(ticketID, THREAD))
    expect(message).toContain(`already has an idle worker ${WORKER}`)
    expect(message).toContain("abort_session")
    // The ticket stays in progress; nothing was dispatched.
    expect(getTicket(ticketID)?.state).toBe("in_progress")
    expect(ctx.data.get(`ticket:${ticketID}`)).toBeDefined()
  })

  test("a running worker blocks a re-dispatch", async () => {
    const { ticketID } = await ticketWithWorker("running")
    const message = await failure(requireDispatchTicket(ticketID, THREAD))
    expect(message).toContain(`already has a running worker ${WORKER}`)
    expect(message).toContain("abort_session")
  })
})

// ── terminal workers release the gate ─────────────────────────────────────────

describe("a terminal worker allows re-dispatch on the same ticket", () => {
  test("done, failed and aborted workers are all accepted", async () => {
    const { ticketID } = await ticketWithWorker("done")
    for (const state of ["done", "failed", "aborted"] as const) {
      const worker = store.workers.get(WORKER)
      if (worker !== undefined) worker.state = state
      const ticket = await succeed(requireDispatchTicket(ticketID, THREAD))
      expect(ticket.id).toBe(ticketID)
      expect(ticket.state).toBe("in_progress")
    }
    // The gate only checks: the ticket still points at the previous worker.
    expect(getTicket(ticketID)?.workerSessionID).toBe(WORKER)
  })
})
