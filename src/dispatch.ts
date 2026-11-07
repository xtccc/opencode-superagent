import { Agent, type Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { encodeThread, saveWorker, store, threadKey, toSessionID } from "./state.js"

const WORKER_AGENT = "superagent-worker"

const DispatchInput = Schema.Struct({
  task: Schema.String,
  title: Schema.optionalKey(Schema.String),
  threadID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
})

const StatusOutput = Schema.Struct({ text: Schema.String })
const DispatchOutput = Schema.Struct({ sessionID: Schema.String })

interface DispatchInput {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
  readonly agent?: string
}

function defaultTitle(task: string): string {
  const line = task.split("\n")[0] ?? ""
  const clean = line.trim().slice(0, 60)
  if (clean === "") return "Worker task"
  return clean
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
    lines.push(`- ${id} ${title} [${threads}] ${worker.state} ${report}`.slice(0, 200))
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
  const resolved = yield* agents.get({ agentID: Agent.ID.make(requested) }).pipe(
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
  const threads = input.threadID === undefined ? [] : [input.threadID]
  const created = yield* sessions
    .create({
      title: input.title ?? defaultTitle(input.task),
      ...(resolved === undefined ? {} : { agent: resolved }),
      ...(input.agent === undefined && routerModel !== undefined ? { model: routerModel } : {}),
      ...(routerDirectory === undefined ? {} : { location: { directory: routerDirectory } }),
      metadata: { superagent: { role: "worker", threads } },
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to create worker session: ${String(cause)}` })))
  const record = {
    sessionID: created.id,
    title: created.title ?? input.title,
    threads,
    state: "running" as const,
    createdAt: Date.now(),
  }
  store.workers.set(created.id, record)
  yield* saveWorker(ctx, record)
  if (input.threadID !== undefined) {
    const threadID = input.threadID
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
      text: workerPrompt(input.threadID, input.title, input.task),
      delivery: "queue",
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to prompt worker session: ${String(cause)}` })))
  return {
    output: { sessionID: created.id },
    content: `Worker ${created.id} started in the background and will report back. Do not poll; wait for its report.`,
  }
})

export const registerTools = Effect.fn("superagent.registerTools")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "dispatch",
      description: "Dispatch one independent task to a background worker session. Only the router may call it.",
      input: DispatchInput,
      output: DispatchOutput,
      execute: (input, context) => runDispatch(ctx, input, context.sessionID),
    })
    editor.add({
      name: "status",
      description: "Show a compact summary of the router, pending triggers and worker sessions.",
      input: Schema.Struct({}),
      output: StatusOutput,
      execute: () => {
        const text = statusText()
        return Effect.succeed({ output: { text }, content: text })
      },
    })
  })
})
