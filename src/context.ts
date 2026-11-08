import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { directorySummary } from "./dirs.js"
import { ROUTER_PROMPT } from "./prompts.js"
import { registerRecall } from "./recall.js"
import { store } from "./state.js"
import { ROUTER_TOOLS } from "./tools.js"

/**
 * Router-only context hook: strip every tool outside the router set
 * (derived from the tool catalog in `src/tools.ts`),
 * then append the router prompt plus a short live status line.
 */
export const registerContext = Effect.fn("superagent.registerContext")(function* (ctx: Plugin.Context) {
  yield* ctx.session.hook("context", (event) =>
    Effect.sync(() => {
      if (store.routerID === undefined || event.sessionID !== store.routerID) return
      for (const name of Object.keys(event.tools)) {
        if (!ROUTER_TOOLS.has(name)) delete event.tools[name]
      }
      event.system.push({
        type: "text",
        text: `${ROUTER_PROMPT}\n\nStatus: workers=${store.workers.size} pending=${store.pending.length} triggers=${store.triggerTotal}. ${directorySummary()}.`,
      })
    }),
  )
  yield* registerRecall(ctx)
})
