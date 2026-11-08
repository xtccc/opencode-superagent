import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Stream } from "effect"
import { buildReport, reportNotice, reportSummary, saveReport } from "./report.js"
import { ensureRouter } from "./router.js"
import { saveWorker, store, toSessionID, type WorkerRecord } from "./state.js"
import { closeTicketsForWorker } from "./ticket.js"

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

function lastAssistantText(messages: ReadonlyArray<unknown>): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (typeof message !== "object" || message === null) continue
    const typed = message as { type?: unknown; content?: unknown }
    if (typed.type !== "assistant") continue
    if (!Array.isArray(typed.content)) continue
    const text = typed.content
      .flatMap((part) => {
        if (typeof part !== "object" || part === null) return []
        const candidate = part as { type?: unknown; text?: unknown }
        return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : []
      })
      .join("\n")
      .trim()
    if (text !== "") return text
  }
  return undefined
}

function errorDetail(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const error = (data as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return undefined
  const typed = error as { type?: unknown; message?: unknown; status?: unknown }
  const parts: Array<string> = []
  if (typeof typed.type === "string" && typed.type !== "") parts.push(typed.type)
  if (typeof typed.status === "number") parts.push(`status ${typed.status}`)
  if (typeof typed.message === "string") {
    const message = typed.message.trim().slice(0, 500)
    if (message !== "") parts.push(message)
  }
  if (parts.length === 0) return undefined
  return parts.join(" ")
}

function interruptDetail(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  return typeof reason === "string" && reason !== "" ? `interrupted (${reason})` : "interrupted"
}

const handleEnded = Effect.fn("superagent.workerEnded")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  state: "done" | "failed" | "idle",
  detail?: string,
) {
  const sessions = ctx.session
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return
  // A terminated worker keeps `aborted`; the abort tool already reported the
  // outcome to whoever asked, so do not re-announce it as finished.
  if (worker.state === "aborted") return
  worker.state = state
  const messages = yield* sessions
    .context({ sessionID: toSessionID(sessionID) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const report = lastAssistantText(messages)
  // Full text first: `report:<sessionID>` is the read-back handle. The worker
  // record only keeps a summary, which is what list/status lines show.
  const captured = report === undefined ? undefined : yield* captureReport(ctx, worker, report)
  yield* saveWorker(ctx, worker)
  // A worker that reached a terminal state closes its in-progress ticket.
  // Interruptions (`idle`) leave it open: the abort tool closes it explicitly
  // and a plain interrupt may still be resumed with a follow-up.
  if (state === "done" || state === "failed") {
    yield* closeTicketsForWorker(ctx, {
      sessionID,
      outcome: state,
      summary: worker.lastReport ?? report ?? detail ?? `${state} (worker ${sessionID})`,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to close ticket for ended worker", { sessionID, cause }),
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
  const routerID = yield* ensureRouter(ctx).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("superagent cannot report without a router", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID === undefined) return
  yield* sessions
    .synthetic({ sessionID: toSessionID(routerID), text, delivery: "steer" })
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to report to router", { cause })))
})

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
          switch (event.type) {
            case "session.execution.started": {
              if (store.routerID !== undefined && event.data.sessionID === store.routerID) store.routerBusy = true
              const worker = store.workers.get(sessionID)
              if (worker === undefined) return
              worker.state = "running"
              yield* saveWorker(ctx, worker)
              return
            }
            case "session.execution.succeeded": {
              if (store.routerID !== undefined && event.data.sessionID === store.routerID) {
                store.routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "done")
              return
            }
            case "session.execution.failed": {
              if (store.routerID !== undefined && event.data.sessionID === store.routerID) {
                store.routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "failed", errorDetail(event.data as unknown))
              return
            }
            case "session.execution.interrupted": {
              if (store.routerID !== undefined && event.data.sessionID === store.routerID) {
                store.routerBusy = false
                return
              }
              yield* handleEnded(ctx, sessionID, "idle", interruptDetail(event.data as unknown))
              return
            }
            case "session.idle": {
              const worker = store.workers.get(sessionID)
              if (worker === undefined || worker.state === "idle" || worker.state === "aborted") return
              worker.state = "idle"
              yield* saveWorker(ctx, worker)
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
