import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { DateTime, Effect, Exit, type Schema } from "effect"
import { runAbort } from "../src/abort.js"
import { decodeReport, reportKey } from "../src/report.js"
import { encodeWorker, hydrate, store, type WorkerRecord, type WorkerState } from "../src/state.js"
import { createTicket, getTicket, hydrateTickets, linkTicketToWorker, requireDispatchTicket, resetTickets, updateTicket } from "../src/ticket.js"
import { handleIdle } from "../src/watcher.js"
import { checkWorker, resetWatchdogAlerts, STALL_TIMEOUT_MS } from "../src/watchdog.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

interface Calls {
  readonly synthetic: Array<string>
  readonly interrupt: Array<string>
  readonly wait: Array<string>
}

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  readonly messages: Map<string, ReadonlyArray<unknown>>
  readonly calls: Calls
}

/** Minimal KV-scanning session context: only the methods these lifecycles use. */
function memoryContext(): Harness {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, ReadonlyArray<unknown>>()
  const calls: Calls = { synthetic: [], interrupt: [], wait: [] }
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
    synthetic: (input: { text: string }) => {
      calls.synthetic.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: ({ sessionID }: { sessionID: string }) => {
      calls.interrupt.push(sessionID)
      return Effect.succeed({ interrupted: true })
    },
    wait: ({ sessionID }: { sessionID: string }) => {
      calls.wait.push(sessionID)
      return Effect.succeed(undefined)
    },
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  const ctx = { options: {}, storage, session, agent } as unknown as Plugin.Context
  return { ctx, data, infos, messages, calls }
}

const at = (ms: number) => DateTime.makeUnsafe(ms)

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

const base = {
  threadID: "thread:1",
  title: "生命周期测试",
  objective: "覆盖 watchdog/idle/abort/hydrate",
  acceptance: ["测试通过"],
  directory: "/opt/ai-gw",
  source: "test",
} as const

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

beforeEach(() => {
  resetWatchdogAlerts()
  resetTickets()
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.pending.length = 0
  store.routerID = undefined
  store.routerBusy = false
})

// ── watchdog: alert only ─────────────────────────────────────────────────────

describe("watchdog alerts without owning the worker lifecycle", () => {
  test("a stall reports to the router but keeps state, report and ticket untouched", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_stalled", { time: { busy: at(0) } })
    store.workers.set("ses_stalled", worker("ses_stalled", "running", { title: "慢任务" }))
    const created = await succeed(
      createTicket(h.ctx, { ...base, threadID: "thread:watchdog", objective: "watchdog keeps ticket" }),
    )
    await succeed(linkTicketToWorker(h.ctx, { ticketID: created.ticket.id, sessionID: "ses_stalled" }))

    const now = 2 * STALL_TIMEOUT_MS
    await succeed(checkWorker(h.ctx, "ses_stalled", now, STALL_TIMEOUT_MS))

    expect(h.calls.synthetic).toHaveLength(1)
    expect(h.calls.synthetic[0]).toContain("已停滞")
    expect(store.workers.get("ses_stalled")?.state).toBe("running")
    expect(store.workers.get("ses_stalled")?.lastReport).toBeUndefined()
    expect(getTicket(created.ticket.id)?.state).toBe("in_progress")

    // Duplicate checks in the same busy window do not re-alert.
    await succeed(checkWorker(h.ctx, "ses_stalled", now, STALL_TIMEOUT_MS))
    expect(h.calls.synthetic).toHaveLength(1)
    expect(store.workers.get("ses_stalled")?.state).toBe("running")
    expect(getTicket(created.ticket.id)?.state).toBe("in_progress")

    // A newer idle proves progress; a following stall is a new episode.
    h.infos.set("ses_stalled", { time: { busy: at(0), idle: at(1) } })
    await succeed(checkWorker(h.ctx, "ses_stalled", now, STALL_TIMEOUT_MS))
    expect(h.calls.synthetic).toHaveLength(1)
    h.infos.set("ses_stalled", { time: { busy: at(0) } })
    await succeed(checkWorker(h.ctx, "ses_stalled", now, STALL_TIMEOUT_MS))
    expect(h.calls.synthetic).toHaveLength(2)
    expect(store.workers.get("ses_stalled")?.state).toBe("running")
  })
})

