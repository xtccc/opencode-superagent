import type { Plugin } from "@opencode/plugin/effect"
import type { Model } from "@opencode/schema/model"
import { AbsolutePath } from "@opencode/schema/schema"
import { Duration, Effect } from "effect"
import { ensureRouter } from "./router.js"
import { store, toSessionID, type TriggerInput } from "./state.js"

/** Trigger source value for all Telegram ingress. Add it to the `sources` allowlist to enable. */
export const TELEGRAM_SOURCE = "telegram"

/** KV key for the Bot API update offset, so a restart resumes without replaying handled updates. */
export const TELEGRAM_OFFSET_KEY = "telegram:offset"

const API_BASE = "https://api.telegram.org"
/** Long-poll window per getUpdates call: one hanging request instead of busy-polling. */
const GET_UPDATES_TIMEOUT_S = 25
const DEFAULT_POLL_IDLE_MS = 2000
/** Telegram message cap is 4096 chars; stay safely below it. */
const SEND_LIMIT = 4000

const START_HELP =
  "我是 Superagent Router。直接发文字即派发任务，Router 会分给 Worker 执行；结论完成后发回这里。\n\n按钮菜单：/menu ｜ 模型：/models ｜ 目录：/dir ｜ Workers：/workers ｜ 状态：/status ｜ 停止任务：/stop"

export interface TelegramTriggerResult {
  readonly route: "router" | "worker" | "dropped"
  readonly sessionID?: string
}

export type TelegramTriggerFn = (input: TriggerInput) => Effect.Effect<TelegramTriggerResult, unknown>

interface TelegramState {
  offset: number | undefined
}

interface TelegramFrom {
  readonly id: number
  readonly author?: string
}

interface TelegramMessage {
  readonly message_id: number
  readonly date: number
  readonly chatID: number
  readonly from?: TelegramFrom
  readonly text?: unknown
  readonly messageThreadID?: number
}

export interface TelegramUpdate {
  readonly update_id: number
  readonly message?: TelegramMessage
  readonly edited_message?: TelegramMessage
  readonly callback_query?: TelegramCallbackQuery
}

export interface TelegramCallbackQuery {
  readonly id: string
  readonly fromID: number
  readonly chatID: number
  readonly messageID?: number
  readonly messageThreadID?: number
  readonly data?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionMs(ctx: Plugin.Context, key: string, fallback: number): number {
  const raw: unknown = ctx.options[key]
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return fallback
  return raw
}

function envToken(): string | undefined {
  if (typeof process === "undefined") return undefined
  const value = process.env["TELEGRAM_BOT_TOKEN"]
  if (typeof value !== "string" || value === "") return undefined
  return value
}

/**
 * Bot token resolution: explicit plugin option first, environment second.
 * The token is never logged. Prefer the `TELEGRAM_BOT_TOKEN` environment
 * variable so the secret never lands in a config file in plaintext.
 */
export function readTelegramToken(ctx: Plugin.Context): string | undefined {
  const direct = ctx.options["telegramBotToken"]
  if (typeof direct === "string" && direct !== "") return direct
  const nested = ctx.options["telegram"]
  if (isRecord(nested)) {
    const token = nested["botToken"]
    if (typeof token === "string" && token !== "") return token
  }
  return envToken()
}

const TELEGRAM_ALLOWED_ENV = "TELEGRAM_ALLOWED_CHAT_IDS"
const TELEGRAM_VIA_ROUTER_ENV = "TELEGRAM_VIA_ROUTER"

function toChatIDList(value: unknown): Array<number> {
  const out: Array<number> = []
  const push = (item: unknown) => {
    if (typeof item === "number" && Number.isSafeInteger(item)) out.push(item)
    if (typeof item === "string" && item.trim() !== "") {
      const parsed = Number(item.trim())
      if (Number.isSafeInteger(parsed)) out.push(parsed)
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
    return [...new Set(out)]
  }
  if (typeof value === "string") {
    for (const part of value.split(",")) push(part)
    return [...new Set(out)]
  }
  return out
}

/**
 * Private-bot allowlist: explicit plugin options first, environment second.
 * Reads `telegramAllowedChatIDs` (or `telegram.allowlist` /
 * `telegram.allowedChatIDs`) and falls back to `TELEGRAM_ALLOWED_CHAT_IDS`
 * (comma-separated). `undefined` means unrestricted (backward compatible).
 */
export function readTelegramAllowlist(ctx: Plugin.Context): Array<number> | undefined {
  const direct = ctx.options["telegramAllowedChatIDs"]
  if (direct !== undefined) {
    const list = toChatIDList(direct)
    if (list.length > 0) return list
  }
  const nested = ctx.options["telegram"]
  if (isRecord(nested)) {
    for (const key of ["allowlist", "allowedChatIDs", "allowedChatIds"]) {
      if (nested[key] !== undefined) {
        const list = toChatIDList(nested[key])
        if (list.length > 0) return list
      }
    }
  }
  if (typeof process !== "undefined") {
    const list = toChatIDList(process.env[TELEGRAM_ALLOWED_ENV])
    if (list.length > 0) return list
  }
  return undefined
}

export function isTelegramAllowed(ctx: Plugin.Context, chatID: number): boolean {
  const allowlist = readTelegramAllowlist(ctx)
  if (allowlist === undefined) return true
  return allowlist.includes(chatID)
}

/**
 * Router-first ingress for Telegram: every message goes through the Router,
 * which dispatches a fresh Worker per request. Disabled by default to keep
 * the sticky thread affinity; enable with `telegramViaRouter` (or
 * `telegram.viaRouter`, env `TELEGRAM_VIA_ROUTER=1`).
 */
export function readTelegramViaRouter(ctx: Plugin.Context): boolean {
  const direct = ctx.options["telegramViaRouter"]
  if (typeof direct === "boolean") return direct
  const nested = ctx.options["telegram"]
  if (isRecord(nested) && typeof nested["viaRouter"] === "boolean") return nested["viaRouter"]
  if (typeof process !== "undefined") {
    const raw = process.env[TELEGRAM_VIA_ROUTER_ENV]
    if (raw === "1" || raw === "true" || raw === "yes") return true
  }
  return false
}

/** Private chat -> `telegram:<chatID>`; forum topic -> `telegram:<chatID>:<topicID>`. */
export function threadIDForChat(chatID: number, messageThreadID?: number): string {
  if (messageThreadID === undefined) return `${TELEGRAM_SOURCE}:${chatID}`
  return `${TELEGRAM_SOURCE}:${chatID}:${messageThreadID}`
}

const THREAD_PATTERN = /^telegram:(-?\d+)(?::(\d+))?$/

/** Reverse of `threadIDForChat`: where to send the reply for a telegram thread. */
export function chatTargetForThread(threadID: string): { chatID: number; messageThreadID?: number } | undefined {
  const match = THREAD_PATTERN.exec(threadID)
  if (match === null) return undefined
  const chatID = Number(match[1])
  if (!Number.isSafeInteger(chatID)) return undefined
  if (match[2] === undefined) return { chatID }
  const messageThreadID = Number(match[2])
  if (!Number.isSafeInteger(messageThreadID)) return undefined
  return { chatID, messageThreadID }
}

function toFrom(value: unknown): TelegramFrom | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["id"] !== "number") return undefined
  const username = value["username"]
  const firstName = value["first_name"]
  if (typeof username === "string" && username !== "") return { id: value["id"], author: `@${username}` }
  if (typeof firstName === "string" && firstName !== "") return { id: value["id"], author: firstName }
  return { id: value["id"] }
}

