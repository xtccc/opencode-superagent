import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Option, Stream } from "effect"
import { ensureRouter } from "./router.js"
import { saveWorker, store, toSessionID } from "./state.js"

/** Default interval between stall checks. Overridable with the `watchdogIntervalMs` plugin option. */
export const WATCHDOG_INTERVAL_MS = 60_000

/** Default stall threshold. Overridable with the `stallTimeoutMs` plugin option. */
export const STALL_TIMEOUT_MS = 30 * 60_000

/** Prefix marking a worker already reported as stalled. Guards duplicate watchdog alerts. */
export const STALLED_PREFIX = "watchdog: stalled"

function optionMs(ctx: Plugin.Context, key: string, fallback: number): number {
  const raw: unknown = ctx.options[key]
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback
  return raw
}

const checkWorker = Effect.fn("superagent.watchdogCheck")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  now: number,
  stallTimeoutMs: number,
) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined || worker.state !== "running") return
  // Already alerted: only the running→failed transition reports once.
  if (worker.lastReport !== undefined && worker.lastReport.startsWith(STALLED_PREFIX)) return
  const info = yield* ctx.session.get({ sessionID: toSessionID(sessionID) }).pipe(Effect.option)
  if (Option.isNone(info)) {
    yield* Effect.logWarning("superagent watchdog: worker session not found", { sessionID })
    return
  }
  const busy = info.value.time.busy
  if (busy === undefined) return
  const busyMs = DateTime.toEpochMillis(busy)
  const idle = info.value.time.idle
  // While a session runs, `idle` still holds the previous execution's end.
  // Only an `idle` newer than `busy` proves progress since this execution started.
  if (idle !== undefined && DateTime.toEpochMillis(idle) > busyMs) return
  const stalledMs = now - busyMs
  if (stalledMs <= stallTimeoutMs) return
  const minutes = Math.floor(stalledMs / 60_000)
  const title = worker.title ?? "-"
  const text = `Worker ${sessionID}（${title}）已停滞 ${minutes} 分钟，建议：stop 后重派或人工介入`
  const routerID = yield* ensureRouter(ctx).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("superagent watchdog cannot report without a router", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID !== undefined) {
    yield* ctx.session
      .synthetic({ sessionID: toSessionID(routerID), text, description: "superagent watchdog", delivery: "queue" })
      .pipe(Effect.catch((cause) => Effect.logWarning("superagent watchdog failed to report to router", { cause })))
  }
  // Alert only: never interrupt automatically, so long tasks are not killed by mistake.
  worker.state = "failed"
  worker.lastReport = `${STALLED_PREFIX} ${minutes}m${worker.lastReport === undefined ? "" : ` | ${worker.lastReport}`}`
  yield* saveWorker(ctx, worker)
})

const checkAll = Effect.fn("superagent.watchdogCheckAll")(function* (ctx: Plugin.Context, stallTimeoutMs: number) {
  const now = Date.now()
  for (const sessionID of [...store.workers.keys()]) {
    yield* checkWorker(ctx, sessionID, now, stallTimeoutMs).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent watchdog check failed", { sessionID, cause })),
    )
  }
})

/**
 * Periodic stall detector. Every interval it flags `running` workers whose
 * session has been busy longer than the stall timeout without an `idle`
 * update, reports them to the router, and marks them `failed`. It never
 * interrupts: stalled workers stay alive until someone stops or re-dispatches
 * them. All errors are swallowed with a warning so the loop never dies.
 */
export const registerWatchdog = Effect.fn("superagent.registerWatchdog")(function* (ctx: Plugin.Context) {
  const intervalMs = optionMs(ctx, "watchdogIntervalMs", WATCHDOG_INTERVAL_MS)
  const stallTimeoutMs = optionMs(ctx, "stallTimeoutMs", STALL_TIMEOUT_MS)
  yield* Stream.tick(intervalMs).pipe(
    Stream.runForEach(() =>
      checkAll(ctx, stallTimeoutMs).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent watchdog run failed", { cause })),
      ),
    ),
    Effect.forkScoped,
  )
})
