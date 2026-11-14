import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { requireRouter } from "./guard.js"
import { partitioningEnabled } from "./settings.js"
import {
  detachWorkerThreads,
  dirKeyForWorker,
  isRouterSession,
  isRunning,
  saveWorker,
  store,
  toSessionID,
} from "./state.js"
import { closeTicketsForWorker } from "./ticket.js"
import { specFor, toolPermission } from "./tools.js"

/** How long a terminating call waits for an interrupted worker to settle before reporting a timeout. */
export const ABORT_TIMEOUT_MS = 10_000

export const AbortInput = Schema.Struct({
  sessionID: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  all: Schema.optionalKey(Schema.Boolean),
  stale: Schema.optionalKey(Schema.Boolean),
})

const AbortOutput = Schema.Struct({ text: Schema.String })

interface AbortInput {
  readonly sessionID?: string
  readonly reason?: string
  readonly all?: boolean
  readonly stale?: boolean
}

type AbortStatus = "aborted" | "already-ended" | "missing"

interface AbortResult {
  readonly sessionID: string
  readonly status: AbortStatus
  readonly interrupted: boolean
  readonly timedOut: boolean
  readonly threads: ReadonlyArray<string>
}

function abortNote(reason: string | undefined, detail: string, previous: string | undefined): string {
  const head = `aborted${reason === undefined ? "" : ` (${reason})`} [${detail}]`
  return previous === undefined ? head : `${head} | ${previous}`
}

/**
 * Drop the session from every thread affinity list it subscribed to, so later
 * messages on those threads no longer target a terminated worker. An empty
 * thread falls back to the router on the next message. The worker record keeps
 * its `threads` for tracing. The lists belong to the worker's own partition.
 */
const detachThreads = Effect.fn("superagent.detachThreads")(function* (ctx: Plugin.Context, sessionID: string) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return [] as Array<string>
  return yield* detachWorkerThreads(ctx, sessionID, worker.threads, dirKeyForWorker(worker))
})

/**
 * Terminate one tracked worker. The record is marked `aborted` before the
 * interrupt lands, so the watcher cannot resurrect it to `idle`/`done` when
 * the interruption settles; the record itself stays in KV for tracing.
 */
const abortWorker = Effect.fn("superagent.abortWorker")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  reason: string | undefined,
) {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return undefined
  const previous = worker.lastReport
  const info = yield* ctx.session.get({ sessionID: toSessionID(sessionID) }).pipe(Effect.option)
  const running = Option.isSome(info) && isRunning(info.value)
  worker.state = "aborted"
  yield* saveWorker(ctx, worker)
  // Terminating a worker aborts its ticket: the work did not finish, and a
  // failed ticket is what the Router needs to decide on a re-dispatch.
  yield* closeTicketsForWorker(ctx, {
    sessionID,
    outcome: "failed",
    summary: `aborted${reason === undefined ? "" : `: ${reason}`}`,
    note: "aborted",
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("superagent failed to abort ticket for worker", { sessionID, cause })),
  )
  const threads = yield* detachThreads(ctx, sessionID)
  if (Option.isNone(info)) {
    worker.lastReport = abortNote(reason, "session missing", previous)
    yield* saveWorker(ctx, worker)
    return { sessionID, status: "missing" as const, interrupted: false, timedOut: false, threads }
  }
  // Interrupt unconditionally: when the session is not executing this is a
  // harmless no-op, but it still clears a prompt queued behind the previous
  // execution so it cannot start after abort returned.
  const interrupted = yield* ctx.session.interrupt({ sessionID: toSessionID(sessionID) }).pipe(
    Effect.map((result) => result.interrupted),
    Effect.catch((cause) =>
      Effect.logWarning("superagent abort interrupt failed", { sessionID, cause }).pipe(Effect.as(false)),
    ),
  )
  if (!running) {
    worker.lastReport = abortNote(
      reason,
      interrupted ? "interrupted queued prompt" : "already ended",
      previous,
    )
    yield* saveWorker(ctx, worker)
    return { sessionID, status: "already-ended" as const, interrupted, timedOut: false, threads }
  }
  const settled = yield* ctx.session.wait({ sessionID: toSessionID(sessionID) }).pipe(
    Effect.timeoutOption(ABORT_TIMEOUT_MS),
    Effect.catch((cause) =>
      Effect.logWarning("superagent abort wait failed", { sessionID, cause }).pipe(Effect.as(Option.some(undefined))),
    ),
  )
  const timedOut = Option.isNone(settled)
  const detail = timedOut ? "interrupted, settle timeout" : interrupted ? "interrupted" : "no active execution"
  worker.lastReport = abortNote(reason, detail, previous)
  yield* saveWorker(ctx, worker)
  return { sessionID, status: "aborted" as const, interrupted, timedOut, threads }
})

