/**
 * Worker records and the in-memory worker registry they live in.
 *
 * This module is intentionally dependency-free: `state.ts` owns KV persistence
 * and the rest of the store, while the ticket layer only needs to look up a
 * worker's state when it gates a dispatch. Keeping the record type and the
 * registry map here lets `ticket.ts` avoid importing `state.ts`, which is what
 * breaks the state ↔ ticket import cycle. `store.workers` in `state.ts` is the
 * same map instance, so both layers always see one registry.
 */

export type WorkerState = "running" | "idle" | "failed" | "done" | "aborted"

export const WORKER_STATES: ReadonlyArray<WorkerState> = ["running", "idle", "failed", "done", "aborted"]

export interface WorkerRecord {
  readonly sessionID: string
  readonly title?: string
  /**
   * Primary thread this worker was dispatched for. Legacy records decode to
   * `""` and `hydrate` backfills it from `thread.workers`, so every live record
   * carries a forward link to its thread without losing the multi-thread
   * `threads` list.
   */
  threadID: string
  /** Trigger that authorized the dispatch, when the record knows it. */
  triggerID?: string
  readonly threads: Array<string>
  state: WorkerState
  readonly createdAt: number
  /** Last persisted write. Refreshed by `saveWorker`, so an aborted record keeps a traceable timestamp. */
  updatedAt?: number
  lastReport?: string
  directory?: string
}

/** Canonical in-memory worker registry; `store.workers` points at this map. */
export const workers = new Map<string, WorkerRecord>()

/**
 * Worker states after which the ticket may be dispatched again. `idle` is not
 * here on purpose: an idle session can still be resumed, so a re-dispatch
 * would race a live worker.
 */
export const TERMINAL_WORKER_STATES: ReadonlyArray<WorkerState> = ["done", "failed", "aborted"]

export function isWorkerTerminal(state: WorkerState): boolean {
  return TERMINAL_WORKER_STATES.includes(state)
}
