import { Agent, type Plugin } from "@opencode/plugin/effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Option, Semaphore, type Schema } from "effect"
import { createHash } from "node:crypto"
import { ROUTER_AGENT } from "./agents.js"
import { buildStatusInjection } from "./context.js"
import { DEFAULT_DIR_KEY, threadDirHint } from "./dirs.js"
import { formatTrigger } from "./format.js"
import { ROUTER_TITLE, superagentMetadata } from "./session-meta.js"
import { perDirectoryRouterEnabled } from "./settings.js"
import {
  ROUTER_KEY,
  dirKeyFor,
  dirKeyForRouter,
  effectiveDirKey,
  dirScopedKey,
  dirState,
  isRouterSession,
  rememberRouter,
  scanDirScoped,
  scanEntries,
  store,
  toSessionID,
  type PendingTrigger,
  type TriggerInput,
} from "./state.js"
import { noteRouterTrigger } from "./ticket.js"
import { ROUTER_PERMISSIONS } from "./tools.js"

const MAX_FLUSH = 20

/**
 * Default lifetime of an undelivered trigger. A trigger queued before a crash
 * is replayed on restart only while it is younger than this: replaying a
 * day-old follow-up asks the Router to act on a world that has moved on.
 */
export const DEFAULT_PENDING_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How a delivered batch enters the router session. `queue` waits for the next
 * prompt boundary; `steer` is used by the interruptible `sleep` so a trigger
 * that woke the router is visible at the very next step boundary instead of
 * after the current turn finishes.
 */
export type FlushDelivery = "queue" | "steer"

type Lock = ReturnType<typeof Semaphore.makeUnsafe>

/**
 * Per-partition locks. A flush must never interleave with another flush *of
 * the same queue*, and router creation must never run twice *for the same
 * directory*; but two directories are independent, so one directory's slow
 * `sessions.create` must not block the other's flush.
 *
 * Both registries live on `globalThis` (like the store): a duplicate plugin
 * copy would otherwise hold its own semaphore and race the first copy. The
 * symbol version is bumped from the pre-partition single-lock symbol because a
 * stale copy expects a bare `Semaphore`, not this registry; cross-version
 * copies already cannot share state, and `versionNotice` says a restart is
 * required. Effect releases a permit on success, failure and interruption.
 */
const LOCK_REGISTRY_KEY = Symbol.for("opencode-superagent.dir-locks.v2")

interface DirLocks {
  readonly flush: Map<string, Lock>
  readonly router: Map<string, Lock>
}

type GlobalWithDirLocks = typeof globalThis & { [LOCK_REGISTRY_KEY]?: DirLocks }

const lockGlobals = globalThis as GlobalWithDirLocks

const dirLocks: DirLocks = lockGlobals[LOCK_REGISTRY_KEY] ?? { flush: new Map(), router: new Map() }

lockGlobals[LOCK_REGISTRY_KEY] = dirLocks

/** The lock for one (kind, partition); created on first use and kept. */
function lockFor(kind: keyof DirLocks, dirKey: string): Lock {
  const locks = dirLocks[kind]
  const existing = locks.get(dirKey)
  if (existing !== undefined) return existing
  const created = Semaphore.makeUnsafe(1)
  locks.set(dirKey, created)
  return created
}

/** Test hook: number of partitions holding a flush / router lock. */
export function lockPartitions(): { readonly flush: number; readonly router: number } {
  return { flush: dirLocks.flush.size, router: dirLocks.router.size }
}

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
 *
 * `dirKey` names the partition queue; it defaults to the default partition so
 * the flag-off path (and every pre-partition caller) is unchanged.
 */
export const enqueuePending = Effect.fn("superagent.enqueuePending")(function* (
  ctx: Plugin.Context,
  input: TriggerInput,
  dirKey: string = DEFAULT_DIR_KEY,
) {
  const partition = effectiveDirKey(dirKey)
  const arrivedAt = Date.now()
  const id = pendingID(input, arrivedAt)
  const pending = dirState(store, partition).pending
  if (pending.some((item) => pendingID(item.trigger, item.arrivedAt) === id)) return
  const item: PendingTrigger = {
    trigger: input.id === undefined ? { ...input, id } : { ...input },
    arrivedAt,
  }
  pending.push(item)
  yield* ctx.storage
    .set(dirScopedKey(keyOf(item), partition), encodePending(item))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist pending trigger", { cause })))
})

/**
 * Replay TTL from plugin options (`pendingTTLMs`). A non-numeric or
 * non-positive value falls back to the default, so a typo can never turn the
 * pending queue into an unbounded replay.
 */
export function pendingTTLMs(ctx: Plugin.Context): number {
  const configured = ctx.options["pendingTTLMs"]
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_PENDING_TTL_MS
}

/**
 * Staleness is measured from `arrivedAt` (when this process accepted the
 * trigger), not `createdAt`: a source timestamp may legitimately be old by the
 * time a bot relays it, while the arrival time is what a crash interrupted.
 */
function isExpiredPending(item: PendingTrigger, now: number, ttl: number): boolean {
  return now - item.arrivedAt > ttl
}

