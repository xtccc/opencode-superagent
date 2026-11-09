import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { directorySummary } from "./dirs.js"
import { ROUTER_PROMPT } from "./prompts.js"
import { registerRecall } from "./recall.js"
import { store, type WorkerRecord } from "./state.js"
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
export function buildRecallInjection(threadID: string | undefined): string {
  if (threadID === undefined) return ""
  const active = activeTicketSummary(threadID, 3)
  const lines: Array<string> = ["## 链式召回（只给 ID 与摘要，正文按需取）"]
  if (active === "") {
    lines.push("进行中工单（当前 thread）：无")
  } else {
    lines.push("进行中工单（当前 thread）：")
    for (const entry of active.split("; ")) lines.push(clip(`- ${entry}`, RECALL_LINE_MAX))
  }
  const workers = [...store.workers.values()]
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
export function buildStatusInjection(threadID: string | undefined, pending: number = store.pending.length): string {
  const stats = ticketStats()
  const active = activeTicketSummary(threadID)
  const tickets = `tickets=open${stats.open}/in_progress${stats.inProgress}/blocked${stats.blocked}/closed${stats.closed}`
  const focus = active === "" ? "" : `\n进行中工单（当前 thread）：${active}`
  const recall = buildRecallInjection(threadID)
  const chain = recall === "" ? "" : `\n\n${recall}`
  return `Status: workers=${store.workers.size} pending=${pending} triggers=${store.triggerTotal} ${tickets}. ${directorySummary()}.${focus}${chain}`
}

/**
 * Narrow one request's toolset by session role. The Router keeps only the
 * catalog tools; a tracked Worker loses every router-only tool (dispatch,
 * sleep, tickets, recall, abort_session), so those tools are not listed to
 * the worker model at all. User sessions are left untouched.
 */
export function filterSessionTools(sessionID: string, tools: Record<string, unknown>): void {
  const router = store.routerID !== undefined && sessionID === store.routerID
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
      const router = store.routerID !== undefined && event.sessionID === store.routerID
      if (!router && !store.workers.has(event.sessionID)) return
      filterSessionTools(event.sessionID, event.tools)
      if (!router) return
      event.system.push({ type: "text", text: ROUTER_PROMPT })
    }),
  )
  yield* registerRecall(ctx)
})
