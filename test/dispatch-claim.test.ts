import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, type Schema } from "effect"
import { runDispatch } from "../src/dispatch.js"
import { store } from "../src/state.js"
import { createTicket, getTicket, resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const ROUTER = "ses_router"
const THREAD = "telegram:42"

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
  return { storage, data }
}

type CreateMode = "ok" | "gate" | "fail" | "never"

interface ClaimContext extends Plugin.Context {
  readonly data: Map<string, Schema.Json>
  readonly prompts: Array<string>
  /** Block inside `sessions.create` until the returned gate is released. */
  installGate(): { readonly gate: Deferred.Deferred<void>; readonly started: Deferred.Deferred<void> }
  clearGate(): void
  failCreate(): void
  neverCreate(): void
  succeedCreate(): void
  createCalls(): number
  createdIDs(): Array<string>
}

/** A context whose `sessions.create` mode the test controls. */
function claimContext(): ClaimContext {
  const { storage, data } = memoryContext()
  const prompts: Array<string> = []
  const created: Array<string> = []
  let createCalls = 0
  let mode: CreateMode = "ok"
  let gate: Deferred.Deferred<void> | undefined
  let started: Deferred.Deferred<void> | undefined
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({ id: sessionID, model: undefined, location: { directory: "/opt/ai-gw" } }),
    create: (input: { title?: string }) =>
      Effect.gen(function* () {
        createCalls += 1
        const call = createCalls
        if (mode === "fail") return yield* Effect.fail(new Error("create exploded"))
        if (mode === "never") return yield* Effect.never
        if (mode === "gate") {
          if (started !== undefined) yield* Deferred.succeed(started, undefined)
          if (gate !== undefined) yield* Deferred.await(gate)
        }
        const id = `ses_worker_${call}`
        created.push(id)
        return { id, title: input.title }
      }),
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: () => Effect.succeed({ interrupted: true }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  return {
    storage,
    data,
    session,
    agent,
    prompts,
    createCalls: () => createCalls,
    createdIDs: () => [...created],
    installGate() {
      mode = "gate"
      gate = Deferred.makeUnsafe<void>()
      started = Deferred.makeUnsafe<void>()
      return { gate, started }
    },
    clearGate() {
      mode = "ok"
      gate = undefined
      started = undefined
    },
    failCreate() {
      mode = "fail"
    },
    neverCreate() {
      mode = "never"
    },
    succeedCreate() {
      mode = "ok"
    },
  } as unknown as ClaimContext
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

/** Fork a dispatch without blocking, keeping the inner Exit as the fiber's value. */
async function forkDispatch(ctx: Plugin.Context, ticketID: string) {
  return Effect.runPromise(
    Effect.exit(runDispatch(ctx, { task: "修日志", ticketID }, ROUTER)).pipe(
      Effect.forkDetach({ startImmediately: true }),
    ),
  )
}

async function release(gate: Deferred.Deferred<void>): Promise<void> {
  await Effect.runPromise(Deferred.succeed(gate, undefined))
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

// ── in-process claim ─────────────────────────────────────────────────────────

describe("a ticket is claimed before dispatch", () => {
  test("two concurrent dispatches create only one worker session", async () => {
    const ctx = claimContext()
    const created = await succeed(createTicket(ctx, base))
    const { gate, started } = ctx.installGate()

    const first = await forkDispatch(ctx, created.ticket.id)
    // Wait until the first dispatch is inside `sessions.create`: its claim is
    // already held and it will not finish until the gate is released.
    await Effect.runPromise(Deferred.await(started))

    const second = await Effect.runPromise(
      Effect.exit(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER)),
    )
    expect(Exit.isFailure(second)).toBe(true)
    if (Exit.isFailure(second)) {
      expect(String(second.cause)).toContain(`dispatch already in progress for ticket ${created.ticket.id}`)
    }
    // The loser never entered `sessions.create`.
    expect(ctx.createCalls()).toBe(1)

    await release(gate)
    const firstExit = await Effect.runPromise(Fiber.join(first))
    expect(Exit.isSuccess(firstExit)).toBe(true)
    if (Exit.isSuccess(firstExit)) {
      expect(String(firstExit.value.output.sessionID)).toBe("ses_worker_1")
    }
    expect(ctx.createdIDs()).toEqual(["ses_worker_1"])
    expect(store.workers.size).toBe(1)

    const ticket = getTicket(created.ticket.id)
    expect(ticket?.state).toBe("in_progress")
    expect(ticket?.attempts).toHaveLength(1)
  })

  test("the claim is released after a successful dispatch, so the ticket can be retried", async () => {
    const ctx = claimContext()
    const created = await succeed(createTicket(ctx, base))
    const first = await succeed(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(String(first.output.sessionID)).toBe("ses_worker_1")

    // A ticket with a running worker is refused by the ticket gate, not by the
    // claim: mark the worker terminal, then dispatch the same ticket again.
    const workerID = getTicket(created.ticket.id)?.workerSessionID
    const worker = workerID === undefined ? undefined : store.workers.get(workerID)
    if (worker !== undefined) worker.state = "done"

    const second = await succeed(runDispatch(ctx, { task: "再修日志", ticketID: created.ticket.id }, ROUTER))
    expect(String(second.output.sessionID)).toBe("ses_worker_2")
    expect(getTicket(created.ticket.id)?.attempts).toHaveLength(2)
  })

  test("a failed dispatch releases the claim for a retry", async () => {
    const ctx = claimContext()
    ctx.failCreate()
    const created = await succeed(createTicket(ctx, base))

    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(message).toContain("failed to create worker session")
    // Nothing was created or linked, so the ticket is still open.
    expect(getTicket(created.ticket.id)?.state).toBe("open")
    expect(store.workers.size).toBe(0)

    ctx.succeedCreate()
    const retried = await succeed(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(String(retried.output.sessionID)).toBe("ses_worker_2")
    expect(getTicket(created.ticket.id)?.attempts).toHaveLength(1)
  })

  test("an interrupted dispatch releases the claim", async () => {
    const ctx = claimContext()
    ctx.neverCreate()
    const created = await succeed(createTicket(ctx, base))

    const outcome = await Effect.runPromise(
      runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER).pipe(Effect.timeoutOption(50)),
    )
    expect(Option.isNone(outcome)).toBe(true)
    expect(getTicket(created.ticket.id)?.state).toBe("open")
    expect(store.workers.size).toBe(0)

    ctx.succeedCreate()
    const retried = await succeed(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(String(retried.output.sessionID)).toBe("ses_worker_2")
  })
})
