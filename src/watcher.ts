import type { Plugin } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { buildReport, lastAssistantText, reportNotice, reportSummary, saveReport } from "./report.js"
import { ensureRouter } from "./router.js"
import { clipCodePoints } from "./format.js"
import { perDirectoryRouterEnabled } from "./settings.js"
import {
  dirKeyForRouter,
  dirKeyForWorker,
  dirState,
  isRouterSession,
  saveWorker,
  store,
  toSessionID,
  type WorkerRecord,
} from "./state.js"
import { blockTicketsForWorker, closeTicketsForWorker } from "./ticket.js"
import { closeOutcomeForWorkerState } from "./ticket-state.js"

/**
 * Degradation warnings that must not spam: the same directory-less worker
 * completion is retried on every duplicate delivery, and a warning per attempt
 * would bury the one line the operator needs. Keyed by warning topic.
 */
const warnedOnce = new Set<string>()

function warnOnce(key: string, message: string, fields: Record<string, unknown>): Effect.Effect<void> {
  if (warnedOnce.has(key)) return Effect.void
  warnedOnce.add(key)
  return Effect.logWarning(message, fields)
}

/** Test hook: forget every one-shot degradation warning. */
export function resetPartitionWarnings(): void {
  warnedOnce.clear()
}

/**
 * Capture one finished report: the complete text goes to `report:<sessionID>`
 * first, then the worker record keeps a short summary for status lines and the
 * router injection. The full text is written before anything else so a crash
 * between the two writes can only lose the summary, never the evidence.
 */
export const captureReport = Effect.fn("superagent.captureReport")(function* (
  ctx: Plugin.Context,
  worker: WorkerRecord,
  text: string,
) {
  const record = buildReport(worker.sessionID, text)
  yield* saveReport(ctx, record)
  worker.lastReport = reportSummary(record)
  return record
})

function errorDetail(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const error = (data as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return undefined
  const typed = error as { type?: unknown; message?: unknown; status?: unknown }
  const parts: Array<string> = []
  if (typeof typed.type === "string" && typed.type !== "") parts.push(typed.type)
  if (typeof typed.status === "number") parts.push(`status ${typed.status}`)
  if (typeof typed.message === "string") {
    const message = clipCodePoints(typed.message.trim(), 500)
    if (message !== "") parts.push(message)
  }
  if (parts.length === 0) return undefined
  return parts.join(" ")
}

/**
 * Raw `reason` the host attached to an interruption (`context canceled`, a
 * user label, …), if any. It is recorded on the ticket, so keep it free of
 * wording the ticket layer adds itself.
 */
function interruptReason(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== "string") return undefined
  const trimmed = reason.trim()
  return trimmed === "" ? undefined : clipCodePoints(trimmed, 500)
}

/** Relative position of an event's execution before/after the worker's current one. */
type ExecutionRelation = "same" | "newer" | "older" | "unknown"

/**
 * `session.execution.started` carries a durable sequence per session. The same
 * event replayed (host reconnect, `hydrate`) keeps its sequence; a genuine
 * follow-up prompt opens a new execution with a newer one. Comparing them is
 * what lets the watcher tell "duplicate delivery" from "worker ran again".
 */
function executionRelation(worker: WorkerRecord, execution: number | undefined): ExecutionRelation {
  if (execution === undefined || worker.execution === undefined) return "unknown"
  if (execution === worker.execution) return "same"
  return execution > worker.execution ? "newer" : "older"
}

/**
 * Stable id for one worker terminal notification. Identity is
 * `(sessionID, execution, terminal state)`, so a notification replayed after
 * a crash computes the same id and the host can drop the duplicate even if
 * `notified` was not persisted in time. The 12-hex time prefix mirrors the
 * host's `msg_` layout (see `router.ts` batch ids).
 */
function completionMessageID(worker: WorkerRecord, state: string): SessionMessage.ID {
  const identity = `superagent.completion\n${worker.sessionID}\n${worker.execution ?? "legacy"}\n${state}`
  const suffix = createHash("sha1").update(identity).digest("hex").slice(0, 14)
  const at = BigInt(Math.max(0, Math.trunc(worker.execution ?? worker.createdAt)))
  const stamp = ((at * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0")
  return `msg_${stamp}${suffix}` as SessionMessage.ID
}

/**
 * Apply a `session.execution.started` notification. A replayed start for an
 * execution that already finished must not resurrect a terminal worker, while
 * a real follow-up prompt (newer durable sequence) starts a fresh execution
 * and clears the completion journal so its result is announced again.
 */
export const handleStarted = Effect.fn("superagent.workerStarted")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  execution?: number,
) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return
  const relation = executionRelation(worker, execution)
  // A stale start (older execution) or a replay for an execution that already
  // reached a terminal state must leave the worker record alone.
  if (relation === "older") return
  if (relation === "same" && worker.state !== "running") return
  let changed = false
  if (relation === "newer") {
    worker.execution = execution
    worker.notified = []
    changed = true
  } else if (execution !== undefined && worker.execution === undefined) {
    // First start seen for this record (legacy/just dispatched): adopt the
    // epoch without clearing anything.
    worker.execution = execution
    changed = true
  }
  if (worker.state !== "running") {
    worker.state = "running"
    changed = true
  }
  if (changed) yield* saveWorker(ctx, worker)
})

