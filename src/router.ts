import { Agent, type Plugin } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Option, Semaphore, type Schema } from "effect"
import { createHash } from "node:crypto"
import { ROUTER_AGENT } from "./agents.js"
import { buildStatusInjection } from "./context.js"
import { threadDirHint } from "./dirs.js"
import { formatTrigger } from "./format.js"
import { ROUTER_TITLE, superagentMetadata } from "./session-meta.js"
import { ROUTER_KEY, store, toSessionID, type PendingTrigger, type TriggerInput } from "./state.js"
import { noteRouterTrigger } from "./ticket.js"
import { ROUTER_PERMISSIONS } from "./tools.js"

const MAX_FLUSH = 20

/**
 * Serialise flushes. A second caller waits for the in-flight flush to finish,
 * then observes the drained queue and only flushes events enqueued meanwhile,
 * so the same batch is never injected twice. Effect releases the permit on
 * success, failure and interruption.
 */
const flushLock = Semaphore.makeUnsafe(1)

/** KV prefix for crash-safe pending triggers. Owned by the router; `state.ts` stays untouched. */
export const PENDING_PREFIX = "pending:"

const pendingKey = (id: string): string => `${PENDING_PREFIX}${id}`

/** Stable queue identity: explicit id, else source/thread/creation time. */
function pendingID(trigger: TriggerInput, arrivedAt: number): string {
  return trigger.id ?? `${trigger.source}:${trigger.threadID}:${trigger.createdAt ?? arrivedAt}`
}

function keyOf(item: PendingTrigger): string {
  return pendingKey(pendingID(item.trigger, item.arrivedAt))
}

/**
 * Stable identity for one delivered batch: the queued ids, sorted, hashed into
 * a `msg_` id with the same layout as the host's (`12 hex time chars + 14
 * suffix`). A re-delivery of the same batch (e.g. `hydratePending` replaying
 * KV after a crash) carries the same id, so the host dedupes it instead of
 * appending the batch — and its status line — twice.
 */
