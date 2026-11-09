import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { enqueuePending } from "../src/router.js"
import { runSleep, SLEEP_MAX_SECONDS, SLEEP_POLL_MS } from "../src/sleep.js"
import { store, type TriggerInput } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import type { WorkerState } from "../src/worker-state.js"

/**
 * Interruptible sleep (plan A): the wait polls plugin memory every 250ms for
 * terminal workers / queued triggers. All tests use a virtual clock so a 60s
 * wait completes instantly and the poll cadence is observable; nothing here
 * depends on wall-clock delays.
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

/** Minimal host: KV in a map, `synthetic` records the delivery mode. */
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

function worker(sessionID: string, state: WorkerState): void {
  store.workers.set(sessionID, {
    sessionID,
    threadID: THREAD,
    threads: [THREAD],
    state,
    createdAt: 1,
  })
}

function trigger(id: string): TriggerInput {
  return { id, source: "test", threadID: THREAD, text: `event ${id}`, createdAt: 1 }
}

/**
 * Virtual clock. `poll(ms)` advances time by `ms` and may run a hook at a
 * chosen tick, which is how a test simulates a worker/trigger appearing
 * between two polls.
 */
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
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.pending.length = 0
  store.triggers.clear()
  store.triggerTotal = 0
})

describe("worker completion wakes sleep", () => {
  test("returns early with the real elapsed time and a woken reason", async () => {
    const clock = virtualClock((tick) =>
      tick === 8 ? Effect.sync(() => void worker("ses_w1", "done")) : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    // Eight 250ms intervals is 2s, not the requested 30s.
    expect(result.content).toBe("slept 2s of 30s (woken: worker completed)")
    expect(result.output).toEqual({
      slept: 2,
      text: "slept 2s of 30s (woken: worker completed)",
      woken: "worker completed",
    })
    expect(result.output.slept).toBeLessThan(30)
    expect(clock.polls).toHaveLength(8)
  })

  test("a worker that was already terminal when sleep started does not wake it", async () => {
    worker("ses_done", "done")
    const clock = virtualClock()
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(result.content).toBe("slept 30s")
    expect("woken" in result.output).toBe(false)
    expect(clock.polls).toHaveLength(120)
  })

  test("a queued trigger that was already pending when sleep started does not wake it", async () => {
    store.pending.push({ trigger: trigger("old"), arrivedAt: 1 })
    const clock = virtualClock()
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(result.content).toBe("slept 30s")
    expect("woken" in result.output).toBe(false)
    expect(store.pending).toHaveLength(1)
  })

  test("several workers completing in one interval wake it exactly once", async () => {
    const ctx = fakeContext()
    const clock = virtualClock((tick) =>
      tick === 2
        ? Effect.sync(() => {
            worker("ses_w1", "done")
            worker("ses_w2", "failed")
          })
        : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, { ...clock.deps, ctx }))

    expect(result.content).toBe("slept 1s of 30s (woken: 2 workers completed)")
    expect(clock.polls).toHaveLength(2)
    // Worker notifications are the watcher's job: sleep must not flush again.
    expect(ctx.deliveries).toHaveLength(0)
  })
})

describe("new triggers wake sleep and are delivered with steer", () => {
  test("a trigger queued during the wait flushes once with delivery=steer", async () => {
    const ctx = fakeContext()
    const clock = virtualClock((tick) =>
      tick === 4 ? enqueuePending(ctx, trigger("t1")) : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, { ...clock.deps, ctx }))

    expect(result.content).toBe("slept 1s of 30s (woken: 1 new event(s))")
    expect(result.output).toEqual({
      slept: 1,
      text: "slept 1s of 30s (woken: 1 new event(s))",
      woken: "1 new event(s)",
    })
    // Exactly one flush, on the steer channel, and the queue is drained.
    expect(ctx.deliveries).toHaveLength(1)
    expect(ctx.deliveries[0]?.delivery).toBe("steer")
    expect(ctx.deliveries[0]?.text).toContain("event t1")
    expect(store.pending).toHaveLength(0)
  })

  test("multiple queued triggers arrive as one batch in one steer flush", async () => {
    const ctx = fakeContext()
    const clock = virtualClock((tick) =>
      tick === 2
        ? Effect.gen(function* () {
            yield* enqueuePending(ctx, trigger("t1"))
            yield* enqueuePending(ctx, trigger("t2"))
          })
        : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, { ...clock.deps, ctx }))

    expect(result.content).toBe("slept 1s of 30s (woken: 2 new event(s))")
    expect(ctx.deliveries).toHaveLength(1)
    expect(ctx.deliveries[0]?.delivery).toBe("steer")
    expect(ctx.deliveries[0]?.text).toContain("event t1")
    expect(ctx.deliveries[0]?.text).toContain("event t2")
    expect(store.pending).toHaveLength(0)
  })

  test("a trigger arriving with a completion is still flushed", async () => {
    const ctx = fakeContext()
    const clock = virtualClock((tick) =>
      tick === 2
        ? Effect.gen(function* () {
            yield* enqueuePending(ctx, trigger("t1"))
            worker("ses_w1", "done")
          })
        : Effect.void,
    )
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, { ...clock.deps, ctx }))

    expect(result.content).toBe("slept 1s of 30s (woken: 1 new event(s), worker completed)")
    expect(ctx.deliveries).toHaveLength(1)
    expect(ctx.deliveries[0]?.delivery).toBe("steer")
    expect(store.pending).toHaveLength(0)
  })
})

describe("normal and bounded waits", () => {
  test("no change sleeps the full time with the original result shape", async () => {
    const clock = virtualClock()
    const result = await succeed(runSleep({ seconds: 30 }, ROUTER, clock.deps))

    expect(result.content).toBe("slept 30s")
    expect(result.output).toEqual({ slept: 30, text: "slept 30s" })
    expect("woken" in result.output).toBe(false)
    expect(clock.polls).toHaveLength(120)
  })

  test("the ceiling is 60 seconds: 60 passes, 0/61/1.5 are rejected", async () => {
    expect(SLEEP_MAX_SECONDS).toBe(60)
    const clock = virtualClock()
    expect((await succeed(runSleep({ seconds: 60 }, ROUTER, clock.deps))).content).toBe("slept 60s")

    expect(await failure(runSleep({ seconds: 0 }, ROUTER, clock.deps))).toContain("between 1 and 60")
    expect(await failure(runSleep({ seconds: 61 }, ROUTER, clock.deps))).toContain("between 1 and 60")
    expect(await failure(runSleep({ seconds: 1.5 }, ROUTER, clock.deps))).toContain("must be an integer")
  })

  test("the poller waits between checks instead of busy looping", async () => {
    const clock = virtualClock()
    const started = performance.now()
    await succeed(runSleep({ seconds: 60 }, ROUTER, clock.deps))
    // 60s / 250ms = 240 real timer waits, and the whole virtual run is instant.
    expect(clock.polls).toHaveLength(240)
    expect(clock.polls.every((millis) => millis === SLEEP_POLL_MS)).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