// ── watcher: idle cannot overwrite a terminal state ──────────────────────────

describe("session.idle lifecycle", () => {
  test("only running becomes idle; done/failed/aborted stay untouched", async () => {
    const h = memoryContext()
    const states: ReadonlyArray<WorkerState> = ["running", "done", "failed", "aborted"]
    for (const state of states) store.workers.set(`ses_${state}`, worker(`ses_${state}`, state))

    for (const state of states) await succeed(handleIdle(h.ctx, `ses_${state}`))

    expect(store.workers.get("ses_running")?.state).toBe("idle")
    expect(store.workers.get("ses_done")?.state).toBe("done")
    expect(store.workers.get("ses_failed")?.state).toBe("failed")
    expect(store.workers.get("ses_aborted")?.state).toBe("aborted")
    // Only the transition that happened was persisted.
    expect(h.data.get("worker:ses_running")).toBeDefined()
    expect(h.data.get("worker:ses_done")).toBeUndefined()
    expect(h.data.get("worker:ses_failed")).toBeUndefined()
    expect(h.data.get("worker:ses_aborted")).toBeUndefined()
  })
})

// ── abort: always interrupt, even for a queued prompt ───────────────────────

describe("abort clears queued prompts", () => {
  test("a not-running session is still interrupted so its queued prompt cannot start", async () => {
    const h = memoryContext()
    store.workers.set("ses_queued", worker("ses_queued", "idle"))
    // `idle` newer than `busy`: no execution is running, but a prompt may be
    // waiting behind the previous one.
    h.infos.set("ses_queued", { time: { busy: at(1), idle: at(2) } })

    const result = await succeed(runAbort(h.ctx, { sessionID: "ses_queued", reason: "queued cleanup" }))

    expect(h.calls.interrupt).toEqual(["ses_queued"])
    expect(h.calls.wait).toEqual([])
    expect(store.workers.get("ses_queued")?.state).toBe("aborted")
    expect(store.workers.get("ses_queued")?.lastReport).toContain("interrupted queued prompt")
    expect(result.output.text).toContain("already-ended")
  })

  test("a running session is interrupted and awaited as before", async () => {
    const h = memoryContext()
    store.workers.set("ses_running", worker("ses_running", "running"))
    h.infos.set("ses_running", { time: { busy: at(2), idle: at(1) } })

    const result = await succeed(runAbort(h.ctx, { sessionID: "ses_running" }))

    expect(h.calls.interrupt).toEqual(["ses_running"])
    expect(h.calls.wait).toEqual(["ses_running"])
    expect(store.workers.get("ses_running")?.state).toBe("aborted")
    expect(result.output.text).toContain("interrupted=true")
  })
})

// ── hydrate: reconcile records that were `running` across a restart ─────────

