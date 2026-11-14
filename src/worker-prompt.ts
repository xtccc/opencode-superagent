import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect, Schema } from "effect"
import { requireRouter } from "./guard.js"
import { perDirectoryRouterEnabled } from "./settings.js"
import { dirKeyForWorker, isRouterSession, store, toSessionID } from "./state.js"
import { isTerminalState } from "./ticket-state.js"
import { ticketForWorker } from "./ticket.js"
import { specFor, toolPermission } from "./tools.js"
import type { WorkerState } from "./worker-state.js"

/**
 * Router-only follow-up prompt for an already running/idle worker.
 *
 * This is deliberately not `dispatch`: it never creates a session and never
 * resumes one whose work order is closed. A worker exists to finish one
 * ticket; once that ticket is done/failed/cancelled (or any other terminal
 * state) waking the session would produce work with no work order behind it.
 * The guard is fail-closed: a tracked worker with no ticket is refused too.
 */

export const WorkerPromptInput = Schema.Struct({
  sessionID: Schema.String,
  text: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["queue", "steer"])),
  interrupt: Schema.optionalKey(Schema.Boolean),
})

export const WorkerPromptOutput = Schema.Struct({
  delivered: Schema.Boolean,
  sessionID: Schema.String,
  state: Schema.String,
  ticketState: Schema.NullOr(Schema.String),
  mode: Schema.String,
  text: Schema.String,
})

interface WorkerPromptInput {
  readonly sessionID: string
  readonly text: string
  readonly delivery?: "queue" | "steer"
  readonly interrupt?: boolean
}

export type WorkerPromptMode = "queue" | "steer" | "interrupt+steer"

/** Worker states that may accept a follow-up; terminal records are history. */
const PROMPTABLE_STATES: ReadonlyArray<WorkerState> = ["running", "idle"]

/** Message source marker so the worker side (and recall) can tell router follow-ups apart. */
export const FOLLOW_UP_PREFIX = "[router:follow-up]"

interface WorkerPromptResult {
  readonly delivered: boolean
  readonly sessionID: string
  readonly state: string
  readonly ticketState: string | null
  readonly mode: WorkerPromptMode
  readonly text: string
}

function ok(input: WorkerPromptResult) {
  return { output: input, content: input.text }
}

/**
 * Shared implementation for the `worker_prompt` tool. `caller` is the host
 * session id supplied by the tool runtime; direct callers must pass it too so
 * the router-only guard cannot be skipped.
 */
export const runWorkerPrompt = Effect.fn("superagent.workerPrompt")(function* (
  ctx: Plugin.Context,
  input: WorkerPromptInput,
  caller: string,
) {
  const callerDirKey = yield* requireRouter(caller, "worker_prompt")

  const sessionID = input.sessionID
  const text = input.text.trim()
  if (text === "") {
    return yield* new Tool.Error({ message: "worker_prompt needs a non-empty text" })
  }
  const delivery: SessionInbox.Delivery = input.delivery ?? "queue"
  if (delivery !== "queue" && delivery !== "steer") {
    return yield* new Tool.Error({ message: `worker_prompt delivery must be "queue" or "steer" (got ${String(input.delivery)})` })
  }

  // The router itself is not a worker and must never be prompted through this
  // tool, even though `requireRouter` already proved the caller's identity.
  // Any partition's router is refused, not just the caller's own.
  if (sessionID === caller || isRouterSession(sessionID)) {
    return yield* new Tool.Error({
      message: "cannot prompt the router session; worker_prompt only targets tracked worker sessions",
    })
  }
  const worker = store.workers.get(sessionID)
  if (worker === undefined) {
    return yield* new Tool.Error({
      message: `${sessionID} is not tracked by the superagent router; refusing to prompt a session the plugin does not own`,
    })
  }
  // A router only drives workers of its own directory: prompting another
  // directory's worker would inject instructions from the wrong context.
  if (perDirectoryRouterEnabled() && dirKeyForWorker(worker) !== callerDirKey) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} belongs to another directory's router; prompt it from that router`,
    })
  }

  // Closed tickets win over every other rule: the explicit requirement is that
  // a worker whose work order ended is never woken, regardless of the record's
  // own state or the requested delivery mode. No prompt and no interrupt run.
  const ticket = ticketForWorker(sessionID)
  if (ticket === undefined) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} has no ticket; refusing to prompt a worker without a work order — start a new worker instead`,
    })
  }
  if (isTerminalState(ticket.state)) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} ticket ${ticket.id} is closed (${ticket.state}); start a new worker instead`,
    })
  }
  if (!PROMPTABLE_STATES.includes(worker.state)) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} is ${worker.state}; only running/idle workers can receive a follow-up prompt`,
    })
  }

  const interrupt = input.interrupt === true
  // `interrupt` always steers first: the text must be in the inbox before the
  // interrupt lands, otherwise resuming the session could start an execution
  // with nothing new to read.
  const mode: WorkerPromptMode = interrupt ? "interrupt+steer" : delivery
  const message = `${FOLLOW_UP_PREFIX} ${text}`
  const target = toSessionID(sessionID)
  const promptFailure = yield* ctx.session
    .prompt({ sessionID: target, text: message, delivery: interrupt ? "steer" : delivery })
    .pipe(
      Effect.as(undefined),
      Effect.catch((cause) => Effect.succeed(String(cause))),
    )
  if (promptFailure !== undefined) {
    return ok({
      delivered: false,
      sessionID,
      state: worker.state,
      ticketState: ticket.state,
      mode,
      text: `failed to deliver ${mode} prompt to worker ${sessionID}: ${promptFailure}`,
    })
  }

  if (!interrupt) {
    return ok({
      delivered: true,
      sessionID,
      state: worker.state,
      ticketState: ticket.state,
      mode,
      text: `delivered ${mode} prompt to worker ${sessionID} (state=${worker.state}, ticket=${ticket.id} ${ticket.state})`,
    })
  }

  const interruptFailure = yield* ctx.session.interrupt({ sessionID: target, resume: true }).pipe(
    Effect.map((result) => (result.interrupted ? undefined : "interrupt returned interrupted=false")),
    Effect.catch((cause) => Effect.succeed(String(cause))),
  )
  if (interruptFailure !== undefined) {
    return ok({
      delivered: true,
      sessionID,
      state: worker.state,
      ticketState: ticket.state,
      mode,
      text: `steer prompt delivered to worker ${sessionID} but interrupt failed: ${interruptFailure}`,
    })
  }
  return ok({
    delivered: true,
    sessionID,
    state: worker.state,
    ticketState: ticket.state,
    mode,
    text: `delivered steer prompt to worker ${sessionID} and interrupted it (state=${worker.state}, ticket=${ticket.id} ${ticket.state})`,
  })
})

export const registerWorkerPrompt = Effect.fn("superagent.registerWorkerPrompt")(function* (
  ctx: Plugin.Context,
) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "worker_prompt",
      description: specFor("worker_prompt").description,
      input: WorkerPromptInput,
      output: WorkerPromptOutput,
      options: { permission: toolPermission(specFor("worker_prompt")) },
      execute: (input, context) => runWorkerPrompt(ctx, input, context.sessionID),
    })
  })
})
