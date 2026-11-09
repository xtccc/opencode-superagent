import type { Plugin } from "@opencode/plugin/effect"
import type { Session } from "@opencode/schema/session"
import { DateTime, Effect, type Schema } from "effect"
import { buildReport, lastAssistantText, reportSummary, saveReport } from "./report.js"
import { closeTicketsForWorker } from "./ticket.js"
import { closeOutcomeForWorkerState } from "./ticket-state.js"
import { WORKER_STATES, workers, type WorkerRecord, type WorkerState } from "./worker-state.js"

export type { WorkerRecord, WorkerState } from "./worker-state.js"

export interface ThreadRecord {
  readonly threadID: string
  readonly workers: Array<string>
  readonly updatedAt: number
}

export interface TriggerInput {
  readonly id?: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly title?: string
  readonly createdAt?: number
}

export interface PendingTrigger {
  readonly trigger: TriggerInput
  readonly arrivedAt: number
}

export type TriggerRoute = "router" | "worker"

export interface TriggerRecord {
  readonly id: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly title?: string
  readonly createdAt: number
  route?: TriggerRoute
  sessionID?: string
  /** Workers dispatched from this trigger (reverse of `WorkerRecord.triggerID`). */
  workerIDs?: Array<string>
}

export interface DirectTriggerInput {
  readonly id: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly createdAt: number
}

const ROUTES: ReadonlyArray<TriggerRoute> = ["router", "worker"]

/** Host context for fire-and-forget KV writes from synchronous interception points. Set during hydrate. */
let persistHost: Plugin.Context | undefined

export function triggerIdFor(input: TriggerInput): string {
  return input.id ?? `${input.source}:${input.threadID}:${input.createdAt ?? Date.now()}`
}

function normalizeTrigger(input: TriggerInput): TriggerInput {
  return {
    ...input,
    id: triggerIdFor(input),
    createdAt: input.createdAt ?? Date.now(),
  }
}

function schedulePersist(record: TriggerRecord): void {
  const host = persistHost
  if (host === undefined) return
  const snapshot: TriggerRecord = { ...record }
  Effect.runFork(persistTrigger(host, snapshot).pipe(Effect.catchCause(() => Effect.void)))
}

function rememberQueued(input: TriggerInput): void {
  const id = input.id ?? triggerIdFor(input)
  const delivered = store.triggers.get(id)
  const record: TriggerRecord = {
    id,
    source: input.source,
    threadID: input.threadID,
    ...(input.author === undefined ? {} : { author: input.author }),
    text: input.text,
    ...(input.title === undefined ? {} : { title: input.title }),
    createdAt: input.createdAt ?? Date.now(),
    ...(delivered !== undefined && delivered.route !== undefined ? { route: delivered.route } : {}),
    ...(delivered !== undefined && delivered.sessionID !== undefined ? { sessionID: delivered.sessionID } : {}),
  }
  if (!store.triggers.has(id)) store.triggerTotal += 1
  store.triggers.set(id, record)
  schedulePersist(record)
}

function markFlushed(removed: Array<PendingTrigger>): void {
  for (const item of removed) {
    const id = item.trigger.id ?? triggerIdFor(item.trigger)
    const record = store.triggers.get(id)
    if (record === undefined) continue
    record.route = "router"
    if (store.routerID !== undefined) record.sessionID = store.routerID
    schedulePersist(record)
  }
}

/**
 * Queue that transparently records trigger history. `server.ts` and
 * `router.ts` keep using plain `push`/`splice`; interception here writes
 * the memory map synchronously and persists to KV in the background, so
 * no caller changes are needed.
 */
export class PendingQueue extends Array<PendingTrigger> {
  override push(...items: Array<PendingTrigger>): number {
    const normalized = items.map((item) => ({ trigger: normalizeTrigger(item.trigger), arrivedAt: item.arrivedAt }))
    for (const item of normalized) rememberQueued(item.trigger)
    return super.push(...normalized)
  }
  override splice(start: number, deleteCount?: number, ...items: Array<PendingTrigger>): Array<PendingTrigger> {
    const removed = deleteCount === undefined ? super.splice(start) : super.splice(start, deleteCount, ...items)
    if (removed.length > 0) markFlushed(removed)
    return removed
  }
}

/**
 * Record a trigger delivered straight to a worker (it never passes the
 * pending queue). The text comes from the admitted prompt, so it carries
 * the same truncation as the worker-visible format; queued triggers keep
 * their full text via `rememberQueued`.
 */
