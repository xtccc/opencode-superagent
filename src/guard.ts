import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { DEFAULT_DIR_KEY } from "./dirs.js"
import { dirKeyForRouter, isRouterSession } from "./state.js"

/**
 * Every router-only tool shares this guard: the caller must be a live router
 * session. With `perDirectoryRouter` off there is exactly one router (the
 * default partition), so this is the historical check; with it on, every
 * partition's router passes and the returned key says which one.
 *
 * The returned key is the caller's **partition**, i.e. the ownership of
 * everything the tool creates or touches. It is never derived from a
 * `directory` argument: a Router may work in any directory, but its work orders
 * and workers belong to it.
 *
 * This guard used to have a `requireRouterFor(caller, directory)` companion
 * that also refused a directory belonging to another partition. That rule
 * conflated "where the work runs" with "who owns the work order": with the flag
 * switched on it locked a Router out of every directory but its own (and, for a
 * pre-flag Router whose partition is `default`, out of every directory at all).
 * Directory arguments are now validated as working directories only, by the
 * tool that uses them (`directoryError`).
 */
export const requireRouter = Effect.fn("superagent.requireRouter")(function* (caller: string, tool: string) {
  if (!isRouterSession(caller)) {
    return yield* new Tool.Error({ message: `${tool} is only available to the router session` })
  }
  return dirKeyForRouter(caller) ?? DEFAULT_DIR_KEY
})
