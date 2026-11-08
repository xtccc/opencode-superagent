import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { directorySummary } from "./dirs.js"
import { ROUTER_PROMPT } from "./prompts.js"
import { registerRecall } from "./recall.js"
import { store } from "./state.js"
import { activeTicketSummary, currentTrigger, ticketStats } from "./ticket.js"
import { ROUTER_TOOLS } from "./tools.js"

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
      const active = activeTicketSummary(currentTrigger()?.threadID)
      const tickets = `tickets=open${stats.open}/in_progress${stats.inProgress}/blocked${stats.blocked}/closed${stats.closed}`
      const focus = active === "" ? "" : `\n进行中工单（当前 thread）：${active}`
      event.system.push({
        type: "text",
        text: `${ROUTER_PROMPT}\n\nStatus: workers=${store.workers.size} pending=${store.pending.length} triggers=${store.triggerTotal} ${tickets}. ${directorySummary()}.${focus}`,
      })
    }),
  )
  yield* registerRecall(ctx)
})