/**
 * Apply a `session.idle` notification. Only a running worker may become idle:
 * `done`, `failed` and `aborted` are terminal for the lifecycle, and an idle
 * event must never resurrect or overwrite them.
 */
export const handleIdle = Effect.fn("superagent.workerIdle")(function* (
  ctx: Plugin.Context,
  sessionID: string,
) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined || worker.state !== "running") return
  worker.state = "idle"
  yield* saveWorker(ctx, worker)
})

/**
 * Announce one terminal state to the Router exactly once per execution.
 * Duplicate sources are all collapsed by `worker.notified`: the watcher seeing
 * the same event twice, the host re-delivering a durable event after a
 * reconnect, and `hydrate` replaying state from KV. The marker is persisted
 * with the worker record *before* the synthetic is sent, so a restart does not
 * re-inject an already-delivered notification.
 */
export const handleEnded = Effect.fn("superagent.workerEnded")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  state: "done" | "failed" | "idle",
  detail?: string,
  execution?: number,
) {
  const sessions = ctx.session
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return
  // A terminated worker keeps `aborted`; the abort tool already reported the
  // outcome to whoever asked, so do not re-announce it as finished.
  if (worker.state === "aborted") return
  const relation = executionRelation(worker, execution)
  // A completion for an execution older than the current one is a replay from
  // before the worker was resumed; it must not reopen the journal.
  if (relation === "older") return
  // Only a `started` event opens a new execution epoch. Completion events
  // carry their own (larger) sequence, so adopting them here or clearing the
  // journal on "newer" would let distinct duplicate deliveries each notify.
  if (execution !== undefined && worker.execution === undefined) worker.execution = execution
  const announced = worker.notified ?? []
  // Deterministic key: same worker + same execution + same terminal state.
  // Checked before any report/ticket work so a duplicate cannot re-close a
  // ticket or overwrite a newer report either.
  if (announced.includes(state)) return
  worker.state = state
  worker.notified = [...announced, state]
  const messages = yield* sessions
    .context({ sessionID: toSessionID(sessionID) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const report = lastAssistantText(messages)
  // Full text first: `report:<sessionID>` is the read-back handle. The worker
  // record only keeps a summary, which is what list/status lines show.
  const captured = report === undefined ? undefined : yield* captureReport(ctx, worker, report)
  yield* saveWorker(ctx, worker)
  // A worker that reached a terminal state closes its in-progress ticket.
  // An interruption (`idle`) parks it instead: the work did not finish and the
  // attempt did not fail, but leaving it `in_progress` would keep it out of
  // every later dispatch. `blocked` records the reason and stays re-dispatchable.
  const closeOutcome = closeOutcomeForWorkerState(state)
  if (closeOutcome !== undefined) {
    yield* closeTicketsForWorker(ctx, {
      sessionID,
      outcome: closeOutcome,
      summary: worker.lastReport ?? report ?? detail ?? `${closeOutcome} (worker ${sessionID})`,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to close ticket for ended worker", { sessionID, cause }),
      ),
    )
  } else if (state === "idle") {
    yield* blockTicketsForWorker(ctx, {
      sessionID,
      ...(detail === undefined ? {} : { reason: detail }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to block ticket for interrupted worker", { sessionID, cause }),
      ),
    )
  }
  // Keep the thread subscriptions after the worker ends: follow-ups on the
  // same thread resume this worker (prompting a finished session starts a new
  // execution in it) instead of spawning a fresh session per message. A
  // genuinely new task clears the affinity.
  const info = yield* sessions.get({ sessionID: toSessionID(sessionID) }).pipe(
    Effect.map((session) => session as { outcome?: unknown }),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  const rawOutcome = info?.outcome
  const outcome =
    rawOutcome === "succeeded" || rawOutcome === "failed" || rawOutcome === "interrupted"
      ? rawOutcome
      : state === "done"
        ? "succeeded"
        : state === "failed"
          ? "failed"
          : "interrupted"
  const label = worker.title === undefined ? `Worker ${sessionID}` : `Worker ${sessionID} (${worker.title})`
  const text =
    report !== undefined && captured !== undefined
      ? [`${label} finished (${state}):`, reportSummary(captured), "---", reportNotice(captured)].join("\n")
      : `${label} finished (${state}) with no report (outcome: ${outcome}).${detail === undefined ? "" : ` Cause: ${detail}.`} Suggest: 可换模型重派.`
  const routerID = yield* ensureRouterForWorker(ctx, worker).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("superagent cannot report without a router", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID === undefined) {
    // Nothing was delivered: release the marker so a replayed completion can
    // retry instead of being suppressed forever.
    worker.notified = (worker.notified ?? []).filter((notified) => notified !== state)
    yield* saveWorker(ctx, worker)
    return
  }
  const delivered = yield* sessions
    .synthetic({
      sessionID: toSessionID(routerID),
      // Deterministic id is the last line of defence: if the process crashes
      // after sending but before this marker is persisted, a replay sends the
      // same id and the host drops the duplicate.
      id: completionMessageID(worker, state),
      text,
      delivery: "steer",
    })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to report to router", { cause }).pipe(Effect.as(false)),
      ),
    )
  if (!delivered) {
    worker.notified = (worker.notified ?? []).filter((notified) => notified !== state)
    yield* saveWorker(ctx, worker)
  }
})

/**
 * The Router a worker's notification belongs to: the one of the worker's own
 * directory partition.
 *
 * Degradation is explicit, never silent: with the switch on, a worker record
 * without a directory has no partition of its own, so its completion falls
 * back to the default partition and warns **once** — dropping it would lose
 * the only signal the Router gets that the work finished. A partition whose
 * router cannot be created keeps the `notified` marker released (the caller
 * retries on the next delivery) instead of misrouting the report elsewhere.
 */
const ensureRouterForWorker = Effect.fn("superagent.ensureRouterForWorker")(function* (
  ctx: Plugin.Context,
  worker: WorkerRecord,
) {
  const dirKey = dirKeyForWorker(worker)
  if (perDirectoryRouterEnabled() && worker.directory === undefined) {
    yield* warnOnce("worker-without-directory", "superagent worker has no directory; reporting to the default router", {
      sessionID: worker.sessionID,
      dirKey,
    })
  }
  return yield* ensureRouter(ctx, {
    dirKey,
    ...(worker.directory === undefined ? {} : { directory: worker.directory }),
  })
})

/** Partition whose Router this session is, or `undefined` when it is not a router. */
function routerPartitionOf(sessionID: string): string | undefined {
  return isRouterSession(sessionID) ? dirKeyForRouter(sessionID) : undefined
}

export const registerWatcher = Effect.fn("superagent.registerWatcher")(function* (ctx: Plugin.Context) {
  yield* ctx.event
    .subscribe({
      types: [
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.idle",
      ],
    })
    .pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const sessionID = event.data.sessionID as string
          // Every `session.execution.*` event is durable and carries a per
          // session sequence number; `session.idle` is ephemeral and has none.
          const execution = (event as { durable?: { seq?: number } }).durable?.seq
          switch (event.type) {
            case "session.execution.started": {
              const routerDirKey = routerPartitionOf(sessionID)
              if (routerDirKey !== undefined) dirState(store, routerDirKey).routerBusy = true
              yield* handleStarted(ctx, sessionID, execution)
              return
            }
            case "session.execution.succeeded": {
              const routerDirKey = routerPartitionOf(sessionID)
              if (routerDirKey !== undefined) {
                dirState(store, routerDirKey).routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "done", undefined, execution)
              return
            }
            case "session.execution.failed": {
              const routerDirKey = routerPartitionOf(sessionID)
              if (routerDirKey !== undefined) {
                dirState(store, routerDirKey).routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "failed", errorDetail(event.data as unknown), execution)
              return
            }
            case "session.execution.interrupted": {
              const routerDirKey = routerPartitionOf(sessionID)
              if (routerDirKey !== undefined) {
                dirState(store, routerDirKey).routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "idle", interruptReason(event.data as unknown), execution)
              return
            }
            case "session.idle": {
              yield* handleIdle(ctx, sessionID)
              return
            }
            default:
              return
          }
        }).pipe(Effect.catch((cause) => Effect.logWarning("superagent watcher failed", { cause }))),
      ),
      Effect.forkScoped,
    )
})
