import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, type Schema } from "effect"
import { enqueuePending } from "../src/router.js"
import { runSleep, SLEEP_MAX_SECONDS } from "../src/sleep.js"
import { store, type TriggerInput } from "../src/state.js"
import { workers, type WorkerState } from "../src/worker-state.js"

/**
 * Regressions for the field report "the first real sleep did not wake".
 *
 * The investigation showed the first 60s sleep legitimately expired: the
 * worker session only reached a terminal state ~5s after the deadline (the
 * 15s figure came from a child shell run inside it). These tests still pin
 * the reliability properties the report suspected: a rejected call leaves no
 * residue, an interrupted sleep can be followed by a normal one, concurrent
 * sleeps do not clear each other, and the baseline compares identities rather
 * than counts so net-zero state changes cannot swallow a wake-up.
 */

const ROUTER = "ses_router"
const THREAD = "thread:1"

interface Delivery {
  readonly text: string
  readonly delivery: string | undefined
}

interface FakeContext extends Plugin.Context {
  readonly deliveries: Array<Delivery>
}

function fakeContext(): FakeContext {
  const data = new Map<string, Schema.Json>()
  const deliveries: Array<Delivery> = []
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (options: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort()
        const start = options.after === undefined ? 0 : keys.indexOf(options.after) + 1
        const page = keys.slice(start, start + (options.limit ?? 100))
        return { entries: page.map((key) => ({ key, value: data.get(key) ?? null })) }
      }),
  }
  const session = {
    get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ id: sessionID }),
    synthetic: (input: { text: string; delivery?: string; id?: string }) =>
      Effect.sync(() => {
        deliveries.push({ text: input.text, delivery: input.delivery })
        return { id: input.id ?? `msg_${deliveries.length}` }
      }),
  }
  return { storage, session, deliveries } as unknown as FakeContext
}

function worker(sessionID: string, state: WorkerState, updatedAt?: number): void {
  store.workers.set(sessionID, {
    sessionID,
    threadID: THREAD,
    threads: [THREAD],
    state,
    createdAt: 1,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  })
}

function trigger(id: string): TriggerInput {
  return { id, source: "test", threadID: THREAD, text: `event ${id}`, createdAt: 1 }
}

