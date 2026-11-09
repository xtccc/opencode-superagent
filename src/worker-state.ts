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
  /**
   * Durable sequence of the current execution's `session.execution.started`
   * event. A replay of the same start event keeps it; a real follow-up prompt
   * starts a new execution with a newer sequence. Persisted, so completion
   * dedupe still works after `hydrate`.
   */
  execution?: number
  /**
   * Terminal states already announced to the Router for `execution`. The
   * watcher appends exactly once per state, so repeated/replayed completion
   * events cannot inject duplicate notifications. Cleared when a new execution
   * starts.
   */
  notified?: Array<WorkerState>
}

/**
 * Process-wide symbol for the worker registry. The host may instantiate one
 * plugin module per workspace (and may even load a second copy of the same
 * version from another install path); a module-level map would then diverge
 * and `sleep` could watch a registry the watcher never writes. Keeping the
 * registry on `globalThis` makes every in-process copy of this plugin share
 * one registry, so a completion is never silently missed.
 */
const WORKERS_KEY = Symbol.for("opencode-superagent.workers.v1")

type GlobalWithWorkers = typeof globalThis & { [WORKERS_KEY]?: Map<string, WorkerRecord> }

const globals = globalThis as GlobalWithWorkers

/** Canonical in-memory worker registry; `store.workers` points at this map. */
export const workers: Map<string, WorkerRecord> = globals[WORKERS_KEY] ?? new Map<string, WorkerRecord>()
globals[WORKERS_KEY] = workers

/**
 * Worker states after which the ticket may be dispatched again. `idle` is not
 * here on purpose: an idle session can still be resumed, so a re-dispatch
 * would race a live worker.
 */
export const TERMINAL_WORKER_STATES: ReadonlyArray<WorkerState> = ["done", "failed", "aborted"]

export function isWorkerTerminal(state: WorkerState): boolean {
  return TERMINAL_WORKER_STATES.includes(state)
}
