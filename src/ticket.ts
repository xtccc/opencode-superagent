import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, type Schema } from "effect"
import { createHash } from "node:crypto"
import { normalizeDirectory } from "./dirs.js"
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

/** In-memory mirror of every hydrated ticket, rebuilt from KV at startup. */
export const tickets = new Map<string, Ticket>()
const byThread = new Map<string, Set<string>>()

/**
 * The trigger most recently delivered to the Router. `ticket_create` copies
 * it into `authorization`, so a ticket always points at what the user said.
 * It is a heuristic: the newest flushed trigger wins, which matches how the
 * Router batches queued events before answering.
 */
export interface RouterTriggerNote {
  readonly id: string
  readonly source: string
  readonly threadID: string
  readonly author?: string
  readonly text: string
  readonly at: number
}

let routerTrigger: RouterTriggerNote | undefined

export function noteRouterTrigger(trigger: TicketTriggerNoteInput): void {
  routerTrigger = {
    id: trigger.id ?? `${trigger.source}:${trigger.threadID}:${trigger.createdAt ?? Date.now()}`,
    source: trigger.source,
    threadID: trigger.threadID,
    ...(trigger.author === undefined ? {} : { author: trigger.author }),
    text: trigger.text,
    at: trigger.createdAt ?? Date.now(),
  }
}

export function currentTrigger(): RouterTriggerNote | undefined {
  return routerTrigger
}

/** Reset memory (hydrate and tests): the map and its thread index are rebuilt together. */
export function resetTickets(): void {
  tickets.clear()
  byThread.clear()
  routerTrigger = undefined
}

function remember(ticket: Ticket): void {
  tickets.set(ticket.id, ticket)
  const ids = byThread.get(ticket.threadID) ?? new Set<string>()
  ids.add(ticket.id)
  byThread.set(ticket.threadID, ids)
}