export function upsertDirectTrigger(input: DirectTriggerInput, sessionID: string): TriggerRecord {
  const existing = store.triggers.get(input.id)
  if (existing !== undefined) {
    if (existing.route === undefined) existing.route = "worker"
    if (existing.sessionID === undefined) existing.sessionID = sessionID
    schedulePersist(existing)
    return existing
  }
  const record: TriggerRecord = {
    id: input.id,
    source: input.source,
    threadID: input.threadID,
    ...(input.author === undefined ? {} : { author: input.author }),
    text: input.text,
    createdAt: input.createdAt,
    route: "worker",
    sessionID,
  }
  store.triggers.set(input.id, record)
  store.triggerTotal += 1
  schedulePersist(record)
  return record
}

export interface Store {
  routerID: string | undefined
  routerBusy: boolean
  readonly workers: Map<string, WorkerRecord>
  readonly threads: Map<string, Array<string>>
  readonly pending: Array<PendingTrigger>
  readonly triggers: Map<string, TriggerRecord>
  triggerTotal: number
}

export const store: Store = {
  routerID: undefined,
  routerBusy: false,
  workers,
  threads: new Map(),
  pending: new PendingQueue(),
  triggers: new Map(),
  triggerTotal: 0,
}

export const ROUTER_KEY = "router"
export const WORKER_PREFIX = "worker:"
export const THREAD_PREFIX = "thread:"
export const TRIGGER_PREFIX = "trigger:"

const RECENT_TRIGGER_LIMIT = 200

export const workerKey = (sessionID: string) => `${WORKER_PREFIX}${sessionID}`
export const threadKey = (threadID: string) => `${THREAD_PREFIX}${threadID}`
export const triggerKey = (id: string) => `${TRIGGER_PREFIX}${id}`

/** Brands are compile-time only, so a validated session id string converts freely. */
export const toSessionID = (id: string) => id as Session.ID

/** A Session is running while `time.busy` is newer than the last completed execution's `time.idle`. */
export function isRunning(info: Session.Info): boolean {
  const busy = info.time.busy
  if (busy === undefined) return false
  const idle = info.time.idle
  return idle === undefined || DateTime.toEpochMillis(busy) > DateTime.toEpochMillis(idle)
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

function stringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === "string")) return undefined
  return [...value]
}

export function decodeWorker(value: Schema.Json | undefined): WorkerRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["sessionID"] !== "string") return undefined
  if (typeof value["state"] !== "string" || !WORKER_STATES.includes(value["state"] as WorkerState)) return undefined
  const threads = stringArray(value["threads"])
  if (threads === undefined) return undefined
  const createdAt = optionalNumber(value, "createdAt") ?? 0
  const triggerID = optionalString(value, "triggerID")
  return {
    sessionID: value["sessionID"],
    title: optionalString(value, "title"),
    // Legacy records have no `threadID`; hydrate backfills it from the thread
    // record (or `threads[0]`) and persists the result.
    threadID: optionalString(value, "threadID") ?? "",
    ...(triggerID === undefined ? {} : { triggerID }),
    threads,
    state: value["state"] as WorkerState,
    createdAt,
    updatedAt: optionalNumber(value, "updatedAt") ?? createdAt,
    lastReport: optionalString(value, "lastReport"),
    ...(optionalString(value, "directory") === undefined ? {} : { directory: optionalString(value, "directory") }),
  }
}

export function decodeThread(value: Schema.Json | undefined): ThreadRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["threadID"] !== "string") return undefined
  const workers = stringArray(value["workers"])
  if (workers === undefined) return undefined
  return {
    threadID: value["threadID"],
    workers,
    updatedAt: optionalNumber(value, "updatedAt") ?? 0,
  }
}

export function decodeTrigger(value: Schema.Json | undefined): TriggerRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["id"] !== "string") return undefined
  if (typeof value["source"] !== "string") return undefined
  if (typeof value["threadID"] !== "string") return undefined
  if (typeof value["text"] !== "string") return undefined
  const route = value["route"]
  if (route !== undefined && (typeof route !== "string" || !ROUTES.includes(route as TriggerRoute))) return undefined
  const sessionID = optionalString(value, "sessionID")
  const workerIDs = stringArray(value["workerIDs"])
  return {
    id: value["id"],
    source: value["source"],
    threadID: value["threadID"],
    author: optionalString(value, "author"),
    text: value["text"],
    title: optionalString(value, "title"),
    createdAt: optionalNumber(value, "createdAt") ?? 0,
    ...(route === undefined ? {} : { route: route as TriggerRoute }),
    ...(sessionID === undefined ? {} : { sessionID }),
    ...(workerIDs === undefined || workerIDs.length === 0 ? {} : { workerIDs }),
  }
}

export function encodeWorker(record: WorkerRecord): Schema.Json {
  return {
    sessionID: record.sessionID,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.threadID === "" ? {} : { threadID: record.threadID }),
    ...(record.triggerID === undefined ? {} : { triggerID: record.triggerID }),
    threads: [...record.threads],
    state: record.state,
    createdAt: record.createdAt,
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    ...(record.lastReport === undefined ? {} : { lastReport: record.lastReport }),
    ...(record.directory === undefined ? {} : { directory: record.directory }),
  } as unknown as Schema.Json
}

