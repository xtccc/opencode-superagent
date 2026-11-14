import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Exit, type Schema } from "effect"
import { createHash } from "node:crypto"
import { DEFAULT_DIR_KEY, DIRECTORY_ERROR, effectiveDirKey, normalizeDirectory, workerOwnerDirKey } from "./dirs.js"
import { clipCodePoints, codePointLength } from "./format.js"
import { dirScopedKey, scanDirScoped, scanEntries } from "./scope.js"
import {
  ACTIVE_STATES,
  findActiveTicketForWorker,
  isTerminalState,
  PRIORITIES,
  TICKET_STATES,
  transitionError,
  workerCloseSummary,
  type Ticket,
  type TicketAuthorization,
  type TicketCloseOutcome,
  type TicketHistoryEntry,
  type TicketPriority,
  type TicketState,
} from "./ticket-state.js"
import { isWorkerTerminal, workers } from "./worker-state.js"
import { displayWidth, wrapText } from "./tools.js"

// The ticket domain model is pure and lives in `ticket-state.ts`; keep
// re-exporting it so every existing `from "./ticket.js"` import still works.
export type {
  Ticket,
  TicketAttempt,
  TicketAuthorization,
  TicketCloseOutcome,
  TicketHistoryEntry,
  TicketPriority,
  TicketRequester,
  TicketState,
} from "./ticket-state.js"
export {
  ACTIVE_STATES,
  allowedTransitions,
  canTransition,
  isTerminalState,
  TICKET_STATES,
  transitionError,
} from "./ticket-state.js"
export { isWorkerTerminal, TERMINAL_WORKER_STATES } from "./worker-state.js"

/**
 * Structural copy of the queued trigger input. The ticket layer must not import
 * `state.ts` (that is the cycle this module just broke), and the shape is all
 * `noteRouterTrigger` needs.
 */
export interface TicketTriggerNoteInput {
  readonly id?: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly title?: string
  readonly createdAt?: number
}

/**
 * Ticket (work order) store for the Super-agent P0.
 *
 * A ticket is the durable statement of "what the user asked for and how we
 * will know it is done". The Router creates one before dispatching work; the
 * dispatch records the worker session on it and the worker's terminal state
 * closes it. Records live in KV under `ticket:<id>`; the `ticketidx:*` keys
 * are derived accelerators, so hydration always rebuilds them from the
 * record prefix (a lost index never loses a ticket).
 *
 * State machine:
 *
 *   open ─┬─▶ in_progress ─┬─▶ done
 *         │                ├─▶ failed
 *         │                ├─▶ blocked ──▶ in_progress
 *         ├─▶ blocked      └─▶ cancelled
 *         ├─▶ cancelled
 *         └─▶ superseded
 *
 * `done`, `failed`, `cancelled` and `superseded` are terminal.
 */

export const TICKET_PREFIX = "ticket:"
export const TICKET_STATUS_PREFIX = "ticketidx:status:"
export const TICKET_THREAD_PREFIX = "ticketidx:thread:"
export const TICKET_ALL_KEY = "ticketidx:all"

export const TITLE_MAX = 80
export const OBJECTIVE_MAX = 2000
export const ACCEPTANCE_MAX = 10
export const ACCEPTANCE_ITEM_MAX = 300
export const QUOTE_MAX = 300
export const SUMMARY_MAX = 500

/** Index buckets are capped so a long-lived gateway never writes an unbounded list. */
export const INDEX_LIMIT = 200
/** Newest-N tickets kept in memory; older records stay in KV and reappear after hydrate. */
export const MEMORY_LIMIT = 500

export const LIST_DEFAULT = 20
export const LIST_MAX = 100

