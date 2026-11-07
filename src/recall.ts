import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { saveTrigger, store, toSessionID, upsertDirectTrigger, type DirectTriggerInput } from "./state.js"

const ThreadDetailInput = Schema.Struct({
  threadID: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
})

const WorkerDetailInput = Schema.Struct({
  sessionID: Schema.String,
  messages: Schema.optionalKey(Schema.Number),
})

const DetailOutput = Schema.Struct({ text: Schema.String })

interface ThreadDetailInput {
  readonly threadID: string
  readonly limit?: number
}

interface WorkerDetailInput {
  readonly sessionID: string
  readonly messages?: number
}

/** Single response budget: compact text, truncated with a note when over. */
const MAX_TEXT = 4000
const THREAD_ITEM_LIMIT = 300
const MESSAGE_ITEM_LIMIT = 500
const DEFAULT_THREAD_LIMIT = 20
const DEFAULT_MESSAGE_COUNT = 5
const MAX_MESSAGE_COUNT = 10

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...(${text.length - limit} chars truncated)`
}

function fitBudget(text: string): string {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n...(truncated to ${MAX_TEXT} chars)`
}

const requireRouter = Effect.fn("superagent.requireRouter")(function* (caller: string, tool: string) {
  if (store.routerID === undefined || caller !== store.routerID) {
    return yield* new Tool.Error({ message: `${tool} is only available to the router session` })
  }
})

function workerLine(sessionID: string): string {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return `- ${sessionID} untracked`
  const threads = worker.threads.length === 0 ? "-" : worker.threads.join(",")
  return `- ${worker.sessionID} ${worker.title ?? "-"} [${threads}] ${worker.state} ${worker.lastReport ?? "-"}`
}

const runThreadDetail = Effect.fn("superagent.threadDetail")(function* (input: ThreadDetailInput, caller: string) {
  yield* requireRouter(caller, "thread_detail")
  const take = input.limit === undefined ? DEFAULT_THREAD_LIMIT : Math.max(1, Math.floor(input.limit))
  const triggers = [...store.triggers.values()]
    .filter((record) => record.threadID === input.threadID)
    .sort((left, right) => left.createdAt - right.createdAt)
  const shown = triggers.slice(-take)
  const workers = [...store.workers.values()].filter((worker) => worker.threads.includes(input.threadID))
  const lines = [
    `thread ${input.threadID}: ${triggers.length} trigger(s), ${workers.length} worker(s)`,
    `triggers (showing ${shown.length} of ${triggers.length}):`,
  ]
  for (const record of shown) {
    const at = new Date(record.createdAt).toISOString()
    lines.push(
      `- [${at}] ${record.author ?? "unknown"} (${record.route ?? "queued"}): ${truncate(record.text, THREAD_ITEM_LIMIT)}`,
    )
  }
  lines.push(`workers (${workers.length}):`)
  for (const worker of workers) lines.push(workerLine(worker.sessionID).slice(0, THREAD_ITEM_LIMIT))
  const text = fitBudget(lines.join("\n"))
  return {
    output: { text },
    content: text,
  }
})

function assistantTexts(messages: ReadonlyArray<unknown>, count: number): Array<string> {
  const collected: Array<string> = []
  for (let index = messages.length - 1; index >= 0 && collected.length < count; index--) {
    const message = messages[index]
    if (typeof message !== "object" || message === null) continue
    const typed = message as { type?: unknown; content?: unknown }
    if (typed.type !== "assistant" || !Array.isArray(typed.content)) continue
    const text = typed.content
      .flatMap((part) => {
        if (typeof part !== "object" || part === null) return []
        const candidate = part as { type?: unknown; text?: unknown }
        return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : []
      })
      .join("\n")
      .trim()
    if (text !== "") collected.push(text)
  }
  return collected.reverse()
}

const runWorkerDetail = Effect.fn("superagent.workerDetail")(function* (
  ctx: Plugin.Context,
  input: WorkerDetailInput,
  caller: string,
) {
  yield* requireRouter(caller, "worker_detail")
  const count =
    input.messages === undefined
      ? DEFAULT_MESSAGE_COUNT
      : Math.min(MAX_MESSAGE_COUNT, Math.max(1, Math.floor(input.messages)))
  const worker = store.workers.get(input.sessionID)
  const messages = yield* ctx.session
    .context({ sessionID: toSessionID(input.sessionID) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const texts = assistantTexts(messages, count)
  const lines =
    worker === undefined
      ? [`worker ${input.sessionID}: not tracked by the router`]
      : [
          `worker ${worker.sessionID} ${worker.title ?? "-"} [${worker.threads.join(",") || "-"}] ${worker.state}`,
          `report: ${worker.lastReport ?? "none"}`,
        ]
  lines.push(`recent assistant messages (last ${texts.length} of up to ${count}):`)
  texts.forEach((text, index) => {
    lines.push(`${index + 1}. ${truncate(text, MESSAGE_ITEM_LIMIT)}`)
  })
  if (texts.length === 0) lines.push("(no assistant text found)")
  const text = fitBudget(lines.join("\n"))
  return {
    output: { text },
    content: text,
  }
})

const TRIGGER_HEADER = /^\[trigger:(.+?)\] source=(\S+) thread=(\S+) author=(\S+) at=(\S+)(?:\n([\s\S]*))?$/

/** Parse the worker-visible trigger format back into a record (see `formatTrigger`). */
function parseTriggerHeader(text: string): DirectTriggerInput | undefined {
  const match = TRIGGER_HEADER.exec(text)
  if (match === null) return undefined
  const id = match[1]
  const source = match[2]
  const threadID = match[3]
  const author = match[4]
  const at = match[5]
  if (id === undefined || source === undefined || threadID === undefined || author === undefined || at === undefined) {
    return undefined
  }
  const parsed = Date.parse(at)
  return {
    id,
    source,
    threadID,
    ...(author === "unknown" ? {} : { author }),
    text: match[6] ?? "",
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
  }
}

/**
 * Router-only recall tools plus capture of triggers delivered straight to
 * workers (they never pass the pending queue, so the prompt hook records
 * them from the admitted text). Both tools reuse the `status` permission
 * action, which the router session already allows.
 */
export const registerRecall = Effect.fn("superagent.registerRecall")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "thread_detail",
      description: "Show a thread's trigger history plus its subscribed workers. Only the router may call it.",
      input: ThreadDetailInput,
      output: DetailOutput,
      options: { permission: "status" },
      execute: (input, context) => runThreadDetail(input, context.sessionID),
    })
    editor.add({
      name: "worker_detail",
      description: "Show a worker's state plus its recent assistant messages. Only the router may call it.",
      input: WorkerDetailInput,
      output: DetailOutput,
      options: { permission: "status" },
      execute: (input, context) => runWorkerDetail(ctx, input, context.sessionID),
    })
  })
  yield* ctx.session.hook("prompt", (event) =>
    Effect.gen(function* () {
      if (!store.workers.has(event.sessionID)) return
      const parsed = parseTriggerHeader(event.prompt.text)
      if (parsed === undefined) return
      const record = upsertDirectTrigger(parsed, event.sessionID)
      yield* saveTrigger(ctx, record)
    }).pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to record direct trigger", { cause }))),
  )
})