export function encodeThread(record: ThreadRecord): Schema.Json {
  return {
    threadID: record.threadID,
    workers: [...record.workers],
    updatedAt: record.updatedAt,
  } as unknown as Schema.Json
}

export function encodeTrigger(record: TriggerRecord): Schema.Json {
  return {
    id: record.id,
    source: record.source,
    threadID: record.threadID,
    ...(record.author === undefined ? {} : { author: record.author }),
    text: record.text,
    ...(record.title === undefined ? {} : { title: record.title }),
    createdAt: record.createdAt,
    ...(record.route === undefined ? {} : { route: record.route }),
    ...(record.sessionID === undefined ? {} : { sessionID: record.sessionID }),
    ...(record.workerIDs === undefined || record.workerIDs.length === 0 ? {} : { workerIDs: [...record.workerIDs] }),
  } as unknown as Schema.Json
}

const persistWorker = Effect.fn("superagent.persistWorker")(function* (ctx: Plugin.Context, record: WorkerRecord) {
  yield* ctx.storage
    .set(workerKey(record.sessionID), encodeWorker(record))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist worker", { cause })))
})

const persistTrigger = Effect.fn("superagent.persistTrigger")(function* (ctx: Plugin.Context, record: TriggerRecord) {
  yield* ctx.storage
    .set(triggerKey(record.id), encodeTrigger(record))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist trigger", { cause })))
})

const removeWorker = Effect.fn("superagent.removeWorker")(function* (ctx: Plugin.Context, sessionID: string) {
  store.workers.delete(sessionID)
  yield* ctx.storage
    .remove(workerKey(sessionID))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to remove worker", { cause })))
})

/**
 * Reconcile one hydrated `running` record with the live session. A session
 * that is still executing keeps `running`; one that finished while the plugin
 * was down is backfilled the same way the watcher would have handled it:
 * capture the last assistant report, persist the terminal/interrupted state,
 * and close its ticket for `done`/`failed`.
 */
const reconcileRunningWorker = Effect.fn("superagent.reconcileRunningWorker")(function* (
  ctx: Plugin.Context,
  record: WorkerRecord,
  info: Session.Info,
) {
  if (isRunning(info)) return
  const state: WorkerState =
    info.outcome === "succeeded" ? "done" : info.outcome === "failed" ? "failed" : "idle"
  record.state = state
  const sessions = ctx.session
  const messages =
    typeof sessions.context === "function"
      ? yield* sessions
          .context({ sessionID: toSessionID(record.sessionID) })
          .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)))
      : ([] as ReadonlyArray<unknown>)
  const report = lastAssistantText(messages)
  if (report !== undefined) {
    const captured = buildReport(record.sessionID, report)
    yield* saveReport(ctx, captured)
    record.lastReport = reportSummary(captured)
  }
  yield* saveWorker(ctx, record)
  const outcome = closeOutcomeForWorkerState(state)
  if (outcome !== undefined) {
    yield* closeTicketsForWorker(ctx, {
      sessionID: record.sessionID,
      outcome,
      summary: record.lastReport ?? report ?? `${outcome} (worker ${record.sessionID})`,
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to close ticket for rehydrated worker", {
          sessionID: record.sessionID,
          cause,
        }),
      ),
    )
  }
  yield* Effect.logInfo("superagent rehydrated ended worker", { sessionID: record.sessionID, state })
})

/**
 * Load KV state into the in-memory maps. Storage is the unique source of
 * truth; every loaded session is validated with `session.get` and stale
 * entries are cleaned from both memory and KV.
 */