function toMessage(value: unknown): TelegramMessage | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["message_id"] !== "number") return undefined
  if (typeof value["date"] !== "number") return undefined
  if (!isRecord(value["chat"]) || typeof value["chat"]["id"] !== "number") return undefined
  const threadID = value["message_thread_id"]
  return {
    message_id: value["message_id"],
    date: value["date"],
    chatID: value["chat"]["id"],
    from: toFrom(value["from"]),
    text: value["text"],
    messageThreadID: typeof threadID === "number" ? threadID : undefined,
  }
}

function toCallbackQuery(value: unknown): TelegramCallbackQuery | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["id"] !== "string") return undefined
  const from = value["from"]
  if (!isRecord(from) || typeof from["id"] !== "number") return undefined
  const message = value["message"]
  let chatID: number | undefined
  let messageID: number | undefined
  let messageThreadID: number | undefined
  if (isRecord(message)) {
    if (typeof message["message_id"] === "number") messageID = message["message_id"]
    const chat = message["chat"]
    if (isRecord(chat) && typeof chat["id"] === "number") chatID = chat["id"]
    if (typeof message["message_thread_id"] === "number") messageThreadID = message["message_thread_id"]
  }
  // Without the originating chat there is nowhere to reply; drop it.
  if (chatID === undefined) return undefined
  const data = value["data"]
  return {
    id: value["id"],
    fromID: from["id"],
    chatID,
    ...(messageID === undefined ? {} : { messageID }),
    ...(messageThreadID === undefined ? {} : { messageThreadID }),
    ...(typeof data === "string" ? { data } : {}),
  }
}

export function toUpdate(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["update_id"] !== "number") return undefined
  return {
    update_id: value["update_id"],
    message: toMessage(value["message"]),
    edited_message: toMessage(value["edited_message"]),
    callback_query: toCallbackQuery(value["callback_query"]),
  }
}

/**
 * Map one Bot API update to a trigger. Non-text updates (stickers, photos,
 * service messages) return `undefined` and are skipped. The stable id
 * (`telegram:<chat>:<message>`) dedupes redeliveries on the router path.
 */
export function updateToTrigger(update: TelegramUpdate): TriggerInput | undefined {
  const message = update.message ?? update.edited_message
  if (message === undefined) return undefined
  if (typeof message.text !== "string" || message.text.trim() === "") return undefined
  return {
    id: `${TELEGRAM_SOURCE}:${message.chatID}:${message.message_id}`,
    source: TELEGRAM_SOURCE,
    threadID: threadIDForChat(message.chatID, message.messageThreadID),
    ...(message.from?.author === undefined ? {} : { author: message.from.author }),
    text: message.text,
    createdAt: message.date * 1000,
  }
}

