import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { encodeWorker, hydrate, store, type WorkerRecord, type WorkerState } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import { handleEnded, handleStarted } from "../src/watcher.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

interface Calls {
  readonly synthetic: Array<string>
  readonly ids: Array<string | undefined>
}

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  readonly messages: Map<string, ReadonlyArray<unknown>>
  readonly calls: Calls
}

/** Minimal KV-scanning session context: only what the watcher/hydrate paths use. */
function memoryContext(): Harness {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, ReadonlyArray<unknown>>()
  const calls: Calls = { synthetic: [], ids: [] }
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
    get: ({ sessionID }: { sessionID: string }) => {
      const info = infos.get(sessionID)
      return info === undefined
        ? Effect.fail(new Error(`missing session ${sessionID}`))
        : Effect.succeed({ id: sessionID, ...info })
    },
    context: ({ sessionID }: { sessionID: string }) => Effect.succeed(messages.get(sessionID) ?? []),
    synthetic: (input: { text: string; id?: string }) => {
      calls.synthetic.push(input.text)
      calls.ids.push(input.id)
      return Effect.succeed(undefined)
    },
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  const ctx = { options: {}, storage, session, agent } as unknown as Plugin.Context
  return { ctx, data, infos, messages, calls }
}

function worker(sessionID: string, state: WorkerState, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threadID: "thread:1",
    threads: ["thread:1"],
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

beforeEach(() => {
  resetTickets()
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.pending.length = 0
  store.routerID = undefined
  store.routerBusy = false
})

// ── dedupe ───────────────────────────────────────────────────────────────────

describe("worker completion dedupe", () => {
  test("three consecutive `done` events inject one router notification", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "running", { execution: 5 }))

    // Three deliveries of the same terminal state. Their durable sequences do
    // not have to match: only `started` opens a new journal.
    for (const execution of [5, 9, 11]) {
      await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, execution))
    }

    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.calls.synthetic[0]).toContain("finished (done)")
    // The marker is persisted with the worker record, not just held in memory.
    expect(store.workers.get("ses_worker")?.notified).toEqual(["done"])
    expect(h.data.get("worker:ses_worker")).toMatchObject({ state: "done", execution: 5, notified: ["done"] })
  })

  test("different workers with the same terminal state are not deduped together", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_a", {})
    h.infos.set("ses_b", {})
    store.workers.set("ses_a", worker("ses_a", "running", { execution: 1 }))
    store.workers.set("ses_b", worker("ses_b", "running", { execution: 1 }))

    await succeed(handleEnded(h.ctx, "ses_a", "done", undefined, 1))
    await succeed(handleEnded(h.ctx, "ses_b", "done", undefined, 1))
    // Duplicates of each are still suppressed individually.
    await succeed(handleEnded(h.ctx, "ses_a", "done", undefined, 1))
    await succeed(handleEnded(h.ctx, "ses_b", "done", undefined, 1))

    expect(h.calls.synthetic).toHaveLength(2)
    expect(h.calls.synthetic[0]).toContain("ses_a")
    expect(h.calls.synthetic[1]).toContain("ses_b")
  })

  test("hydrate preserves the marker, so replaying the completion injects nothing", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "running", { execution: 5 }))

    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 5))
    expect(h.calls.synthetic).toHaveLength(1)

    // Simulate a fresh process: drop memory, reload the worker record from KV.
    store.workers.clear()
    await succeed(hydrate(h.ctx))
    expect(store.workers.get("ses_worker")?.state).toBe("done")
    expect(store.workers.get("ses_worker")?.notified).toEqual(["done"])

    // Host replay: the start event and three completion events arrive again.
    await succeed(handleStarted(h.ctx, "ses_worker", 5))
    expect(store.workers.get("ses_worker")?.state).toBe("done")
    for (let index = 0; index < 3; index += 1) {
      await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 5))
    }
    expect(h.calls.synthetic).toHaveLength(1)
  })

  test("a genuine resume opens a new execution and notifies once more", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "running", { execution: 5 }))

    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 5))
    expect(h.calls.synthetic).toHaveLength(1)

    // Follow-up prompt: the host starts execution 7.
    await succeed(handleStarted(h.ctx, "ses_worker", 7))
    expect(store.workers.get("ses_worker")?.state).toBe("running")
    expect(store.workers.get("ses_worker")?.notified).toEqual([])

    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 7))
    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 7))
    expect(h.calls.synthetic).toHaveLength(2)

    // A late replay of the *previous* execution must not resurrect or re-report.
    await succeed(handleStarted(h.ctx, "ses_worker", 5))
    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 5))
    expect(store.workers.get("ses_worker")?.state).toBe("done")
    expect(h.calls.synthetic).toHaveLength(2)
  })

  test("the same event id after hydrate is suppressed across states already announced", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "running", { execution: 9 }))

    await succeed(handleEnded(h.ctx, "ses_worker", "idle", "interrupted", 9))
    await succeed(handleEnded(h.ctx, "ses_worker", "failed", "boom", 9))
    // Same terminal state twice: interrupted replay is the deduped one.
    await succeed(handleEnded(h.ctx, "ses_worker", "idle", "interrupted", 9))
    await succeed(handleEnded(h.ctx, "ses_worker", "failed", "boom", 9))

    expect(h.calls.synthetic).toHaveLength(2)
    expect(store.workers.get("ses_worker")?.notified).toEqual(["idle", "failed"])
  })

  test("an aborted worker is never announced as finished", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "aborted", { execution: 3 }))

    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 3))

    expect(h.calls.synthetic).toHaveLength(0)
    expect(store.workers.get("ses_worker")?.state).toBe("aborted")
  })

  test("a replayed start event does not resurrect a terminal worker", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", {})
    store.workers.set("ses_worker", worker("ses_worker", "running", { execution: 4 }))

    await succeed(handleEnded(h.ctx, "ses_worker", "done", undefined, 4))
    // Reconnect replay: the same start event arrives after the terminal state.
    await succeed(handleStarted(h.ctx, "ses_worker", 4))

    expect(store.workers.get("ses_worker")?.state).toBe("done")
    expect(h.calls.synthetic).toHaveLength(1)
  })
})
