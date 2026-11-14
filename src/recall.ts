import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { threadDirs } from "./dirs.js"
import { requireRouter } from "./guard.js"
import { loadReport, REPORT_DEFAULT_LIMIT, REPORT_MAX_LIMIT, REPORT_TEXT_LIMIT, sliceReport } from "./report.js"
import {
  decodeTrigger,
  dirKeyForWorker,
  dirScopedKey,
  dirState,
  saveTrigger,
  store,
  toSessionID,
  TRIGGER_PREFIX,
  upsertDirectTrigger,
  type DirectTriggerInput,
  type TriggerRecord,
} from "./state.js"
import { specFor, toolPermission } from "./tools.js"

export const ThreadDetailInput = Schema.Struct({
  threadID: Schema.String,
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
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
  readonly offset?: number
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
const MAX_THREAD_TAKE = 200
/** KV fallback is bounded: one page read at a time, so a recall never fans out into per-id reads. */
const KV_SCAN_PAGE = 100
const KV_SCAN_MAX_ENTRIES = 2_000
/** At most this many older triggers are pulled from KV for one `thread_detail` call. */
const KV_BACKFILL_MAX = 20
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

export const runThreadDetail = Effect.fn("superagent.threadDetail")(function* (
  ctx: Plugin.Context,
  input: ThreadDetailInput,
  caller: string,
) {
  const dirKey = yield* requireRouter(caller, "thread_detail")
  const take = Math.min(
    MAX_THREAD_TAKE,
    input.limit === undefined ? DEFAULT_THREAD_LIMIT : Math.max(1, Math.floor(input.limit)),
  )
  const offset = input.offset === undefined ? 0 : Math.max(0, Math.floor(input.offset))
  // 只读本分区的 trigger 历史：另一个目录里同名 thread 的对话不该出现在这里。
  const memory = [...dirState(store, dirKey).triggers.values()]
    .filter((record) => record.threadID === input.threadID)
    .sort((left, right) => left.createdAt - right.createdAt)
  // Memory keeps only the newest 200 triggers. When the requested window
  // starts before that, scan the trigger prefix once (paged, bounded) and keep
  // the older records. This is a prefix scan, not one KV read per missing id,
  // so a stale thread cannot fan out into hundreds of round trips.
  let triggers = memory
  let kvFilled = 0
  let kvTruncated = false
  if (offset + take > memory.length) {
    const seen = new Set(memory.map((record) => record.id))
    const found: Array<TriggerRecord> = []
    let scanned = 0
    let after: string | undefined
    // Scan the whole bounded prefix first, then keep the newest missing
    // records: stopping at the first 20 matches would return key order, not
    // the most recent triggers of the thread.
    while (scanned < KV_SCAN_MAX_ENTRIES) {
      const page = yield* ctx.storage
        .scan({ prefix: dirScopedKey(TRIGGER_PREFIX, dirKey), after, limit: KV_SCAN_PAGE })
        .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
      if (page.entries.length === 0) break
      scanned += page.entries.length
      for (const entry of page.entries) {
        const record = decodeTrigger(entry.value)
        if (record === undefined || record.threadID !== input.threadID || seen.has(record.id)) continue
        seen.add(record.id)
        found.push(record)
      }
      after = page.next
      if (after === undefined) break
    }
    found.sort((left, right) => right.createdAt - left.createdAt)
    const older = found.slice(0, KV_BACKFILL_MAX)
    // Still more pages or more matching records than the cap: say so instead of
    // pretending the list is complete.
    if (after !== undefined || found.length > KV_BACKFILL_MAX) kvTruncated = true
    kvFilled = older.length
    if (older.length > 0) triggers = [...memory, ...older].sort((left, right) => left.createdAt - right.createdAt)
  }
  const total = triggers.length
  const end = Math.max(0, total - offset)
  const start = Math.max(0, end - take)
  const shown = triggers.slice(start, end)
  const workers = [...store.workers.values()]
    .filter((worker) => dirKeyForWorker(worker) === dirKey)
    .filter((worker) => worker.threadID === input.threadID || worker.threads.includes(input.threadID))
  const source = kvFilled > 0 ? `memory ${memory.length} + KV ${kvFilled}` : `memory ${memory.length}`
  const lines = [
    `thread ${input.threadID}: ${total} trigger(s) (${source}), ${workers.length} worker(s)`,
    `directory: ${threadDirs.get(input.threadID) ?? "(no binding, use gateway default and confirm with user)"}`,
    `triggers (offset=${offset}, showing ${shown.length} of ${total}):`,
  ]
  for (const record of shown) {
    const at = new Date(record.createdAt).toISOString()
    lines.push(
      `- [${at}] ${record.author ?? "unknown"} (${record.route ?? "queued"}): ${truncate(record.text, THREAD_ITEM_LIMIT)}`,
    )
  }
  if (shown.length === 0) lines.push("(no trigger in this range)")
  if (offset >= total) {
    lines.push(`offset ${offset} 超出已知 ${total} 条；thread_detail 每次最多从 KV 回源 ${KV_BACKFILL_MAX} 条。`)
  }
  if (kvTruncated) {
    lines.push(
      `KV 回源已截断：本次扫描 ${KV_SCAN_MAX_ENTRIES} 条、最多补 ${KV_BACKFILL_MAX} 条，仍有更早的 trigger 未列出。`,
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
      options: { permission: toolPermission(specFor("thread_detail")) },
      execute: (input, context) => runThreadDetail(ctx, input, context.sessionID),
    })
    editor.add({
      name: "worker_detail",
      description: specFor("worker_detail").description,
      input: WorkerDetailInput,
      output: DetailOutput,
      options: { permission: toolPermission(specFor("worker_detail")) },
      execute: (input, context) => runWorkerDetail(ctx, input, context.sessionID),
    })
    editor.add({
      name: "report_read",
      description: specFor("report_read").description,
      input: ReportReadInput,
      output: DetailOutput,
      options: { permission: toolPermission(specFor("report_read")) },
      execute: (input, context) => runReportRead(ctx, input, context.sessionID),
    })
  })
  yield* ctx.session.hook("prompt", (event) =>
    Effect.gen(function* () {
      const worker = store.workers.get(event.sessionID)
      if (worker === undefined) return
      const parsed = parseTriggerHeader(event.prompt.text)
      if (parsed === undefined) return
      // 直投 worker 的 trigger 进派发它的那个分区（`ownerDirKey`），不是它跑的目录。
      const dirKey = dirKeyForWorker(worker)
      const record = upsertDirectTrigger(parsed, event.sessionID, dirKey)
      yield* saveTrigger(ctx, record, dirKey)
    }).pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to record direct trigger", { cause }))),
  )
})