function truncateSend(text: string): string {
  if (text.length <= SEND_LIMIT) return text
  return `${text.slice(0, SEND_LIMIT)}…`
}

function describeFailure(body: unknown, status: number): string {
  if (isRecord(body) && typeof body["description"] === "string" && body["description"] !== "") {
    return `status ${status}: ${body["description"]}`
  }
  return `status ${status}`
}

/** Minimal Bot API client. The token stays inside the URL; failures never log it. */
const botApi = Effect.fn("superagent.telegramApi")(function* (token: string, method: string, params?: unknown) {
  return yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: params === undefined ? "{}" : JSON.stringify(params),
      })
      const body: unknown = await response.json()
      if (!response.ok || !isRecord(body) || body["ok"] !== true) {
        throw new Error(`telegram ${method} failed (${describeFailure(body, response.status)})`)
      }
      return body["result"]
    },
    catch: (cause) => cause,
  })
})

const getUpdates = Effect.fn("superagent.telegramGetUpdates")(function* (token: string, offset: number | undefined) {
  const result = yield* botApi(token, "getUpdates", {
    ...(offset === undefined ? {} : { offset }),
    timeout: GET_UPDATES_TIMEOUT_S,
    allowed_updates: ["message", "edited_message", "callback_query"],
  })
  if (!Array.isArray(result)) return []
  const updates: Array<TelegramUpdate> = []
  for (const item of result) {
    const update = toUpdate(item)
    if (update !== undefined) updates.push(update)
  }
  return updates
})

interface TelegramButton {
  readonly text: string
  readonly callback_data: string
}

interface TelegramMarkup {
  readonly inline_keyboard: ReadonlyArray<ReadonlyArray<TelegramButton>>
}

function button(text: string, data: string): TelegramButton {
  return { text, callback_data: data }
}

function markup(rows: ReadonlyArray<ReadonlyArray<TelegramButton>>): TelegramMarkup {
  return { inline_keyboard: rows }
}

/** Main menu rows reused by /menu, reports and view footers. */
function menuRows(): Array<Array<TelegramButton>> {
  return [
    [button("🤖 模型", "sa:models:0"), button("📁 目录", "sa:dir")],
    [button("👷 Workers", "sa:workers"), button("📊 状态", "sa:status")],
  ]
}

/** Mini design: inline buttons only (no reply keyboard, no chat clutter).
 * `callback_data` is capped at 64 bytes, so payloads are short codes:
 * `sa:menu`, `sa:models:<page>`, `sa:mset:<page>:<idx>`, `sa:dir`,
 * `sa:dset:<idx>`, `sa:workers`, `sa:wdetail:<sessionID>`,
 * `sa:wstop:<sessionID>`, `sa:status`. Model/dir indices resolve against
 * freshly listed state, so no server-side cache is needed. */

const sendMessage = Effect.fn("superagent.telegramSend")(function* (
  token: string,
  chatID: number,
  text: string,
  messageThreadID?: number,
  replyMarkup?: TelegramMarkup,
) {
  yield* botApi(token, "sendMessage", {
    chat_id: chatID,
    text: truncateSend(text),
    disable_web_page_preview: true,
    ...(messageThreadID === undefined ? {} : { message_thread_id: messageThreadID }),
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
  })
})

const editMessage = Effect.fn("superagent.telegramEdit")(function* (
  token: string,
  chatID: number,
  messageID: number,
  text: string,
  replyMarkup?: TelegramMarkup,
) {
  yield* botApi(token, "editMessageText", {
    chat_id: chatID,
    message_id: messageID,
    text: truncateSend(text),
    disable_web_page_preview: true,
    ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
  })
})

const answerCallback = Effect.fn("superagent.telegramAnswer")(function* (
  token: string,
  queryID: string,
  text?: string,
  showAlert?: boolean,
) {
  yield* botApi(token, "answerCallbackQuery", {
    callback_query_id: queryID,
    ...(text === undefined ? {} : { text: text.slice(0, 190) }),
    ...(showAlert === true ? { show_alert: true } : {}),
  })
})

/** Publish the command list so Telegram clients render a `/` menu. Best-effort. */
const setMyCommands = Effect.fn("superagent.telegramCommands")(function* (token: string) {
  yield* botApi(token, "setMyCommands", {
    commands: [
      { command: "menu", description: "按钮主菜单" },
      { command: "models", description: "查看/切换模型" },
      { command: "dir", description: "查看/切换工作目录" },
      { command: "workers", description: "运行中与历史 Workers" },
      { command: "status", description: "Router 与队列状态" },
      { command: "stop", description: "停止一个 Worker" },
      { command: "stop", description: "停止一个 Worker" },
    ],
  })
})

const MODELS_PAGE_SIZE = 8
const WORKER_HISTORY_LIMIT = 10
const DIR_CANDIDATE_LIMIT = 6