function forget(ticket: Ticket): void {
  tickets.delete(ticket.id)
  byThread.get(ticket.threadID)?.delete(ticket.id)
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

export function getTicket(ticketID: string): Ticket | undefined {
  return tickets.get(ticketID)
}

/** Same-thread, same-dedupe-key ticket still open or in progress, if any. */
export function findDuplicate(threadID: string, dedupeKey: string): Ticket | undefined {
  const ids = byThread.get(threadID)
  // No ids means this thread owns no in-memory ticket, so there is nothing to reuse.
  if (ids === undefined) return undefined
  const candidates = [...ids].flatMap((id) => tickets.get(id) ?? [])
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

export function ticketStats(): TicketStats {
  const stats = { total: 0, open: 0, inProgress: 0, blocked: 0, closed: 0 }
  for (const ticket of tickets.values()) {
    stats.total += 1
    if (ticket.state === "open") stats.open += 1
    else if (ticket.state === "in_progress") stats.inProgress += 1
    else if (ticket.state === "blocked") stats.blocked += 1
    else stats.closed += 1
  }
  return stats
}

/** Compact "tk_x title; tk_y title" line for the system status, empty when there is nothing active. */
export function activeTicketSummary(threadID: string | undefined, limit = 3): string {
  const active = [...tickets.values()]
    .filter((ticket) => ACTIVE_STATES.includes(ticket.state))
    .filter((ticket) => threadID === undefined || ticket.threadID === threadID)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return active
    .slice(0, limit)
    .map((ticket) => `${ticket.id} ${ticket.title}`)
    .join("; ")
}

/** Active ticket for a worker session, used when a worker ends. */
export function activeTicketForWorker(sessionID: string): Ticket | undefined {
  return findActiveTicketForWorker(tickets.values(), sessionID)
}

/**
 * The ticket bound to a worker session, including a closed one. Used by
 * `worker_prompt` to refuse waking a worker whose work order already ended.
 * The ticket store is the only worker → ticket mapping; a reused worker
 * session keeps the newest write (a closed ticket is never reopened).
 */
export function ticketForWorker(sessionID: string): Ticket | undefined {
  let latest: Ticket | undefined
  for (const ticket of tickets.values()) {
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
  if (title.length > TITLE_MAX) return `title must be at most ${TITLE_MAX} characters`
  const objective = (input.objective ?? "").trim()
  if (objective === "") return "ticket_create needs a non-empty objective; ask the user first"
  if (objective.length > OBJECTIVE_MAX) return `objective must be at most ${OBJECTIVE_MAX} characters`
  const acceptance = (input.acceptance ?? []).map((item) => item.trim()).filter((item) => item !== "")
  if (acceptance.length === 0) {
    return "ticket_create needs at least one acceptance criterion; ask the user instead of creating an empty ticket"
  }
  if (acceptance.length > ACCEPTANCE_MAX) return `acceptance takes at most ${ACCEPTANCE_MAX} items`
  if (acceptance.some((item) => item.length > ACCEPTANCE_ITEM_MAX)) {
    return `each acceptance item must be at most ${ACCEPTANCE_ITEM_MAX} characters`
  }
  if ((input.directory ?? "").trim() === "") return "ticket_create needs a directory (absolute path)"
  if (normalizeDirectory(input.directory ?? "") === undefined) return "directory must be an absolute path"
  return undefined
}

function compact(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1).trimEnd()}…`
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

function collect(predicate: (ticket: Ticket) => boolean): Array<string> {
  return [...tickets.values()]
    .filter(predicate)
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, INDEX_LIMIT)
    .map((ticket) => ticket.id)
}

const writeIds = Effect.fn("superagent.persistTicketIndex")(function* (
  ctx: Plugin.Context,
  key: string,
  ids: Array<string>,
) {
  yield* ctx.storage
    .set(key, ids as unknown as Schema.Json)
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist ticket index", { key, cause })))
})

const persistTicket = Effect.fn("superagent.persistTicket")(function* (ctx: Plugin.Context, ticket: Ticket) {
  yield* ctx.storage
    .set(ticketKey(ticket.id), encodeTicket(ticket))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist ticket", { cause })))
})

/** Only the buckets the ticket touches are rewritten; the record prefix stays authoritative. */
const persistIndexes = Effect.fn("superagent.persistTicketIndexes")(function* (ctx: Plugin.Context, ticket: Ticket) {
  yield* writeIds(
    ctx,
    TICKET_ALL_KEY,
    collect(() => true),
  )
  yield* writeIds(
    ctx,
    ticketStatusKey(ticket.state),
    collect((item) => item.state === ticket.state),
  )
  yield* writeIds(
    ctx,
    ticketThreadKey(ticket.threadID),
    collect((item) => item.threadID === ticket.threadID),
  )
})

const rewriteIndexes = Effect.fn("superagent.rewriteTicketIndexes")(function* (ctx: Plugin.Context) {
  yield* writeIds(
    ctx,
    TICKET_ALL_KEY,
    collect(() => true),
  )
  for (const state of TICKET_STATES) {
    yield* writeIds(
      ctx,
      ticketStatusKey(state),
      collect((ticket) => ticket.state === state),
    )
  }
  for (const threadID of [...new Set([...tickets.values()].map((ticket) => ticket.threadID))]) {
    yield* writeIds(
      ctx,
      ticketThreadKey(threadID),
      collect((ticket) => ticket.threadID === threadID),
    )
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
  if (directory === undefined) return yield* new Tool.Error({ message: "directory must be an absolute path" })
  const acceptance = input.acceptance.map((item) => item.trim()).filter((item) => item !== "")
  const dedupeKey =
    input.dedupeKey?.trim() ||
    dedupeKeyFor({ source: input.source, threadID: input.threadID, objective: input.objective })
  const duplicate = findDuplicate(input.threadID, dedupeKey)
  if (duplicate !== undefined) return { ticket: duplicate, reused: true }
  const trigger = routerTrigger
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
    directory,
    dedupeKey,
    ...(input.parentTicketID === undefined ? {} : { parentTicketID: input.parentTicketID }),
    tags: [...(input.tags ?? [])],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, kind: "created", to: "open" }],
  }
  remember(ticket)
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
  readonly now?: number
}

/** Move a ticket through the state machine. Illegal moves fail with a `Tool.Error`. */
export const updateTicket = Effect.fn("superagent.updateTicket")(function* (
  ctx: Plugin.Context,
  input: UpdateTicketInput,
) {
  const ticket = tickets.get(input.ticketID)
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
  readonly now?: number
}

/** Close a ticket with an outcome, recording summary/closedAt in the record and history. */
export const closeTicket = Effect.fn("superagent.closeTicket")(function* (
  ctx: Plugin.Context,
  input: CloseTicketInput,
) {
  const ticket = tickets.get(input.ticketID)
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

/** Newest-updated first; filters are combined with AND. */
export function listTickets(input: ListTicketsInput = {}): Array<Ticket> {
  const limit = clamp(input.limit ?? LIST_DEFAULT, 1, LIST_MAX)
  return [...tickets.values()]
    .filter((ticket) => input.threadID === undefined || ticket.threadID === input.threadID)
    .filter((ticket) => input.status === undefined || ticket.state === input.status)
    .filter((ticket) => input.since === undefined || ticket.updatedAt >= input.since)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
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
  // a re-dispatch exactly like `running`. A worker record that is gone blocks
  // nothing: there is no live worker left to wait for.
  const workerID = ticket.workerSessionID
  const worker = workerID === undefined ? undefined : workers.get(workerID)
  if (workerID !== undefined && worker !== undefined && !isWorkerTerminal(worker.state)) {
    const article = worker.state === "idle" ? "an" : "a"
    return yield* new Tool.Error({
      message: `ticket ${ticket.id} already has ${article} ${worker.state} worker ${workerID}; wait for it to finish, abort_session it, or ticket_create a new ticket for the re-dispatch`,
    })
  }
  return ticket
})

export interface LinkTicketInput {
  readonly ticketID: string
  readonly sessionID: string
  readonly note?: string
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
  const ticket = tickets.get(input.ticketID)
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
  ticket.history.push({ at: now, kind: "dispatch", note: `worker ${input.sessionID}` })
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
    ...(input.now === undefined ? {} : { now: input.now }),
  })
})

/**
 * Load every `ticket:<id>` record and rebuild the indexes. Older workers are
 * never backfilled: a worker with no ticket stays without one, silently.
 */
export const hydrateTickets = Effect.fn("superagent.hydrateTickets")(function* (ctx: Plugin.Context) {
  resetTickets()
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
      remember(ticket)
    }
    after = page.next
  } while (after !== undefined)
  trimMemory()
  yield* rewriteIndexes(ctx)
  yield* Effect.logInfo("superagent tickets hydrated", { count: tickets.size })
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
