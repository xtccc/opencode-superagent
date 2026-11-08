import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { store } from "./state.js"

/** Every router-only tool shares this guard: the caller must be the live router session. */
export const requireRouter = Effect.fn("superagent.requireRouter")(function* (caller: string, tool: string) {
  if (store.routerID === undefined || caller !== store.routerID) {
    return yield* new Tool.Error({ message: `${tool} is only available to the router session` })
  }
})