describe("hydrate reconciles running records", () => {
  test("keeps live workers, backfills ended reports and closes their tickets", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})

    h.infos.set("ses_live", { time: { busy: at(10), idle: at(5) } })
    h.infos.set("ses_done", { time: { busy: at(10), idle: at(20) }, outcome: "succeeded" })
    h.messages.set("ses_done", [
      { type: "assistant", content: [{ type: "text", text: "迁移完成：报告正文" }] },
    ])
    h.infos.set("ses_failed", { time: { busy: at(10), idle: at(20) }, outcome: "failed" })
    h.infos.set("ses_interrupted", { time: { busy: at(10), idle: at(20) }, outcome: "interrupted" })

    for (const sessionID of ["ses_live", "ses_done", "ses_failed", "ses_interrupted", "ses_gone"]) {
      h.data.set(
        `worker:${sessionID}`,
        encodeWorker(worker(sessionID, "running", { threadID: "thread:hydrate", threads: ["thread:hydrate"] })),
      )
    }

    const doneTicket = await succeed(
      createTicket(h.ctx, { ...base, threadID: "thread:done", objective: "hydrate closes done" }),
    )
    await succeed(linkTicketToWorker(h.ctx, { ticketID: doneTicket.ticket.id, sessionID: "ses_done" }))
    const failedTicket = await succeed(
      createTicket(h.ctx, { ...base, threadID: "thread:failed", objective: "hydrate closes failed" }),
    )
    await succeed(linkTicketToWorker(h.ctx, { ticketID: failedTicket.ticket.id, sessionID: "ses_failed" }))
    const interruptedTicket = await succeed(
      createTicket(h.ctx, { ...base, threadID: "thread:interrupted", objective: "hydrate keeps interrupted open" }),
    )
    await succeed(linkTicketToWorker(h.ctx, { ticketID: interruptedTicket.ticket.id, sessionID: "ses_interrupted" }))

    // Simulate a fresh process: rebuild the in-memory ticket store from KV.
    resetTickets()
    await succeed(hydrateTickets(h.ctx))
    expect(getTicket(doneTicket.ticket.id)?.state).toBe("in_progress")

    await succeed(hydrate(h.ctx))

    // Still executing: untouched.
    expect(store.workers.get("ses_live")?.state).toBe("running")
    expect(h.data.has(reportKey("ses_live"))).toBe(false)

    // Finished successfully: done + report backfill + ticket close.
    expect(store.workers.get("ses_done")?.state).toBe("done")
    expect(store.workers.get("ses_done")?.lastReport).toBe("迁移完成：报告正文")
    expect(decodeReport(h.data.get(reportKey("ses_done")))?.text).toBe("迁移完成：报告正文")
    expect(getTicket(doneTicket.ticket.id)?.state).toBe("done")

    // Failed: failed + ticket close, no report invented.
    expect(store.workers.get("ses_failed")?.state).toBe("failed")
    expect(h.data.has(reportKey("ses_failed"))).toBe(false)
    expect(getTicket(failedTicket.ticket.id)?.state).toBe("failed")

    // Interrupted: idle + ticket parked as `blocked` so a restart does not
    // leave it `in_progress` behind the idle dispatch gate.
    expect(store.workers.get("ses_interrupted")?.state).toBe("idle")
    const parked = getTicket(interruptedTicket.ticket.id)
    expect(parked?.state).toBe("blocked")
    expect(parked?.history.at(-1)?.note).toContain("interrupted")
    expect(parked?.workerSessionID).toBe("ses_interrupted")

    // A session that no longer exists is dropped from memory and KV.
    expect(store.workers.has("ses_gone")).toBe(false)
    expect(h.data.has("worker:ses_gone")).toBe(false)
  })

  // Regression: hydrate used to only close `done`/`failed` tickets, so an
  // interrupted worker came back as `idle` while its ticket stayed
  // `in_progress` — invisible to the gate's "released" heuristic and therefore
  // undispatchable until a manual abort. After a restart it must land in
  // `blocked` and be re-dispatchable straight away.
  test("an interrupted worker's ticket is blocked and re-dispatchable after a restart", async () => {
    const h = memoryContext()
    store.routerID = "ses_router"
    h.infos.set("ses_router", {})
    h.infos.set("ses_worker", { time: { busy: at(10), idle: at(20) }, outcome: "interrupted" })
    h.data.set(
      "worker:ses_worker",
      encodeWorker(worker("ses_worker", "running", { threadID: "thread:1", threads: ["thread:1"] })),
    )

    const created = await succeed(
      createTicket(h.ctx, { ...base, threadID: "thread:1", objective: "restart parks the interrupted ticket" }),
    )
    await succeed(linkTicketToWorker(h.ctx, { ticketID: created.ticket.id, sessionID: "ses_worker" }))
    // The ticket is mid-flight when the plugin dies.
    await succeed(updateTicket(h.ctx, { ticketID: created.ticket.id, state: "in_progress" }))
    expect(getTicket(created.ticket.id)?.state).toBe("in_progress")

    // Fresh process: rebuild worker records and tickets from KV.
    store.workers.clear()
    resetTickets()
    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrate(h.ctx))

    const parked = getTicket(created.ticket.id)
    expect(store.workers.get("ses_worker")?.state).toBe("idle")
    expect(parked?.state).toBe("blocked")
    expect(parked?.history.at(-1)?.note).toContain("interrupted")

    // The idle worker no longer gates the ticket: reopening is enough.
    await succeed(updateTicket(h.ctx, { ticketID: created.ticket.id, state: "in_progress" }))
    const ready = await succeed(requireDispatchTicket(created.ticket.id, "thread:1"))
    expect(ready.id).toBe(created.ticket.id)
  })
})