type SortedModel = Model.Info

const listSortedModels = Effect.fn("superagent.telegramModels")(function* (ctx: Plugin.Context) {
  const result = yield* ctx.model.list().pipe(Effect.catch(() => Effect.succeed(undefined)))
  const items: Array<SortedModel> = result === undefined ? [] : [...result.data]
  items.sort((left, right) => left.providerID.localeCompare(right.providerID) || left.id.localeCompare(right.id))
  return items
})

const routerSnapshot = Effect.fn("superagent.telegramRouterSnapshot")(function* (ctx: Plugin.Context) {
  if (store.routerID === undefined) return undefined
  const info = yield* ctx.session
    .get({ sessionID: toSessionID(store.routerID) })
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (info === undefined) return undefined
  return { sessionID: store.routerID, model: info.model, directory: info.location.directory }
})

function refText(model: { providerID: string; id: string; variant?: string } | undefined): string | undefined {
  if (model === undefined) return undefined
  return `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`
}

function shortID(sessionID: string): string {
  return sessionID.slice(0, 8)
}

function shortTitle(title: string | undefined, limit: number): string {
  if (title === undefined || title.trim() === "") return "-"
  const clean = title.trim().replace(/\s+/g, " ")
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

function menuView(): { text: string; replyMarkup: TelegramMarkup } {
  return {
    text: "Superagent 控制面板：\n🤖 模型：查看/切换 Router 与后续 Worker 的模型\n📁 目录：查看/切换工作目录（新 Worker 跟随 Router 目录）\n👷 Workers：运行中与历史任务，可看详情、可停止\n📊 状态：Router、队列与 Worker 汇总\n\n直接发文字即派发任务。",
    replyMarkup: markup(menuRows()),
  }
}

function modelsView(
  models: ReadonlyArray<SortedModel>,
  current: string | undefined,
  page: number,
): { text: string; replyMarkup: TelegramMarkup } {
  const total = Math.max(1, Math.ceil(models.length / MODELS_PAGE_SIZE))
  const safe = Math.min(Math.max(0, page), total - 1)
  const rows: Array<Array<TelegramButton>> = []
  for (let index = safe * MODELS_PAGE_SIZE; index < Math.min(models.length, safe * MODELS_PAGE_SIZE + MODELS_PAGE_SIZE); index++) {
    const item = models[index]
    if (item === undefined) continue
    const key = `${item.providerID}/${item.id}`
    const entry = button(`${current === key ? "✓ " : ""}${key.slice(0, 28)}`, `sa:mset:${safe}:${index}`)
    const last = rows[rows.length - 1]
    if (last !== undefined && last.length === 1) last.push(entry)
    else rows.push([entry])
  }
  const nav: Array<TelegramButton> = []
  if (safe > 0) nav.push(button("◀ 上一页", `sa:models:${safe - 1}`))
  if (safe < total - 1) nav.push(button("下一页 ▶", `sa:models:${safe + 1}`))
  if (nav.length > 0) rows.push(nav)
  rows.push([button("🔙 菜单", "sa:menu")])
  return {
    text: `模型（当前 Router：${current ?? "默认"}，共 ${models.length} 个，第 ${safe + 1}/${total} 页）：点按钮切换，新 Worker 跟随 Router 模型。`,
    replyMarkup: markup(rows),
  }
}

const dirCandidates = Effect.fn("superagent.telegramDirs")(function* (ctx: Plugin.Context) {
  const out: Array<string> = []
  const push = (dir: string | undefined) => {
    if (dir === undefined || dir === "") return
    if (!out.includes(dir)) out.push(dir)
  }
  push(ctx.location.directory)
  const snap = yield* routerSnapshot(ctx)
  push(snap?.directory)
  const recent = [...store.workers.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, 5)
  for (const worker of recent) {
    const info = yield* ctx.session
      .get({ sessionID: toSessionID(worker.sessionID) })
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    push(info?.location.directory)
    if (out.length >= DIR_CANDIDATE_LIMIT) break
  }
  return { fallback: ctx.location.directory, router: snap?.directory, candidates: out.slice(0, DIR_CANDIDATE_LIMIT) }
})

function dirView(fallback: string, router: string | undefined, candidates: ReadonlyArray<string>): {
  text: string
  replyMarkup: TelegramMarkup
} {
  const rows = candidates.map((dir, index) => [
    button(`${router === dir ? "✓ " : ""}${dir.length > 40 ? `…${dir.slice(-39)}` : dir}`, `sa:dset:${index}`),
  ])
  rows.push([button("🔙 菜单", "sa:menu")])
  return {
    text: `目录（Router 当前：${router ?? "默认"}，服务默认：${fallback}）：点按钮把 Router 切到该目录，新 Worker 会跟随。或直接发 /dir /绝对路径 切换。`,
    replyMarkup: markup(rows),
  }
}

function workersView(): { text: string; replyMarkup: TelegramMarkup } {
  const all = [...store.workers.values()].sort((left, right) => right.createdAt - left.createdAt)
  const running = all.filter((worker) => worker.state === "running")
  const history = all.filter((worker) => worker.state !== "running").slice(0, WORKER_HISTORY_LIMIT)
  const lines = [`👷 Workers：运行中 ${running.length}，历史 ${all.length - running.length}`]
  for (const worker of running) {
    lines.push(`🟢 ${shortID(worker.sessionID)} ${shortTitle(worker.title, 30)} [${worker.threads.join(",") || "-"}]`)
  }
  for (const worker of history) {
    lines.push(`${worker.state === "done" ? "✅" : worker.state === "failed" ? "❌" : "💤"} ${shortID(worker.sessionID)} ${shortTitle(worker.title, 30)} ${worker.state}`)
  }
  if (all.length === 0) lines.push("暂无 Worker，直接发文字即可派发第一个任务。")
  const rows: Array<Array<TelegramButton>> = []
  for (const worker of running) {
    rows.push([
      button(`🔍 ${shortID(worker.sessionID)} ${shortTitle(worker.title, 16)}`, `sa:wdetail:${worker.sessionID}`),
      button("⛔ 停止", `sa:wstop:${worker.sessionID}`),
    ])
  }
  for (const worker of history) {
    rows.push([
      button(`📜 ${shortID(worker.sessionID)} ${shortTitle(worker.title, 24)} ${worker.state}`, `sa:wdetail:${worker.sessionID}`),
    ])
  }
  rows.push([button("🔄 刷新", "sa:workers"), button("🔙 菜单", "sa:menu")])
  return { text: lines.join("\n"), replyMarkup: markup(rows) }
}

function workerDetailView(sessionID: string): { text: string; replyMarkup: TelegramMarkup } {
  const worker = store.workers.get(sessionID)
  if (worker === undefined) {
    return { text: `Worker ${sessionID} 不在记录中（可能已清理）。`, replyMarkup: markup([[button("🔙 Workers", "sa:workers")]]) }
  }
  const rows: Array<Array<TelegramButton>> = []
  if (worker.state === "running") rows.push([button("⛔ 停止该 Worker", `sa:wstop:${worker.sessionID}`)])
  rows.push([button("🔙 Workers", "sa:workers"), button("🔙 菜单", "sa:menu")])
  const lines = [
    `Worker ${worker.sessionID}`,
    `标题：${worker.title ?? "-"}`,
    `状态：${worker.state}`,
    `threads：${worker.threads.join(",") || "-"}`,
    `创建：${new Date(worker.createdAt).toISOString()}`,
    `结论：${worker.lastReport === undefined || worker.lastReport === "" ? "(尚无结论)" : worker.lastReport.slice(0, 1500)}`,
  ]
  return { text: lines.join("\n"), replyMarkup: markup(rows) }
}

const statusView = Effect.fn("superagent.telegramStatusView")(function* (ctx: Plugin.Context) {
  const snap = yield* routerSnapshot(ctx)
  const current = refText(snap?.model)
  const counts = { running: 0, idle: 0, failed: 0, done: 0 }
  for (const worker of store.workers.values()) counts[worker.state] += 1
  const lines = [
    "📊 状态",
    `Router：${snap?.sessionID ?? "未创建"}${store.routerBusy ? "（忙）" : ""}`,
    `模型：${current ?? "默认"}`,
    `目录：${snap?.directory ?? ctx.location.directory}`,
    `pending：${store.pending.length} ｜ triggers：${store.triggerTotal} ｜ workers：${store.workers.size}（运行中 ${counts.running}）`,
  ]
  const all = [...store.workers.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, 12)
  for (const worker of all) {
    lines.push(`- ${shortID(worker.sessionID)} ${shortTitle(worker.title, 24)} [${worker.threads.join(",") || "-"}] ${worker.state}`)
  }
  return {
    text: lines.join("\n"),
    replyMarkup: markup([[button("🔄 刷新", "sa:status"), button("🔙 菜单", "sa:menu")]]),
  }
})

function parseCommand(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith("/")) return undefined
  const first = text.split("\n")[0] ?? ""
  const space = first.indexOf(" ")
  const token = (space === -1 ? first : first.slice(0, space)).trim()
  const at = token.indexOf("@")
  const name = (at === -1 ? token : token.slice(0, at)).toLowerCase()
  const args = (space === -1 ? "" : first.slice(space + 1)).trim()
  if (name === "" || !name.startsWith("/")) return undefined
  return { name, args }
}

