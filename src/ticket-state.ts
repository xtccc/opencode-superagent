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
  /**
   * Most recently dispatched worker session. Kept as the single-field view for
   * backward compatibility (older KV records, the TUI detail pane and the
   * list trailer all use it); the full history lives in `workerSessionIDs`.
   */
  workerSessionID?: string
  /**
   * Every worker session ever bound to this ticket, oldest first. A reopened
   * ticket can be dispatched again (or resumed via `worker_prompt`), so the
   * association is one-to-many rather than a single overwritten pointer.
   */
  readonly workerSessionIDs: Array<string>
  readonly attempts: Array<TicketAttempt>
  readonly priority: TicketPriority
  /**
   * Partition that owns this work order: the partition of the Router that
   * created it. Never derived from `directory` — a ticket may be dispatched
   * into any working directory.
   */
  dirKey?: string
  /**
   * Working directory of the work order (display/audit, and the default target
   * `dispatch` uses). It does **not** decide the partition.
   */
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

/** Closed outcomes. Kept separate from the transition table so a closed ticket can be reopened. */
export const CLOSED_STATES: ReadonlyArray<TicketState> = ["done", "failed", "cancelled", "superseded"]

const TRANSITIONS: Record<TicketState, ReadonlyArray<TicketState>> = {
  // A ticket can close from any active state: `done`/`failed` also cover work
  // finished outside the worker (or a dispatch that never started).
  open: ["in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
  in_progress: ["blocked", "done", "failed", "cancelled", "superseded"],
  blocked: ["in_progress", "done", "failed", "cancelled", "superseded"],
  // Reopen: a closed work order can go back to in_progress (never straight to
  // open/blocked). This lets the Router continue on the same ticket — and via
  // `worker_prompt` on the same worker session — without losing accumulated
  // context or creating a duplicate work order.
  done: ["in_progress"],
  failed: ["in_progress"],
  cancelled: ["in_progress"],
  superseded: ["in_progress"],
}

export function isTerminalState(state: TicketState): boolean {
  return CLOSED_STATES.includes(state)
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
  if (isTerminalState(from)) {
    return `ticket is closed (${from}); cannot move to ${to} — reopen it with status=in_progress first`
  }
  return `illegal transition ${from} -> ${to}; allowed: ${TRANSITIONS[from].join(", ")}`
}

/**
 * All worker sessions bound to a ticket, oldest first.
 *
 * Reads the new list when present, then folds in the legacy single field so a
 * record written before the list existed (or a `ticket_update({ workerSessionID })`)
 * still resolves. Duplicates are removed without reordering.
 */
export function ticketWorkerIDs(ticket: {
  readonly workerSessionID?: string
  readonly workerSessionIDs?: ReadonlyArray<string>
}): ReadonlyArray<string> {
  const out: Array<string> = []
  const candidates = [...(ticket.workerSessionIDs ?? []), ...(ticket.workerSessionID ? [ticket.workerSessionID] : [])]
  for (const id of candidates) {
    if (id !== "" && !out.includes(id)) out.push(id)
  }
  return out
}

/** Minimal shape a worker-bound ticket needs, so the selector stays pure and generic. */
export interface WorkerBoundTicket {
  readonly workerSessionID?: string
  readonly workerSessionIDs?: ReadonlyArray<string>
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
    if (ticket.state === "in_progress" && ticketWorkerIDs(ticket).includes(sessionID)) return ticket
  }
  return undefined
}

/**
 * Ticket outcome for a worker that just ended, or `undefined` when the worker
 * end does not close the ticket. Only a successful worker closes its ticket:
 * a failure is parked as `blocked` so the Router can re-dispatch with a
 * corrected angle instead of silently turning one failed attempt into a
 * closed work order. `idle`/`aborted`/`running` stay open for the abort path.
 */
export function closeOutcomeForWorkerState(state: WorkerState): "done" | undefined {
  return state === "done" ? "done" : undefined
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
