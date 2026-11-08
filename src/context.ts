import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { directorySummary } from "./dirs.js"
import { ROUTER_PROMPT } from "./prompts.js"
import { registerRecall } from "./recall.js"
import { store, type WorkerRecord } from "./state.js"
import { activeTicketSummary, currentTrigger, ticketStats } from "./ticket.js"
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
 * Router-only context hook: strip every tool outside the router set
 * (derived from the tool catalog in `src/tools.ts`),
 * then append the router prompt plus a short live status line.
 *
 * The status line carries the ticket counters and the current thread's
 * in-progress ticket ids/titles, so a follow-up can be linked back to an
 * existing ticket without a tool call.
 */
export const registerContext = Effect.fn("superagent.registerContext")(function* (ctx: Plugin.Context) {
  yield* ctx.session.hook("context", (event) =>
    Effect.sync(() => {
      if (store.routerID === undefined || event.sessionID !== store.routerID) return
      for (const name of Object.keys(event.tools)) {
        if (!ROUTER_TOOLS.has(name)) delete event.tools[name]
      }
      const stats = ticketStats()
      const threadID = currentTrigger()?.threadID
      const active = activeTicketSummary(threadID)
      const tickets = `tickets=open${stats.open}/in_progress${stats.inProgress}/blocked${stats.blocked}/closed${stats.closed}`
      const focus = active === "" ? "" : `\n进行中工单（当前 thread）：${active}`
      const recall = buildRecallInjection(threadID)
      const chain = recall === "" ? "" : `\n\n${recall}`
      event.system.push({
        type: "text",
        text: `${ROUTER_PROMPT}\n\nStatus: workers=${store.workers.size} pending=${store.pending.length} triggers=${store.triggerTotal} ${tickets}. ${directorySummary()}.${focus}${chain}`,
      })
    }),
  )
  yield* registerRecall(ctx)
})
