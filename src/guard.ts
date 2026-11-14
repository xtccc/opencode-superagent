import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { DEFAULT_DIR_KEY, dirKeyOf } from "./dirs.js"
import { perDirectoryRouterEnabled } from "./settings.js"
import { dirKeyForRouter, isRouterSession } from "./state.js"

/**
 * Every router-only tool shares this guard: the caller must be a live router
 * session. With `perDirectoryRouter` off there is exactly one router (the
 * default partition), so this is the historical check; with it on, every
 * partition's router passes and the returned key says which one.
 */
export const requireRouter = Effect.fn("superagent.requireRouter")(function* (caller: string, tool: string) {
  if (!isRouterSession(caller)) {
    return yield* new Tool.Error({ message: `${tool} is only available to the router session` })
  }
  return dirKeyForRouter(caller) ?? DEFAULT_DIR_KEY
})

/**
 * A tool that acts on a directory must be called by the router of that
 * directory's partition. With the switch off every directory maps to the
 * single default partition, so the check is always satisfied and behaviour is
 * unchanged; with it on, router A can never operate on router B's directory.
 */
export const requireRouterFor = Effect.fn("superagent.requireRouterFor")(function* (
  caller: string,
  directory: string | undefined,
  tool: string,
) {
  const callerDirKey = yield* requireRouter(caller, tool)
  if (!perDirectoryRouterEnabled()) return callerDirKey
  const targetDirKey = dirKeyOf(directory)
  if (targetDirKey !== callerDirKey) {
    return yield* new Tool.Error({
      message: `${tool}: this router (partition ${callerDirKey}) cannot operate on ${directory ?? "the default directory"} (partition ${targetDirKey}); use that directory's router`,
    })
  }
  return callerDirKey
})
