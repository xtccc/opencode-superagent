import { canonicalDirectory, dirKeyFor, directoryOfDirKey } from "./dirs.js"
import { perDirectoryRouterEnabled } from "./settings.js"
import { dirKeyForWorker, routerPartitions, store, totalPending } from "./state.js"
import { pluginVersion } from "./version.js"
import type { WorkerRecord, WorkerState } from "./worker-state.js"

/**
 * The RPC `status` view model.
 *
 * Stage 2b made the store multi-partition but the RPC still reported whichever
 * partition happened to be "first". Stage 3 exposes that split without breaking
 * the pre-partition shape:
 *
 * - no `directory` → process-wide aggregate. The legacy `router` / `pending` /
 *   `workers` fields keep their old meaning (default partition's router, the
 *   sum over every partition, every worker). `partitions` is added only when
 *   the flag is on *and* at least two partitions are active, so a single-partition
 *   payload is byte-identical to stage 2b (and the TUI hides the summary anyway).
 * - `directory` → that directory's partition only: its router, its queue depth
 *   and its workers. `dirKey` is echoed so the TUI can highlight the partition
 *   it is looking at, and no `partitions` summary is sent, so one directory
 *   never reads another directory's worker list.
 */

export interface StatusWorkerView {
  readonly sessionID: string
  readonly title?: string
  readonly threads: ReadonlyArray<string>
  readonly state: WorkerState
}

/** One row of the aggregate partition summary (counts only, never worker ids). */
export interface StatusPartitionView {
  readonly dirKey: string
  readonly directory?: string
  /** Present while the partition's Router session is alive/tracked. */
  readonly router?: string
  readonly pending: number
  readonly workers: number
  /** Workers currently `running` (the number the TUI label calls "running"). */
  readonly running: number
}

export interface StatusSnapshot {
  readonly version?: string
  readonly router?: string
  readonly pending: number
  readonly workers: Array<StatusWorkerView>
  /** Aggregate mode only: `perDirectoryRouter` on and at least two active partitions. */
  readonly partitions?: Array<StatusPartitionView>
  /** Scoped mode only: the partition key the `directory` argument resolved to. */
  readonly dirKey?: string
  /** Scoped mode only: canonical form of the requested directory. */
  readonly directory?: string
}

function workerView(worker: WorkerRecord): StatusWorkerView {
  return {
    sessionID: worker.sessionID,
    ...(worker.title === undefined ? {} : { title: worker.title }),
    threads: [...worker.threads],
    state: worker.state,
  }
}

function activeWorkerCount(workers: ReadonlyArray<WorkerRecord>): number {
  return workers.filter((worker) => worker.state === "running").length
}

/**
 * Partitions worth showing: a freshly-hydrated default partition with no router,
 * no queued trigger and no worker is noise, so it is dropped from the summary.
 * Order follows `store.dirs` (the default partition is created first).
 */
function partitionViews(workers: ReadonlyArray<WorkerRecord>): Array<StatusPartitionView> {
  const out: Array<StatusPartitionView> = []
  for (const [dirKey, partition] of store.dirs) {
    const owned = workers.filter((worker) => dirKeyForWorker(worker) === dirKey)
    if (partition.routerID === undefined && partition.pending.length === 0 && owned.length === 0) continue
    const directory = partition.directory ?? directoryOfDirKey(dirKey)
    out.push({
      dirKey,
      ...(directory === undefined ? {} : { directory }),
      ...(partition.routerID === undefined ? {} : { router: partition.routerID }),
      pending: partition.pending.length,
      workers: owned.length,
      running: activeWorkerCount(owned),
    })
  }
  return out
}

/** Build the `status` RPC payload. Pure read of the in-memory store. */
export function statusSnapshot(input: { readonly directory?: string } = {}): StatusSnapshot {
  const version = pluginVersion()
  const allWorkers = [...store.workers.values()]

  if (input.directory !== undefined) {
    const dirKey = dirKeyFor(input.directory)
    const partition = store.dirs.get(dirKey)
    const workers = allWorkers.filter((worker) => dirKeyForWorker(worker) === dirKey)
    const directory = canonicalDirectory(input.directory) ?? input.directory
    return {
      version,
      ...(partition?.routerID === undefined ? {} : { router: partition.routerID }),
      pending: partition?.pending.length ?? 0,
      workers: workers.map(workerView),
      dirKey,
      directory,
    }
  }

  // Legacy fields keep their stage 2b values: the default partition's router
  // (else the first partition that has one), the sum over every queue and the
  // full worker list.
  const router = store.routerID ?? routerPartitions()[0]?.routerID
  const partitions = perDirectoryRouterEnabled() ? partitionViews(allWorkers) : []
  return {
    version,
    ...(router === undefined ? {} : { router }),
    pending: totalPending(),
    workers: allWorkers.map(workerView),
    // A single active partition is exactly the stage 2b world: do not add the
    // summary, so that payload stays byte-identical. The TUI only needs it to
    // tell several directories apart anyway.
    ...(partitions.length > 1 ? { partitions } : {}),
  }
}
