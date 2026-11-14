import type { Plugin } from "@opencode/plugin/effect"
import { DateTime, Effect, Option, Stream } from "effect"
import { ensureRouter } from "./router.js"
import { dirKeyForWorker, store, toSessionID } from "./state.js"

/** Default interval between stall checks. Overridable with the `watchdogIntervalMs` plugin option. */
export const WATCHDOG_INTERVAL_MS = 60_000

/** Default stall threshold. Overridable with the `stallTimeoutMs` plugin option. */
export const STALL_TIMEOUT_MS = 30 * 60_000

/**
 * Older records may still carry the watchdog marker in `lastReport`; keep
 * honouring it so a restart cannot re-alert the same legacy stall.
 */
export const STALLED_PREFIX = "watchdog: stalled"

/**
 * Sessions already reported for their current busy window. Alert-only mode
 * never mutates the worker record, so dedupe lives in memory. Keying by
 * `time.busy` lets a resumed worker alert once more if it stalls again.
 */
const alerted = new Map<string, number>()

/** Test/hydrate hook: forget every in-memory stall alert. */
export function resetWatchdogAlerts(): void {
  alerted.clear()
}

function optionMs(ctx: Plugin.Context, key: string, fallback: number): number {
  const raw: unknown = ctx.options[key]
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback
  return raw
}

export const checkWorker = Effect.fn("superagent.watchdogCheck")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  now: number,
  stallTimeoutMs: number,
) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined || worker.state !== "running") {
    alerted.delete(sessionID)
    return
  }
  if (worker.lastReport !== undefined && worker.lastReport.startsWith(STALLED_PREFIX)) return
  const info = yield* ctx.session.get({ sessionID: toSessionID(sessionID) }).pipe(Effect.option)
  if (Option.isNone(info)) {
    yield* Effect.logWarning("superagent watchdog: worker session not found", { sessionID })
    return
  }
  const busy = info.value.time.busy
  if (busy === undefined) {
    alerted.delete(sessionID)
    return
  }
  const busyMs = DateTime.toEpochMillis(busy)
  const idle = info.value.time.idle
  // While a session runs, `idle` still holds the previous execution's end.
  // Only an `idle` newer than `busy` proves progress since this execution started.
  if (idle !== undefined && DateTime.toEpochMillis(idle) > busyMs) {
    alerted.delete(sessionID)
    return
  }
  // One alert per busy window: duplicate checks must not spam the Router.
  if (alerted.get(sessionID) === busyMs) return
  const stalledMs = now - busyMs
  if (stalledMs <= stallTimeoutMs) return
  const minutes = Math.floor(stalledMs / 60_000)
  const title = worker.title ?? "-"
  const text = `Worker ${sessionID}（${title}）已停滞 ${minutes} 分钟，建议：stop 后重派或人工介入`
  // The alert belongs to the stalled worker's own Router: with per-directory
  // routers, sending it to the default one would tell the wrong directory.
  const routerID = yield* ensureRouter(ctx, {
    dirKey: dirKeyForWorker(worker),
    ...(worker.directory === undefined ? {} : { directory: worker.directory }),
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("superagent watchdog cannot report without a router", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID !== undefined) {
    yield* ctx.session
      .synthetic({ sessionID: toSessionID(routerID), text, description: "superagent watchdog", delivery: "queue" })
      .pipe(Effect.catch((cause) => Effect.logWarning("superagent watchdog failed to report to router", { cause })))
  }
  alerted.set(sessionID, busyMs)
  // Alert only: never change worker.state, never close its ticket and never
  // interrupt automatically, so a long task is not killed by mistake. The
  // Router decides whether to stop/re-dispatch.
  yield* Effect.logWarning("superagent watchdog: worker stalled", { sessionID, minutes })
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
 * update, and reports them to the router. It is alert-only: the worker record
 * keeps its `running` state, its ticket stays open and the worker is never
 * interrupted, so the Router stays in control. Alerts are deduped per busy
 * window. All errors are swallowed with a warning so the loop never dies.
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
