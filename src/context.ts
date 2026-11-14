import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { directorySummary } from "./dirs.js"
import { ROUTER_PROMPT } from "./prompts.js"
import { registerRecall } from "./recall.js"
import { supersededNotice } from "./superseded.js"
import { dirKeyForWorker, dirState, effectiveDirKey, isRouterSession, store, type WorkerRecord } from "./state.js"
import { activeTicketSummary, ticketStats } from "./ticket.js"
import { displayWidth, ROUTER_TOOLS } from "./tools.js"

/** How many recent workers the recall block names; their full text stays behind tools. */
const RECALL_WORKER_LIMIT = 3
/** A recall line must stay readable in a narrow terminal. */
const RECALL_LINE_MAX = 100
/** Whole recall block budget: ids and one-line summaries only, never report text. */
const RECALL_BUDGET = 800

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function clip(text: string, max: number): string {
  if (max <= 0) return ""
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** One worker line inside 100 cells; the session id stays whole so it can be copied. */
function workerLine(worker: WorkerRecord): string {
  const head = `- ${worker.sessionID} ${worker.state}`
  const tail = " | report_read"
  const room = RECALL_LINE_MAX - displayWidth(head) - displayWidth(tail) - 3
  const summary = flatten(worker.lastReport ?? worker.title ?? "")
  return `${head} | ${clip(summary, Math.max(8, room))}${tail}`
}

/**
 * Chain-recall block for the current thread: active tickets plus the newest
 * workers, each as id + state + one-line summary + report handle. Only IDs and
 * summaries are injected; `worker_detail`, `report_read`, `thread_detail` and
 * `ticket_list` fetch the bodies on demand. The whole block is capped so a
 * long summary cannot crowd out the router prompt.
 */
export function buildRecallInjection(threadID: string | undefined, dirKey?: string): string {
  if (threadID === undefined) return ""
  // 分区内的召回：B 目录的 worker 不该出现在 A 目录 Router 的上下文里。
  const scope = effectiveDirKey(dirKey)
  const active = activeTicketSummary(threadID, 3, scope)
  const lines: Array<string> = ["## 链式召回（只给 ID 与摘要，正文按需取）"]
  if (active === "") {
    lines.push("进行中工单（当前 thread）：无")
  } else {
    lines.push("进行中工单（当前 thread）：")
    for (const entry of active.split("; ")) lines.push(clip(`- ${entry}`, RECALL_LINE_MAX))
  }
  const workers = [...store.workers.values()]
    .filter((worker) => dirKeyForWorker(worker) === scope)
    .filter((worker) => worker.threadID === threadID || worker.threads.includes(threadID))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, RECALL_WORKER_LIMIT)
  lines.push(`最近 Worker（当前 thread，最多 ${RECALL_WORKER_LIMIT}）：`)
  if (workers.length === 0) lines.push("无")
  for (const worker of workers) lines.push(workerLine(worker))
  lines.push("取正文：worker_detail / report_read / thread_detail / ticket_list")
  const text = lines.join("\n")
  if (text.length <= RECALL_BUDGET) return text
  // Pathological titles/summaries: shrink every line instead of dropping whole
  // lines, so each worker/ticket ID stays visible while the block fits budget.
  const perLine = Math.max(24, Math.floor(RECALL_BUDGET / lines.length) - 1)
  return clip(lines.map((line) => clip(line, perLine)).join("\n"), RECALL_BUDGET)
}

/**
 * Live status line the Router reads at the end of its message history:
 * worker/queue/ticket counters, the directory memory, the current thread's
 * active tickets and its chain-recall block.
 *
 * Every counter here changes while the gateway runs (`triggerTotal` only ever
 * grows), so this text must never reach the system prefix. `flushPending`
 * appends it to the synthetic batch message, i.e. after the cached history,
 * where a changing tail cannot invalidate the prefix. `threadID` scopes the
 * ticket/recall part to the batch's target thread; `pending` is the queue size
 * *after* the delivered batch so the number matches what is still waiting.
 */
export function buildStatusInjection(
  threadID: string | undefined,
  pending: number = store.pending.length,
  dirKey?: string,
): string {
  // 每个分区一行状态：工单计数、trigger 计数、召回都只读本分区。
  // `dirKey === undefined` 落在默认分区，开关关闭时与阶段 2a 逐字节一致。
  const scope = effectiveDirKey(dirKey)
  const stats = ticketStats(scope)
  const active = activeTicketSummary(threadID, 3, scope)
  const tickets = `tickets=open${stats.open}/in_progress${stats.inProgress}/blocked${stats.blocked}/closed${stats.closed}`
  const focus = active === "" ? "" : `\n进行中工单（当前 thread）：${active}`
  const recall = buildRecallInjection(threadID, scope)
  const chain = recall === "" ? "" : `\n\n${recall}`
  const workers = [...store.workers.values()].filter((worker) => dirKeyForWorker(worker) === scope).length
  const triggers = dirState(store, scope).triggerTotal
  return `Status: workers=${workers} pending=${pending} triggers=${triggers} ${tickets}. ${directorySummary()}.${focus}${chain}`
}

/**
 * Narrow one request's toolset by session role. The Router (of any directory
 * partition) keeps only the catalog tools; a tracked Worker loses every
 * router-only tool (dispatch, sleep, tickets, recall, abort_session), so those
 * tools are not listed to the worker model at all. User sessions are left
 * untouched.
 */
export function filterSessionTools(sessionID: string, tools: Record<string, unknown>): void {
  const router = isRouterSession(sessionID)
  const worker = store.workers.has(sessionID)
  if (!router && !worker) return
  for (const name of Object.keys(tools)) {
    if (router ? !ROUTER_TOOLS.has(name) : ROUTER_TOOLS.has(name)) delete tools[name]
  }
}

/**
 * Context hook: strip each session's toolset to what that role may see
 * (Router: catalog only; Worker: catalog tools removed), then append the
 * router prompt for the Router.
 *
 * The system block must stay byte-stable for prompt caching: it carries only
 * `ROUTER_PROMPT`, never live counters or recall. Dynamic state would change
 * on every trigger and invalidate the cached prefix for the whole history
 * after it. Live status is delivered by `router.flushPending` as the tail of the
 * synthetic batch message instead (see `buildStatusInjection`).
 */
export const registerContext = Effect.fn("superagent.registerContext")(function* (ctx: Plugin.Context) {
  yield* ctx.session.hook("context", (event) =>
    Effect.sync(() => {
      const router = isRouterSession(event.sessionID)
      const worker = store.workers.has(event.sessionID)
      // A session that *was* the Router and lost the role to another one is
      // told so explicitly: otherwise it keeps seeing the router-only tools in
      // its catalog and only learns from their error messages.
      const superseded = supersededNotice(event.sessionID)
      if (superseded !== undefined) {
        event.system.push({ type: "text", text: superseded })
        return
      }
      if (!router && !worker) return
      filterSessionTools(event.sessionID, event.tools)
      if (!router) return
      event.system.push({ type: "text", text: ROUTER_PROMPT })
    }),
  )
  yield* registerRecall(ctx)
})
