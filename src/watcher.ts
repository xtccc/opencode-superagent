import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Option, Stream } from "effect"
import { ensureRouter } from "./router.js"
import { saveThread, saveWorker, store, threadKey, toSessionID } from "./state.js"
import { reportWorkerToTelegram } from "./telegram.js"

const REPORT_LIMIT = 1200

function truncateReport(text: string): string {
  if (text.length <= REPORT_LIMIT) return text
  return `${text.slice(0, REPORT_LIMIT)}…`
}

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
  worker.state = state
  const messages = yield* sessions
    .context({ sessionID: toSessionID(sessionID) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const report = lastAssistantText(messages)
  if (report !== undefined) worker.lastReport = truncateReport(report)
  yield* saveWorker(ctx, worker)
  // Release the thread subscriptions so the next message on the same thread
  // returns to the Router (fresh dispatch) instead of reusing a stale session.
  // The worker record itself is kept for status/history.
  for (const threadID of worker.threads) {
    const rest = (store.threads.get(threadID) ?? []).filter((id) => id !== sessionID)
    if (rest.length === 0) {
      store.threads.delete(threadID)
      yield* ctx.storage.remove(threadKey(threadID)).pipe(Effect.catch(() => Effect.void))
    } else {
      store.threads.set(threadID, rest)
      yield* saveThread(ctx, { threadID, workers: [...rest], updatedAt: Date.now() })
    }
  }
  yield* reportWorkerToTelegram(ctx, sessionID).pipe(
    Effect.catch((cause) => Effect.logWarning("superagent telegram report failed", { sessionID, cause })),
  )
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
  const text =
    report !== undefined
      ? `Worker ${sessionID} finished (${state}):\n${worker.lastReport ?? ""}`
      : `Worker ${sessionID} finished (${state}) with no report (outcome: ${outcome}).${detail === undefined ? "" : ` Cause: ${detail}.`} Suggest: 可换模型重派.`
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
              if (worker === undefined || worker.state === "idle") return
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
