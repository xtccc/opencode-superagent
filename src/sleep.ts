import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Duration, Effect, Schema } from "effect"
import { requireRouter } from "./guard.js"
import { specFor, toolPermission } from "./tools.js"

/**
 * Router-only `sleep` tool: a bounded, real pause after `dispatch` so the
 * Worker gets execution time before the Router decides to act again. It is a
 * timer, never a busy loop, so the Router session (and every other fiber in
 * the process) stays responsive while it waits.
 */

export const SLEEP_DEFAULT_SECONDS = 30
export const SLEEP_MIN_SECONDS = 1
export const SLEEP_MAX_SECONDS = 600

export const SleepInput = Schema.Struct({
  seconds: Schema.optionalKey(Schema.Number),
})

export const SleepOutput = Schema.Struct({
  slept: Schema.Number,
  text: Schema.String,
})

interface SleepInput {
  readonly seconds?: number
}

/** Performs the wait; tests inject a no-op so the default 30s never runs. */
export type Sleeper = (seconds: number) => Effect.Effect<void>

/** The production sleeper: a platform timer, not a spin loop. */
export const effectSleeper: Sleeper = (seconds) => Effect.sleep(Duration.seconds(seconds))

export const runSleep = Effect.fn("superagent.sleep")(function* (
  input: SleepInput,
  caller: string,
  sleeper: Sleeper = effectSleeper,
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
  yield* sleeper(seconds)
  const text = `slept ${seconds}s`
  return { output: { slept: seconds, text }, content: text }
})

export const registerSleep = Effect.fn("superagent.registerSleep")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "sleep",
      description: specFor("sleep").description,
      input: SleepInput,
      output: SleepOutput,
      options: { permission: toolPermission(specFor("sleep")) },
      execute: (input, context) => runSleep(input, context.sessionID),
    })
  })
})