function batchMessageID(batch: ReadonlyArray<PendingTrigger>): SessionMessage.ID {
  const ids = batch.map((item) => pendingID(item.trigger, item.arrivedAt)).sort().join("\n")
  const suffix = createHash("sha1").update(ids).digest("hex").slice(0, 14)
  // `createdAt` is fixed when the trigger is enqueued and persisted in KV, so a
  // hydrated replay yields the same time prefix; `arrivedAt` is the fallback.
  const newest = batch[batch.length - 1]
  const at = BigInt(newest?.trigger.createdAt ?? newest?.arrivedAt ?? 0)
  const stamp = ((at * 4096n) & 0xffffffffffffn).toString(16).padStart(12, "0")
  return `msg_${stamp}${suffix}` as SessionMessage.ID
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

function decodePending(value: Schema.Json | undefined): PendingTrigger | undefined {
  if (!isRecord(value)) return undefined
  const raw = value["trigger"]
  if (!isRecord(raw)) return undefined
  if (typeof raw["source"] !== "string" || typeof raw["threadID"] !== "string") return undefined
  if (typeof raw["text"] !== "string") return undefined
  const arrivedAt = optionalNumber(value, "arrivedAt")
  if (arrivedAt === undefined) return undefined
  return {
    trigger: {
      id: optionalString(raw, "id"),
      source: raw["source"],
      threadID: raw["threadID"],
      author: optionalString(raw, "author"),
      text: raw["text"],
      title: optionalString(raw, "title"),
      createdAt: optionalNumber(raw, "createdAt"),
    },
    arrivedAt,
  }
}

function encodePending(item: PendingTrigger): Schema.Json {
  return {
    trigger: {
      ...(item.trigger.id === undefined ? {} : { id: item.trigger.id }),
      source: item.trigger.source,
      threadID: item.trigger.threadID,
      ...(item.trigger.author === undefined ? {} : { author: item.trigger.author }),
      text: item.trigger.text,
      ...(item.trigger.title === undefined ? {} : { title: item.trigger.title }),
      ...(item.trigger.createdAt === undefined ? {} : { createdAt: item.trigger.createdAt }),
    },
    arrivedAt: item.arrivedAt,
  } as unknown as Schema.Json
}

/**
 * Enqueue a trigger in memory and in KV. The trigger gets a stable id when
 * the caller did not supply one, so a crash-restarted process can dedupe and
 * rehydrate it. Same-id enqueues are ignored.
 */
export const enqueuePending = Effect.fn("superagent.enqueuePending")(function* (
  ctx: Plugin.Context,
  input: TriggerInput,
) {
  const arrivedAt = Date.now()
  const id = pendingID(input, arrivedAt)
  if (store.pending.some((item) => pendingID(item.trigger, item.arrivedAt) === id)) return
  const item: PendingTrigger = {
    trigger: input.id === undefined ? { ...input, id } : { ...input },
    arrivedAt,
  }
  store.pending.push(item)
  yield* ctx.storage
    .set(keyOf(item), encodePending(item))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist pending trigger", { cause })))
})

/**
 * Reload unflushed triggers left in KV by a crashed process back into the
 * memory queue. Never creates a router session: the queue waits until the
 * next `router` RPC or trigger asks for a flush.
 */
export const hydratePending = Effect.fn("superagent.hydratePending")(function* (ctx: Plugin.Context) {
  let after: string | undefined
  do {
    const page = yield* ctx.storage
      .scan({ prefix: PENDING_PREFIX, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const item = decodePending(entry.value)
      if (item === undefined) {
        yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      const id = pendingID(item.trigger, item.arrivedAt)
      if (store.pending.some((existing) => pendingID(existing.trigger, existing.arrivedAt) === id)) continue
      store.pending.push(
        item.trigger.id === undefined ? { trigger: { ...item.trigger, id }, arrivedAt: item.arrivedAt } : item,
      )
    }
    after = page.next
  } while (after !== undefined)
})

/**
 * Return the live router session, creating it when missing. A router id
 * whose session no longer exists is forgotten before creating a new one,
 * so a user-deleted router is recovered automatically.
 */
export const ensureRouter = Effect.fn("superagent.ensureRouter")(function* (ctx: Plugin.Context) {
  const sessions = ctx.session
  const storage = ctx.storage
  if (store.routerID !== undefined) {
    const cached = yield* sessions.get({ sessionID: toSessionID(store.routerID) }).pipe(Effect.option)
    if (Option.isSome(cached)) return store.routerID
    store.routerID = undefined
    store.routerBusy = false
    yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
  }
  const stored = yield* storage.get(ROUTER_KEY).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (typeof stored === "string") {
    const info = yield* sessions.get({ sessionID: toSessionID(stored) }).pipe(Effect.option)
    if (Option.isSome(info)) {
      store.routerID = info.value.id
      return store.routerID
    }
    yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
  }
  const agents = ctx.agent
  const routerAgent = yield* agents.get({ agentID: Agent.ID.make(ROUTER_AGENT) }).pipe(
    Effect.map((result) => result.data.id),
    Effect.catch((cause) =>
      Effect.logWarning("superagent router agent missing, creating session without it", { cause }).pipe(
        Effect.as(undefined),
      ),
    ),
  )
  const created = yield* sessions.create({
    title: ROUTER_TITLE,
    ...(routerAgent === undefined ? {} : { agent: routerAgent }),
    metadata: superagentMetadata("router"),
    // Derived from the tool catalog: a tool whose permission action is not
    // allowed here is dropped from the Router's toolset by `Tool.snapshot`,
    // so adding a tool without its action would hide it silently.
    permissions: ROUTER_PERMISSIONS,
  })
  store.routerID = created.id
  store.routerBusy = false
  yield* storage
    .set(ROUTER_KEY, created.id)
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist router", { cause })))
  return created.id
})

/**
 * Merge queued triggers into one synthetic prompt for the router. Items
 * leave the queue (memory and KV) only after the injection succeeds; on
 * failure they stay queued for the next attempt.
 *
 * The message is the only place live state enters the prompt: the trigger
 * listing is followed by `buildStatusInjection`, so the counters, tickets and
 * recall land at the tail of the history and the system prefix stays
 * byte-stable (prompt-cache friendly). The synthetic carries a batch-derived
 * id, so replaying the same queue (hydrate after a crash) is deduped by the
 * host instead of appending a second copy.
 */
const flushPendingUnlocked = Effect.fn("superagent.flushPendingUnlocked")(function* (ctx: Plugin.Context) {
  if (store.pending.length === 0) return
  const routerID = yield* ensureRouter(ctx)
  const batch = store.pending.slice(0, MAX_FLUSH)
  // Identity snapshot of this delivery. Removal below matches these ids
  // instead of the queue prefix, so events enqueued while the injection is
  // in flight survive.
  const batchIDs = new Set(batch.map((item) => pendingID(item.trigger, item.arrivedAt)))
  const newest = batch[batch.length - 1]
  // `pending` counts what is still waiting: this batch is being delivered now.
  const pendingAfter = store.pending.filter((item) => !batchIDs.has(pendingID(item.trigger, item.arrivedAt))).length
  const events = [
    `${batch.length} new event(s) for the router:`,
    ...batch.map((item) => {
      const base = formatTrigger(item.trigger)
      const hint = threadDirHint(item.trigger.threadID)
      return hint === undefined ? base : `${base}\n${hint}`
    }),
  ].join("\n\n")
  // Status sits at the very end of the injected message: it is the only part
  // that changes between turns, so keeping it here (and out of `system`)
  // leaves every earlier byte of the request cacheable.
  const text = `${events}\n\n${buildStatusInjection(newest?.trigger.threadID, pendingAfter)}`
  const delivered = yield* ctx.session
    .synthetic({
      sessionID: toSessionID(routerID),
      id: batchMessageID(batch),
      text,
      description: "superagent triggers",
      delivery: "queue",
    })
    .pipe(Effect.option)
  if (Option.isNone(delivered)) {
    yield* Effect.logWarning("superagent failed to flush pending triggers, keeping them queued", {
      count: batch.length,
    })
    return
  }
  // Remove by delivered id, never by position: the queue may have grown at
  // the tail (or been trimmed elsewhere) while `synthetic` was awaited.
  for (let index = store.pending.length - 1; index >= 0; index -= 1) {
    const item = store.pending[index]
    if (item !== undefined && batchIDs.has(pendingID(item.trigger, item.arrivedAt))) {
      store.pending.splice(index, 1)
    }
  }
  // Remember what the Router was just told: `ticket_create` copies this
  // trigger into the ticket's authorization (id + quote).
  if (newest !== undefined) noteRouterTrigger(newest.trigger)
  for (const item of batch) {
    yield* ctx.storage.remove(keyOf(item)).pipe(Effect.catch(() => Effect.void))
  }
})

/**
 * Serialised entry point for every flush caller (idle hook, RPC, tests).
 * Concurrent calls wait on `flushLock`, so one batch is delivered once.
 */
export const flushPending = Effect.fn("superagent.flushPending")(function* (ctx: Plugin.Context) {
  yield* flushLock.withPermit(flushPendingUnlocked(ctx))
})

/**
 * Router idle hook: when the router goes idle with nothing pending in the
 * background, flush queued triggers into the same execution. An empty queue
 * returns without admitting input, so the hook never loops on its own.
 */
export const registerRouterIdle = Effect.fn("superagent.registerRouterIdle")(function* (ctx: Plugin.Context) {
  yield* ctx.session.hook("experimental.idle", (event) =>
    Effect.gen(function* () {
      if (store.routerID === undefined || event.sessionID !== store.routerID) return
      if (event.background.length > 0) return
      yield* flushPending(ctx)
    }).pipe(Effect.catch((cause) => Effect.logWarning("superagent router idle flush failed", { cause }))),
  )
})