/**
 * Reload unflushed triggers left in KV by a crashed process back into the
 * memory queue. Never creates a router session: the queue waits until the
 * next `router` RPC or trigger asks for a flush.
 *
 * Entries older than the replay TTL are dropped from KV instead of replayed:
 * a restart days later must not inject a follow-up the thread has moved past.
 * The count is logged and kept on the store so `status` can show it.
 *
 * Both namespaces are read: the legacy `pending:` (default partition) and, when
 * the switch is on, `dir:<dirKey>:pending:` per partition. Each entry returns to
 * the partition that owns it — a replayed trigger must never land in another
 * directory's queue.
 */
export const hydratePending = Effect.fn("superagent.hydratePending")(function* (ctx: Plugin.Context) {
  const ttl = pendingTTLMs(ctx)
  const now = Date.now()
  let dropped = 0
  let oldestDroppedAge = 0
  const groups: Array<{ dirKey: string; entries: ReadonlyArray<{ key: string; value: Schema.Json | undefined }> }> = [
    { dirKey: DEFAULT_DIR_KEY, entries: yield* scanEntries(ctx, PENDING_PREFIX) },
  ]
  for (const entry of yield* scanDirScoped(ctx, PENDING_PREFIX)) groups.push({ dirKey: entry.dirKey, entries: [entry] })
  for (const group of groups) {
    const pending = dirState(store, group.dirKey).pending
    for (const entry of group.entries) {
      const item = decodePending(entry.value)
      if (item === undefined) {
        yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      if (isExpiredPending(item, now, ttl)) {
        dropped += 1
        oldestDroppedAge = Math.max(oldestDroppedAge, now - item.arrivedAt)
        yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      const id = pendingID(item.trigger, item.arrivedAt)
      if (pending.some((existing) => pendingID(existing.trigger, existing.arrivedAt) === id)) continue
      pending.push(item.trigger.id === undefined ? { trigger: { ...item.trigger, id }, arrivedAt: item.arrivedAt } : item)
    }
  }
  if (dropped > 0) {
    store.pendingDropped += dropped
    yield* Effect.logWarning("superagent dropped expired pending triggers on hydrate", {
      dropped,
      ttlMs: ttl,
      oldestAgeMs: oldestDroppedAge,
    })
  }
})

/** Which directory a Router is being requested for. Defaults to the default partition. */
export interface RouterTarget {
  readonly dirKey?: string
  readonly directory?: string
}

/**
 * Return the live router session of a partition, creating it when missing. A
 * router id whose session no longer exists is forgotten before creating a new
 * one, so a user-deleted router is recovered automatically.
 *
 * Every caller goes through the partition's router lock (see
 * `ensureRouterUnlocked`), so the check → create → persist sequence below is
 * never executed concurrently *for the same directory*. Different directories
 * hold different permits and never wait on each other.
 */
export const ensureRouter = Effect.fn("superagent.ensureRouter")(function* (
  ctx: Plugin.Context,
  target: RouterTarget = {},
) {
  const dirKey = effectiveDirKey(target.dirKey ?? dirKeyFor(target.directory))
  const directory = target.directory ?? dirState(store, dirKey).directory
  return yield* lockFor("router", dirKey).withPermit(ensureRouterUnlocked(ctx, dirKey, directory))
})

/**
 * Body of `ensureRouter`, run while the partition's router permit is held.
 * Re-reading the partition's router id and the KV id here is what makes the
 * loser of a race adopt the winner's session instead of creating an orphan.
 */
const ensureRouterUnlocked = Effect.fn("superagent.ensureRouterUnlocked")(function* (
  ctx: Plugin.Context,
  dirKey: string,
  directory: string | undefined,
) {
  const sessions = ctx.session
  const storage = ctx.storage
  const dir = dirState(store, dirKey, directory)
  // Non-default partitions keep their router under their own KV namespace; the
  // default partition keeps the legacy `router` key so upgrades read old state.
  const routerKey = dirScopedKey(ROUTER_KEY, dirKey)
  if (dir.routerID !== undefined) {
    const cached = yield* sessions.get({ sessionID: toSessionID(dir.routerID) }).pipe(Effect.option)
    if (Option.isSome(cached)) return dir.routerID
    rememberRouter(dirKey, undefined)
    dir.routerBusy = false
    yield* storage.remove(routerKey).pipe(Effect.catch(() => Effect.void))
  }
  const stored = yield* storage.get(routerKey).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (typeof stored === "string") {
    const info = yield* sessions.get({ sessionID: toSessionID(stored) }).pipe(Effect.option)
    if (Option.isSome(info)) {
      rememberRouter(dirKey, info.value.id)
      return info.value.id
    }
    yield* storage.remove(routerKey).pipe(Effect.catch(() => Effect.void))
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
  // Each partition's Router lives in that partition's directory: its model
  // resolution, tool cwd and injected directory context then match the workers
  // it dispatches (`dispatch` creates workers the same way). The default
  // partition keeps the host default (`location` omitted), which is what the
  // pre-partition code always did.
  const where = perDirectoryRouterEnabled() && dirKey !== DEFAULT_DIR_KEY ? dir.directory : undefined
  if (perDirectoryRouterEnabled() && dirKey !== DEFAULT_DIR_KEY && where === undefined) {
    yield* Effect.logWarning("superagent router created without a directory: partition has no known path", {
      dirKey,
    })
  }
  const created = yield* sessions.create({
    title: ROUTER_TITLE,
    ...(routerAgent === undefined ? {} : { agent: routerAgent }),
    ...(where === undefined ? {} : { location: { directory: AbsolutePath.make(where) } }),
    metadata: superagentMetadata("router"),
    // Derived from the tool catalog: a tool whose permission action is not
    // allowed here is dropped from the Router's toolset by `Tool.snapshot`,
    // so adding a tool without its action would hide it silently.
    permissions: ROUTER_PERMISSIONS,
  })
  rememberRouter(dirKey, created.id)
  dir.routerBusy = false
  yield* storage
    .set(routerKey, created.id)
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
const flushPendingUnlocked = Effect.fn("superagent.flushPendingUnlocked")(function* (
  ctx: Plugin.Context,
  delivery: FlushDelivery = "queue",
  dirKey: string = DEFAULT_DIR_KEY,
) {
  const dir = dirState(store, dirKey)
  const pending = dir.pending
  if (pending.length === 0) return
  const routerID = yield* ensureRouter(ctx, {
    dirKey,
    ...(dir.directory === undefined ? {} : { directory: dir.directory }),
  })
  const batch = pending.slice(0, MAX_FLUSH)
  // Identity snapshot of this delivery. Removal below matches these ids
  // instead of the queue prefix, so events enqueued while the injection is
  // in flight survive.
  const batchIDs = new Set(batch.map((item) => pendingID(item.trigger, item.arrivedAt)))
  const newest = batch[batch.length - 1]
  // `pending` counts what is still waiting: this batch is being delivered now.
  const pendingAfter = pending.filter((item) => !batchIDs.has(pendingID(item.trigger, item.arrivedAt))).length
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
  const text = `${events}\n\n${buildStatusInjection(newest?.trigger.threadID, pendingAfter, dirKey)}`
  const delivered = yield* ctx.session
    .synthetic({
      sessionID: toSessionID(routerID),
      id: batchMessageID(batch),
      text,
      description: "superagent triggers",
      delivery,
    })
    .pipe(Effect.option)
  if (Option.isNone(delivered)) {
    yield* Effect.logWarning("superagent failed to flush pending triggers, keeping them queued", {
      count: batch.length,
      dirKey,
    })
    return
  }
  // Remove by delivered id, never by position: the queue may have grown at
  // the tail (or been trimmed elsewhere) while `synthetic` was awaited.
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const item = pending[index]
    if (item !== undefined && batchIDs.has(pendingID(item.trigger, item.arrivedAt))) {
      pending.splice(index, 1)
    }
  }
  // Remember what the Router was just told: `ticket_create` copies this
  // trigger into the ticket's authorization (id + quote).
  if (newest !== undefined) noteRouterTrigger(newest.trigger, dirKey)
  for (const item of batch) {
    yield* ctx.storage
      .remove(dirScopedKey(keyOf(item), dirKey))
      .pipe(Effect.catch(() => Effect.void))
  }
})

/**
 * Serialised entry point for every flush caller (idle hook, RPC, tests).
 * Concurrent calls wait on their partition's `flush` lock, so one batch is
 * delivered once; another directory's queue is a different lock and keeps
 * flushing in parallel. `delivery` defaults to `queue`; `sleep` passes `steer`
 * for its wake flush. `dirKey` defaults to the default partition.
 */
export const flushPending = Effect.fn("superagent.flushPending")(function* (
  ctx: Plugin.Context,
  options: { readonly delivery?: FlushDelivery; readonly dirKey?: string } = {},
) {
  const dirKey = effectiveDirKey(options.dirKey)
  yield* lockFor("flush", dirKey).withPermit(flushPendingUnlocked(ctx, options.delivery ?? "queue", dirKey))
})

/**
 * Router idle hook: when a router goes idle with nothing pending in the
 * background, flush *its own* queue into the same execution. An empty queue
 * returns without admitting input, so the hook never loops on its own. The
 * event is matched against every partition's router, so one directory's idle
 * never flushes another directory's triggers.
 */
export const registerRouterIdle = Effect.fn("superagent.registerRouterIdle")(function* (ctx: Plugin.Context) {
  yield* ctx.session.hook("experimental.idle", (event) =>
    Effect.gen(function* () {
      const dirKey = isRouterSession(event.sessionID)
        ? (dirKeyForRouter(event.sessionID) ?? DEFAULT_DIR_KEY)
        : undefined
      if (dirKey === undefined) return
      if (event.background.length > 0) return
      yield* flushPending(ctx, { dirKey })
    }).pipe(Effect.catch((cause) => Effect.logWarning("superagent router idle flush failed", { cause }))),
  )
})
