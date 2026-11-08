import { Agent, type Plugin } from "@opencode/plugin/effect"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { normalizeDirectory, rememberDirectory, resolveDirectory } from "./dirs.js"
import { superagentMetadata, workerTitle } from "./session-meta.js"
import { encodeThread, saveWorker, store, threadKey, toSessionID } from "./state.js"
import { specFor } from "./tools.js"

const WORKER_AGENT = "superagent-worker"

export const DispatchInput = Schema.Struct({
  task: Schema.String,
  title: Schema.optionalKey(Schema.String),
  threadID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  directory: Schema.optionalKey(Schema.String),
})

const StatusOutput = Schema.Struct({ text: Schema.String })
const DispatchOutput = Schema.Struct({ sessionID: Schema.String })

interface DispatchInput {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
  readonly agent?: string
  readonly directory?: string
}

function workerPrompt(threadID: string | undefined, title: string | undefined, task: string): string {
  const header = threadID === undefined ? "" : `Thread: ${threadID}\n`
  const subject = title === undefined ? "" : `Title: ${title}\n`
  return `${header}${subject}Task:\n${task}\n\nEnd with a short report: what changed, how it was verified, remaining risks.`
}

function statusText(): string {
  const lines = [`router: ${store.routerID ?? "none"} pending: ${store.pending.length} workers: ${store.workers.size}`]
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
  // otherwise thread binding / alias match, otherwise follow Router. The
  // gateway process directory itself is irrelevant.
  const requestedDir = input.directory === undefined ? undefined : normalizeDirectory(input.directory)
  const rememberedDir = resolveDirectory({
    threadID: input.threadID,
    task: input.task,
    requested: requestedDir,
  })
  const targetDirectory = rememberedDir ?? routerDirectory
  const threadID = input.threadID
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
      text: workerPrompt(threadID, input.title, input.task),
      delivery: "queue",
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to prompt worker session: ${String(cause)}` })))
  const where = targetDirectory === undefined ? "gateway default directory" : targetDirectory
  return {
    output: { sessionID: created.id },
    content: `Worker ${created.id} started in ${where} in the background and will report back. Do not poll; wait for its report.`,
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
