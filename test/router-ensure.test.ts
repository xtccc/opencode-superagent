import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, type Schema } from "effect"
import { ensureRouter } from "../src/router.js"
import { store } from "../src/state.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

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

interface RouterContext extends Plugin.Context {
  readonly data: Map<string, Schema.Json>
  readonly sessions: Map<string, Record<string, unknown>>
  /** Hold the next `sessions.create` calls inside the create until the gate opens. */
  installGate(): { readonly gate: Deferred.Deferred<void>; readonly started: Deferred.Deferred<void> }
  clearGate(): void
  failCreate(): void
  neverCreate(): void
  createCalls(): number
  createdIDs(): Array<string>
}

/** A context that creates router sessions on demand, optionally gated or failing. */
function routerContext(): RouterContext {
  const { storage, data } = memoryContext()
  const sessions = new Map<string, Record<string, unknown>>()
  const created: Array<string> = []
  let createCalls = 0
  let mode: CreateMode = "ok"
  let gate: Deferred.Deferred<void> | undefined
  let started: Deferred.Deferred<void> | undefined
  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      const info = sessions.get(sessionID)
      return info === undefined
        ? Effect.fail(new Error(`missing session ${sessionID}`))
        : Effect.succeed({ id: sessionID, ...info })
    },
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
        const id = `ses_router_${call}`
        created.push(id)
        sessions.set(id, { title: input.title })
        return { id, title: input.title }
      }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  return {
    storage,
    data,
    sessions,
    session,
    agent,
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
  } as unknown as RouterContext
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function forkEnsure(ctx: Plugin.Context) {
  return Effect.runPromise(Effect.exit(ensureRouter(ctx)).pipe(Effect.forkDetach({ startImmediately: true })))
}

async function release(gate: Deferred.Deferred<void>): Promise<void> {
  await Effect.runPromise(Deferred.succeed(gate, undefined))
}

beforeEach(() => {
  store.routerID = undefined
  store.routerBusy = false
})

// ── concurrent router creation ────────────────────────────────────────────────

describe("ensureRouter is serialised", () => {
  test("two concurrent callers create exactly one router session", async () => {
    const ctx = routerContext()
    const { gate, started } = ctx.installGate()

    const first = await forkEnsure(ctx)
    // The first caller is inside `sessions.create` and holds the permit.
    await Effect.runPromise(Deferred.await(started))
    const second = await forkEnsure(ctx)
    // Let the second caller run until it has to wait: without the lock it would
    // already be inside `sessions.create` here.
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(Effect.yieldNow)
    expect(ctx.createCalls()).toBe(1)

    await release(gate)
    const firstExit = await Effect.runPromise(Fiber.join(first))
    const secondExit = await Effect.runPromise(Fiber.join(second))
    expect(Exit.isSuccess(firstExit)).toBe(true)
    expect(Exit.isSuccess(secondExit)).toBe(true)
    if (Exit.isSuccess(firstExit) && Exit.isSuccess(secondExit)) {
      // Both callers adopt the same session; the loser never creates an orphan.
      expect(String(firstExit.value)).toBe("ses_router_1")
      expect(String(secondExit.value)).toBe("ses_router_1")
    }
    expect(ctx.createCalls()).toBe(1)
    expect(ctx.createdIDs()).toEqual(["ses_router_1"])
    expect(store.routerID).toBe("ses_router_1")
  })

  test("the permit is released after a failed create, so the next call retries", async () => {
    const ctx = routerContext()
    ctx.failCreate()
    const failed = await Effect.runPromise(Effect.exit(ensureRouter(ctx)))
    expect(Exit.isFailure(failed)).toBe(true)
    expect(store.routerID).toBeUndefined()

    ctx.clearGate()
    const routerID = await succeed(ensureRouter(ctx))
    expect(String(routerID)).toBe("ses_router_2")
    expect(ctx.createCalls()).toBe(2)
  })

  test("the permit is released on interruption, so a stuck create cannot wedge the router", async () => {
    const ctx = routerContext()
    // A create that never returns: the caller is interrupted while it holds the
    // permit, which must still be released for the next attempt.
    ctx.neverCreate()
    const interrupted = await Effect.runPromise(ensureRouter(ctx).pipe(Effect.timeoutOption(10)))
    expect(Option.isNone(interrupted)).toBe(true)
    expect(store.routerID).toBeUndefined()

    ctx.clearGate()
    const retried = await succeed(ensureRouter(ctx))
    // The interrupted attempt counted a call but created nothing.
    expect(String(retried)).toBe("ses_router_2")
    expect(ctx.createdIDs()).toEqual(["ses_router_2"])
  })

  test("a remembered router id that no longer exists is replaced once", async () => {
    const ctx = routerContext()
    store.routerID = "ses_deleted"
    ctx.data.set("router", "ses_deleted")

    const first = await forkEnsure(ctx)
    const second = await forkEnsure(ctx)
    const exits = await Promise.all([Effect.runPromise(Fiber.join(first)), Effect.runPromise(Fiber.join(second))])
    for (const exit of exits) expect(Exit.isSuccess(exit)).toBe(true)
    expect(ctx.createCalls()).toBe(1)
    expect(ctx.data.get("router")).toBe("ses_router_1")
    expect(store.routerID).toBe("ses_router_1")
  })
})