const setRouterDirectory = Effect.fn("superagent.telegramSetDir")(function* (
  ctx: Plugin.Context,
  token: string,
  chatID: number,
  messageThreadID: number | undefined,
  dir: string,
) {
  if (!dir.startsWith("/") || dir.length > 500) {
    yield* sendMessage(token, chatID, "目录必须是绝对路径，例如：/dir /opt/repo", messageThreadID).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent telegram dir usage reply failed", { cause })),
    )
    return
  }
  const routerID = yield* Effect.sync(() => store.routerID).pipe(
    Effect.flatMap((cached) => (cached === undefined ? ensureRouter(ctx) : Effect.succeed(cached))),
    Effect.catch((cause) =>
      Effect.logWarning("superagent telegram ensure router failed", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID === undefined) {
    yield* sendMessage(token, chatID, "Router 不可用，稍后再试。", messageThreadID).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent telegram dir reply failed", { cause })),
    )
    return
  }
  const moved = yield* ctx.session
    .move({ sessionID: toSessionID(routerID), directory: AbsolutePath.make(dir) })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) => Effect.logWarning("superagent telegram move failed", { dir, cause }).pipe(Effect.as(false))),
    )
  yield* sendMessage(
    token,
    chatID,
    moved ? `目录已切换为 ${dir}，新 Worker 会跟随该目录。` : `切换失败：${dir} 不可用或无对应项目。`,
    messageThreadID,
  ).pipe(Effect.catch((cause) => Effect.logWarning("superagent telegram dir reply failed", { cause })))
})

