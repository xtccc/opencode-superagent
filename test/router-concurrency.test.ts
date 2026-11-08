import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, type Schema } from "effect"
import { enqueuePending, flushPending } from "../src/router.js"
import { store, type TriggerInput } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"

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

interface FlushContext extends Plugin.Context {
  readonly delivered: Array<string>
  /** Make the next `synthetic` calls block until the returned gate is fulfilled. */
  installGate(): { readonly gate: Deferred.Deferred<void>; readonly started: Deferred.Deferred<void> }
  /** Let later flushes deliver immediately again. */
  clearGate(): void
}

function flushContext(): FlushContext {
  const { storage, data } = memoryContext()
  const delivered: Array<string> = []
  let gate: Deferred.Deferred<void> | undefined
  let started: Deferred.Deferred<void> | undefined
  const session = {
    get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ id: sessionID }),
    synthetic: (input: { text: string }) =>
      Effect.gen(function* () {
        delivered.push(input.text)
        if (started !== undefined) yield* Deferred.succeed(started, undefined)
        if (gate !== undefined) yield* Deferred.await(gate)
        return { id: `msg_${delivered.length}` }
      }),
  }
  return {
    storage,
    session,
    data,
    delivered,
    installGate() {
      const nextGate = Deferred.makeUnsafe<void>()
      const nextStarted = Deferred.makeUnsafe<void>()
      gate = nextGate
      started = nextStarted
      return { gate: nextGate, started: nextStarted }
    },
    clearGate() {
      gate = undefined
      started = undefined
    },
  } as unknown as FlushContext
}

function trigger(id: string, text: string = `event ${id}`): TriggerInput {
  return { id, source: "test", threadID: "thread:1", text, createdAt: 1 }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

function pendingIDs(): Array<string> {
  return store.pending.map((item) => item.trigger.id ?? "")
}

beforeEach(() => {
  resetTickets()
  store.pending.length = 0
  store.triggers.clear()
  store.triggerTotal = 0
  store.routerID = "ses_router"
  store.routerBusy = false
})

// ── concurrent flush ─────────────────────────────────────────────────────────

/** Start a flush fiber without blocking, so the test controls the gate. */
async function forkFlush(ctx: FlushContext) {
  return Effect.runPromise(flushPending(ctx).pipe(Effect.forkDetach({ startImmediately: true })))
}

async function release(gate: Deferred.Deferred<void>): Promise<void> {
  await Effect.runPromise(Deferred.succeed(gate, undefined))
}

describe("flushPending concurrency", () => {
  test("two concurrent flushes inject the same batch only once", async () => {
    const ctx = flushContext()
    await succeed(enqueuePending(ctx, trigger("t1")))
    await succeed(enqueuePending(ctx, trigger("t2")))
    const { gate, started } = ctx.installGate()

    const first = await forkFlush(ctx)
    // Let the first flush capture its batch and block inside `synthetic`.
    await Effect.runPromise(Deferred.await(started))
    const second = await forkFlush(ctx)
    // Give the second flush a chance to reach the lock/synthetic before the
    // first batch is released; without serialisation it would inject it too.
    await Effect.runPromise(Effect.yieldNow)
    await Effect.runPromise(Effect.yieldNow)
    await release(gate)
    await Effect.runPromise(Fiber.join(first))
    await Effect.runPromise(Fiber.join(second))

    expect(ctx.delivered.length).toBe(1)
    expect(ctx.delivered[0]).toContain("event t1")
    expect(ctx.delivered[0]).toContain("event t2")
    expect(store.pending.length).toBe(0)
  })

  test("an event enqueued while a flush is in flight is delivered afterwards, not dropped", async () => {
    const ctx = flushContext()
    await succeed(enqueuePending(ctx, trigger("t1")))
    const { gate, started } = ctx.installGate()

    const fiber = await forkFlush(ctx)
    await Effect.runPromise(Deferred.await(started))
    // The injection is in flight, so this event lands after the batch snapshot.
    await succeed(enqueuePending(ctx, trigger("t2")))
    await release(gate)
    await Effect.runPromise(Fiber.join(fiber))

    expect(ctx.delivered.length).toBe(1)
    expect(ctx.delivered[0]).toContain("event t1")
    expect(ctx.delivered[0]).not.toContain("event t2")
    expect(pendingIDs()).toEqual(["t2"])

    ctx.clearGate()
    await succeed(flushPending(ctx))
    expect(ctx.delivered.length).toBe(2)
    expect(ctx.delivered[1]).toContain("event t2")
    expect(store.pending.length).toBe(0)
  })

  test("removal is by delivered id, so a tail event survives a shifted queue", async () => {
    const ctx = flushContext()
    for (const id of ["t1", "t2"]) await succeed(enqueuePending(ctx, trigger(id)))
    const { gate, started } = ctx.installGate()

    const fiber = await forkFlush(ctx)
    await Effect.runPromise(Deferred.await(started))
    // Queue a tail event, then simulate another consumer acknowledging the
    // head event while the batch [t1, t2] is being delivered. A positional
    // splice(0, 2) would now delete t2 and the untouched tail event t3.
    await succeed(enqueuePending(ctx, trigger("t3")))
    store.pending.splice(0, 1)
    await release(gate)
    await Effect.runPromise(Fiber.join(fiber))

    expect(ctx.delivered.length).toBe(1)
    expect(ctx.delivered[0]).toContain("event t1")
    expect(ctx.delivered[0]).toContain("event t2")
    expect(pendingIDs()).toEqual(["t3"])
  })
})