export const hydrate = Effect.fn("superagent.hydrate")(function* (ctx: Plugin.Context) {
  persistHost = ctx
  const sessions = ctx.session
  const storage = ctx.storage
  const storedRouter = yield* storage.get(ROUTER_KEY).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (typeof storedRouter === "string") {
    const info = yield* sessions.get({ sessionID: toSessionID(storedRouter) }).pipe(
      Effect.map((session) => session as Session.Info | undefined),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (info === undefined) {
      yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
    } else {
      store.routerID = info.id
    }
  }
  let after: string | undefined
  do {
    const page = yield* storage
      .scan({ prefix: WORKER_PREFIX, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const record = decodeWorker(entry.value)
      if (record === undefined) {
        yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      const info = yield* sessions.get({ sessionID: toSessionID(record.sessionID) }).pipe(
        Effect.map((session) => session as Session.Info | undefined),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (info === undefined) {
        yield* removeWorker(ctx, record.sessionID)
        continue
      }
      store.workers.set(record.sessionID, record)
      if (record.state === "running") yield* reconcileRunningWorker(ctx, record, info)
    }
    after = page.next
  } while (after !== undefined)
  let threadAfter: string | undefined
  do {
    const page = yield* storage
      .scan({ prefix: THREAD_PREFIX, after: threadAfter, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const record = decodeThread(entry.value)
      if (record === undefined) {
        yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      const alive = record.workers.filter((sessionID) => store.workers.has(sessionID))
      if (alive.length === 0) {
        yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      store.threads.set(record.threadID, alive)
    }
    threadAfter = page.next
  } while (threadAfter !== undefined)
  const collected: Array<TriggerRecord> = []
  let triggerAfter: string | undefined
  do {
    const page = yield* storage
      .scan({ prefix: TRIGGER_PREFIX, after: triggerAfter, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const record = decodeTrigger(entry.value)
      if (record === undefined) {
        yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      collected.push(record)
    }
    triggerAfter = page.next
  } while (triggerAfter !== undefined)
  collected.sort((left, right) => right.createdAt - left.createdAt)
  store.triggerTotal = collected.length
  for (const record of collected.slice(0, RECENT_TRIGGER_LIMIT)) {
    if (!store.triggers.has(record.id)) store.triggers.set(record.id, record)
  }
  // ── reference graph backfill (idempotent) ──────────────────────────────────
  // New records carry `threadID`/`triggerID`/`workerIDs`; legacy records only
  // have `threads`. Rebuild a missing edge from what is still authoritative
  // (the thread affinity list, or the opposite edge) and persist only changed
  // records, so a second hydrate writes nothing and only a stat line is logged.
  let backfilledWorkers = 0
  let backfilledTriggers = 0
  for (const [threadID, workerIDs] of store.threads) {
    for (const sessionID of workerIDs) {
      const worker = store.workers.get(sessionID)
      if (worker === undefined || worker.threadID !== "") continue
      worker.threadID = threadID
      backfilledWorkers += 1
      yield* persistWorker(ctx, worker)
    }
  }
  for (const worker of store.workers.values()) {
    if (worker.threadID !== "") continue
    const primary = worker.threads[0]
    if (primary === undefined) continue
    worker.threadID = primary
    backfilledWorkers += 1
    yield* persistWorker(ctx, worker)
  }
  for (const worker of store.workers.values()) {
    const triggerID = worker.triggerID
    if (triggerID === undefined) continue
    const trigger = store.triggers.get(triggerID)
    if (trigger === undefined) continue
    const ids = trigger.workerIDs ?? []
    if (ids.includes(worker.sessionID)) continue
    trigger.workerIDs = [...ids, worker.sessionID]
    backfilledTriggers += 1
    yield* persistTrigger(ctx, trigger)
  }
  for (const trigger of store.triggers.values()) {
    for (const sessionID of trigger.workerIDs ?? []) {
      const worker = store.workers.get(sessionID)
      if (worker === undefined || worker.triggerID !== undefined) continue
      worker.triggerID = trigger.id
      backfilledWorkers += 1
      yield* persistWorker(ctx, worker)
    }
  }
  if (backfilledWorkers > 0 || backfilledTriggers > 0) {
    yield* Effect.logInfo("superagent reference graph backfilled", {
      workers: backfilledWorkers,
      triggers: backfilledTriggers,
    })
  }
})

/** Every worker write refreshes `updatedAt`, so an aborted record keeps a traceable timestamp. */
export const saveWorker = Effect.fn("superagent.saveWorker")(function* (ctx: Plugin.Context, record: WorkerRecord) {
  record.updatedAt = Date.now()
  yield* persistWorker(ctx, record)
})

export const saveTrigger = persistTrigger

/**
 * Record the worker on the trigger that authorized it (`trigger.workerIDs`),
 * completing the reverse edge of `WorkerRecord.triggerID`. Memory holds only
 * the newest triggers, so an older trigger is read from KV once; a missing
 * trigger is not invented. Repeating the call is a no-op.
 */
export const linkTriggerToWorker = Effect.fn("superagent.linkTriggerToWorker")(function* (
  ctx: Plugin.Context,
  triggerID: string,
  sessionID: string,
) {
  const existing = store.triggers.get(triggerID)
  const record =
    existing ??
    decodeTrigger(yield* ctx.storage.get(triggerKey(triggerID)).pipe(Effect.catch(() => Effect.succeed(undefined))))
  if (record === undefined) return false
  const workerIDs = record.workerIDs ?? []
  if (workerIDs.includes(sessionID)) return false
  record.workerIDs = [...workerIDs, sessionID]
  yield* persistTrigger(ctx, record)
  return true
})

export const saveThread = Effect.fn("superagent.saveThread")(function* (ctx: Plugin.Context, record: ThreadRecord) {
  yield* ctx.storage
    .set(threadKey(record.threadID), encodeThread(record))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
})