const setRouterModel = Effect.fn("superagent.telegramSetModel")(function* (
  ctx: Plugin.Context,
  token: string,
  queryID: string,
  index: number,
) {
  const models = yield* listSortedModels(ctx)
  const item = models[index]
  if (item === undefined) {
    yield* answerCallback(token, queryID, "模型列表已过期，重新打开 /models", true).pipe(
      Effect.catch(() => Effect.void),
    )
    return undefined
  }
  const routerID = yield* Effect.sync(() => store.routerID).pipe(
    Effect.flatMap((cached) => (cached === undefined ? ensureRouter(ctx) : Effect.succeed(cached))),
    Effect.catch((cause) =>
      Effect.logWarning("superagent telegram ensure router failed", { cause }).pipe(Effect.as(undefined)),
    ),
  )
  if (routerID === undefined) {
    yield* answerCallback(token, queryID, "Router 不可用", true).pipe(Effect.catch(() => Effect.void))
    return undefined
  }
  const switched = yield* ctx.session
    .switchModel({ sessionID: toSessionID(routerID), model: { providerID: item.providerID, id: item.id } })
    .pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("superagent telegram switch model failed", { cause }).pipe(Effect.as(false)),
      ),
    )
  yield* answerCallback(token, queryID, switched ? `已切换为 ${item.providerID}/${item.id}` : "切换失败", !switched).pipe(
    Effect.catch(() => Effect.void),
  )
  if (!switched) return undefined
  return yield* listSortedModels(ctx)
})

const stopWorkerByID = Effect.fn("superagent.telegramStopWorker")(function* (ctx: Plugin.Context, sessionID: string) {
  if (!store.workers.has(sessionID)) return false
  const result = yield* ctx.session
    .interrupt({ sessionID: toSessionID(sessionID) })
    .pipe(Effect.catch(() => Effect.succeed({ interrupted: false })))
  return result.interrupted
})

const handleCommand = Effect.fn("superagent.telegramCommand")(function* (
  ctx: Plugin.Context,
  token: string,
  chatID: number,
  messageThreadID: number | undefined,
  name: string,
  args: string,
) {
  switch (name) {
    case "/start": {
      yield* sendMessage(token, chatID, START_HELP, messageThreadID, markup(menuRows())).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram menu reply failed", { cause })),
      )
      return
    }
    case "/help":
    case "/menu": {
      const view = menuView()
      yield* sendMessage(token, chatID, view.text, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram menu reply failed", { cause })),
      )
      return
    }
    case "/models": {
      const models = yield* listSortedModels(ctx)
      const snap = yield* routerSnapshot(ctx)
      const view = modelsView(models, refText(snap?.model), 0)
      yield* sendMessage(token, chatID, view.text, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram models reply failed", { cause })),
      )
      return
    }
    case "/dir": {
      if (args !== "") {
        yield* setRouterDirectory(ctx, token, chatID, messageThreadID, args)
        return
      }
      const dirs = yield* dirCandidates(ctx)
      const view = dirView(dirs.fallback, dirs.router, dirs.candidates)
      yield* sendMessage(token, chatID, view.text, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram dir reply failed", { cause })),
      )
      return
    }
    case "/workers": {
      const view = workersView()
      yield* sendMessage(token, chatID, view.text, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram workers reply failed", { cause })),
      )
      return
    }
    case "/status": {
      const view = yield* statusView(ctx)
      yield* sendMessage(token, chatID, view.text, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram status reply failed", { cause })),
      )
      return
    }
    case "/stop": {
      if (args === "") {
        const view = workersView()
        yield* sendMessage(token, chatID, `用法：/stop <workerID>（点按钮停止更方便）\n\n${view.text}`, messageThreadID, view.replyMarkup).pipe(
          Effect.catch((cause) => Effect.logWarning("superagent telegram stop reply failed", { cause })),
        )
        return
      }
      const stopped = yield* stopWorkerByID(ctx, args.split(/\s+/)[0] ?? "")
      yield* sendMessage(token, chatID, stopped ? "已发送停止信号，Worker 结束后会回报告。" : "未找到运行中的 Worker（ID 不对或已结束）。", messageThreadID).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram stop reply failed", { cause })),
      )
      return
    }
    default: {
      const view = menuView()
      yield* sendMessage(token, chatID, `未知命令 ${name}，可用：/menu /models /dir /workers /status /stop`, messageThreadID, view.replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram unknown command reply failed", { cause })),
      )
    }
  }
})