function render(results: ReadonlyArray<AbortResult>) {
  if (results.length === 0) {
    const text = "no tracked worker matched; nothing to abort"
    return { output: { text }, content: text }
  }
  const counts: Record<AbortStatus, number> = { aborted: 0, "already-ended": 0, missing: 0 }
  const lines: Array<string> = []
  for (const result of results) {
    counts[result.status] += 1
    const title = store.workers.get(result.sessionID)?.title ?? "-"
    const detail =
      result.status === "aborted"
        ? `interrupted=${result.interrupted}${result.timedOut ? " settle-timeout" : ""}`
        : result.status
    const threads = result.threads.length === 0 ? "" : ` detached=${result.threads.join(",")}`
    lines.push(`- ${result.sessionID} ${title}: ${detail}${threads}`)
  }
  const summary = `aborted ${counts.aborted}, already ended ${counts["already-ended"]}, session missing ${counts.missing} (${results.length} worker(s))`
  const text = [summary, ...lines].join("\n")
  return { output: { text }, content: text }
}

/**
 * Terminate tracked workers. `caller` is set by the router tool (which then
 * enforces router-only access); the TUI RPC passes nothing because the user
 * drives it directly. Only sessions the plugin created can be touched: the
 * router, user sessions and unknown ids are always refused.
 */
export const runAbort = Effect.fn("superagent.abort")(function* (
  ctx: Plugin.Context,
  input: AbortInput,
  caller?: string,
) {
  // A router can only touch the workers it dispatched (its own partition); the
  // TUI passes no caller and keeps its process-wide reach. Flag off -> every
  // worker is in the default partition, so this is the historical behaviour.
  const callerDirKey = caller === undefined ? undefined : yield* requireRouter(caller, "abort_session")
  const inCallerPartition = (sessionID: string | undefined): boolean =>
    callerDirKey === undefined || dirKeyForWorker(store.workers.get(sessionID ?? "")) === callerDirKey
  const batch = input.all === true || input.stale === true
  if (batch && input.sessionID !== undefined) {
    return yield* new Tool.Error({ message: "pass either sessionID or all/stale, not both" })
  }
  if (!batch && input.sessionID === undefined) {
    return yield* new Tool.Error({
      message: "abort_session needs a sessionID, or all: true / stale: true for batch cleanup",
    })
  }
  if (input.sessionID !== undefined) {
    if (input.sessionID === caller) {
      return yield* new Tool.Error({ message: "cannot abort the calling session" })
    }
    if (isRouterSession(input.sessionID)) {
      return yield* new Tool.Error({ message: "cannot abort the router session" })
    }
    if (!store.workers.has(input.sessionID)) {
      return yield* new Tool.Error({
        message: `${input.sessionID} is not tracked by the superagent router; refusing to abort a session the plugin does not own`,
      })
    }
    if (partitioningEnabled() && !inCallerPartition(input.sessionID)) {
      return yield* new Tool.Error({
        message: `${input.sessionID} belongs to another router's partition (${dirKeyForWorker(store.workers.get(input.sessionID))}); abort it from that router (or from the TUI)`,
      })
    }
    const result = yield* abortWorker(ctx, input.sessionID, input.reason)
    return render(result === undefined ? [] : [result])
  }
  // Batch mode never includes the router: it is not a worker record. `stale`
  // only cleans records with no live work; `all` also interrupts running ones.
  const targets = [...store.workers.values()]
    .filter((worker) => inCallerPartition(worker.sessionID))
    .filter((worker) => input.all === true || worker.state !== "running")
    .map((worker) => worker.sessionID)
  const results: Array<AbortResult> = []
  for (const sessionID of targets) {
    const result = yield* abortWorker(ctx, sessionID, input.reason)
    if (result !== undefined) results.push(result)
  }
  return render(results)
})

export const registerAbort = Effect.fn("superagent.registerAbort")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "abort_session",
      description: specFor("abort_session").description,
      input: AbortInput,
      output: AbortOutput,
      options: { permission: toolPermission(specFor("abort_session")) },
      execute: (input, context) => runAbort(ctx, input, context.sessionID),
    })
  })
})
