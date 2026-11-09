import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Duration, Effect, Schema } from "effect"
import { requireRouter } from "./guard.js"
import { flushPending } from "./router.js"
import { store } from "./state.js"
import { specFor, toolPermission } from "./tools.js"
import { isWorkerTerminal } from "./worker-state.js"

/**
 * Router-only `sleep` tool: a bounded, real pause after `dispatch` so the
 * Worker gets execution time before the Router decides to act again. It is a
 * timer, never a busy loop, so the Router session (and every other fiber in
 * the process) stays responsive while it waits.
 *
 * The wait is interruptible (plan A): every {@link SLEEP_POLL_MS} the loop
 * checks the plugin's in-memory state and returns early when a worker reached
 * a terminal state or a new trigger was queued. The baseline is sampled before
 * the first wait, so work that already existed when `sleep` started never
 * causes a false wake-up. A pending-trigger wake flushes the queue with
 * `delivery: "steer"` so the new trigger is visible at the next step boundary.
 */

export const SLEEP_DEFAULT_SECONDS = 30
export const SLEEP_MIN_SECONDS = 1
export const SLEEP_MAX_SECONDS = 60
/** State-check interval during a sleep; small enough to feel immediate, large enough not to spin. */
export const SLEEP_POLL_MS = 250

export const SleepInput = Schema.Struct({
  seconds: Schema.optionalKey(Schema.Number),
})

export const SleepOutput = Schema.Struct({
  slept: Schema.Number,
  text: Schema.String,
  /** Present only on an early return: why the wait was cut short. */
  woken: Schema.optionalKey(Schema.String),
})

interface SleepInput {
  readonly seconds?: number
}

/** Waits `millis` before the next state check; tests inject a fake clock. */
export type Poller = (millis: number) => Effect.Effect<void>

/** The production poller: a platform timer, not a spin loop. */
export const effectPoller: Poller = (millis) => Effect.sleep(Duration.millis(millis))

export interface SleepDeps {
  /** Interval wait; defaults to the real timer. */
  readonly poll?: Poller
  /** Clock used for the real elapsed time; defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * Host context. The production registration passes it so a pending-trigger
   * wake can flush with steer delivery; unit callers may omit it.
   */
  readonly ctx?: Plugin.Context
  /** Test hook: replaces the wake-up flush (defaults to `flushPending(..., { delivery: "steer" })`). */
  readonly flush?: () => Effect.Effect<void>
}

interface WorkSnapshot {
  readonly pending: number
  readonly terminal: number
}

/** Current plugin state the loop watches: queued triggers and terminal workers. */
function snapshotWork(): WorkSnapshot {
  let terminal = 0
  for (const worker of store.workers.values()) {
    if (isWorkerTerminal(worker.state)) terminal += 1
  }
  return { pending: store.pending.length, terminal }
}

interface Wake {
  /** Human-readable reason appended to the result text. */
  readonly reason: string
  /** Whether the queue must be flushed (new triggers) or the watcher already steered. */
  readonly flush: boolean
}

/** Compare the live state against the baseline sampled before waiting. */
function wakeFor(baseline: WorkSnapshot, current: WorkSnapshot): Wake | undefined {
  const completed = current.terminal - baseline.terminal
  const queued = current.pending - baseline.pending
  const parts: Array<string> = []
  // Pending is listed first: when new triggers arrive they must be flushed,
  // even if a worker also finished in the same interval.
  if (queued > 0) parts.push(`${queued} new event(s)`)
  else if (queued < 0) parts.push("pending queue changed")
  if (completed > 0) parts.push(completed === 1 ? "worker completed" : `${completed} workers completed`)
  else if (completed < 0) parts.push("worker state changed")
  if (parts.length === 0) return undefined
  return { reason: parts.join(", "), flush: queued > 0 }
}

export const runSleep = Effect.fn("superagent.sleep")(function* (
  input: SleepInput,
  caller: string,
  deps: SleepDeps = {},
) {
  yield* requireRouter(caller, "sleep")
  const seconds = input.seconds ?? SLEEP_DEFAULT_SECONDS
  // The registered schema already rejects non-numbers at the tool boundary;
  // this re-check keeps direct/RPC-style callers from bypassing validation.
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    return yield* new Tool.Error({
      message: `sleep seconds must be a number between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS} (got ${String(input.seconds)})`,
    })
  }
  if (!Number.isInteger(seconds)) {
    return yield* new Tool.Error({
      message: `sleep seconds must be an integer between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS} (got ${seconds})`,
    })
  }
  if (seconds < SLEEP_MIN_SECONDS || seconds > SLEEP_MAX_SECONDS) {
    return yield* new Tool.Error({
      message: `sleep seconds must be between ${SLEEP_MIN_SECONDS} and ${SLEEP_MAX_SECONDS} (got ${seconds})`,
    })
  }

  const poll = deps.poll ?? effectPoller
  const now = deps.now ?? Date.now
  const totalMs = seconds * 1000
  const startedAt = now()
  // Baseline before the first wait: pre-existing terminal workers or queued
  // triggers must not wake this sleep.
  const baseline = snapshotWork()
  let wake: Wake | undefined
  for (;;) {
    const elapsedMs = now() - startedAt
    if (elapsedMs >= totalMs) break
    yield* poll(Math.min(SLEEP_POLL_MS, totalMs - elapsedMs))
    wake = wakeFor(baseline, snapshotWork())
    if (wake !== undefined) break
  }

  if (wake === undefined) {
    const text = `slept ${seconds}s`
    return { output: { slept: seconds, text }, content: text }
  }

  // Real elapsed time, floored and never reported as 0: a 250ms check that
  // fires immediately still slept at least one second.
  const elapsedMs = Math.max(0, now() - startedAt)
  const slept = Math.max(1, Math.floor(elapsedMs / 1000))
  const text = `slept ${slept}s of ${seconds}s (woken: ${wake.reason})`
  if (wake.flush) {
    const ctx = deps.ctx
    const flush =
      deps.flush ?? (ctx === undefined ? undefined : () => flushPending(ctx, { delivery: "steer" }))
    if (flush === undefined) {
      yield* Effect.logWarning("superagent sleep woke on pending triggers without a host context to flush")
    } else {
      // A flush failure must not fail the tool call: the triggers stay queued
      // and the idle hook or the next trigger retries them.
      yield* flush().pipe(
        Effect.catch((cause) => Effect.logWarning("superagent sleep wake flush failed", { cause })),
      )
    }
  }
  return { output: { slept, text, woken: wake.reason }, content: text }
})

export const registerSleep = Effect.fn("superagent.registerSleep")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "sleep",
      description: specFor("sleep").description,
      input: SleepInput,
      output: SleepOutput,
      options: { permission: toolPermission(specFor("sleep")) },
      execute: (input, context) => runSleep(input, context.sessionID, { ctx }),
    })
  })
})
