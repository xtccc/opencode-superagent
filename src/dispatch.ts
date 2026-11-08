import { Agent, type Plugin } from "@opencode/plugin/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { WORKER_AGENT } from "./agents.js"
import { normalizeDirectory, rememberDirectory, resolveDirectory } from "./dirs.js"
import { superagentMetadata, workerTitle } from "./session-meta.js"
import { encodeThread, linkTriggerToWorker, saveWorker, store, threadKey, toSessionID, workerKey } from "./state.js"
import {
  activeTicketForWorker,
  activeTicketSummary,
  closeTicket,
  currentTrigger,
  linkTicketToWorker,
  requireDispatchTicket,
  ticketStats,
  type Ticket,
} from "./ticket.js"
import { specFor } from "./tools.js"

export const DispatchInput = Schema.Struct({
  task: Schema.String,
  title: Schema.optionalKey(Schema.String),
  threadID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
  ticketID: Schema.String,
})

const StatusOutput = Schema.Struct({ text: Schema.String })
const DispatchOutput = Schema.Struct({ sessionID: Schema.String })

interface DispatchInput {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
  readonly agent?: string
  readonly directory?: string
  readonly ticketID: string
}

/** The ticket header a worker sees first: objective and acceptance, verbatim. */
function ticketHeader(ticket: Ticket): string {
  const acceptance = ticket.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n")
  return `工单 ${ticket.id}: ${ticket.objective}\n验收:\n${acceptance}\n`
}

function workerPrompt(threadID: string, title: string | undefined, task: string, ticket: Ticket): string {
  const subject = title === undefined ? "" : `Title: ${title}\n`
  return `${ticketHeader(ticket)}Thread: ${threadID}\n${subject}Task:\n${task}\n\nEnd with a short report: what changed, how it was verified, remaining risks.`
}

function statusText(): string {
  const stats = ticketStats()
  const active = activeTicketSummary(undefined, 5)
  const lines = [
    `router: ${store.routerID ?? "none"} pending: ${store.pending.length} workers: ${store.workers.size} tickets: open=${stats.open} in_progress=${stats.inProgress} blocked=${stats.blocked} closed=${stats.closed}`,
  ]
  if (active !== "") lines.push(`active tickets: ${active}`)
  for (const worker of store.workers.values()) {
    const id = worker.sessionID
    const title = worker.title ?? "-"
    const threads = worker.threads.length === 0 ? "-" : worker.threads.join(",")
    const report = worker.lastReport ?? "-"
    const dir = worker.directory ?? "-"
    lines.push(`- ${id} ${title} [${threads}] ${worker.state} dir=${dir} ${report}`.slice(0, 220))
  }
  return lines.join("\n")
}

/**
 * Undo a half-created dispatch: fail the ticket bound to the worker, detach
 * the worker from its thread affinity lists, forget the worker record and stop
 * its session. Every step is best-effort after the first failure, so one
 * storage problem cannot leave the whole dispatch half-rolled-back.
 */
const rollbackDispatch = Effect.fn("superagent.rollbackDispatch")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  reason: string,
) {
  // Fail the ticket while the worker → ticket edge still exists, so the
  // Router sees why the dispatch never started instead of a stuck in_progress.
  const ticket = activeTicketForWorker(sessionID)
  if (ticket !== undefined) {
    yield* closeTicket(ctx, {
      ticketID: ticket.id,
      outcome: "failed",
      summary: `dispatch rollback: ${reason}`,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to fail ticket for rolled-back worker", {
          sessionID,
          ticketID: ticket.id,
          cause,
        }),
      ),
    )
  }
  // Thread affinity is written before the prompt; drop the worker from every
  // list it was added to so the thread falls back to the Router.
  const worker = store.workers.get(sessionID)
  if (worker !== undefined) {
    for (const threadID of worker.threads) {
      const current = store.threads.get(threadID)
      if (current === undefined || !current.includes(sessionID)) continue
      const next = current.filter((id) => id !== sessionID)
      if (next.length === 0) {
        store.threads.delete(threadID)
        yield* ctx.storage.remove(threadKey(threadID)).pipe(Effect.catch(() => Effect.void))
      } else {
        store.threads.set(threadID, next)
        yield* ctx.storage
          .set(threadKey(threadID), encodeThread({ threadID, workers: next, updatedAt: Date.now() }))
          .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
      }
    }
  }
  store.workers.delete(sessionID)
  yield* ctx.storage
    .remove(workerKey(sessionID))
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to remove rolled-back worker", { sessionID, cause }),
      ),
    )
  yield* ctx.session
    .interrupt({ sessionID: toSessionID(sessionID) })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to interrupt rolled-back worker", { sessionID, cause }),
      ),
    )
})

