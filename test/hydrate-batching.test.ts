import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, type Schema } from "effect"
import { hydrateSessionMeta } from "../src/session-meta.js"
import { encodeWorker, HYDRATE_CONCURRENCY, hydrate, store, workerKey, type WorkerRecord, type WorkerState } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

interface Harness extends Plugin.Context {
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  /** Highest number of `session.get` calls that were in flight at the same time. */
  peak(): number
  /** Fulfilled once `HydrateConcurrency` lookups have started together. */
  readonly allStarted: Deferred.Deferred<void>
  readonly gate: Deferred.Deferred<void>
  readonly updates: Array<string>
}

/**
 * A context whose `session.get` blocks until the test opens the gate, so the
 * test can observe how many lookups `hydrate` actually keeps in flight.
 */
function harness(): Harness {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const updates: Array<string> = []
  const gate = Deferred.makeUnsafe<void>()
  const allStarted = Deferred.makeUnsafe<void>()
  let inFlight = 0
  let peak = 0
  let starts = 0
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
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.gen(function* () {
        starts += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        if (starts >= HYDRATE_CONCURRENCY) yield* Deferred.succeed(allStarted, undefined)
        yield* Deferred.await(gate)
        inFlight -= 1
        const info = infos.get(sessionID)
        if (info === undefined) return yield* Effect.fail(new Error(`missing session ${sessionID}`))
        return { id: sessionID, ...info }
      }),
    update: ({ sessionID }: { sessionID: string }) =>
      Effect.sync(() => {
        updates.push(sessionID)
      }),
    context: () => Effect.succeed([]),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  return {
    options: {},
    storage,
    session,
    agent,
    data,
    infos,
    updates,
    gate,
    allStarted,
    peak: () => peak,
  } as unknown as Harness
}

function worker(sessionID: string, state: WorkerState): WorkerRecord {
  return {
    sessionID,
    threadID: "thread:1",
    threads: ["thread:1"],
    state,
    createdAt: 1_000,
    updatedAt: 1_000,
  }
}

function seedWorkers(h: Harness, count: number): Array<string> {
  const ids: Array<string> = []
  for (let index = 0; index < count; index += 1) {
    const sessionID = `ses_worker_${index}`
    ids.push(sessionID)
    h.data.set(workerKey(sessionID), encodeWorker(worker(sessionID, "done")))
    h.infos.set(sessionID, {})
  }
  return ids
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

/** Wait for the lookups to overlap; a serial load never gets here and times out. */
async function awaitOverlap(h: Harness): Promise<boolean> {
  const started = await Effect.runPromise(Deferred.await(h.allStarted).pipe(Effect.timeoutOption(500)))
  return Option.isSome(started)
}

async function runHydrate(h: Harness) {
  const fiber = await Effect.runPromise(
    Effect.exit(hydrate(h)).pipe(Effect.forkDetach({ startImmediately: true })),
  )
  const overlapped = await awaitOverlap(h)
  await Effect.runPromise(Deferred.succeed(h.gate, undefined))
  const exit = await Effect.runPromise(Fiber.join(fiber))
  return { overlapped, exit }
}

beforeEach(() => {
  resetTickets()
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.routerID = undefined
  store.pending.length = 0
})

afterEach(() => {
  store.workers.clear()
  store.threads.clear()
  store.routerID = undefined
})

// ── startup lookups ───────────────────────────────────────────────────────────

describe("hydrate validates sessions with bounded concurrency", () => {
  test("worker lookups overlap up to the bound, not one at a time", async () => {
    const h = harness()
    const ids = seedWorkers(h, 12)

    const { overlapped, exit } = await runHydrate(h)

    // A per-record serial loop would never start the second lookup before the
    // first returned, so `allStarted` would time out.
    expect(overlapped).toBe(true)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.peak()).toBe(HYDRATE_CONCURRENCY)
    expect(store.workers.size).toBe(ids.length)
    // Ordering and content are unchanged: every record is registered.
    expect([...store.workers.keys()].sort()).toEqual([...ids].sort())
  })

  test("a worker whose session is gone is still removed, and no lookup is skipped", async () => {
    const h = harness()
    seedWorkers(h, 3)
    const gone = "ses_worker_gone"
    h.data.set(workerKey(gone), encodeWorker(worker(gone, "done") as never))

    const { exit } = await runHydrate(h)

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(store.workers.has(gone)).toBe(false)
    expect(h.data.has(workerKey(gone))).toBe(false)
    expect(store.workers.size).toBe(3)
  })

  test("hydrateSessionMeta reads every owned session with the same bound", async () => {
    const h = harness()
    store.routerID = "ses_router"
    h.infos.set("ses_router", { metadata: {} })
    const ids = seedWorkers(h, 12)
    // hydrateSessionMeta walks the store, so register the same records there.
    for (const sessionID of ids) store.workers.set(sessionID, worker(sessionID, "done"))

    const fiber = await Effect.runPromise(
      Effect.exit(hydrateSessionMeta(h)).pipe(Effect.forkDetach({ startImmediately: true })),
    )
    const overlapped = await awaitOverlap(h)
    await Effect.runPromise(Deferred.succeed(h.gate, undefined))
    const exit = await Effect.runPromise(Fiber.join(fiber))

    expect(overlapped).toBe(true)
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.peak()).toBe(HYDRATE_CONCURRENCY)
    // Metadata is missing on every session, so all of them are backfilled.
    expect([...h.updates].sort()).toEqual(["ses_router", ...ids].sort())
  })
})
