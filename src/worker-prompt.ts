import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect, Schema } from "effect"
import { requireRouter } from "./guard.js"
import { partitioningEnabled } from "./settings.js"
import { dirKeyForWorker, isRouterSession, store, toSessionID } from "./state.js"
import { isTerminalState } from "./ticket-state.js"
import { ticketForWorker } from "./ticket.js"
import { specFor, toolPermission } from "./tools.js"
import type { WorkerState } from "./worker-state.js"

/**
 * Router-only follow-up prompt for an existing worker session.
 *
 * This is deliberately not `dispatch`: it never creates a session. A `done`
 * worker can be resumed just like `running`/`idle` (the same resume path the
 * thread-affinity router uses), so its accumulated context is not thrown away
 * when a follow-up arrives. A closed ticket is no longer a hard refusal — the
 * reply carries a reminder to reopen it — but a worker with *no* ticket is
 * still refused: every follow-up must have a work order behind it.
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

/**
 * Worker states that may accept a follow-up. `done` is promptable on purpose:
 * prompting a finished session starts a new execution in it, which is exactly
 * how the thread-affinity router reuses a completed worker's context.
 * `failed`/`aborted` stay refused so a broken or user-cancelled session is not
 * silently revived (use a fresh dispatch instead).
 */
const PROMPTABLE_STATES: ReadonlyArray<WorkerState> = ["running", "idle", "done"]

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
  // A router only drives the workers it dispatched: a worker running in this
  // directory but owned by another partition belongs to that Router.
  if (partitioningEnabled() && dirKeyForWorker(worker) !== callerDirKey) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} belongs to another router's partition (${dirKeyForWorker(worker)}); prompt it from that router`,
    })
  }

  // A ticket is required (fail-closed), but a closed one no longer blocks the
  // prompt: continuing an existing worker is precisely how we avoid losing its
  // context. The reply reminds the Router to reopen the work order.
  const ticket = ticketForWorker(sessionID)
  if (ticket === undefined) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} has no ticket; refusing to prompt a worker without a work order — start a new worker instead`,
    })
  }
  const ticketClosed = isTerminalState(ticket.state)
  const closedNote = ticketClosed
    ? `; ticket ${ticket.id} is closed (${ticket.state}) — reopen it with ticket_update({ status: "in_progress" }) to keep a live work order`
    : ""
  if (!PROMPTABLE_STATES.includes(worker.state)) {
    return yield* new Tool.Error({
      message: `worker ${sessionID} is ${worker.state}; only running/idle/done workers can receive a follow-up prompt`,
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
      text: `failed to deliver ${mode} prompt to worker ${sessionID}: ${promptFailure}${closedNote}`,
    })
  }

  if (!interrupt) {
    return ok({
      delivered: true,
      sessionID,
      state: worker.state,
      ticketState: ticket.state,
      mode,
      text: `delivered ${mode} prompt to worker ${sessionID} (state=${worker.state}, ticket=${ticket.id} ${ticket.state})${closedNote}`,
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
      text: `steer prompt delivered to worker ${sessionID} but interrupt failed: ${interruptFailure}${closedNote}`,
    })
  }
  return ok({
    delivered: true,
    sessionID,
    state: worker.state,
    ticketState: ticket.state,
    mode,
    text: `delivered steer prompt to worker ${sessionID} and interrupted it (state=${worker.state}, ticket=${ticket.id} ${ticket.state})${closedNote}`,
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
