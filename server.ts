import { Plugin, Rpc } from "@opencode/plugin/effect"
import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect, Schema } from "effect"
import { registerAbort, runAbort } from "./src/abort.js"
import { registerAgents } from "./src/agents.js"
import { registerContext } from "./src/context.js"
import { hydrateDirs } from "./src/dirs.js"
import { registerTools } from "./src/dispatch.js"
import { formatTrigger } from "./src/format.js"
import { Definition } from "./src/protocol.js"
import { hydrateReports } from "./src/report.js"
import { ensureRouter, enqueuePending, flushPending, hydratePending, registerRouterIdle } from "./src/router.js"
import { hydrateSessionMeta } from "./src/session-meta.js"
import { hydrate, store, toSessionID, type TriggerInput } from "./src/state.js"
import { hydrateTickets, TICKET_STATES, type TicketState } from "./src/ticket.js"
import { registerTicketTools, renderTicketText, renderTicketsText } from "./src/ticket-tools.js"
import { registerWatcher } from "./src/watcher.js"
import { registerWatchdog } from "./src/watchdog.js"

const runTrigger = Effect.fn("superagent.runTrigger")(function* (ctx: Plugin.Context, input: TriggerInput) {
  const sources = ctx.options.sources as ReadonlyArray<string> | undefined
  if (Array.isArray(sources) && !sources.includes(input.source)) return { route: "dropped" as const }
  if (input.text.trim() === "") return { route: "dropped" as const }
  const formatted = formatTrigger(input)
  // Sticky thread affinity: follow-ups on a known thread go straight back to
  // its worker instead of spawning a fresh session per message. Running
  // workers get everything; otherwise the most recent idle/done worker is
  // resumed (prompting a finished session starts a new execution in it, and
  // the watcher flips it back to running). Failed workers are skipped so the
  // next message gets a fresh dispatch through the Router. A genuinely new
  // thread (no affinity record) starts with the Router.
  const subscribed = store.threads.get(input.threadID) ?? []
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
  yield* enqueuePending(ctx, input)
  const routerID = yield* ensureRouter(ctx)
  if (!store.routerBusy) yield* flushPending(ctx)
  return { route: "router" as const, sessionID: routerID }
})

/**
 * The RPC surface this server registers. `stop` gains its rejection error here
 * rather than in the shared TUI contract: only the server refuses router-only
 * calls, and the TUI never calls `stop`.
 */
export const ServerDefinition = {
  ...Definition,
  methods: {
    ...Definition.methods,
    stop: {
      ...Definition.methods.stop,
      errors: { "stop.rejected": Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
  },
} as const satisfies Rpc.Definition

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
    yield* registerTicketTools(ctx)
    yield* registerAbort(ctx)
    yield* registerContext(ctx)
    yield* registerRouterIdle(ctx)
    yield* registerWatcher(ctx)
    yield* registerWatchdog(ctx)
    yield* ctx.rpc
      .register(ServerDefinition, {
        router: () =>
          ensureRouter(ctx).pipe(
            Effect.map((sessionID) => ({ sessionID })),
            Effect.catch((cause) =>
              Effect.logWarning("superagent router handler failed", { cause }).pipe(
                Effect.andThen(Effect.die(new Error("superagent router is unavailable"))),
              ),
            ),
          ),
        status: () =>
          Effect.sync(() => ({
            // Omit the key entirely when no router exists: an explicit
            // `undefined` value fails output validation.
            ...(store.routerID === undefined ? {} : { router: store.routerID }),
            pending: store.pending.length,
            workers: [...store.workers.values()].map((worker) => ({
              sessionID: worker.sessionID,
              ...(worker.title === undefined ? {} : { title: worker.title }),
              threads: [...worker.threads],
              state: worker.state,
            })),
          })),
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
          return Effect.sync(() =>
            renderTicketsText({
              ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
          ).pipe(Effect.map((text) => ({ text })))
        },
        ticket: (input) => Effect.sync(() => ({ text: renderTicketText(input.ticketID) })),
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
