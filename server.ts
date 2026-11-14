import { Plugin, Rpc } from "@opencode/plugin/effect"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect } from "effect"
import { registerAbort, runAbort } from "./src/abort.js"
import { registerAgents } from "./src/agents.js"
import { registerContext } from "./src/context.js"
import { hydrateDirs, dirKeyFor, resolveDirectory } from "./src/dirs.js"
import { registerTools } from "./src/dispatch.js"
import { formatTrigger } from "./src/format.js"
import { Definition } from "./src/protocol.js"
import { hydrateReports } from "./src/report.js"
import { ensureRouter, enqueuePending, flushPending, hydratePending, registerRouterIdle } from "./src/router.js"
import { hydrateSessionMeta } from "./src/session-meta.js"
import { applySettings, perDirectoryRouterEnabled, takeRouterDirectoryWarning } from "./src/settings.js"
import { registerSleep } from "./src/sleep.js"
import { statusSnapshot } from "./src/status.js"
import { dirStateForDirectory, hydrate, store, toSessionID, type TriggerInput } from "./src/state.js"
import { hydrateTickets, TICKET_STATES, type TicketState } from "./src/ticket.js"
import {
  registerTicketTools,
  renderAllTicketsTextDeep,
  renderTicketTextDeep,
  renderTicketsTextDeep,
} from "./src/ticket-tools.js"
import { registerWatcher } from "./src/watcher.js"
import { registerWatchdog } from "./src/watchdog.js"
import { versionNotice } from "./src/version.js"
import { registerWorkerPrompt } from "./src/worker-prompt.js"

const runTrigger = Effect.fn("superagent.runTrigger")(function* (ctx: Plugin.Context, input: TriggerInput) {
  const sources = ctx.options.sources as ReadonlyArray<string> | undefined
  if (Array.isArray(sources) && !sources.includes(input.source)) return { route: "dropped" as const }
  if (input.text.trim() === "") return { route: "dropped" as const }
  const formatted = formatTrigger(input)
  // Which directory this trigger belongs to: with per-directory routers the
  // thread binding / alias match decides the partition, otherwise everything
  // stays in the default partition (the pre-partition behaviour).
  const directory = perDirectoryRouterEnabled()
    ? resolveDirectory({ threadID: input.threadID, task: input.text })
    : undefined
  const partition = dirStateForDirectory(directory)
  // Sticky thread affinity: follow-ups on a known thread go straight back to
  // its worker instead of spawning a fresh session per message. Running
  // workers get everything; otherwise the most recent idle/done worker is
  // resumed (prompting a finished session starts a new execution in it, and
  // the watcher flips it back to running). Failed workers are skipped so the
  // next message gets a fresh dispatch through the Router. A genuinely new
  // thread (no affinity record) starts with the Router.
  const subscribed = partition.threads.get(input.threadID) ?? []
  const running = subscribed.filter((sessionID) => store.workers.get(sessionID)?.state === "running")
  const resumed = [...subscribed].reverse().find((sessionID) => {
    const state = store.workers.get(sessionID)?.state
    return state === "idle" || state === "done"
  })
  const targets = running.length > 0 ? running : resumed === undefined ? [] : [resumed]
  if (targets.length > 0) {
    const sessions = ctx.session
    let delivered = 0
    for (const target of targets) {
      const ok = yield* sessions.prompt({ sessionID: toSessionID(target), text: formatted, delivery: "queue" }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("superagent direct-to-worker prompt failed", { worker: target, cause }).pipe(
            Effect.as(false),
          ),
        ),
      )
      if (ok) delivered += 1
    }
    if (delivered > 0) return { route: "worker" as const, sessionID: targets[0] }
  }
  yield* enqueuePending(ctx, input, partition.dirKey)
  const routerID = yield* ensureRouter(ctx, {
    dirKey: partition.dirKey,
    ...(directory === undefined ? {} : { directory }),
  })
  if (!partition.routerBusy) yield* flushPending(ctx, { dirKey: partition.dirKey })
  return { route: "router" as const, sessionID: routerID }
})

/**
 * The RPC surface this server registers. It is the shared `Definition` object
 * itself, not a copy: `stop.rejected` and `dispatch.rejected` live in
 * `src/protocol.ts`, which is also what the TUI imports, so the server and the
 * TUI can never advertise different errors.
 */
export const ServerDefinition = Definition satisfies Rpc.Definition

type ServerRpcHandlers = RpcHandlers<typeof ServerDefinition>

/**
 * Router-only RPC methods are rejected unconditionally.
 *
 * The RPC transport does not expose a caller identity: `RpcCallContext` only
 * carries `error`. The old handler therefore passed `store.routerID` as
 * `runDispatch`'s caller, which let every RPC client act as the router. Input
 * fields such as `caller` / `routerID` are just as forgeable (and the router
 * id is public in `status`), so they are never used as proof of identity.
 * Until the host exposes the calling session on the RPC context, the safe
 * behavior is to keep router-only effects off the RPC surface. The real
 * router still works through its tools, whose `context.sessionID` is
 * authoritative and is checked by `runDispatch` / `runAbort`.
 */