const handleCallback = Effect.fn("superagent.telegramCallback")(function* (
  ctx: Plugin.Context,
  token: string,
  query: TelegramCallbackQuery,
) {
  if (!isTelegramAllowed(ctx, query.chatID)) {
    yield* answerCallback(token, query.id).pipe(Effect.catch(() => Effect.void))
    yield* Effect.logWarning("superagent telegram callback from unauthorized chat dropped", { chatID: query.chatID })
    return
  }
  const data = query.data ?? ""
  const say = (text?: string, alert?: boolean) =>
    answerCallback(token, query.id, text, alert).pipe(Effect.catch(() => Effect.void))
  const show = (text: string, replyMarkup: TelegramMarkup) => {
    if (query.messageID === undefined) {
      return sendMessage(token, query.chatID, text, query.messageThreadID, replyMarkup).pipe(
        Effect.catch((cause) => Effect.logWarning("superagent telegram callback send failed", { cause })),
      )
    }
    return editMessage(token, query.chatID, query.messageID, text, replyMarkup).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent telegram callback edit failed", { cause })),
    )
  }
  if (data === "sa:menu") {
    const view = menuView()
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data.startsWith("sa:models:")) {
    const page = Number(data.slice("sa:models:".length))
    const models = yield* listSortedModels(ctx)
    const snap = yield* routerSnapshot(ctx)
    const view = modelsView(models, refText(snap?.model), Number.isSafeInteger(page) ? page : 0)
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data.startsWith("sa:mset:")) {
    const parts = data.slice("sa:mset:".length).split(":")
    const page = Number(parts[0])
    const index = Number(parts[1])
    if (!Number.isSafeInteger(index)) {
      yield* say("参数无效，重新打开 /models", true)
      return
    }
    const models = yield* setRouterModel(ctx, token, query.id, index)
    if (models === undefined) return
    const snap = yield* routerSnapshot(ctx)
    const view = modelsView(models, refText(snap?.model), Number.isSafeInteger(page) ? page : 0)
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data === "sa:dir") {
    const dirs = yield* dirCandidates(ctx)
    const view = dirView(dirs.fallback, dirs.router, dirs.candidates)
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data.startsWith("sa:dset:")) {
    const index = Number(data.slice("sa:dset:".length))
    const dirs = yield* dirCandidates(ctx)
    const dir = Number.isSafeInteger(index) ? dirs.candidates[index] : undefined
    if (dir === undefined) {
      yield* say("目录已过期，重新打开 /dir", true)
      return
    }
    const routerID = yield* Effect.sync(() => store.routerID).pipe(
      Effect.flatMap((cached) => (cached === undefined ? ensureRouter(ctx) : Effect.succeed(cached))),
      Effect.catch((cause) =>
        Effect.logWarning("superagent telegram ensure router failed", { cause }).pipe(Effect.as(undefined)),
      ),
    )
    if (routerID === undefined) {
      yield* say("Router 不可用", true)
      return
    }
    const moved = yield* ctx.session
      .move({ sessionID: toSessionID(routerID), directory: AbsolutePath.make(dir) })
      .pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
    yield* say(moved ? `目录已切换为 ${dir}` : "切换失败", !moved)
    const fresh = yield* dirCandidates(ctx)
    const view = dirView(fresh.fallback, fresh.router, fresh.candidates)
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data === "sa:workers") {
    const view = workersView()
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data.startsWith("sa:wdetail:")) {
    const view = workerDetailView(data.slice("sa:wdetail:".length))
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data.startsWith("sa:wstop:")) {
    const sessionID = data.slice("sa:wstop:".length)
    const stopped = yield* stopWorkerByID(ctx, sessionID)
    yield* say(stopped ? "已发送停止信号" : "该 Worker 不在运行中", !stopped)
    const view = workersView()
    yield* show(view.text, view.replyMarkup)
    return
  }
  if (data === "sa:status") {
    const view = yield* statusView(ctx)
    yield* say()
    yield* show(view.text, view.replyMarkup)
    return
  }
  yield* say("未知按钮，点 /menu 刷新", true)
})