/** Lowercased, whitespace-collapsed objective, so wording drift does not defeat dedupe. */
export function normalizeObjective(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

export function dedupeKeyFor(input: {
  readonly source: string
  readonly threadID: string
  readonly objective: string
}): string {
  return createHash("sha1")
    .update(`${input.source}\n${input.threadID}\n${normalizeObjective(input.objective)}`)
    .digest("hex")
}

export const ticketKey = (id: string): string => `${TICKET_PREFIX}${id}`
export const ticketStatusKey = (state: TicketState): string => `${TICKET_STATUS_PREFIX}${state}`
export const ticketThreadKey = (threadID: string): string => `${TICKET_THREAD_PREFIX}${threadID}`

/**
 * 工单的分区归属。
 *
 * 阶段 2b 起，工单与 Router / thread 亲和一样按分区隔离，但**归属口径**是
 * 「谁创建的」而不是「工作目录在哪」：
 *
 * - **KV 布局**：默认分区仍是旧 key（`ticket:<id>` / `ticketidx:*`），非默认分区是
 *   `dir:<dirKey>:ticket:<id>` / `dir:<dirKey>:ticketidx:*`（`dirScopedKey`）。
 *   开关关闭时 `effectiveDirKey` 恒返回默认分区，所以键名逐字节不变。
 * - **归属判定**：工单记录自己的 `dirKey` —— 创建它的 Router 的分区。`directory`
 *   只是工作目录（展示/审计，以及 dispatch 的默认落点），**不参与**归属判断：
 *   一个 Router 可以把 worker 派到任意目录，工单仍然属于它。
 * - **内存**：`tickets` 仍是一张按 id 索引的表（id 全局随机唯一，便于 `getTicket`
 *   这样的进程级视图），分区记在 `ticketPartitions` 里；`byThread` 的 key 是
 *   `(dirKey, threadID)` 复合键，所以同一个 threadID 在两个分区下各有各的桶。
 */
export const tickets = new Map<string, Ticket>()
const ticketPartitions = new Map<string, string>()
const byThread = new Map<string, Set<string>>()
/** 每个分区在 KV 里的记录数（不是内存里剩下的条数）。 */
const kvTotals = new Map<string, number>()

/** `(dirKey, threadID)` 复合键。NUL 不会出现在 thread id 里，分隔无歧义。 */
function threadSlot(dirKey: string, threadID: string): string {
  return `${dirKey}\u0000${threadID}`
}

/** 分区口径：开关关闭时一切都是默认分区（与 `effectiveDirKey` 同一规则）。 */
function scopeOf(dirKey: string | undefined): string {
  return effectiveDirKey(dirKey)
}

/**
 * 一张工单的归属分区：记录自己的 `dirKey`。旧记录（阶段 2b 之前、没有 `dirKey`）
 * 一律归默认分区 —— 那是它们当初唯一可能落在的地方，也是升级后老 Router 还能
 * 看见自己历史数据的原因。
 */
function ticketOwner(ticket: Ticket): string {
  return scopeOf(ticket.dirKey ?? DEFAULT_DIR_KEY)
}

/** 一张工单实际落在哪个分区（内存索引优先，它记录了 hydrate 是从哪个命名空间读到的）。 */
function partitionOf(ticket: Ticket): string {
  return ticketPartitions.get(ticket.id) ?? ticketOwner(ticket)
}

/** 该工单是否对某个分区的调用方可见。`dirKey === undefined` 表示进程级视图。 */
function visibleIn(ticket: Ticket, dirKey: string | undefined): boolean {
  return dirKey === undefined || partitionOf(ticket) === scopeOf(dirKey)
}

/** 只返回某个分区当前分区的工单（进程级视图用 `tickets.values()`）。 */
function inScope(dirKey: string): Array<Ticket> {
  const target = scopeOf(dirKey)
  return [...tickets.values()].filter((ticket) => partitionOf(ticket) === target)
}

/**
 * How many ticket records exist in KV. `hydrateTickets` counts the whole
 * prefix and `createTicket` adds one per new record; nothing else removes a
 * record. Memory only holds the newest `MEMORY_LIMIT` tickets, so
 * `tickets.size < kvTotal` is the signal that a query must fall back to KV
 * instead of reporting "no such ticket" for a trimmed one.
 */
function kvTotal(dirKey: string): number {
  return kvTotals.get(scopeOf(dirKey)) ?? 0
}

function bumpKvTotal(dirKey: string): void {
  const key = scopeOf(dirKey)
  kvTotals.set(key, (kvTotals.get(key) ?? 0) + 1)
}

/** 所有分区在 KV 里的工单总数。 */
export function kvTicketCount(): number {
  let total = 0
  for (const count of kvTotals.values()) total += count
  return total
}

/**
 * True while the in-memory map still mirrors every record in KV.
 * `dirKey === undefined` is the process-wide view (the pre-partition shape).
 */
function memoryComplete(dirKey: string | undefined): boolean {
  if (dirKey === undefined) return tickets.size >= kvTicketCount()
  return inScope(dirKey).length >= kvTotal(dirKey)
}

/**
 * Write-behind state. A ticket (or index bucket) whose KV write failed stays
 * queued here: memory already moved on, so dropping the write would make a
 * restart resurrect the old state. The next write retries it.
 */
const dirty = new Map<string, Ticket>()
const dirtyIndexes = new Map<string, Array<string>>()

/** Ticket ids whose last write failed and is still queued for retry. */
export function dirtyTicketIDs(): ReadonlyArray<string> {
  return [...dirty.keys()]
}

/** Index keys whose last write failed and is still queued for retry. */
export function dirtyTicketIndexKeys(): ReadonlyArray<string> {
  return [...dirtyIndexes.keys()]
}

/**
 * The trigger most recently delivered to the Router. `ticket_create` copies
 * it into `authorization`, so a ticket always points at what the user said.
 * It is a heuristic: the newest flushed trigger wins, which matches how the
 * Router batches queued events before answering.
 *
 * 按分区保存：多个目录的 Router 会各自 flush 各自的队列，共用一条记录会让 B 目录
 * 的工单引用 A 目录的 trigger（甚至 quote 到另一段对话的原文）。
 */
export interface RouterTriggerNote {
  readonly id: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly at: number
}

const routerTriggers = new Map<string, RouterTriggerNote>()

export function noteRouterTrigger(trigger: TicketTriggerNoteInput, dirKey?: string): void {
  routerTriggers.set(scopeOf(dirKey), {
    id: trigger.id ?? `${trigger.source}:${trigger.threadID}:${trigger.createdAt ?? Date.now()}`,
    source: trigger.source,
    threadID: trigger.threadID,
    ...(trigger.author === undefined ? {} : { author: trigger.author }),
    text: trigger.text,
    at: trigger.createdAt ?? Date.now(),
  })
}

export function currentTrigger(dirKey?: string): RouterTriggerNote | undefined {
  return routerTriggers.get(scopeOf(dirKey))
}

/** Reset memory (hydrate and tests): the map and its thread index are rebuilt together. */
export function resetTickets(): void {
  tickets.clear()
  ticketPartitions.clear()
  byThread.clear()
  dirty.clear()
  dirtyIndexes.clear()
  kvTotals.clear()
  routerTriggers.clear()
}

function remember(ticket: Ticket, dirKey?: string): void {
  const partition = scopeOf(dirKey ?? ticket.dirKey ?? DEFAULT_DIR_KEY)
  tickets.set(ticket.id, ticket)
  ticketPartitions.set(ticket.id, partition)
  const slot = threadSlot(partition, ticket.threadID)
  const ids = byThread.get(slot) ?? new Set<string>()
  ids.add(ticket.id)
  byThread.set(slot, ids)
}

function forget(ticket: Ticket): void {
  const slot = threadSlot(partitionOf(ticket), ticket.threadID)
  tickets.delete(ticket.id)
  ticketPartitions.delete(ticket.id)
  const ids = byThread.get(slot)
  ids?.delete(ticket.id)
  if (ids !== undefined && ids.size === 0) byThread.delete(slot)
}

/** Ids of one partition's tickets in one thread. */
function threadIds(dirKey: string | undefined, threadID: string): Array<string> | undefined {
  if (dirKey !== undefined) return [...(byThread.get(threadSlot(scopeOf(dirKey), threadID)) ?? [])]
  const out: Array<string> = []
  for (const [slot, ids] of byThread) {
    if (!slot.endsWith(`\u0000${threadID}`)) continue
    out.push(...ids)
  }
  return out
}

/** Cap memory by dropping the oldest closed tickets; they remain in KV. */
function trimMemory(): void {
  if (tickets.size <= MEMORY_LIMIT) return
  const closable = [...tickets.values()]
    .filter((ticket) => isTerminalState(ticket.state))
    .sort((left, right) => left.updatedAt - right.updatedAt)
  for (const ticket of closable) {
    if (tickets.size <= MEMORY_LIMIT) return
    forget(ticket)
  }
}

/**
 * Process-wide read (the TUI `/tickets` pane). Router-facing code must go
 * through `loadTicket(ctx, id, dirKey)` so a ticket of another directory is
 * invisible, not merely unselectable.
 */
export function getTicket(ticketID: string): Ticket | undefined {
  return tickets.get(ticketID)
}

/**
 * Memory first, KV second. Memory only holds the newest `MEMORY_LIMIT`
 * tickets, so a closed ticket that was trimmed out must still be readable:
 * answering from memory alone is what made the UI claim a ticket in KV did not
 * exist. One `get` on a miss, never a scan.
 *
 * `dirKey` scopes the lookup: a ticket of another partition is reported as
 * unknown (`undefined`), which is what makes cross-directory ids unusable. When
 * `dirKey` is omitted (TUI/RPC) the lookup is process-wide: the legacy key is
 * tried first, then the scoped namespaces once, so a partitioned ticket is
 * still readable from the user-facing surface.
 */
export const loadTicket = Effect.fn("superagent.loadTicket")(function* (
  ctx: Plugin.Context,
  ticketID: string,
  dirKey?: string,
) {
  const id = ticketID.trim()
  const cached = tickets.get(id)
  if (cached !== undefined) return visibleIn(cached, dirKey) ? cached : undefined
  const owner = dirKey === undefined ? undefined : scopeOf(dirKey)
  // Where the record was physically read from. A record written before the
  // ownership field existed has no `dirKey` of its own, and the namespace it
  // lives in is then the only statement about its partition.
  let readFrom: string | undefined = owner
  let value = yield* ctx.storage
    .get(owner === undefined ? ticketKey(id) : dirScopedKey(ticketKey(id), owner))
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to read ticket from storage", { ticketID: id, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    )
  if (value === undefined && owner === undefined) {
    for (const entry of yield* scanDirScoped(ctx, TICKET_PREFIX)) {
      if (entry.suffix !== ticketKey(id)) continue
      value = entry.value
      readFrom = entry.dirKey
      break
    }
  }
  const ticket = decodeTicket(value)
  if (ticket === undefined) return undefined
  // Ownership is the record's own `dirKey` (or the namespace it came from), not
  // its working directory: a misplaced key must not become a visible ticket in
  // the wrong partition, and a cross-directory dispatch must stay readable.
  const derived = ticket.dirKey === undefined ? scopeOf(readFrom ?? DEFAULT_DIR_KEY) : ticketOwner(ticket)
  if (dirKey !== undefined && derived !== scopeOf(dirKey)) return undefined
  // Re-cache only while there is room: a read must not push memory back over
  // the cap it was trimmed to.
  if (tickets.size < MEMORY_LIMIT) remember(ticket, derived)
  return ticket
})

/** Same-thread, same-dedupe-key ticket still open or in progress, if any. */
export function findDuplicate(threadID: string, dedupeKey: string, dirKey?: string): Ticket | undefined {
  const ids = threadIds(dirKey, threadID)
  // No ids means this thread owns no in-memory ticket, so there is nothing to reuse.
  if (ids === undefined) return undefined
  const candidates = ids.flatMap((id) => tickets.get(id) ?? [])
  return candidates.find((ticket) => ticket.dedupeKey === dedupeKey && ACTIVE_STATES.includes(ticket.state))
}

export function isActive(ticket: Ticket): boolean {
  return ACTIVE_STATES.includes(ticket.state)
}

export interface TicketStats {
  readonly total: number
  readonly open: number
  readonly inProgress: number
  readonly blocked: number
  readonly closed: number
}

/**
 * Ticket counters of one partition (`dirKey === undefined` = the whole
 * process, which is the pre-partition shape and what the TUI shows).
 */
export function ticketStats(dirKey?: string): TicketStats {
  const stats = { total: 0, open: 0, inProgress: 0, blocked: 0, closed: 0 }
  for (const ticket of dirKey === undefined ? tickets.values() : inScope(dirKey)) {
    stats.total += 1
    if (ticket.state === "open") stats.open += 1
    else if (ticket.state === "in_progress") stats.inProgress += 1
    else if (ticket.state === "blocked") stats.blocked += 1
    else stats.closed += 1
  }
  return stats
}

/** Compact "tk_x title; tk_y title" line for the system status, empty when there is nothing active. */
export function activeTicketSummary(threadID: string | undefined, limit = 3, dirKey?: string): string {
  const active = (dirKey === undefined ? [...tickets.values()] : inScope(dirKey))
    .filter((ticket) => ACTIVE_STATES.includes(ticket.state))
    .filter((ticket) => threadID === undefined || ticket.threadID === threadID)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return active
    .slice(0, limit)
    .map((ticket) => `${ticket.id} ${ticket.title}`)
    .join("; ")
}

/**
 * Partition of the worker that owns a session, when it is a tracked worker.
 * Used to scope the ticket lookups the watcher/abort paths make: they only
 * have a session id, and the worker record (not the ticket) knows who
 * dispatched it (`ownerDirKey`, falling back to `directory` for old records).
 */
function workerScope(sessionID: string): string | undefined {
  const worker = workers.get(sessionID)
  return worker === undefined ? undefined : scopeOf(workerOwnerDirKey(worker))
}

/** Active ticket for a worker session, used when a worker ends. */
export function activeTicketForWorker(sessionID: string): Ticket | undefined {
  const dirKey = workerScope(sessionID)
  const pool = dirKey === undefined ? [...tickets.values()] : inScope(dirKey)
  return findActiveTicketForWorker(pool, sessionID)
}

/**
 * The ticket bound to a worker session, including a closed one. Used by
 * `worker_prompt` to refuse waking a worker whose work order already ended.
 * The ticket store is the only worker → ticket mapping; a reused worker
 * session keeps the newest write (a closed ticket is never reopened).
 */
export function ticketForWorker(sessionID: string): Ticket | undefined {
  const dirKey = workerScope(sessionID)
  const pool = dirKey === undefined ? [...tickets.values()] : inScope(dirKey)
  let latest: Ticket | undefined
  for (const ticket of pool) {
    if (ticket.workerSessionID !== sessionID) continue
    if (latest === undefined || ticket.updatedAt > latest.updatedAt) latest = ticket
  }
  return latest
}

// ── validation ────────────────────────────────────────────────────────────────

export function validateCreateInput(input: {
  readonly threadID?: string
  readonly title?: string
  readonly objective?: string
  readonly acceptance?: ReadonlyArray<string>
  readonly directory?: string
}): string | undefined {
  if ((input.threadID ?? "").trim() === "") return "ticket_create needs a threadID"
  const title = (input.title ?? "").trim()
  if (title === "") return "ticket_create needs a non-empty title"
  // Lengths are counted in code points: a 40-emoji title is 40 characters to
  // the user, not the 80 UTF-16 units a naive `length` sees.
  if (codePointLength(title) > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters`
  const objective = (input.objective ?? "").trim()
  if (objective === "") return "ticket_create needs a non-empty objective; ask the user first"
  if (codePointLength(objective) > OBJECTIVE_MAX) return `objective must be at most ${OBJECTIVE_MAX} characters`
  const acceptance = (input.acceptance ?? []).map((item) => item.trim()).filter((item) => item !== "")
  if (acceptance.length === 0) {
    return "ticket_create needs at least one acceptance criterion; ask the user instead of creating an empty ticket"
  }
  if (acceptance.length > ACCEPTANCE_MAX) return `acceptance takes at most ${ACCEPTANCE_MAX} items`
  if (acceptance.some((item) => codePointLength(item) > ACCEPTANCE_ITEM_MAX)) {
    return `each acceptance item must be at most ${ACCEPTANCE_ITEM_MAX} characters`
  }
  if ((input.directory ?? "").trim() === "") return `ticket_create needs a directory: ${DIRECTORY_ERROR}`
  if (normalizeDirectory(input.directory ?? "") === undefined) return DIRECTORY_ERROR
  return undefined
}

function compact(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (codePointLength(clean) <= limit) return clean
  // Code points, not UTF-16 units: cutting a report mid-emoji leaves a lone
  // surrogate that no longer renders as anything.
  return `${clipCodePoints(clean, limit - 1).trimEnd()}…`
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function newTicketID(now: number): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = Math.floor(Math.random() * 36 ** 4)
      .toString(36)
      .padStart(4, "0")
    const id = `tk_${now.toString(36)}_${suffix}`
    if (!tickets.has(id)) return id
  }
  return `tk_${now.toString(36)}_${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`
}

// ── encoding ──────────────────────────────────────────────────────────────────

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
  return value.every((item) => typeof item === "string") ? [...value] : undefined
}

export function decodeTicket(value: Schema.Json | undefined): Ticket | undefined {
  if (!isRecord(value)) return undefined
  const id = optionalString(value, "id")
  const state = optionalString(value, "state")
  const title = optionalString(value, "title")
  const objective = optionalString(value, "objective")
  const threadID = optionalString(value, "threadID")
  const dedupeKey = optionalString(value, "dedupeKey")
  const acceptance = stringArray(value["acceptance"])
  if (id === undefined || state === undefined || title === undefined || objective === undefined) return undefined
  if (threadID === undefined || dedupeKey === undefined) return undefined
  if (acceptance === undefined || acceptance.length === 0) return undefined
  if (!TICKET_STATES.includes(state as TicketState)) return undefined
  const createdAt = optionalNumber(value, "createdAt")
  if (createdAt === undefined) return undefined
  const priority = optionalString(value, "priority")
  const requester = isRecord(value["requester"]) ? value["requester"] : {}
  const authorization = isRecord(value["authorization"]) ? value["authorization"] : {}
  const attempts = Array.isArray(value["attempts"])
    ? value["attempts"].flatMap((item) => {
        if (!isRecord(item)) return []
        const at = optionalNumber(item, "at")
        if (at === undefined) return []
        const sessionID = optionalString(item, "sessionID")
        const note = optionalString(item, "note")
        return [{ at, ...(sessionID === undefined ? {} : { sessionID }), ...(note === undefined ? {} : { note }) }]
      })
    : []
  const history = Array.isArray(value["history"])
    ? value["history"].flatMap((item) => {
        if (!isRecord(item)) return []
        const at = optionalNumber(item, "at")
        const kind = optionalString(item, "kind")
        if (at === undefined || kind === undefined) return []
        const from = optionalString(item, "from")
        const to = optionalString(item, "to")
        const note = optionalString(item, "note")
        return [
          {
            at,
            kind: kind as TicketHistoryEntry["kind"],
            ...(from === undefined ? {} : { from: from as TicketState }),
            ...(to === undefined ? {} : { to: to as TicketState }),
            ...(note === undefined ? {} : { note }),
          },
        ]
      })
    : []
  const workerSessionID = optionalString(value, "workerSessionID")
  const dirKey = optionalString(value, "dirKey")
  const directory = optionalString(value, "directory")
  const parentTicketID = optionalString(value, "parentTicketID")
  const closedAt = optionalNumber(value, "closedAt")
  const closeReason = optionalString(value, "closeReason")
  return {
    id,
    state: state as TicketState,
    title,
    objective,
    acceptance,
    requester: {
      source: optionalString(requester, "source") ?? "unknown",
      threadID: optionalString(requester, "threadID") ?? threadID,
      ...(optionalString(requester, "author") === undefined ? {} : { author: optionalString(requester, "author") }),
    },
    authorization: {
      triggerID: optionalString(authorization, "triggerID") ?? "unknown",
      quote: optionalString(authorization, "quote") ?? "",
      at: optionalNumber(authorization, "at") ?? createdAt,
    },
    threadID,
    ...(workerSessionID === undefined ? {} : { workerSessionID }),
    attempts,
    priority: PRIORITIES.includes(priority as TicketPriority) ? (priority as TicketPriority) : "p1",
    ...(dirKey === undefined ? {} : { dirKey }),
    ...(directory === undefined ? {} : { directory }),
    dedupeKey,
    ...(parentTicketID === undefined ? {} : { parentTicketID }),
    tags: stringArray(value["tags"]) ?? [],
    createdAt,
    updatedAt: optionalNumber(value, "updatedAt") ?? createdAt,
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(closeReason === undefined ? {} : { closeReason }),
    history,
  }
}

export function encodeTicket(ticket: Ticket): Schema.Json {
  return {
    id: ticket.id,
    state: ticket.state,
    title: ticket.title,
    objective: ticket.objective,
    acceptance: [...ticket.acceptance],
    requester: {
      source: ticket.requester.source,
      threadID: ticket.requester.threadID,
      ...(ticket.requester.author === undefined ? {} : { author: ticket.requester.author }),
    },
    authorization: {
      triggerID: ticket.authorization.triggerID,
      quote: ticket.authorization.quote,
      at: ticket.authorization.at,
    },
    threadID: ticket.threadID,
    ...(ticket.workerSessionID === undefined ? {} : { workerSessionID: ticket.workerSessionID }),
    attempts: ticket.attempts.map((attempt) => ({
      at: attempt.at,
      ...(attempt.sessionID === undefined ? {} : { sessionID: attempt.sessionID }),
      ...(attempt.note === undefined ? {} : { note: attempt.note }),
    })),
    priority: ticket.priority,
    ...(ticket.dirKey === undefined ? {} : { dirKey: ticket.dirKey }),
    ...(ticket.directory === undefined ? {} : { directory: ticket.directory }),
    dedupeKey: ticket.dedupeKey,
    ...(ticket.parentTicketID === undefined ? {} : { parentTicketID: ticket.parentTicketID }),
    tags: [...ticket.tags],
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(ticket.closedAt === undefined ? {} : { closedAt: ticket.closedAt }),
    ...(ticket.closeReason === undefined ? {} : { closeReason: ticket.closeReason }),
    history: ticket.history.map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      ...(entry.from === undefined ? {} : { from: entry.from }),
      ...(entry.to === undefined ? {} : { to: entry.to }),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    })),
  } as unknown as Schema.Json
}

// ── persistence ───────────────────────────────────────────────────────────────

function collect(dirKey: string, predicate: (ticket: Ticket) => boolean): Array<string> {
  return inScope(dirKey)
    .filter(predicate)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, INDEX_LIMIT)
    .map((ticket) => ticket.id)
}

/** KV key of a ticket record: its own partition's namespace. */
function storageKeyOf(ticket: Ticket): string {
  return dirScopedKey(ticketKey(ticket.id), partitionOf(ticket))
}

/**
 * Retry everything the last write left behind. Cheap and idempotent: with an
 * empty queue this is a no-op, so every mutation can call it first.
 */
export const flushTicketWrites = Effect.fn("superagent.flushTicketWrites")(function* (ctx: Plugin.Context) {
  for (const [id, snapshot] of [...dirty]) {
    // The live record wins over the snapshot: it is the newest state.
    const ticket = tickets.get(id) ?? snapshot
    const key = storageKeyOf(ticket)
    const exit = yield* Effect.exit(ctx.storage.set(key, encodeTicket(ticket)))
    if (Exit.isSuccess(exit)) {
      dirty.delete(id)
      continue
    }
    yield* Effect.logWarning("superagent ticket write retry failed", {
      ticketID: id,
      state: ticket.state,
      key,
      cause: exit.cause,
    })
  }
  for (const [key, ids] of [...dirtyIndexes]) {
    const exit = yield* Effect.exit(ctx.storage.set(key, ids as unknown as Schema.Json))
    if (Exit.isSuccess(exit)) {
      dirtyIndexes.delete(key)
      continue
    }
    yield* Effect.logWarning("superagent ticket index write retry failed", { key, ids: ids.length, cause: exit.cause })
  }
})

const writeIds = Effect.fn("superagent.persistTicketIndex")(function* (
  ctx: Plugin.Context,
  key: string,
  ids: Array<string>,
) {
  const exit = yield* Effect.exit(ctx.storage.set(key, ids as unknown as Schema.Json))
  if (Exit.isSuccess(exit)) {
    dirtyIndexes.delete(key)
    return
  }
  // Index buckets are derived accelerators, so a lost write never loses a
  // ticket — but the queue keeps it retried instead of silently stale.
  dirtyIndexes.set(key, [...ids])
  yield* Effect.logWarning("superagent failed to persist ticket index; queued for retry", {
    key,
    ids: ids.length,
    cause: exit.cause,
  })
})

const persistTicket = Effect.fn("superagent.persistTicket")(function* (ctx: Plugin.Context, ticket: Ticket) {
  yield* flushTicketWrites(ctx)
  const key = storageKeyOf(ticket)
  const exit = yield* Effect.exit(ctx.storage.set(key, encodeTicket(ticket)))
  if (Exit.isSuccess(exit)) {
    dirty.delete(ticket.id)
    return
  }
  // Never swallow this: memory is already updated, so the write is queued and
  // retried by the next mutation instead of being lost until a restart.
  dirty.set(ticket.id, ticket)
  yield* Effect.logWarning("superagent failed to persist ticket; kept in memory and queued for retry", {
    ticketID: ticket.id,
    state: ticket.state,
    key,
    cause: exit.cause,
  })
})

/** Only the buckets the ticket touches are rewritten; the record prefix stays authoritative. */
const persistIndexes = Effect.fn("superagent.persistTicketIndexes")(function* (ctx: Plugin.Context, ticket: Ticket) {
  const dirKey = partitionOf(ticket)
  yield* writeIds(
    ctx,
    dirScopedKey(TICKET_ALL_KEY, dirKey),
    collect(dirKey, () => true),
  )
  yield* writeIds(
    ctx,
    dirScopedKey(ticketStatusKey(ticket.state), dirKey),
    collect(dirKey, (item) => item.state === ticket.state),
  )
  yield* writeIds(
    ctx,
    dirScopedKey(ticketThreadKey(ticket.threadID), dirKey),
    collect(dirKey, (item) => item.threadID === ticket.threadID),
  )
})

/**
 * Rebuild every index bucket of every partition that has tickets in memory.
 * Indexes are derived accelerators: their namespace follows the record's
 * (`ticketidx:*` for the default partition, `dir:<k>:ticketidx:*` otherwise).
 */
const rewriteIndexes = Effect.fn("superagent.rewriteTicketIndexes")(function* (ctx: Plugin.Context) {
  for (const dirKey of new Set([...tickets.values()].map((ticket) => partitionOf(ticket)))) {
    yield* writeIds(
      ctx,
      dirScopedKey(TICKET_ALL_KEY, dirKey),
      collect(dirKey, () => true),
    )
    for (const state of TICKET_STATES) {
      yield* writeIds(
        ctx,
        dirScopedKey(ticketStatusKey(state), dirKey),
        collect(dirKey, (ticket) => ticket.state === state),
      )
    }
    const threads = new Set(
      inScope(dirKey)
        .map((ticket) => ticket.threadID)
        .filter((threadID) => threadID !== ""),
    )
    for (const threadID of threads) {
      yield* writeIds(
        ctx,
        dirScopedKey(ticketThreadKey(threadID), dirKey),
        collect(dirKey, (ticket) => ticket.threadID === threadID),
      )
    }
  }
})

// ── public API ────────────────────────────────────────────────────────────────

export interface CreateTicketInput {
  readonly threadID: string
  readonly title: string
  readonly objective: string
  readonly acceptance: ReadonlyArray<string>
  readonly directory: string
  readonly source: string
  readonly author?: string
  readonly priority?: TicketPriority
  readonly parentTicketID?: string
  readonly dedupeKey?: string
  readonly tags?: ReadonlyArray<string>
  /** Defaults to the trigger most recently delivered to the Router. */
  readonly authorization?: TicketAuthorization
  /**
   * Partition of the caller (the Router). This is the ticket's owner; it
   * defaults to the default partition (a caller that did not identify itself),
   * **never** to the partition of `directory`: the directory is only the
   * working directory, and one Router may create tickets for any directory.
   */
  readonly dirKey?: string
  readonly now?: number
}

export interface CreateTicketResult {
  readonly ticket: Ticket
  readonly reused: boolean
}

/**
 * Create a ticket, or return the still-open same-key ticket in the same
 * thread (`reused: true`). Objective, acceptance and directory are required;
 * an empty acceptance is rejected so no placeholder ticket can exist.
 */
export const createTicket = Effect.fn("superagent.createTicket")(function* (
  ctx: Plugin.Context,
  input: CreateTicketInput,
) {
  const failure = validateCreateInput(input)
  if (failure !== undefined) return yield* new Tool.Error({ message: failure })
  const now = input.now ?? Date.now()
  const directory = normalizeDirectory(input.directory)
  if (directory === undefined) return yield* new Tool.Error({ message: DIRECTORY_ERROR })
  const acceptance = input.acceptance.map((item) => item.trim()).filter((item) => item !== "")
  // 归属＝调用方 Router 的分区。`directory` 已通过绝对路径校验，但只作为工作目录。
  const dirKey = scopeOf(input.dirKey ?? DEFAULT_DIR_KEY)
  const dedupeKey =
    input.dedupeKey?.trim() ||
    dedupeKeyFor({ source: input.source, threadID: input.threadID, objective: input.objective })
  // Dedupe never crosses partitions: the same thread id and objective in two
  // directories are two independent work orders.
  const duplicate = findDuplicate(input.threadID, dedupeKey, dirKey)
  if (duplicate !== undefined) return { ticket: duplicate, reused: true }
  const trigger = currentTrigger(dirKey)
  const authorization: TicketAuthorization =
    input.authorization ??
    (trigger === undefined
      ? { triggerID: "unknown", quote: "", at: now }
      : { triggerID: trigger.id, quote: compact(trigger.text, QUOTE_MAX), at: trigger.at })
  const ticket: Ticket = {
    id: newTicketID(now),
    state: "open",
    title: compact(input.title, TITLE_MAX),
    objective: input.objective.trim(),
    acceptance,
    requester: {
      source: input.source,
      threadID: input.threadID,
      ...(input.author === undefined ? {} : { author: input.author }),
    },
    authorization,
    threadID: input.threadID,
    attempts: [],
    priority: input.priority ?? "p1",
    dirKey,
    directory,
    dedupeKey,
    ...(input.parentTicketID === undefined ? {} : { parentTicketID: input.parentTicketID }),
    tags: [...(input.tags ?? [])],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, kind: "created", to: "open" }],
  }
  remember(ticket, dirKey)
  bumpKvTotal(dirKey)
  trimMemory()
  yield* persistTicket(ctx, ticket)
  yield* persistIndexes(ctx, ticket)
  return { ticket, reused: false }
})

export interface UpdateTicketInput {
  readonly ticketID: string
  readonly state?: TicketState
  readonly note?: string
  readonly workerSessionID?: string
  /** Partition of the caller; a ticket of another partition is refused. */
  readonly dirKey?: string
  readonly now?: number
}

/**
 * The message a scoped caller gets when it names a ticket that belongs to
 * another partition. `undefined` when the id is unknown (the normal
 * "unknown ticket" path) or already belongs to the caller's partition.
 *
 * This is what makes a stolen id useless: `ticket_update` / `ticket_close` /
 * `dispatch` do not silently operate on the other directory's work order.
 */
function foreignTicketMessage(ticketID: string, dirKey: string | undefined): string | undefined {
  if (dirKey === undefined) return undefined
  const known = tickets.get(ticketID.trim())
  if (known === undefined) return undefined
  const own = partitionOf(known)
  const mine = scopeOf(dirKey)
  if (own === mine) return undefined
  return `ticket ${known.id} belongs to partition ${own}, not this router's partition ${mine}; operate on it from that partition's router`
}

/** Move a ticket through the state machine. Illegal moves fail with a `Tool.Error`. */
export const updateTicket = Effect.fn("superagent.updateTicket")(function* (
  ctx: Plugin.Context,
  input: UpdateTicketInput,
) {
  const foreign = foreignTicketMessage(input.ticketID, input.dirKey)
  if (foreign !== undefined) return yield* new Tool.Error({ message: foreign })
  const ticket = yield* loadTicket(ctx, input.ticketID, input.dirKey)
  if (ticket === undefined) return yield* new Tool.Error({ message: `unknown ticket ${input.ticketID}` })
  const now = input.now ?? Date.now()
  if (input.state !== undefined && input.state !== ticket.state) {
    const failure = transitionError(ticket.state, input.state)
    if (failure !== undefined) return yield* new Tool.Error({ message: failure })
    ticket.history.push({
      at: now,
      kind: "state",
      from: ticket.state,
      to: input.state,
      ...(input.note === undefined ? {} : { note: input.note }),
    })
    ticket.state = input.state
    if (isTerminalState(input.state)) {
      ticket.closedAt = now
      ticket.closeReason = compact(input.note ?? input.state, SUMMARY_MAX)
    }
  } else if (input.note !== undefined) {
    ticket.history.push({ at: now, kind: "note", note: compact(input.note, SUMMARY_MAX) })
  }
  if (input.workerSessionID !== undefined) ticket.workerSessionID = input.workerSessionID
  ticket.updatedAt = now
  yield* persistTicket(ctx, ticket)
  yield* persistIndexes(ctx, ticket)
  return ticket
})

export interface CloseTicketInput {
  readonly ticketID: string
  readonly outcome: TicketCloseOutcome
  readonly summary: string
  /** Partition of the caller; a ticket of another partition is refused. */
  readonly dirKey?: string
  readonly now?: number
}

/** Close a ticket with an outcome, recording summary/closedAt in the record and history. */
export const closeTicket = Effect.fn("superagent.closeTicket")(function* (
  ctx: Plugin.Context,
  input: CloseTicketInput,
) {
  const foreign = foreignTicketMessage(input.ticketID, input.dirKey)
  if (foreign !== undefined) return yield* new Tool.Error({ message: foreign })
  const ticket = yield* loadTicket(ctx, input.ticketID, input.dirKey)
  if (ticket === undefined) return yield* new Tool.Error({ message: `unknown ticket ${input.ticketID}` })
  // Re-closing with the same outcome is idempotent; a different outcome is a conflict.
  if (isTerminalState(ticket.state)) {
    if (ticket.state === input.outcome) return ticket
    return yield* new Tool.Error({
      message: `ticket ${ticket.id} is already closed (${ticket.state}); cannot close as ${input.outcome}`,
    })
  }
  const failure = transitionError(ticket.state, input.outcome)
  if (failure !== undefined) return yield* new Tool.Error({ message: failure })
  const now = input.now ?? Date.now()
  const summary = compact(input.summary, SUMMARY_MAX)
  ticket.history.push({ at: now, kind: "closed", from: ticket.state, to: input.outcome, note: summary })
  ticket.state = input.outcome
  ticket.closedAt = now
  ticket.closeReason = summary
  ticket.updatedAt = now
  yield* persistTicket(ctx, ticket)
  yield* persistIndexes(ctx, ticket)
  return ticket
})

export interface ListTicketsInput {
  readonly threadID?: string
  readonly status?: TicketState
  readonly since?: number
  readonly limit?: number
}

function matchesQuery(ticket: Ticket, input: ListTicketsInput): boolean {
  if (input.threadID !== undefined && ticket.threadID !== input.threadID) return false
  if (input.status !== undefined && ticket.state !== input.status) return false
  if (input.since !== undefined && ticket.updatedAt < input.since) return false
  return true
}

/**
 * Newest-updated first; filters are combined with AND.
 *
 * `dirKey` scopes the list to one partition (`undefined` = process-wide, which
 * is the TUI view and the pre-partition behaviour).
 */
export function listTickets(input: ListTicketsInput = {}, dirKey?: string): Array<Ticket> {
  const limit = clamp(input.limit ?? LIST_DEFAULT, 1, LIST_MAX)
  return (dirKey === undefined ? [...tickets.values()] : inScope(dirKey))
    .filter((ticket) => matchesQuery(ticket, input))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

/**
 * Page a ticket list the way `ticket_list` needs it: memory answers while it
 * is complete (the normal case, no I/O). Once trimming has dropped closed
 * records, a page that memory cannot fill is completed from KV, so a ticket
 * that exists in KV never shows up as "no such ticket". The KV walk is paged
 * and only runs on that short-page path, never on every call.
 *
 * The KV walk is scoped to the caller's partition: records of another
 * partition (and legacy `ticket:` records, which belong to the default one)
 * are filtered out instead of leaking into this partition's list.
 */
export const listTicketRecords = Effect.fn("superagent.listTicketRecords")(function* (
  ctx: Plugin.Context,
  input: ListTicketsInput = {},
  dirKey?: string,
) {
  // A read is the cheapest retry point for writes an earlier storage hiccup
  // left queued, so a ticket that memory already shows can reach KV even when
  // no further mutation happens.
  yield* flushTicketWrites(ctx)
  const limit = clamp(input.limit ?? LIST_DEFAULT, 1, LIST_MAX)
  const local = listTickets(input, dirKey)
  if (memoryComplete(dirKey) || local.length >= limit) return local
  const merged = new Map(local.map((ticket) => [ticket.id, ticket]))
  // `from` is the namespace the record was read from: a record written before
  // the ownership field existed has no `dirKey` of its own, and the namespace
  // is then the only statement about its partition.
  const add = (value: Schema.Json | undefined, from?: string): void => {
    const ticket = decodeTicket(value)
    if (ticket === undefined || merged.has(ticket.id)) return
    if (!matchesQuery(ticket, input)) return
    const owner = ticket.dirKey === undefined ? scopeOf(from ?? DEFAULT_DIR_KEY) : ticketOwner(ticket)
    if (dirKey !== undefined && owner !== scopeOf(dirKey)) return
    merged.set(ticket.id, ticket)
  }
  if (dirKey === undefined) {
    // Process-wide view (TUI/RPC): both the legacy prefix and the scoped ones.
    for (const entry of yield* scanEntries(ctx, TICKET_PREFIX)) add(entry.value, DEFAULT_DIR_KEY)
    for (const entry of yield* scanDirScoped(ctx, TICKET_PREFIX)) add(entry.value, entry.dirKey)
  } else {
    // One partition: its own namespace. Records of another partition are
    // filtered out instead of leaking into this list.
    const prefix = dirScopedKey(TICKET_PREFIX, scopeOf(dirKey))
    for (const entry of yield* scanEntries(ctx, prefix)) add(entry.value, scopeOf(dirKey))
  }
  return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit)
})

/**
 * True when the ticket was parked (`blocked`) or closed after its newest
 * dispatch, i.e. the worker that was dispatched no longer owns it. A parked
 * ticket is how an interruption is undone: the watcher moves `in_progress` to
 * `blocked`, the Router re-opens it, and the interrupted (now `idle`) worker
 * must not gate that re-dispatch any more.
 */
function releasedSinceDispatch(ticket: Ticket): boolean {
  for (let index = ticket.history.length - 1; index >= 0; index--) {
    const entry = ticket.history[index]
    if (entry === undefined) continue
    if (entry.kind === "dispatch") return false
    const to = entry.kind === "state" || entry.kind === "closed" ? entry.to : undefined
    if (to === "blocked" || (to !== undefined && isTerminalState(to))) return true
  }
  return false
}

/**
 * Gate every dispatch must pass: a dispatch always names a ticket, and that
 * ticket must be workable right now. The rules are enforced here (not in the
 * prompt) so a Router cannot dispatch without a ticket, onto a closed ticket,
 * across threads, or onto a ticket that already has a live (non-terminal) worker.
 */
export const requireDispatchTicket = Effect.fn("superagent.requireDispatchTicket")(function* (
  ticketID: string | undefined,
  threadID: string | undefined,
  dirKey?: string,
) {
  if (ticketID === undefined || ticketID.trim() === "") {
    return yield* new Tool.Error({ message: "dispatch requires ticketID; create a ticket with ticket_create first" })
  }
  const ticket = tickets.get(ticketID)
  if (ticket === undefined) {
    return yield* new Tool.Error({
      message: `unknown ticket ${ticketID}; create it with ticket_create first, then dispatch({ ticketID })`,
    })
  }
  // A router only dispatches work orders of its own partition. The message
  // names both keys so the Router knows which directory's router to use.
  const foreign = foreignTicketMessage(ticketID, dirKey)
  if (foreign !== undefined) return yield* new Tool.Error({ message: foreign })
  if (!ACTIVE_STATES.includes(ticket.state)) {
    const hint =
      ticket.state === "blocked"
        ? 'reopen it with ticket_update({ status: "in_progress" })'
        : "create a new ticket with ticket_create"
    return yield* new Tool.Error({
      message: `ticket ${ticket.id} is ${ticket.state}; only open/in_progress tickets can be dispatched — ${hint}`,
    })
  }
  if (threadID !== undefined && threadID !== ticket.threadID) {
    return yield* new Tool.Error({
      message: `ticket ${ticket.id} belongs to thread ${ticket.threadID}, not ${threadID}; dispatch with threadID=${ticket.threadID} or ticket_create a ticket for ${threadID}`,
    })
  }
  // One ticket never runs two workers at once: the previous worker must be
  // terminal (done, failed, aborted) before anything is dispatched again.
  // `idle` is NOT terminal — the session may still be resumed — so it blocks
  // a re-dispatch exactly like `running`, unless the ticket was parked after
  // that worker went idle (an interruption released it). A worker record that
  // is gone blocks nothing: there is no live worker left to wait for.
  const workerID = ticket.workerSessionID
  const worker = workerID === undefined ? undefined : workers.get(workerID)
  if (workerID !== undefined && worker !== undefined && !isWorkerTerminal(worker.state)) {
    const released = worker.state === "idle" && releasedSinceDispatch(ticket)
    if (!released) {
      const article = worker.state === "idle" ? "an" : "a"
      return yield* new Tool.Error({
        message: `ticket ${ticket.id} already has ${article} ${worker.state} worker ${workerID}; wait for it to finish, abort_session it, or ticket_create a new ticket for the re-dispatch`,
      })
    }
  }
  return ticket
})

export interface LinkTicketInput {
  readonly ticketID: string
  readonly sessionID: string
  readonly note?: string
  /**
   * Reasoning effort this dispatch asked for, already resolved by the
   * dispatcher (`high`, or `high (unverified: inherited)` when the model
   * catalog could not confirm it). Recorded per attempt in the history, so a
   * retry shows its own effort instead of inheriting a stale one.
   */
  readonly effort?: string
  /** Partition of the dispatching router; a ticket of another partition is refused. */
  readonly dirKey?: string
  readonly now?: number
}

/**
 * Attach a dispatched worker to its ticket and move `open` to `in_progress`.
 * Only `open`/`in_progress` tickets accept a worker.
 */
export const linkTicketToWorker = Effect.fn("superagent.linkTicketToWorker")(function* (
  ctx: Plugin.Context,
  input: LinkTicketInput,
) {
  const foreign = foreignTicketMessage(input.ticketID, input.dirKey)
  if (foreign !== undefined) return yield* new Tool.Error({ message: foreign })
  const ticket = yield* loadTicket(ctx, input.ticketID, input.dirKey)
  if (ticket === undefined) return yield* new Tool.Error({ message: `unknown ticket ${input.ticketID}` })
  if (!ACTIVE_STATES.includes(ticket.state)) {
    return yield* new Tool.Error({
      message: `ticket ${ticket.id} is ${ticket.state}; only open/in_progress tickets can be dispatched`,
    })
  }
  const now = input.now ?? Date.now()
  ticket.workerSessionID = input.sessionID
  ticket.attempts.push({
    at: now,
    sessionID: input.sessionID,
    ...(input.note === undefined ? {} : { note: input.note }),
  })
  ticket.history.push({
    at: now,
    kind: "dispatch",
    note: input.effort === undefined ? `worker ${input.sessionID}` : `worker ${input.sessionID} effort=${input.effort}`,
  })
  if (ticket.state === "open") {
    ticket.history.push({ at: now, kind: "state", from: "open", to: "in_progress" })
    ticket.state = "in_progress"
  }
  ticket.updatedAt = now
  yield* persistTicket(ctx, ticket)
  yield* persistIndexes(ctx, ticket)
  return ticket
})

export interface CloseForWorkerInput {
  readonly sessionID: string
  readonly outcome: "done" | "failed"
  readonly summary?: string
  readonly note?: string
  readonly now?: number
}

/**
 * Close the in-progress ticket attached to a worker that just ended. Tickets
 * in any other state are left alone: a closed ticket never reopens and an
 * aborted worker is handled by its own path.
 */
export const closeTicketsForWorker = Effect.fn("superagent.closeTicketsForWorker")(function* (
  ctx: Plugin.Context,
  input: CloseForWorkerInput,
) {
  const ticket = activeTicketForWorker(input.sessionID)
  if (ticket === undefined) return undefined
  return yield* closeTicket(ctx, {
    ticketID: ticket.id,
    outcome: input.outcome,
    summary: workerCloseSummary(input),
    dirKey: partitionOf(ticket),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
})

/** Why a ticket was parked: the worker was interrupted, not finished. */
export const INTERRUPTED_REASON = "interrupted"

export interface BlockForWorkerInput {
  readonly sessionID: string
  /** Raw interruption detail (the host's `reason`), when there is one. */
  readonly reason?: string
  readonly now?: number
}

/**
 * Park the in-progress ticket of a worker that was interrupted.
 *
 * An interruption finishes neither the work nor the attempt: closing the
 * ticket as `failed` would lie and leaving it `in_progress` would keep it out
 * of every later dispatch (the interrupted worker stays `idle`, which the
 * dispatch gate treats as live). `blocked` is the honest state — the ticket
 * says why it stopped, and the Router can re-open and re-dispatch it. The
 * history entry is also what tells the gate that worker released the ticket.
 */
export const blockTicketsForWorker = Effect.fn("superagent.blockTicketsForWorker")(function* (
  ctx: Plugin.Context,
  input: BlockForWorkerInput,
) {
  const ticket = activeTicketForWorker(input.sessionID)
  if (ticket === undefined) return undefined
  const now = input.now ?? Date.now()
  const reason = input.reason === undefined || input.reason.trim() === "" ? undefined : input.reason.trim()
  const note = compact(reason === undefined ? INTERRUPTED_REASON : `${INTERRUPTED_REASON}: ${reason}`, SUMMARY_MAX)
  ticket.history.push({ at: now, kind: "state", from: ticket.state, to: "blocked", note })
  ticket.state = "blocked"
  ticket.updatedAt = now
  yield* persistTicket(ctx, ticket)
  yield* persistIndexes(ctx, ticket)
  return ticket
})

/**
 * Load every ticket record and rebuild the indexes.
 *
 * Two namespaces are read:
 *
 * - the legacy `ticket:<id>` prefix, and
 * - `dir:<dirKey>:ticket:<id>` per explicit partition.
 *
 * **Migration**：旧键里的工单**一律归默认分区**，不再按 `ticket.directory` 打散，
 * 也**不再写**分区副本（旧 key 保留，回滚后老版本仍读得到）。理由：分区归属是
 * 「谁创建的」，而旧记录没有 `dirKey`，它们当初只可能在默认分区；按目录打散会让
 * 开关打开后老 Router 一张自己的历史工单都看不见（`closed=19` → `closed=0`）。
 *
 * `dir:<dirKey>:` 下的记录保持原样（那是显式分区过的）。同一 id 在两处都存在
 * （旧版本迁移时写过一份副本）时：归属回到默认分区（它本来就是旧键里的那张单），
 * 内容取 `updatedAt` 更新的那份，所以迁移后继续更新的状态不会被旧副本回滚。
 *
 * 整个过程**不写 KV**（除了清理损坏记录与重写派生索引），因此重复 hydrate 的
 * 结果与键集合完全相同。
 */
export const hydrateTickets = Effect.fn("superagent.hydrateTickets")(function* (ctx: Plugin.Context) {
  resetTickets()
  /** id → 归属分区与该 id 的最新内容。 */
  const settled = new Map<string, { ticket: Ticket; dirKey: string }>()
  /**
   * 旧键扫描先跑：出现在旧键里的 id 一律归默认分区。副本更新时只替换内容，
   * 不改变归属（`lockDirKey`）。
   */
  const consider = (ticket: Ticket, dirKey: string, lockDirKey: boolean): void => {
    const previous = settled.get(ticket.id)
    if (previous === undefined) {
      settled.set(ticket.id, { ticket, dirKey })
      return
    }
    if (ticket.updatedAt <= previous.ticket.updatedAt) return
    settled.set(ticket.id, { ticket, dirKey: lockDirKey ? previous.dirKey : dirKey })
  }
  // 1. 旧布局：`ticket:<id>`。开关关闭时只会走这一条路径。
  let after: string | undefined
  do {
    const page = yield* ctx.storage
      .scan({ prefix: TICKET_PREFIX, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const ticket = decodeTicket(entry.value)
      if (ticket === undefined) {
        yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      consider(ticket, DEFAULT_DIR_KEY, true)
    }
    after = page.next
  } while (after !== undefined)
  // 2. 显式分区：`dir:<dirKey>:ticket:<id>`。已由旧键认领的 id 不再改变归属。
  for (const entry of yield* scanDirScoped(ctx, TICKET_PREFIX)) {
    const ticket = decodeTicket(entry.value)
    if (ticket === undefined) {
      yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
      continue
    }
    consider(ticket, entry.dirKey, settled.has(ticket.id))
  }
  for (const { ticket, dirKey } of settled.values()) {
    remember(ticket, dirKey)
    bumpKvTotal(dirKey)
  }
  trimMemory()
  yield* rewriteIndexes(ctx)
  yield* Effect.logInfo("superagent tickets hydrated", { count: tickets.size, inKV: kvTicketCount() })
})

// ── rendering (shared by tools and the TUI, narrow-terminal first) ─────────────

export const DETAIL_WIDTH = 52

function wrapBullet(text: string, width: number): Array<string> {
  return wrapText(text, width - 2).map((line, index) => (index === 0 ? `· ${line}` : `  ${line}`))
}

function wrapLabel(label: string, text: string, width: number): Array<string> {
  const indent = " ".repeat(displayWidth(label))
  return wrapText(`${label}${text}`, width).map((line, index) => (index === 0 ? line : `${indent}${line}`))
}

function shortTime(epoch: number): string {
  const date = new Date(epoch)
  const pad = (value: number) => `${value}`.padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Reasoning effort recorded on the newest dispatch of this ticket, e.g.
 * `high`, or `high (unverified: inherited)` when the dispatcher could not
 * confirm it. `undefined` when the last dispatch asked for nothing (older
 * dispatches, or a plain inherited dispatch), so the detail view says nothing
 * rather than inventing a level.
 */
export function dispatchEffort(ticket: Ticket): string | undefined {
  for (let index = ticket.history.length - 1; index >= 0; index--) {
    const entry = ticket.history[index]
    if (entry === undefined || entry.kind !== "dispatch") continue
    if (entry.note === undefined) return undefined
    const match = /(?:^|\s)effort=(\S+(?:\s+\([^)]*\))?)/.exec(entry.note)
    return match?.[1]
  }
  return undefined
}

export function renderTicketList(items: ReadonlyArray<Ticket>, width = DETAIL_WIDTH): string {
  if (items.length === 0) return "暂无工单（用户交代新任务时先 ticket_create）"
  const active = items.filter((ticket) => ACTIVE_STATES.includes(ticket.state)).length
  const lines = [`工单 ${items.length} · 进行中 ${active}`]
  for (const state of TICKET_STATES) {
    const group = items.filter((ticket) => ticket.state === state)
    if (group.length === 0) continue
    lines.push("", `${state} (${group.length})`)
    for (const ticket of group) {
      const worker = ticket.workerSessionID === undefined ? "" : ` w=${ticket.workerSessionID.slice(-6)}`
      const tail = `${shortTime(ticket.updatedAt)}${worker}`
      lines.push(...wrapBullet(`${ticket.id} ${ticket.priority} ${ticket.title}`, width))
      lines.push(...wrapBullet(tail, width))
    }
  }
  return lines.join("\n")
}

export function renderTicketDetail(ticket: Ticket, width = DETAIL_WIDTH): string {
  const lines = [`${ticket.id} · ${ticket.state} · ${ticket.priority}`, ...wrapText(ticket.title, width)]
  lines.push("", ...wrapLabel("目标：", ticket.objective, width))
  lines.push("", "验收：")
  ticket.acceptance.forEach((item, index) => {
    lines.push(...wrapBullet(`${index + 1}. ${item}`, width))
  })
  lines.push("")
  lines.push(...wrapLabel("thread：", ticket.threadID, width))
  lines.push(...wrapLabel("目录：", ticket.directory ?? "-", width))
  lines.push(...wrapLabel("worker：", ticket.workerSessionID ?? "-", width))
  const effort = dispatchEffort(ticket)
  if (effort !== undefined) lines.push(...wrapLabel("档位：", effort, width))
  lines.push(...wrapLabel("尝试：", `${ticket.attempts.length}`, width))
  lines.push(...wrapLabel("建档：", shortTime(ticket.createdAt), width))
  lines.push(...wrapLabel("更新：", shortTime(ticket.updatedAt), width))
  if (ticket.closedAt !== undefined) lines.push(...wrapLabel("关闭：", shortTime(ticket.closedAt), width))
  if (ticket.closeReason !== undefined) lines.push(...wrapLabel("结论：", ticket.closeReason, width))
  if (ticket.parentTicketID !== undefined) lines.push(...wrapLabel("父单：", ticket.parentTicketID, width))
  if (ticket.authorization.quote !== "") {
    lines.push("", ...wrapLabel("原话：", ticket.authorization.quote, width))
  }
  const history = ticket.history.slice(-5)
  if (history.length > 0) {
    lines.push("", `历史（最近 ${history.length} 条）：`)
    for (const entry of history) {
      const move = entry.from === undefined ? entry.kind : `${entry.from}→${entry.to ?? entry.kind}`
      const note = entry.note === undefined ? "" : ` ${entry.note}`
      lines.push(...wrapBullet(`${shortTime(entry.at)} ${move}${note}`, width))
    }
  }
  return lines.join("\n")
}