export const rejectedRouterRpc: Pick<ServerRpcHandlers, "dispatch" | "stop"> = {
  dispatch: (_input, context) =>
    Effect.fail(
      context.error(
        "dispatch.rejected",
        "dispatch is only available to the router session; RPC callers cannot prove that identity — use the router's dispatch tool",
        {},
      ),
    ),
  stop: (_input, context) =>
    Effect.fail(
      context.error(
        "stop.rejected",
        "stop is only available to the router session; RPC callers cannot prove that identity — use abort_session from the router",
        {},
      ),
    ),
}

export default Plugin.define({
  id: "opencode.superagent",
  effect: Effect.fn(function* (ctx) {
    // Version only: no paths, options or tokens. Makes a stale gateway obvious
    // in the log right after an upgrade (the plugin has no hot reload).
    yield* Effect.logInfo(versionNotice())
    // Resolve plugin options once, before any hydrate: the directory-partition
    // switch decides where state is read and written, so it must not be read
    // lazily per call after some state has already been routed.
    applySettings(ctx.options)
    // A configured-but-unusable `routerDirectory` is ignored (never fatal) and
    // reported once per process, not once per loaded location.
    const routerDirectoryWarning = takeRouterDirectoryWarning()
    if (routerDirectoryWarning !== undefined) yield* Effect.logWarning(routerDirectoryWarning)
    // Tickets first: hydrating workers reconciles finished `running` records
    // and closes their tickets, so the ticket store must already be loaded.
    yield* hydrateTickets(ctx)
    yield* hydrate(ctx)
    // Before any session work: the Router and Worker sessions resolve their agent by id.
    yield* registerAgents(ctx)
    yield* hydratePending(ctx)
    yield* hydrateDirs(ctx)
    yield* hydrateSessionMeta(ctx)
    yield* hydrateReports(ctx)
    yield* registerTools(ctx)
    yield* registerSleep(ctx)
    yield* registerTicketTools(ctx)
    yield* registerAbort(ctx)
    yield* registerWorkerPrompt(ctx)
    yield* registerContext(ctx)
    yield* registerRouterIdle(ctx)
    yield* registerWatcher(ctx)
    yield* registerWatchdog(ctx)
    yield* ctx.rpc
      .register(ServerDefinition, {
        router: (input) =>
          // Stage 3: the TUI passes its session directory so a per-directory
          // install opens (or reuses) that directory's Router. With the flag off
          // `ensureRouter` collapses every directory onto the default partition.
          ensureRouter(ctx, input.directory === undefined ? {} : { directory: input.directory }).pipe(
            Effect.map((sessionID) => ({ sessionID })),
            Effect.catch((cause) =>
              Effect.logWarning("superagent router handler failed", { cause }).pipe(
                Effect.andThen(Effect.die(new Error("superagent router is unavailable"))),
              ),
            ),
          ),
        status: (input) =>
          Effect.sync(() =>
            statusSnapshot(input.directory === undefined ? {} : { directory: input.directory }),
          ),
        tickets: (input, context) => {
          // The protocol literal already rejects unknown states with
          // `rpc.invalid_input`; keep an explicit RPC error as a second line of
          // defence so a bypassed/older client can never turn an unknown status
          // into an unfiltered list.
          if (input.status !== undefined && !TICKET_STATES.includes(input.status as TicketState)) {
            return Effect.fail(
              context.error("tickets.invalid_status", `invalid ticket status: ${String(input.status)}`, {
                status: String(input.status),
              }),
            )
          }
          // The aggregate view (`all: true`): every partition, grouped by
          // directory. It ignores `directory` — "all" and "one directory" are
          // different questions, and asking for both is not an error, just the
          // aggregate answer.
          if (input.all === true) {
            return renderAllTicketsTextDeep(ctx, {
              ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }).pipe(Effect.map((text) => ({ text })))
          }
          // Stage 3: a directory argument scopes the read to that partition;
          // omitting it keeps the process-wide list (the pre-3 behaviour).
          // `dirKeyFor` already collapses to the default partition when the
          // flag is off, so old TUI builds see the same list as before.
          const dirKey = input.directory === undefined ? undefined : dirKeyFor(input.directory)
          // Read through the ticket store's KV fallback: memory only keeps the
          // newest tickets, and a trimmed one must not look missing here.
          return renderTicketsTextDeep(
            ctx,
            {
              ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            },
            dirKey,
          ).pipe(Effect.map((text) => ({ text })))
        },
        ticket: (input) => renderTicketTextDeep(ctx, input.ticketID).pipe(Effect.map((text) => ({ text }))),
        ...rejectedRouterRpc,
        trigger: (input) =>
          runTrigger(ctx, input).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("superagent trigger handler failed", { cause }).pipe(
                Effect.as({ route: "dropped" as const }),
              ),
            ),
          ),
        abort: (input, context) =>
          runAbort(ctx, input).pipe(
            Effect.map((result) => ({ text: result.output.text })),
            Effect.catchTag("Tool.Error", (error) => Effect.fail(context.error("abort.rejected", error.message, {}))),
          ),
      })
      .pipe(Effect.orDie)
  }),
})
