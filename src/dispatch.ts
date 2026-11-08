import { Agent, type Plugin } from "@opencode/plugin/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { normalizeDirectory, rememberDirectory, resolveDirectory } from "./dirs.js"
import { superagentMetadata, workerTitle } from "./session-meta.js"
import { encodeThread, saveWorker, store, threadKey, toSessionID } from "./state.js"
import { activeTicketSummary, getTicket, isActive, linkTicketToWorker, ticketStats, type Ticket } from "./ticket.js"
import { specFor } from "./tools.js"

const WORKER_AGENT = "superagent-worker"

export const DispatchInput = Schema.Struct({
  task: Schema.String,
  title: Schema.optionalKey(Schema.String),
  threadID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
  ticketID: Schema.optionalKey(Schema.String),
})

const StatusOutput = Schema.Struct({ text: Schema.String })
const DispatchOutput = Schema.Struct({ sessionID: Schema.String })

interface DispatchInput {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
  readonly agent?: string
  readonly directory?: string
  readonly ticketID?: string
}

/** The ticket header a worker sees first: objective and acceptance, verbatim. */
function ticketHeader(ticket: Ticket): string {
  const acceptance = ticket.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n")
  return `工单 ${ticket.id}: ${ticket.objective}\n验收:\n${acceptance}\n`
}

function workerPrompt(threadID: string | undefined, title: string | undefined, task: string, ticket?: Ticket): string {
  const header = threadID === undefined ? "" : `Thread: ${threadID}\n`
  const subject = title === undefined ? "" : `Title: ${title}\n`
  const ticketLine = ticket === undefined ? "" : ticketHeader(ticket)
  return `${ticketLine}${header}${subject}Task:\n${task}\n\nEnd with a short report: what changed, how it was verified, remaining risks.`
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

const runDispatch = Effect.fn("superagent.dispatch")(function* (
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
  // A dispatch may carry a ticket: it must exist and still be workable, and
  // the ticket directory is the fallback when the call omits one.
  const ticket = input.ticketID === undefined ? undefined : getTicket(input.ticketID)
  if (input.ticketID !== undefined) {
    if (ticket === undefined) {
      return yield* new Tool.Error({ message: `unknown ticket ${input.ticketID}; create it with ticket_create first` })
    }
    if (!isActive(ticket)) {
      return yield* new Tool.Error({
        message: `ticket ${ticket.id} is ${ticket.state}; only open/in_progress tickets can be dispatched`,
      })
    }
  }
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
  const ticketDir = ticket?.directory === undefined ? undefined : normalizeDirectory(ticket.directory)
  const rememberedDir = resolveDirectory({
    threadID: input.threadID,
    task: input.task,
    requested: requestedDir ?? ticketDir,
  })
  const targetDirectory = rememberedDir ?? routerDirectory
  // A ticket carries its own thread; dispatch inherits it when the call omits one.
  const threadID = input.threadID ?? ticket?.threadID
  const threads = threadID === undefined ? [] : [threadID]
  const created = yield* sessions
    .create({
      // The prefix keeps workers recognizable in session lists; metadata, not
      // this title, is what identifies the session after a user rename.
      title: workerTitle({
        task: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(threadID === undefined ? {} : { threadID }),
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
    threads,
    state: "running" as const,
    createdAt: Date.now(),
    ...(targetDirectory === undefined ? {} : { directory: targetDirectory }),
  }
  store.workers.set(created.id, record)
  yield* saveWorker(ctx, record)
  if (targetDirectory !== undefined) {
    yield* rememberDirectory(ctx, { threadID, directory: targetDirectory }).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent failed to remember directory", { cause })),
    )
  }
  // Record the worker on its ticket (open → in_progress) before the prompt
  // lands, so the watcher can close it even if the worker fails immediately.
  if (ticket !== undefined) {
    yield* linkTicketToWorker(ctx, {
      ticketID: ticket.id,
      sessionID: created.id,
      ...(targetDirectory === undefined ? {} : { note: targetDirectory }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to link ticket to worker", { ticketID: ticket.id, cause }),
      ),
    )
  }
  if (threadID !== undefined) {
    const existing = store.threads.get(threadID) ?? []
    if (!existing.includes(created.id)) existing.push(created.id)
    // Affinity lists persist after workers end; cap them so long-lived
    // threads don't grow unbounded in memory and KV.
    if (existing.length > 20) existing.splice(0, existing.length - 20)
    store.threads.set(threadID, existing)
    yield* ctx.storage
      .set(threadKey(threadID), encodeThread({ threadID, workers: [...existing], updatedAt: Date.now() }))
      .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
  }
  yield* sessions
    .prompt({
      sessionID: created.id,
      text: workerPrompt(threadID, input.title, input.task, ticket),
      delivery: "queue",
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to prompt worker session: ${String(cause)}` })))
  const where = targetDirectory === undefined ? "gateway default directory" : targetDirectory
  const ticketNote = ticket === undefined ? "" : ` Ticket ${ticket.id} is now in_progress.`
  return {
    output: { sessionID: created.id },
    content: `Worker ${created.id} started in ${where} in the background and will report back. Do not poll; wait for its report.${ticketNote}`,
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
