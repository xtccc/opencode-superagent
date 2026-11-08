import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { registerAbort, runAbort } from "./src/abort.js"
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

const runStop = Effect.fn("superagent.runStop")(function* (ctx: Plugin.Context, sessionID: string) {
  if (!store.workers.has(sessionID)) return { interrupted: false }
  const result = yield* ctx.session
    .interrupt({ sessionID: toSessionID(sessionID) })
    .pipe(Effect.catch(() => Effect.succeed({ interrupted: false })))
  return { interrupted: result.interrupted }
})

export default Plugin.define({
  id: "opencode.superagent",
  effect: Effect.fn(function* (ctx) {
    yield* hydrate(ctx)
    yield* hydratePending(ctx)
    yield* hydrateDirs(ctx)
    yield* hydrateSessionMeta(ctx)
    yield* hydrateTickets(ctx)
    yield* hydrateReports(ctx)
    yield* registerTools(ctx)
    yield* registerTicketTools(ctx)
    yield* registerAbort(ctx)
    yield* registerContext(ctx)
    yield* registerRouterIdle(ctx)
    yield* registerWatcher(ctx)
    yield* registerWatchdog(ctx)
    yield* ctx.rpc
      .register(Definition, {
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
        tickets: (input) =>
          Effect.sync(() =>
            renderTicketsText({
              ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
              ...(input.status === undefined || !TICKET_STATES.includes(input.status as TicketState)
                ? {}
                : { status: input.status as TicketState }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
          ).pipe(Effect.map((text) => ({ text }))),
        ticket: (input) => Effect.sync(() => ({ text: renderTicketText(input.ticketID) })),
        trigger: (input) =>
          runTrigger(ctx, input).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("superagent trigger handler failed", { cause }).pipe(
                Effect.as({ route: "dropped" as const }),
              ),
            ),
          ),
        stop: (input) =>
          runStop(ctx, input.sessionID).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("superagent stop handler failed", { cause }).pipe(Effect.as({ interrupted: false })),
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