/** Virtual clock; the hook runs before each tick's state check. */
function virtualClock(onPoll?: (tick: number) => Effect.Effect<void>) {
  let current = 0
  let tick = 0
  const polls: Array<number> = []
  const deps = {
    now: () => current,
    poll: (millis: number) =>
      Effect.gen(function* () {
        polls.push(millis)
        current += millis
        tick += 1
        if (onPoll !== undefined) yield* onPoll(tick)
        // Yield so two virtual sleeps really interleave instead of running
        // to completion one after the other.
        yield* Effect.yieldNow
      }),
  }
  return { deps, polls }
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

beforeEach(() => {
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
  store.pending.length = 0
  store.triggers.clear()
  store.triggerTotal = 0
})

describe("invalid and interrupted calls leave no residue", () => {
  test("a rejected sleep(4000) does not poll and the next sleep still wakes", async () => {
    const rejected = virtualClock()
    expect(await failure(runSleep({ seconds: 4000 }, ROUTER, rejected.deps))).toContain("between 1 and 3600")
    // Validation returns before the baseline snapshot and before any timer:
    // there is no waiter or poll loop to leak.
    expect(rejected.polls).toEqual([])

    const clock = virtualClock((tick) =>
      tick === 4 ? Effect.sync(() => worker("ses_w1", "done", 100)) : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(SLEEP_MAX_SECONDS).toBe(3600)
    expect(result.content).toBe("slept 1s of 30s (woken: worker completed)")
    expect(result.output).toMatchObject({ slept: 1, woken: "worker completed" })
  })

  test("an interrupted sleep does not block the next sleep from waking", async () => {
    const fiber = await Effect.runPromise(Effect.forkDetach(runSleep({ seconds: 60 }, ROUTER)))
    // The production poller is a real timer; let at least one interval start.
    await Effect.runPromise(Effect.sleep(Duration.millis(120)))
    await Effect.runPromise(Fiber.interrupt(fiber))

    const clock = virtualClock((tick) =>
      tick === 3 ? Effect.sync(() => worker("ses_after_abort", "done", 200)) : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(result.content).toBe("slept 1s of 30s (woken: worker completed)")
  })

  test("two concurrent sleeps both wake on the same completion", async () => {
    const first = await Effect.runPromise(Effect.forkDetach(runSleep({ seconds: 30 }, ROUTER)))
    const second = await Effect.runPromise(Effect.forkDetach(runSleep({ seconds: 30 }, ROUTER)))
    await Effect.runPromise(Effect.sleep(Duration.millis(300)))
    worker("ses_w1", "done", 300)

    const [a, b] = await Effect.runPromise(Effect.zip(Fiber.join(first), Fiber.join(second)))

    for (const result of [a, b]) {
      expect(result.content).toContain("woken: worker completed")
      expect(result.output.slept).toBeLessThan(5)
    }
  })
})

describe("baseline compares identities, not counters", () => {
  test("a resumed terminal worker plus a new completion (same count) still wakes", async () => {
    // Baseline has exactly one terminal worker; during the sleep it is resumed
    // and another worker finishes. A count-based baseline sees 1 -> 1 and
    // would miss the completion entirely.
    worker("ses_a", "done", 1)
    const clock = virtualClock((tick) =>
      tick === 2
        ? Effect.sync(() => {
            worker("ses_a", "running")
            worker("ses_b", "done", 2)
          })
        : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(result.content).toBe("slept 1s of 30s (woken: worker completed)")
  })

  test("a queue drained and refilled to the same length still wakes", async () => {
    const ctx = fakeContext()
    store.pending.push({ trigger: trigger("old"), arrivedAt: 1 })
    const clock = virtualClock((tick) =>
      tick === 2
        ? Effect.gen(function* () {
            // Simulate the router idle hook draining the old trigger while the
            // sleep is still waiting, then a new trigger arrives.
            store.pending.splice(0, 1)
            yield* enqueuePending(ctx, trigger("new"))
          })
        : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, { ...clock.deps, ctx }))

    expect(result.content).toBe("slept 1s of 30s (woken: 1 new event(s))")
    expect(ctx.deliveries).toHaveLength(1)
    expect(ctx.deliveries[0]?.delivery).toBe("steer")
    expect(ctx.deliveries[0]?.text).toContain("event new")
    expect(store.pending).toHaveLength(0)
  })
})

describe("duplicate plugin instances share one store", () => {
  test("the store and worker registry live on globalThis symbols", () => {
    const globals = globalThis as Record<symbol, unknown>
    expect(globals[Symbol.for("opencode-superagent.store.v1")]).toBe(store)
    expect(globals[Symbol.for("opencode-superagent.workers.v1")]).toBe(workers)
    expect(store.workers).toBe(workers)
  })

  test("a second module evaluation imports the same store, not a private copy", async () => {
    // A cache-busted specifier makes Bun evaluate the module a second time,
    // which is what a second plugin copy looks like. Without the globalThis
    // hand-off this would be a different object (and `sleep` would poll a
    // registry the watcher never writes).
    const copy = (await import(`../src/state.ts?duplicate-instance=${Date.now()}`)) as typeof import("../src/state.js")
    const copyWorkers = (await import(
      `../src/worker-state.ts?duplicate-instance=${Date.now()}`
    )) as typeof import("../src/worker-state.js")

    expect(copy.store).toBe(store)
    expect(copyWorkers.workers).toBe(workers)
    worker("ses_shared", "done", 1)
    expect(copy.store.workers.get("ses_shared")?.state).toBe("done")
  })
})