const handleUpdate = Effect.fn("superagent.telegramUpdate")(function* (
  ctx: Plugin.Context,
  token: string,
  trigger: TelegramTriggerFn,
  update: TelegramUpdate,
) {
  const message = update.message ?? update.edited_message
  if (message === undefined) return
  if (typeof message.text !== "string" || message.text.trim() === "") return
  if (!isTelegramAllowed(ctx, message.chatID)) {
    yield* Effect.logWarning("superagent telegram message from unauthorized chat dropped", {
      chatID: message.chatID,
    })
    return
  }
  const parsed = parseCommand(message.text.trim())
  if (parsed !== undefined) {
    yield* handleCommand(ctx, token, message.chatID, message.messageThreadID, parsed.name, parsed.args).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent telegram command failed", { cause })),
    )
    return
  }
  const input = updateToTrigger(update)
  if (input === undefined) return
  const result = yield* trigger(input).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("superagent telegram trigger failed", { cause }).pipe(
        Effect.as({ route: "dropped" } as TelegramTriggerResult),
      ),
    ),
  )
  if (result.route !== "router") return
  yield* sendMessage(token, message.chatID, "Router 已收到，正在派发处理…完成后结论会发回这里。", message.messageThreadID).pipe(
    Effect.catch((cause) => Effect.logWarning("superagent telegram ack failed", { cause })),
  )
})

const runPollLoop = Effect.fn("superagent.telegramPollLoop")(function* (
  ctx: Plugin.Context,
  token: string,
  idleMs: number,
  trigger: TelegramTriggerFn,
  state: TelegramState,
) {
  const loop = Effect.gen(function* () {
    const updates = yield* getUpdates(token, state.offset).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent telegram poll failed", { cause }).pipe(Effect.as([] as Array<TelegramUpdate>)),
      ),
    )
    for (const update of updates) {
      state.offset = update.update_id + 1
      if (update.callback_query !== undefined) {
        const query = update.callback_query
        yield* handleCallback(ctx, token, query).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("superagent telegram callback failed", { update: update.update_id, cause }),
          ),
        )
      } else {
        yield* handleUpdate(ctx, token, trigger, update).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("superagent telegram update failed", { update: update.update_id, cause }),
          ),
        )
      }
    }
    if (state.offset !== undefined) {
      const offset: number = state.offset
      yield* ctx.storage.set(TELEGRAM_OFFSET_KEY, offset).pipe(Effect.catch(() => Effect.void))
    }
    if (updates.length === 0) yield* Effect.sleep(Duration.millis(idleMs))
  })
  yield* Effect.forever(loop)
})

/**
 * Telegram ingress: long-poll `getUpdates` in a scoped background fiber and
 * map each text message to `trigger({ source: "telegram", ... })`, reusing the
 * standard router/status/trigger/stop contract. Replies are event-driven from
 * the worker watcher (`reportWorkerToTelegram`); this loop only sends command
 * views (`/menu` `/models` `/dir` `/workers` `/status` `/stop`, all backed by
 * inline-keyboard callbacks), a short ack for first-touch threads, and the
 * report buttons. Without a token the adapter stays disabled and everything
 * else keeps working.
 */
export const registerTelegram = Effect.fn("superagent.registerTelegram")(function* (
  ctx: Plugin.Context,
  trigger: TelegramTriggerFn,
) {
  const token = readTelegramToken(ctx)
  if (token === undefined) {
    yield* Effect.logInfo("superagent telegram disabled: set TELEGRAM_BOT_TOKEN to enable")
    return
  }
  const sources = ctx.options["sources"] as ReadonlyArray<string> | undefined
  if (Array.isArray(sources) && !sources.includes(TELEGRAM_SOURCE)) {
    yield* Effect.logWarning('superagent telegram updates will be dropped: add "telegram" to the sources allowlist')
  }
  const idleMs = optionMs(ctx, "telegramPollIdleMs", DEFAULT_POLL_IDLE_MS)
  const stored = yield* ctx.storage.get(TELEGRAM_OFFSET_KEY).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const state: TelegramState = { offset: typeof stored === "number" ? stored : undefined }
  yield* Effect.logInfo("superagent telegram polling enabled (long polling, no webhook)")
  yield* setMyCommands(token).pipe(Effect.catch((cause) => Effect.logWarning("superagent telegram commands failed", { cause })))
  yield* runPollLoop(ctx, token, idleMs, trigger, state).pipe(Effect.forkScoped)
})

/**
 * Worker-side egress: after a worker finishes, send its report back to every
 * subscribed Telegram chat. Called from the worker watcher alongside the
 * router report; a no-op without a token or without telegram threads.
 */
export const reportWorkerToTelegram = Effect.fn("superagent.telegramReport")(function* (
  ctx: Plugin.Context,
  sessionID: string,
) {
  const token = readTelegramToken(ctx)
  if (token === undefined) return
  const worker = store.workers.get(sessionID)
  const report = worker?.lastReport
  if (worker === undefined || report === undefined || report.trim() === "") return
  const targets: Array<{ chatID: number; messageThreadID?: number; thread: string }> = []
  for (const thread of worker.threads) {
    const target = chatTargetForThread(thread)
    if (target === undefined) continue
    if (!isTelegramAllowed(ctx, target.chatID)) continue
    targets.push({ ...target, thread })
  }
  for (const target of targets) {
    yield* sendMessage(token, target.chatID, report, target.messageThreadID, markup(menuRows())).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent telegram reply failed", { sessionID, thread: target.thread, cause }),
      ),
    )
  }
})
