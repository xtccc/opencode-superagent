import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { threadDirs } from "./dirs.js"
import { requireRouter } from "./guard.js"
import { loadReport, REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT, REPORT_TEXT_LIMIT, sliceReport } from "./report.js"
import { saveTrigger, store, toSessionID, upsertDirectTrigger, type DirectTriggerInput } from "./state.js"
import { specFor } from "./tools.js"

export const ThreadDetailInput = Schema.Struct({
  threadID: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
})

export const WorkerDetailInput = Schema.Struct({
  sessionID: Schema.String,
  messages: Schema.optionalKey(Schema.Number),
})

export const ReportReadInput = Schema.Struct({
  sessionID: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
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

interface ReportReadInput {
  readonly sessionID: string
  readonly offset?: number
  readonly limit?: number
}

/** Single response budget: compact text, truncated with a note when over. */
const MAX_TEXT = 6000
const THREAD_ITEM_LIMIT = 300
/** Per-message text in `worker_detail`; overridable through plugin options. */
const MESSAGE_ITEM_LIMIT = 1500
const MESSAGE_ITEM_MIN = 200
const MESSAGE_ITEM_MAX = 4000
const DEFAULT_THREAD_LIMIT = 20
const DEFAULT_MESSAGE_COUNT = 5
const MAX_MESSAGE_COUNT = 10

function truncate(text: string, limit: number, hint?: string): string {
  if (text.length <= limit) return text
  const suffix = `(${text.length - limit} chars truncated)${hint === undefined ? "" : ` ${hint}`}`
  return `${text.slice(0, limit)}...${suffix}`
}

/** Plugin option `worker_detail_message_limit`, clamped so one message cannot eat the whole budget. */
function messageItemLimit(ctx: Plugin.Context): number {
  const raw = ctx.options["worker_detail_message_limit"]
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value)) return MESSAGE_ITEM_LIMIT
  return Math.min(MESSAGE_ITEM_MAX, Math.max(MESSAGE_ITEM_MIN, Math.floor(value)))
}

function fitBudget(text: string): string {
  if (text.length <= MAX_TEXT) return text
  return `${text.slice(0, MAX_TEXT)}\n...(truncated to ${MAX_TEXT} chars)`
}

function workerLine(sessionID: string): string {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) return `- ${sessionID} untracked`
  const threads = worker.threads.length === 0 ? "-" : worker.threads.join(",")
  const dir = worker.directory ?? "-"
  return `- ${worker.sessionID} ${worker.title ?? "-"} [${threads}] ${worker.state} dir=${dir} ${worker.lastReport ?? "-"}`
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
    `directory: ${threadDirs.get(input.threadID) ?? "(no binding, use gateway default and confirm with user)"}`,
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

export const runWorkerDetail = Effect.fn("superagent.workerDetail")(function* (
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
  const stored = yield* loadReport(ctx, input.sessionID)
  const messages = yield* ctx.session
    .context({ sessionID: toSessionID(input.sessionID) })
    .pipe(Effect.catch(() => Effect.succeed([])))
  const texts = assistantTexts(messages, count)
  const handle =
    stored === undefined
      ? "none (无全文记录：Worker 还没结束过，或没有 assistant 文本)"
      : `${stored.length} chars${stored.truncated ? ` (仅存前 ${stored.text.length})` : ""}，用 report_read 读取全文`
  const lines =
    worker === undefined
      ? [`worker ${input.sessionID}: not tracked by the router`]
      : [
          `worker ${worker.sessionID} ${worker.title ?? "-"} [${worker.threads.join(",") || "-"}] ${worker.state}`,
          `directory: ${worker.directory ?? "(gateway default)"}`,
          `report: ${worker.lastReport ?? "none"}`,
          `report full: ${handle}`,
        ]
  const perMessage = messageItemLimit(ctx)
  const hint = `用 report_read(sessionID: "${input.sessionID}") 读取全文`
  lines.push(`recent assistant messages (last ${texts.length} of up to ${count}):`)
  texts.forEach((text, index) => {
    lines.push(`${index + 1}. ${truncate(text, perMessage, hint)}`)
  })
  if (texts.length === 0) lines.push("(no assistant text found)")
  const text = fitBudget(lines.join("\n"))
  return {
    output: { text },
    content: text,
  }
})

/** Page through the full report kept at `report:<sessionID>`. */
export const runReportRead = Effect.fn("superagent.reportRead")(function* (
  ctx: Plugin.Context,
  input: ReportReadInput,
  caller: string,
) {
  yield* requireRouter(caller, "report_read")
  const record = yield* loadReport(ctx, input.sessionID)
  if (record === undefined) {
    return yield* new Tool.Error({
      message: `no stored report for ${input.sessionID}: 该 Worker 没有全文报告（可能还没结束过，或没有 assistant 文本）；先用 worker_detail 看摘要`,
    })
  }
  const rawOffset = input.offset ?? 0
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  if (offset >= record.text.length) {
    return yield* new Tool.Error({
      message: `offset ${offset} 超出已存全文长度 ${record.text.length}${record.truncated ? `（原文 ${record.length} 字，已截断存储）` : ""}`,
    })
  }
  const rawLimit = input.limit ?? REPORT_DEFAULT_LIMIT
  const limit = Number.isFinite(rawLimit)
    ? Math.min(REPORT_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : REPORT_DEFAULT_LIMIT
  const slice = sliceReport(record, offset, limit)
  const lines = [
    `report ${record.sessionID}: 全文 ${record.length} 字，已存 ${record.text.length} 字${
      record.truncated ? `（超出 ${REPORT_TEXT_LIMIT} 字上限，已截断保存）` : ""
    }`,
    `captured ${new Date(record.capturedAt).toISOString()} · 本次 [${slice.offset}, ${slice.end}) · limit=${limit}`,
    "",
    slice.text,
  ]
  if (slice.hasMore) {
    lines.push("", `还有后续：report_read(sessionID: "${record.sessionID}", offset: ${slice.nextOffset})`)
  } else {
    lines.push("", "已到末尾。")
  }
  const text = lines.join("\n")
  return { output: { text }, content: text }
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
      description: specFor("thread_detail").description,
      input: ThreadDetailInput,
      output: DetailOutput,
      options: { permission: "status" },
      execute: (input, context) => runThreadDetail(input, context.sessionID),
    })
    editor.add({
      name: "worker_detail",
      description: specFor("worker_detail").description,
      input: WorkerDetailInput,
      output: DetailOutput,
      options: { permission: "status" },
      execute: (input, context) => runWorkerDetail(ctx, input, context.sessionID),
    })
    editor.add({
      name: "report_read",
      description: specFor("report_read").description,
      input: ReportReadInput,
      output: DetailOutput,
      options: { permission: "status" },
      execute: (input, context) => runReportRead(ctx, input, context.sessionID),
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
