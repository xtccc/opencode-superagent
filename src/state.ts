import type { Plugin } from "@opencode/plugin/effect"
import type { Session } from "@opencode/schema/session"
import { Effect, type Schema } from "effect"

export type WorkerState = "running" | "idle" | "failed" | "done"

export interface WorkerRecord {
  readonly sessionID: string
  readonly title?: string
  readonly threads: Array<string>
  state: WorkerState
  readonly createdAt: number
  lastReport?: string
}

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
  workers: new Map(),
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

const STATES: ReadonlyArray<WorkerState> = ["running", "idle", "failed", "done"]

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
  if (typeof value["state"] !== "string" || !STATES.includes(value["state"] as WorkerState)) return undefined
  const threads = stringArray(value["threads"])
  if (threads === undefined) return undefined
  return {
    sessionID: value["sessionID"],
    title: optionalString(value, "title"),
    threads,
    state: value["state"] as WorkerState,
    createdAt: optionalNumber(value, "createdAt") ?? 0,
    lastReport: optionalString(value, "lastReport"),
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
  }
}

export function encodeWorker(record: WorkerRecord): Schema.Json {
  return {
    sessionID: record.sessionID,
    ...(record.title === undefined ? {} : { title: record.title }),
    threads: [...record.threads],
    state: record.state,
    createdAt: record.createdAt,
    ...(record.lastReport === undefined ? {} : { lastReport: record.lastReport }),
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
})

export const saveWorker = persistWorker

export const saveTrigger = persistTrigger

export const saveThread = Effect.fn("superagent.saveThread")(function* (ctx: Plugin.Context, record: ThreadRecord) {
  yield* ctx.storage
    .set(threadKey(record.threadID), encodeThread(record))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
})
