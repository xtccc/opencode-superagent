import type { WorkerState } from "./worker-state.js"

/**
 * Pure ticket domain model: records, the state machine, and the selectors
 * shared by the ticket store, the dispatcher and the worker lifecycle.
 *
 * Nothing here touches the KV store, Effect or the worker registry, so this
 * module can be imported from any layer without recreating the state ↔ ticket
 * import cycle. `ticket.ts` keeps the effectful store and re-exports these
 * names, so its public API is unchanged.
 */

export type TicketState = "open" | "in_progress" | "blocked" | "done" | "failed" | "cancelled" | "superseded"
export type TicketPriority = "p0" | "p1" | "p2"
export type TicketCloseOutcome = "done" | "failed" | "cancelled"

export interface TicketRequester {
  readonly source: string
  readonly threadID: string
  readonly author?: string
}

/** Which trigger authorized the ticket: the id plus a short quote of what the user said. */
export interface TicketAuthorization {
  readonly triggerID: string
  readonly quote: string
  readonly at: number
}

export interface TicketAttempt {
  readonly at: number
  readonly sessionID?: string
  readonly note?: string
}

export interface TicketHistoryEntry {
  readonly at: number
  readonly kind: "created" | "state" | "note" | "dispatch" | "closed"
  readonly from?: TicketState
  readonly to?: TicketState
  readonly note?: string
}

export interface Ticket {
  readonly id: string
  state: TicketState
  readonly title: string
  readonly objective: string
  readonly acceptance: ReadonlyArray<string>
  readonly requester: TicketRequester
  readonly authorization: TicketAuthorization
  readonly threadID: string
  workerSessionID?: string
  readonly attempts: Array<TicketAttempt>
  readonly priority: TicketPriority
  directory?: string
  readonly dedupeKey: string
  readonly parentTicketID?: string
  readonly tags: Array<string>
  readonly createdAt: number
  updatedAt: number
  closedAt?: number
  closeReason?: string
  readonly history: Array<TicketHistoryEntry>
}

export const PRIORITIES: ReadonlyArray<TicketPriority> = ["p0", "p1", "p2"]

export const TICKET_STATES: ReadonlyArray<TicketState> = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
  "superseded",
]

/** A ticket can be dispatched while it is one of these. */
export const ACTIVE_STATES: ReadonlyArray<TicketState> = ["open", "in_progress"]

const TRANSITIONS: Record<TicketState, ReadonlyArray<TicketState>> = {
  // A ticket can close from any active state: `done`/`failed` also cover work
  // finished outside the worker (or a dispatch that never started).
  open: ["in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
  in_progress: ["blocked", "done", "failed", "cancelled", "superseded"],
  blocked: ["in_progress", "done", "failed", "cancelled", "superseded"],
  done: [],
  failed: [],
  cancelled: [],
  superseded: [],
}

export function isTerminalState(state: TicketState): boolean {
  return TRANSITIONS[state].length === 0
}

export function allowedTransitions(state: TicketState): ReadonlyArray<TicketState> {
  return TRANSITIONS[state]
}

/** Same-state moves are no-ops, not transitions. */
export function canTransition(from: TicketState, to: TicketState): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

/** Human-readable reason a move is illegal, or `undefined` when it is allowed. */
export function transitionError(from: TicketState, to: TicketState): string | undefined {
  if (canTransition(from, to)) return undefined
  if (isTerminalState(from)) return `ticket is already closed (${from}); cannot move to ${to}`
  return `illegal transition ${from} -> ${to}; allowed: ${TRANSITIONS[from].join(", ")}`
}

/** Minimal shape a worker-bound ticket needs, so the selector stays pure and generic. */
export interface WorkerBoundTicket {
  readonly workerSessionID?: string
  readonly state: TicketState
}

/**
 * The `in_progress` ticket attached to a worker session, if any. Shared by the
 * dispatch link and worker-end closing so both sides agree on "active ticket
 * for this worker"; insertion order decides ties, as before.
 */
export function findActiveTicketForWorker<T extends WorkerBoundTicket>(
  candidates: Iterable<T>,
  sessionID: string,
): T | undefined {
  for (const ticket of candidates) {
    if (ticket.workerSessionID === sessionID && ticket.state === "in_progress") return ticket
  }
  return undefined
}

/**
 * Ticket outcome for a worker that just ended, or `undefined` when the worker
 * end closes nothing. `idle`/`aborted`/`running` leave the ticket for the abort
 * path or a deliberate re-dispatch.
 */
export function closeOutcomeForWorkerState(state: WorkerState): "done" | "failed" | undefined {
  return state === "done" || state === "failed" ? state : undefined
}

/**
 * Reason recorded when a worker end closes its ticket: an explicit summary
 * wins, then the caller's note, then a generated `done (worker <id>)` line.
 * The store still compacts it to `SUMMARY_MAX` before persisting, exactly as
 * before this helper existed.
 */
export function workerCloseSummary(input: {
  readonly sessionID: string
  readonly outcome: "done" | "failed"
  readonly summary?: string | undefined
  readonly note?: string | undefined
}): string {
  return input.summary ?? input.note ?? `${input.outcome} (worker ${input.sessionID})`
}