/**
 * The one dispatch implementation, shared by the `dispatch` tool and the
 * `dispatch` RPC. Both paths pass the same ticket gate: `ticketID` is required
 * by the schema and re-checked here, so a direct RPC call cannot skip the
 * work order either.
 *
 * There is deliberately no `internal` bypass: no watchdog/resume path calls
 * dispatch today (the watchdog reports to the Router and resume prompts an
 * existing worker session), so every caller of this function is a real task
 * dispatch and must be backed by a ticket.
 */
export const runDispatch = Effect.fn("superagent.dispatch")(function* (
  ctx: Plugin.Context,
  input: DispatchInput,
  caller: string,
) {
  if (store.routerID === undefined || caller !== store.routerID) {
    return yield* new Tool.Error({ message: "dispatch is only available to the router session" })
  }
  const routerID = store.routerID
  const agents = ctx.agent
  const sessions = ctx.session
  const requested = input.agent ?? WORKER_AGENT
  if (input.directory !== undefined && normalizeDirectory(input.directory) === undefined) {
    return yield* new Tool.Error({ message: "dispatch directory must be an absolute path, e.g. /opt/ai-gw" })
  }
  // Every dispatch is backed by a ticket: the gate refuses a missing ticket,
  // an unknown/closed one, a thread mismatch and a ticket whose worker is
  // still running, so no dispatch can bypass the work-order record.
  const ticket = yield* requireDispatchTicket(input.ticketID, input.threadID)
  // The ticket carries its thread; the dispatch must agree with it and
  // inherits it when the call omits one.
  const threadID = input.threadID ?? ticket.threadID
  const agentResolved = yield* agents.get({ agentID: Agent.ID.make(requested) }).pipe(
    Effect.map((result) => result.data.id),
    Effect.catch((cause) =>
      Effect.logWarning("superagent worker agent missing, creating session without it", {
        agent: requested,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  )
  // Mirror the router session's explicit model so the worker resolves the
  // same model. When the router has no explicit model (default resolution),
  // pass nothing so the worker follows the same default resolution.
  // An explicitly requested agent keeps its own model priority: no override.
  const routerInherit = yield* sessions.get({ sessionID: toSessionID(routerID) }).pipe(
    Effect.map((info) => ({ model: info.model, directory: info.location.directory })),
    Effect.catch((cause) =>
      Effect.logWarning("superagent router model unavailable, creating worker without it", {
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  )
  const routerModel = routerInherit?.model
  const routerDirectory = routerInherit?.directory
  // Single gateway, Router-managed directories: explicit directory wins,
  // otherwise the ticket's directory, then thread binding / alias match,
  // otherwise follow Router. The gateway process directory itself is irrelevant.
  const requestedDir = input.directory === undefined ? undefined : normalizeDirectory(input.directory)
  const ticketDir = ticket.directory === undefined ? undefined : normalizeDirectory(ticket.directory)
  const rememberedDir = resolveDirectory({
    threadID,
    task: input.task,
    requested: requestedDir ?? ticketDir,
  })
  const targetDirectory = rememberedDir ?? routerDirectory
  const threads = [threadID]
  const current = currentTrigger()
  const authorizing =
    current !== undefined && current.threadID === threadID ? current.id : ticket.authorization.triggerID
  const triggerID = authorizing === "" || authorizing === "unknown" ? undefined : authorizing
  const created = yield* sessions
    .create({
      // The prefix keeps workers recognizable in session lists; metadata, not
      // this title, is what identifies the session after a user rename.
      title: workerTitle({
        task: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        threadID,
      }),
      ...(agentResolved === undefined ? {} : { agent: agentResolved }),
      ...(input.agent === undefined && routerModel !== undefined ? { model: routerModel } : {}),
      ...(targetDirectory === undefined ? {} : { location: { directory: AbsolutePath.make(targetDirectory) } }),
      metadata: superagentMetadata("worker", threads),
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to create worker session: ${String(cause)}` })))
  const record = {
    sessionID: created.id,
    title: created.title ?? input.title,
    // Forward edges: worker → primary thread and worker → authorizing trigger.
    // The ticket's authorization is the trigger that created the work order;
    // a newer router trigger on the same thread wins because it is the one
    // that actually asked for this dispatch.
    threadID,
    ...(triggerID === undefined ? {} : { triggerID }),
    threads,
    state: "running" as const,
    createdAt: Date.now(),
    ...(targetDirectory === undefined ? {} : { directory: targetDirectory }),
  }
  store.workers.set(created.id, record)
  yield* saveWorker(ctx, record)
  // Complete the reverse edge (trigger → worker) so the dispatch can be traced
  // from the message that caused it. A missing trigger is not an error: the
  // ticket remains the durable record in that case.
  if (triggerID !== undefined) {
    yield* linkTriggerToWorker(ctx, triggerID, created.id).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent failed to link trigger to worker", { cause })),
    )
  }
  if (targetDirectory !== undefined) {
    yield* rememberDirectory(ctx, { threadID, directory: targetDirectory }).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent failed to remember directory", { cause })),
    )
  }
  // Record the worker on its ticket (open → in_progress) before the prompt
  // lands, so the watcher can close it even if the worker fails immediately.
  // The binding is part of the dispatch: if it fails, the half-created worker
  // is rolled back instead of running outside the ticket it was dispatched for.
  const linkFailure = yield* linkTicketToWorker(ctx, {
    ticketID: ticket.id,
    sessionID: created.id,
    ...(targetDirectory === undefined ? {} : { note: targetDirectory }),
  }).pipe(
    Effect.as(undefined),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed(error.message)),
  )
  if (linkFailure !== undefined) {
    yield* rollbackDispatch(ctx, created.id, `could not bind ticket ${ticket.id} to the new worker (${linkFailure})`)
    return yield* new Tool.Error({
      message: `dispatch aborted: could not bind ticket ${ticket.id} to the new worker (${linkFailure})`,
    })
  }
  const existing = store.threads.get(threadID) ?? []
  if (!existing.includes(created.id)) existing.push(created.id)
  // Affinity lists persist after workers end; cap them so long-lived
  // threads don't grow unbounded in memory and KV.
  if (existing.length > 20) existing.splice(0, existing.length - 20)
  store.threads.set(threadID, existing)
  yield* ctx.storage
    .set(threadKey(threadID), encodeThread({ threadID, workers: [...existing], updatedAt: Date.now() }))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
  // Prompt delivery is part of the dispatch: if the worker never receives its
  // task, the ticket, thread affinity and worker record must not stay behind.
  const promptFailure = yield* sessions
    .prompt({
      sessionID: created.id,
      text: workerPrompt(threadID, input.title, input.task, ticket),
      delivery: "queue",
    })
    .pipe(
      Effect.as(undefined),
      Effect.catch((cause) => Effect.succeed(String(cause))),
    )
  if (promptFailure !== undefined) {
    yield* rollbackDispatch(ctx, created.id, `failed to prompt worker session: ${promptFailure}`)
    return yield* new Tool.Error({
      message: `dispatch aborted: failed to prompt worker session: ${promptFailure}`,
    })
  }
  const where = targetDirectory === undefined ? "gateway default directory" : targetDirectory
  return {
    output: { sessionID: created.id },
    content: `Worker ${created.id} started in ${where} in the background and will report back. Do not poll; wait for its report. Ticket ${ticket.id} is now in_progress.`,
  }
})

export const registerTools = Effect.fn("superagent.registerTools")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "dispatch",
      description: specFor("dispatch").description,
      input: DispatchInput,
      output: DispatchOutput,
      execute: (input, context) => runDispatch(ctx, input, context.sessionID),
    })
    editor.add({
      name: "status",
      description: specFor("status").description,
      input: Schema.Struct({}),
      output: StatusOutput,
      execute: () => {
        const text = statusText()
        return Effect.succeed({ output: { text }, content: text })
      },
    })
  })
})
