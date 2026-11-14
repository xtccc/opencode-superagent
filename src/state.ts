import type { Plugin } from "@opencode/plugin/effect"
import type { Session } from "@opencode/schema/session"
import { DateTime, Effect, type Schema } from "effect"
import {
  DEFAULT_DIR_KEY,
  canonicalDirectory,
  dirKeyFor,
  effectiveDirKey,
  rememberDirDirectory,
  resetDirDirectories,
  routerDirKeySetting,
  routerDirectoryForPartition,
  workerHomeDirectory,
  workerOwnerDirKey,
} from "./dirs.js"
import { buildReport, lastAssistantText, reportSummary, saveReport } from "./report.js"
import { dirScopedKey, scanDirScoped, scanEntries } from "./scope.js"
import { partitioningEnabled, routerDirectorySetting } from "./settings.js"
import { sharedSingleton } from "./shared.js"
import { blockTicketsForWorker, closeTicketsForWorker } from "./ticket.js"
import { closeOutcomeForWorkerState } from "./ticket-state.js"
import { WORKER_STATES, workers, type WorkerRecord, type WorkerState } from "./worker-state.js"

export type { WorkerRecord, WorkerState } from "./worker-state.js"

/**
 * 分区 key 的两个纯函数定义在 `dirs.ts`（工单层也要用，而工单层不能 import 本模块）。
 * 这里重新导出，旧调用点 `from "./state.js"` 的写法继续成立。
 */
export { dirKeyFor, effectiveDirKey }

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

/**
 * Host context for fire-and-forget KV writes from synchronous interception
 * points. Set during hydrate; shared so an instance that has not hydrated yet
 * (or whose hydrate ran first) still persists through the process-wide host.
 */
const persistHost = sharedSingleton("state.persist-host", () => ({ current: undefined as Plugin.Context | undefined }))

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

function schedulePersist(record: TriggerRecord, dirKey: string): void {
  const host = persistHost.current
  if (host === undefined) return
  const snapshot: TriggerRecord = { ...record }
  const scope = effectiveDirKey(dirKey)
  Effect.runFork(persistTrigger(host, snapshot, scope).pipe(Effect.catchCause(() => Effect.void)))
}

/** 某个分区的 trigger 历史表（开关关闭时恒为默认分区的那张）。 */
function triggerStore(dirKey: string): DirState {
  return dirState(store, effectiveDirKey(dirKey))
}

/**
 * 按 id 在所有已加载的分区里找 trigger 记录（连同它所属的分区）。
 * trigger id 在分区内唯一；跨分区同名只可能来自同一线程被两个目录复用，
 * 此时返回第一个命中的分区，反查补链不会因此丢记录。
 */
function findTrigger(id: string): { record: TriggerRecord; dirKey: string } | undefined {
  for (const [dirKey, dir] of store.dirs) {
    const record = dir.triggers.get(id)
    if (record !== undefined) return { record, dirKey }
  }
  return undefined
}

function rememberQueued(input: TriggerInput, dirKey: string): void {
  const partition = triggerStore(dirKey)
  const id = input.id ?? triggerIdFor(input)
  const delivered = partition.triggers.get(id)
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
  if (!partition.triggers.has(id)) partition.triggerTotal += 1
  partition.triggers.set(id, record)
  schedulePersist(record, partition.dirKey)
}

function markFlushed(removed: Array<PendingTrigger>, dirKey: string): void {
  const partition = triggerStore(dirKey)
  const routerID = routerIDForDir(partition.dirKey)
  for (const item of removed) {
    const id = item.trigger.id ?? triggerIdFor(item.trigger)
    const record = partition.triggers.get(id)
    if (record === undefined) continue
    record.route = "router"
    if (routerID !== undefined) record.sessionID = routerID
    schedulePersist(record, partition.dirKey)
  }
}

/**
 * Queue that transparently records trigger history. `server.ts` and
 * `router.ts` keep using plain `push`/`splice`; interception here writes
 * the memory map synchronously and persists to KV in the background, so
 * no caller changes are needed.
 *
 * 每个分区一份队列，实例自己记得 `dirKey`：历史记录里的 `sessionID` 必须是
 * **该分区**的 Router，否则跨目录投递看起来像是同一个 Router 处理的。
 */
export class PendingQueue extends Array<PendingTrigger> {
  /** 所属分区。`Array` 的 species 构造会传数字长度，非字符串一律回落到默认分区。 */
  readonly dirKey: string

  constructor(dirKey: unknown = DEFAULT_DIR_KEY) {
    super()
    this.dirKey = typeof dirKey === "string" ? dirKey : DEFAULT_DIR_KEY
  }

  override push(...items: Array<PendingTrigger>): number {
    const normalized = items.map((item) => ({ trigger: normalizeTrigger(item.trigger), arrivedAt: item.arrivedAt }))
    for (const item of normalized) rememberQueued(item.trigger, this.dirKey)
    return super.push(...normalized)
  }
  override splice(start: number, deleteCount?: number, ...items: Array<PendingTrigger>): Array<PendingTrigger> {
    const removed = deleteCount === undefined ? super.splice(start) : super.splice(start, deleteCount, ...items)
    if (removed.length > 0) markFlushed(removed, this.dirKey)
    return removed
  }
}

/**
 * Record a trigger delivered straight to a worker (it never passes the
 * pending queue). The text comes from the admitted prompt, so it carries
 * the same truncation as the worker-visible format; queued triggers keep
 * their full text via `rememberQueued`.
 *
 * `dirKey` is the partition of the worker that received it: a direct trigger
 * recorded from worker A's prompt must never appear in directory B's history.
 */
export function upsertDirectTrigger(
  input: DirectTriggerInput,
  sessionID: string,
  dirKey: string = DEFAULT_DIR_KEY,
): TriggerRecord {
  const partition = triggerStore(dirKey)
  const existing = partition.triggers.get(input.id)
  if (existing !== undefined) {
    if (existing.route === undefined) existing.route = "worker"
    if (existing.sessionID === undefined) existing.sessionID = sessionID
    schedulePersist(existing, partition.dirKey)
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
  partition.triggers.set(input.id, record)
  partition.triggerTotal += 1
  schedulePersist(record, partition.dirKey)
  return record
}

/**
 * 单个目录的状态切片：一个分区拥有自己的 Router、未投递队列和 thread 亲和。
 * 开关关闭时这张表里永远只有 `DEFAULT_DIR_KEY` 一条，读写行为与改造前完全一致。
 */
export interface DirState {
  /** 分区 key。分区自己知道落在哪一格，遍历/索引时不必反查。 */
  readonly dirKey: string
  /**
   * 该分区对应的绝对目录。创建分区的 Router 会话时用它作为
   * `location.directory`；默认分区或目录未知时为 `undefined`。
   */
  directory?: string
  routerID: string | undefined
  routerBusy: boolean
  readonly threads: Map<string, Array<string>>
  /**
   * 未投递队列。**必须**是 `PendingQueue`：它的 `push`/`splice` 拦截负责 trigger
   * 历史的同步与异步落盘，普通 Array 会静默丢掉这段行为。类型写成 Array 是为了
   * 让 `adoptLegacyStore` 保留旧 store 里那个普通数组的对象身份（升级不换队列）。
   */
  readonly pending: Array<PendingTrigger>
  /**
   * 目录内的 trigger 历史（阶段 2b 起按分区隔离）。`PendingQueue` 的 push/splice
   * 与 `upsertDirectTrigger` 都写这里；读写它的调用方必须自己带上分区。
   */
  readonly triggers: Map<string, TriggerRecord>
  /**
   * 该分区在 KV 里的 trigger 记录数（不是内存里保留的最近 200 条）。
   * `status`/`buildStatusInjection` 读本分区的这个计数。
   */
  triggerTotal: number
}

export interface Store {
  /**
   * 「当前分区」视图的落点。阶段 2a 恒为 `DEFAULT_DIR_KEY`（运行期不改写）：
   * 有目录感知的代码显式传 `dirKey`，不靠这个全局游标。
   */
  dirKey: string
  /** 目录分区表，由 `dirState` 懒创建。 */
  readonly dirs: Map<string, DirState>
  // 以下字段是「当前分区」的视图（accessor），不是独立状态：所有既有调用点
  // 继续写 `store.routerID` / `store.threads` / `store.pending` / `store.triggers`，
  // 落点由 `dirState` 决定。分区的代码路径显式传 `dirKey`，不依赖这个游标。
  routerID: string | undefined
  routerBusy: boolean
  readonly workers: Map<string, WorkerRecord>
  readonly threads: Map<string, Array<string>>
  readonly pending: Array<PendingTrigger>
  /** 「当前分区」的 trigger 历史视图（accessor，落点由 `dirState` 决定）。 */
  readonly triggers: Map<string, TriggerRecord>
  /** 「当前分区」的 trigger 记录数（accessor）。 */
  triggerTotal: number
  /** Pending triggers dropped as stale at hydrate (see the router replay TTL); surfaced by `status`. */
  pendingDropped: number
}

/**
 * 一个空的分区。`pending` 必须是 `PendingQueue`：它的 `push`/`splice` 拦截负责
 * trigger 历史的同步与异步落盘，普通 Array 会静默丢掉这段行为。
 */
export function createDirState(dirKey: string = DEFAULT_DIR_KEY, directory?: string): DirState {
  return {
    dirKey,
    ...(directory === undefined ? {} : { directory }),
    routerID: undefined,
    routerBusy: false,
    threads: new Map(),
    pending: new PendingQueue(dirKey),
    triggers: new Map<string, TriggerRecord>(),
    triggerTotal: 0,
  }
}

/**
 * 取（必要时创建）某个目录的分区。`key` 缺省是当前分区，因此默认开关下
 * 所有既有读写都落在同一张图上，`store.dirs.size` 恒为 1。
 *
 * `directory` 只在创建时（或原分区还不知道自己的目录时）写入：它是运行期
 * 提示，不是身份，分区身份始终是 `dirKey`。
 */
export function dirState(target: Store, key?: string, directory?: string): DirState {
  const dirKey = key ?? target.dirKey ?? DEFAULT_DIR_KEY
  // The partition's own directory is fixed when it is the `routerDirectory`
  // partition: a caller passing a work directory must not rename it (status,
  // Router creation and `workerHomeDirectory` all read this field).
  const pinned = routerDirectoryForPartition(dirKey)
  const home = pinned ?? directory
  const existing = target.dirs.get(dirKey)
  if (existing !== undefined) {
    if (pinned !== undefined) existing.directory = pinned
    else if (directory !== undefined && existing.directory === undefined) existing.directory = directory
    return existing
  }
  const created = createDirState(dirKey, home)
  target.dirs.set(dirKey, created)
  if (home !== undefined) rememberDirDirectory(dirKey, home)
  return created
}

// ── directory partitioning helpers（阶段 2a：每目录一个 Router） ──────────────

/**
 * 某个 worker 记录所属的分区（开关关闭时恒为默认分区）。
 *
 * 归属看 `ownerDirKey`（派发方 Router 的分区），不是 `directory`：跨目录派发时
 * worker 的会话落在别的目录里，但它仍然属于派发它的那个 Router。旧记录没有
 * `ownerDirKey`，回退到按 `directory` 推导（升级前的口径）。
 */
export function dirKeyForWorker(worker: { readonly ownerDirKey?: string; readonly directory?: string } | undefined): string {
  return workerOwnerDirKey(worker)
}

/** 取（必要时创建）某个目录的分区，并把目录登记到分区上。 */
export function dirStateForDirectory(directory: string | undefined): DirState {
  const canonical = directory === undefined ? undefined : canonicalDirectory(directory)
  const dir = dirState(store, dirKeyFor(directory), canonical)
  if (canonical !== undefined) rememberDirDirectory(dir.dirKey, canonical)
  return dir
}

/** 某个分区的 Router id（未创建时 `undefined`）。 */
export function routerIDForDir(dirKey: string): string | undefined {
  return store.dirs.get(dirKey)?.routerID
}

/** 所有已存在 Router 的分区（`status`/`session-meta` 用）。 */
export function routerPartitions(): Array<{ dirKey: string; routerID: string }> {
  const out: Array<{ dirKey: string; routerID: string }> = []
  for (const [dirKey, dir] of store.dirs) {
    if (dir.routerID !== undefined) out.push({ dirKey, routerID: dir.routerID })
  }
  return out
}

/**
 * Router 会话 → 分区的 O(1) 反查索引。`routerID` 的 accessor 每次赋值都会维护
 * 它（包括 hydrate 与测试直接赋值），miss 时退回一次分区扫描并补登记：旧版
 * store、被 adopt 的 legacy store 或重复加载的插件副本都不会因此丢路由。
 */
const ROUTER_DIRS_KEY = Symbol.for("opencode-superagent.router-dirs.v1")

type GlobalWithRouterDirs = typeof globalThis & { [ROUTER_DIRS_KEY]?: Map<string, string> }

const routerDirGlobals = globalThis as GlobalWithRouterDirs

const routerDirs: Map<string, string> = routerDirGlobals[ROUTER_DIRS_KEY] ?? new Map<string, string>()

routerDirGlobals[ROUTER_DIRS_KEY] = routerDirs

/** 登记 routerID → dirKey，并清掉该分区上已被替换的旧 id。 */
function indexRouter(routerID: string, dirKey: string): void {
  for (const [known, key] of routerDirs) {
    if (key === dirKey && known !== routerID) routerDirs.delete(known)
  }
  routerDirs.set(routerID, dirKey)
}

/** 分区丢掉 Router 时清掉索引（否则被删会话的事件仍会被当成 Router 事件）。 */
function unindexRouter(dirKey: string): void {
  for (const [known, key] of routerDirs) {
    if (key === dirKey) routerDirs.delete(known)
  }
}

/** 把某个分区的 Router 设为 `routerID`（`undefined` = 忘记它），同时维护反查索引。 */
export function rememberRouter(dirKey: string, routerID: string | undefined): void {
  const dir = dirState(store, dirKey)
  dir.routerID = routerID
  if (routerID === undefined) unindexRouter(dirKey)
  else indexRouter(routerID, dirKey)
}

/** Router 会话所属的分区；不是 Router 返回 `undefined`。 */
export function dirKeyForRouter(sessionID: string | undefined): string | undefined {
  if (sessionID === undefined) return undefined
  const indexed = routerDirs.get(sessionID)
  if (indexed !== undefined) return indexed
  for (const [dirKey, dir] of store.dirs) {
    if (dir.routerID === sessionID) {
      routerDirs.set(sessionID, dirKey)
      return dirKey
    }
  }
  return undefined
}

/**
 * 该会话是不是（当前配置下的）Router。开关关闭时只有默认分区的 Router 算数，
 * 这样升级期间残留的非默认分区绝不可能被当成 Router 而拿到 router-only 工具。
 */
export function isRouterSession(sessionID: string | undefined): boolean {
  const dirKey = dirKeyForRouter(sessionID)
  if (dirKey === undefined) return false
  return partitioningEnabled() || dirKey === DEFAULT_DIR_KEY
}

/** 所有分区的未投递 trigger 总数（`status`/RPC 用；开关关闭时等于旧行为）。 */
export function totalPending(): number {
  if (!partitioningEnabled()) return store.pending.length
  let total = 0
  for (const dir of store.dirs.values()) total += dir.pending.length
  return total
}

/**
 * 测试用：回到「只有默认分区、且默认分区是空的」状态，并清掉 Router 反查索引。
 * 单纯 `store.dirs.delete(key)` 会留下索引里的脏映射，后续用例就会把一个已
 * 不存在的 Router 当成真的。
 */
export function resetPartitions(): void {
  for (const key of [...store.dirs.keys()]) {
    if (key !== DEFAULT_DIR_KEY) store.dirs.delete(key)
  }
  const def = dirState(store, DEFAULT_DIR_KEY)
  def.routerID = undefined
  def.routerBusy = false
  def.directory = undefined
  def.threads.clear()
  // 直接截断（不走 `splice`）：清场不应写 trigger 历史。
  def.pending.length = 0
  def.triggers.clear()
  def.triggerTotal = 0
  routerDirs.clear()
  resetDirDirectories()
}

/**
 * 把扁平字段接到「当前分区」上。用 accessor 而不是让每个调用点改成
 * `dirState(store).x`：`state.ts` 之外有 ~40 处 `store.routerID` /
 * `store.threads` / `store.pending` / `store.triggers` 读写，逐个改写既容易漏，
 * 也把阶段 2 的改动面放大。accessor 让旧写法继续成立，同时把真正的存储收敛到一处
 * （也保证测试里 `store.triggers.clear()` 清的仍是默认分区那张表）。
 */
function bindDirPartition(target: Store): void {
  Object.defineProperties(target, {
    routerID: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).routerID,
      set: (value: string | undefined) => {
        const dir = dirState(target)
        dir.routerID = value
        if (value === undefined) unindexRouter(dir.dirKey)
        else indexRouter(value, dir.dirKey)
      },
    },
    routerBusy: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).routerBusy,
      set: (value: boolean) => {
        dirState(target).routerBusy = value
      },
    },
    threads: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).threads,
    },
    pending: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).pending,
    },
    triggers: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).triggers,
    },
    triggerTotal: {
      configurable: true,
      enumerable: true,
      get: () => dirState(target).triggerTotal,
      set: (value: number) => {
        dirState(target).triggerTotal = value
      },
    },
  })
}

/**
 * 把一个由旧版插件创建的 store 迁移到分区结构：旧 store 的扁平字段（以及它
 * 可能已经写进去的 router/线程/队列）原样搬进默认分区，再重新绑定 accessor。
 * 跨版本共享 store 实际上很罕见（旧版没有同一个 `Symbol.for`），但升级时如果
 * 发生了，绝不能让 Router id 或未投递队列凭空消失。
 */
export function adoptLegacyStore(target: Store): void {
  // 先读旧值：`bindDirPartition` 会把它们换成 accessor，之后读到的就是新分区的空表。
  const previousTriggers: unknown = (target as { triggers?: unknown }).triggers
  const previousTotal: unknown = (target as { triggerTotal?: unknown }).triggerTotal
  if (!(target.dirs instanceof Map)) {
    const legacy = target as Store & { dirs?: Map<string, DirState>; dirKey?: string }
    const flat: DirState = {
      dirKey: DEFAULT_DIR_KEY,
      routerID: target.routerID,
      routerBusy: target.routerBusy === true,
      threads: target.threads instanceof Map ? target.threads : new Map<string, Array<string>>(),
      pending: Array.isArray(target.pending) ? target.pending : new PendingQueue(DEFAULT_DIR_KEY),
      triggers: previousTriggers instanceof Map ? (previousTriggers as Map<string, TriggerRecord>) : new Map(),
      triggerTotal: typeof previousTotal === "number" ? previousTotal : 0,
    }
    const dirs = new Map<string, DirState>()
    dirs.set(DEFAULT_DIR_KEY, flat)
    legacy.dirs = dirs
    legacy.dirKey = DEFAULT_DIR_KEY
  }
  if (typeof target.dirKey !== "string" || target.dirKey === "") target.dirKey = DEFAULT_DIR_KEY
  if (!target.dirs.has(target.dirKey)) target.dirs.set(target.dirKey, createDirState(target.dirKey))
  // A store created by an intermediate copy has `dirs` but no per-partition
  // trigger history: adopt its flat trigger map into the default partition (the
  // one a pre-2b copy wrote to) and default the counter, so nothing is dropped
  // and later arithmetic never yields NaN.
  for (const dir of target.dirs.values()) {
    if (!(dir.triggers instanceof Map)) {
      const adopt =
        dir.dirKey === DEFAULT_DIR_KEY && previousTriggers instanceof Map
          ? (previousTriggers as Map<string, TriggerRecord>)
          : new Map<string, TriggerRecord>()
      ;(dir as { triggers: Map<string, TriggerRecord> }).triggers = adopt
    }
    if (typeof dir.triggerTotal !== "number") {
      dir.triggerTotal = dir.dirKey === DEFAULT_DIR_KEY && typeof previousTotal === "number" ? previousTotal : 0
    }
  }
  bindDirPartition(target)
  // 被 adopt 的 store 是「赋值已经发生过」的旧对象，accessor 的 setter 没机会
  // 维护反向索引：这里补一次，否则 dirKeyForRouter 只能走兜底扫描。
  for (const [dirKey, dir] of target.dirs) {
    if (dir.routerID !== undefined) indexRouter(dir.routerID, dirKey)
  }
}

/**
 * Process-wide symbol for the store object. A module-level store is safe while
 * the host reuses one module instance, but a duplicate plugin copy (two install
 * paths for the same version, or a re-reconciliation) would hydrate its own
 * maps. `sleep` could then poll a store that the watcher never writes and
 * silently sleep the full time. Sharing the object on `globalThis` keeps the
 * tool, the watcher and the RPC surface on the same state.
 *
 * Cross-version copies cannot share (older code has no such symbol), so the
 * upgrade path still requires a gateway restart; `versionNotice` says so.
 */
const STORE_KEY = Symbol.for("opencode-superagent.store.v1")

type GlobalWithStore = typeof globalThis & { [STORE_KEY]?: Store }

const globals = globalThis as GlobalWithStore

function createStore(): Store {
  const dirs = new Map<string, DirState>()
  dirs.set(DEFAULT_DIR_KEY, createDirState(DEFAULT_DIR_KEY))
  // `routerID`/`routerBusy`/`threads`/`pending`/`triggers`/`triggerTotal` 由
  // `bindDirPartition` 装成 accessor，所以这里先只构造其余字段，再补上分区视图。
  const created = {
    dirKey: DEFAULT_DIR_KEY,
    dirs,
    workers,
    pendingDropped: 0,
  } as unknown as Store
  bindDirPartition(created)
  return created
}

export const store: Store = globals[STORE_KEY] ?? createStore()
// A store created by an older copy of this plugin may predate a field added
// here; default it once so later arithmetic never yields `NaN`.
if (typeof store.pendingDropped !== "number") store.pendingDropped = 0
// A store shared with an older copy has no `dirs`; fold its flat fields into the
// default partition before anything else touches it.
adoptLegacyStore(store)
globals[STORE_KEY] = store

export const ROUTER_KEY = "router"
export const WORKER_PREFIX = "worker:"
export const THREAD_PREFIX = "thread:"
export const TRIGGER_PREFIX = "trigger:"

/**
 * 非默认目录的 KV 命名空间（`dir:<dirKey>:`）与扫描工具定义在 `scope.ts`：
 * 工单层 `ticket.ts` 也要用同一份实现，而它不能 import 本模块。
 *
 * **兼容策略**：`router` / `worker:` / `thread:` / `trigger:` / `pending:` /
 * `ticket…` 这些 key 在默认分区全部保持原样，hydrate 也扫描这些旧前缀——
 * 升级后的进程因此读到与升级前完全相同的 KV，不存在「状态孤岛」。
 * 只有当 `perDirectoryRouter` 打开**且**分区不是默认目录时，才在前面加
 * `dir:<dirKey>:`；默认分区永远走旧格式，避免把已有数据搬来搬去。
 *
 * 阶段 2a 分区 Router / thread 亲和 / pending 队列；阶段 2b 追加 trigger 历史
 * 与工单（worker 记录仍挂在进程级表上，靠记录里的 `directory` 归位）。
 */
export { DIR_SCOPE_PREFIX, dirScopedKey } from "./scope.js"
export type { ScannedEntry, ScopedEntry } from "./scope.js"
export { scanDirScoped, scanEntries }

/**
 * 从一个分区的 thread 亲和表里摘掉 worker，并把变化写回该分区的 KV key。
 * 派发回滚与 abort 共用：两侧各写一份已经漂移过，跨目录时尤其危险。
 */
export const detachWorkerThreads = Effect.fn("superagent.detachWorkerThreads")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  threadIDs: ReadonlyArray<string>,
  dirKey: string,
) {
  const threads = dirState(store, dirKey).threads
  const detached: Array<string> = []
  for (const threadID of threadIDs) {
    const current = threads.get(threadID)
    if (current === undefined || !current.includes(sessionID)) continue
    const next = current.filter((id) => id !== sessionID)
    if (next.length === 0) {
      threads.delete(threadID)
      yield* ctx.storage.remove(dirScopedKey(threadKey(threadID), dirKey)).pipe(Effect.catch(() => Effect.void))
    } else {
      threads.set(threadID, next)
      yield* ctx.storage
        .set(dirScopedKey(threadKey(threadID), dirKey), encodeThread({ threadID, workers: next, updatedAt: Date.now() }))
        .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
    }
    detached.push(threadID)
  }
  return detached
})

// 阶段 1：以下 key 构造器仍输出旧格式（默认分区），阶段 2 再把非默认分区接到
// `dirScopedKey` 上；保持单一入口，避免读写两侧各改一半。
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

/** A session's directory, tolerant of hosts/test doubles that omit `location`. */
function sessionDirectory(info: unknown): string | undefined {
  if (typeof info !== "object" || info === null) return undefined
  const location = (info as { location?: unknown }).location
  if (typeof location !== "object" || location === null) return undefined
  const directory = (location as { directory?: unknown }).directory
  return typeof directory === "string" ? directory : undefined
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

/** Only known worker states are kept; unknown legacy values are dropped. */
function stateArray(value: unknown): Array<WorkerState> | undefined {
  const states = stringArray(value)
  if (states === undefined) return undefined
  return states.filter((state): state is WorkerState => WORKER_STATES.includes(state as WorkerState))
}

export function decodeWorker(value: Schema.Json | undefined): WorkerRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["sessionID"] !== "string") return undefined
  if (typeof value["state"] !== "string" || !WORKER_STATES.includes(value["state"] as WorkerState)) return undefined
  const threads = stringArray(value["threads"])
  if (threads === undefined) return undefined
  const createdAt = optionalNumber(value, "createdAt") ?? 0
  const triggerID = optionalString(value, "triggerID")
  const execution = optionalNumber(value, "execution")
  const notified = stateArray(value["notified"])
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
    ...(optionalString(value, "ownerDirKey") === undefined ? {} : { ownerDirKey: optionalString(value, "ownerDirKey") }),
    ...(execution === undefined ? {} : { execution }),
    ...(notified === undefined || notified.length === 0 ? {} : { notified }),
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
    ...(record.ownerDirKey === undefined ? {} : { ownerDirKey: record.ownerDirKey }),
    ...(record.execution === undefined ? {} : { execution: record.execution }),
    ...(record.notified === undefined || record.notified.length === 0 ? {} : { notified: [...record.notified] }),
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

const persistTrigger = Effect.fn("superagent.persistTrigger")(function* (
  ctx: Plugin.Context,
  record: TriggerRecord,
  dirKey: string = DEFAULT_DIR_KEY,
) {
  yield* ctx.storage
    .set(dirScopedKey(triggerKey(record.id), effectiveDirKey(dirKey)), encodeTrigger(record))
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
 * close its ticket for `done`/`failed`, and park it as `blocked` for an
 * interruption.
 *
 * The interruption branch is the restart counterpart of the watcher's: the
 * worker becomes `idle`, which the dispatch gate treats as a live session, so a
 * ticket left `in_progress` would be gated forever and the Router could never
 * re-dispatch it. `blocked` records that the attempt was interrupted and makes
 * the ticket dispatchable again.
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
  } else if (state === "idle") {
    yield* blockTicketsForWorker(ctx, {
      sessionID: record.sessionID,
      ...(info.outcome === undefined ? {} : { reason: `interrupted while the plugin was down (${info.outcome})` }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to block ticket for rehydrated interrupted worker", {
          sessionID: record.sessionID,
          cause,
        }),
      ),
    )
  }
  yield* Effect.logInfo("superagent rehydrated ended worker", { sessionID: record.sessionID, state })
})

/**
 * How many `session.get` calls `hydrate` and `hydrateSessionMeta` keep in
 * flight. Startup validates every persisted worker/session with one lookup, so
 * a serial loop costs one round trip per record (the N+1 the review found);
 * the bound keeps a large install from opening hundreds of requests at once.
 */
export const HYDRATE_CONCURRENCY = 8

/**
 * Load KV state into the in-memory maps. Storage is the unique source of
 * truth; every loaded session is validated with `session.get` and stale
 * entries are cleaned from both memory and KV.
 *
 * Worker records are decoded page by page but their session lookups run with
 * bounded concurrency, and the records are then applied in their original
 * order: the load is no longer one round trip per worker, while the state
 * transitions (and the ticket reconciliation they trigger) keep the order they
 * had when the loop was serial.
 */
export const hydrate = Effect.fn("superagent.hydrate")(function* (ctx: Plugin.Context) {
  persistHost.current = ctx
  const sessions = ctx.session
  const storage = ctx.storage
  // 旧 KV 只有一套扁平 key：读回的 Router / thread 亲和一律归入默认目录。
  // 分区读写（`dir:<dirKey>:`）留给阶段 2，因此这里永远显式指向默认分区，
  // 而不是依赖 `store.dirKey`——升级时不会把状态写进一个空分区。
  const defaultDir = dirState(store, DEFAULT_DIR_KEY)
  // `routerDirectory`：网关的 Router 固定在这个目录的分区里。旧版（开关打开前）
  // 创建的 Router 没有 `location.directory`，重启后按这个配置「认领」过去，而不是
  // 留在 `default` 分区（那样用户在任何目录的 `/tickets` 都看不到它的工单）。
  const pinnedDir = routerDirectorySetting()
  const pinnedKey = routerDirKeySetting()
  const storedRouter = yield* storage.get(ROUTER_KEY).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (typeof storedRouter === "string") {
    const info = yield* sessions.get({ sessionID: toSessionID(storedRouter) }).pipe(
      Effect.map((session) => session as Session.Info | undefined),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (info === undefined) {
      yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
    } else {
      const home = sessionDirectory(info)
      // The legacy `router` pointer is by definition the default partition's
      // Router — created before the flag/feature, so it has no partition of its
      // own. With a fixed directory configured it belongs to that partition;
      // its session location (when the host reports the gateway's own default)
      // is not an ownership statement.
      const claimable = pinnedKey !== undefined && pinnedKey !== DEFAULT_DIR_KEY
      if (claimable) {
        const scoped = yield* storage
          .get(dirScopedKey(ROUTER_KEY, pinnedKey))
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (typeof scoped === "string" && scoped !== info.id) {
          // A per-directory Router already owns this partition: keep it and
          // drop the stale legacy pointer, so the same session can never be
          // served by two partitions.
          yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
          yield* Effect.logInfo("superagent legacy router superseded by routerDirectory partition", {
            legacy: info.id,
            kept: scoped,
            dirKey: pinnedKey,
          })
        } else {
          dirState(store, pinnedKey, pinnedDir)
          rememberRouter(pinnedKey, info.id)
          yield* storage
            .set(dirScopedKey(ROUTER_KEY, pinnedKey), info.id)
            .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist claimed router", { cause })))
          // Move the pointer: keeping both keys would let the default
          // partition adopt the same session again on the next ensureRouter.
          yield* storage.remove(ROUTER_KEY).pipe(Effect.catch(() => Effect.void))
          yield* Effect.logInfo("superagent legacy router claimed by routerDirectory", {
            router: info.id,
            dirKey: pinnedKey,
            directory: pinnedDir,
          })
        }
      } else {
        rememberRouter(DEFAULT_DIR_KEY, info.id)
        if (home !== undefined) defaultDir.directory = home
      }
    }
  }
  // 非默认分区的 Router 存在 `dir:<dirKey>:router`。开关关闭时 scanDirScoped
  // 返回空数组，旧路径一个字节都不变。
  for (const entry of yield* scanDirScoped(ctx, "router")) {
    if (entry.suffix !== "router") continue
    const id = typeof entry.value === "string" ? entry.value : undefined
    if (id === undefined) {
      yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
      continue
    }
    const info = yield* sessions.get({ sessionID: toSessionID(id) }).pipe(
      Effect.map((session) => session as Session.Info | undefined),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (info === undefined) {
      yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
      continue
    }
    dirState(store, entry.dirKey, sessionDirectory(info))
    rememberRouter(entry.dirKey, info.id)
  }
  const records: Array<WorkerRecord> = []
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
      records.push(record)
    }
    after = page.next
  } while (after !== undefined)
  const validated = yield* Effect.forEach(
    records,
    (record) =>
      sessions.get({ sessionID: toSessionID(record.sessionID) }).pipe(
        Effect.map((session) => ({ record, info: session as Session.Info | undefined })),
        Effect.catch(() => Effect.succeed({ record, info: undefined })),
      ),
    { concurrency: HYDRATE_CONCURRENCY },
  )
  for (const { record, info } of validated) {
    if (info === undefined) {
      yield* removeWorker(ctx, record.sessionID)
      continue
    }
    store.workers.set(record.sessionID, record)
    if (record.state === "running") yield* reconcileRunningWorker(ctx, record, info)
  }
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
      defaultDir.threads.set(record.threadID, alive)
    }
    threadAfter = page.next
  } while (threadAfter !== undefined)
  // 分区 thread 亲和（`dir:<dirKey>:thread:<threadID>`）：开关关闭时为空。
  for (const entry of yield* scanDirScoped(ctx, THREAD_PREFIX)) {
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
    dirState(store, entry.dirKey).threads.set(record.threadID, alive)
  }
  // 分区必须知道自己的目录，才能把该目录的 Router 会话创建在正确位置。
  // 只有**确实是该分区自己的目录**才会被登记（旧记录按 `directory` 推导归属，
  // 新记录只在 `dirKeyOf(directory) === dirKey` 时命中）：`directory` 是工作目录，
  // 把一个跨目录派发的 worker 的目录登记给派发方分区，会让 A 分区的 Router 被
  // 创建在 B 的工作目录里。
  if (partitioningEnabled()) {
    for (const worker of store.workers.values()) {
      const dirKey = dirKeyForWorker(worker)
      const home = workerHomeDirectory(worker, dirKey)
      dirState(store, dirKey, home === undefined ? undefined : canonicalDirectory(home))
    }
  }
  // Trigger 历史按分区读回：旧前缀 `trigger:` 归默认分区，`dir:<k>:trigger:` 归
  // 各自分区。开关关闭时 `scanDirScoped` 返回空数组，这段就退化成原来的单表读取。
  const triggerGroups: Array<{
    dirKey: string
    entries: ReadonlyArray<{ key: string; value: Schema.Json | undefined }>
  }> = [{ dirKey: DEFAULT_DIR_KEY, entries: yield* scanEntries(ctx, TRIGGER_PREFIX) }]
  for (const entry of yield* scanDirScoped(ctx, TRIGGER_PREFIX)) {
    triggerGroups.push({ dirKey: entry.dirKey, entries: [entry] })
  }
  for (const group of triggerGroups) {
    const partition = dirState(store, group.dirKey)
    const decoded: Array<TriggerRecord> = []
    const seen = new Set<string>()
    for (const entry of group.entries) {
      const record = decodeTrigger(entry.value)
      if (record === undefined) {
        yield* storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      if (seen.has(record.id)) continue
      seen.add(record.id)
      decoded.push(record)
    }
    decoded.sort((left, right) => right.createdAt - left.createdAt)
    // 计数是整个 KV 里的记录数，内存只保留最近 200 条。
    partition.triggerTotal = decoded.length
    for (const record of decoded.slice(0, RECENT_TRIGGER_LIMIT)) {
      // 不覆盖内存里已有的同 id 记录：内存可能比 KV 更新（上次写盘失败时
      // 记录只是排进重试队列），重复 hydrate 不该把它回滚成旧值。
      if (!partition.triggers.has(record.id)) partition.triggers.set(record.id, record)
    }
  }
  // ── reference graph backfill (idempotent) ──────────────────────────────────
  // New records carry `threadID`/`triggerID`/`workerIDs`; legacy records only
  // have `threads`. Rebuild a missing edge from what is still authoritative
  // (the thread affinity list, or the opposite edge) and persist only changed
  // records, so a second hydrate writes nothing and only a stat line is logged.
  let backfilledWorkers = 0
  let backfilledTriggers = 0
  for (const dir of store.dirs.values()) {
    for (const [threadID, workerIDs] of dir.threads) {
      for (const sessionID of workerIDs) {
        const worker = store.workers.get(sessionID)
        if (worker === undefined || worker.threadID !== "") continue
        worker.threadID = threadID
        backfilledWorkers += 1
        yield* persistWorker(ctx, worker)
      }
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
  for (const dir of store.dirs.values()) {
    for (const trigger of dir.triggers.values()) {
      const triggerID = trigger.id
      for (const sessionID of trigger.workerIDs ?? []) {
        const worker = store.workers.get(sessionID)
        if (worker === undefined || worker.triggerID !== undefined) continue
        worker.triggerID = triggerID
        backfilledWorkers += 1
        yield* persistWorker(ctx, worker)
      }
    }
  }
  for (const worker of store.workers.values()) {
    const triggerID = worker.triggerID
    if (triggerID === undefined) continue
    const found = findTrigger(triggerID)
    if (found === undefined) continue
    const ids = found.record.workerIDs ?? []
    if (ids.includes(worker.sessionID)) continue
    found.record.workerIDs = [...ids, worker.sessionID]
    backfilledTriggers += 1
    yield* persistTrigger(ctx, found.record, found.dirKey)
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
 *
 * `dirKey` is the partition the trigger belongs to (the dispatcher's own): a
 * trigger id is only meaningful inside one partition's history.
 */
export const linkTriggerToWorker = Effect.fn("superagent.linkTriggerToWorker")(function* (
  ctx: Plugin.Context,
  triggerID: string,
  sessionID: string,
  dirKey: string = DEFAULT_DIR_KEY,
) {
  const partition = triggerStore(dirKey)
  const existing = partition.triggers.get(triggerID)
  const record =
    existing ??
    decodeTrigger(
      yield* ctx.storage
        .get(dirScopedKey(triggerKey(triggerID), partition.dirKey))
        .pipe(Effect.catch(() => Effect.succeed(undefined))),
    )
  if (record === undefined) return false
  const workerIDs = record.workerIDs ?? []
  if (workerIDs.includes(sessionID)) return false
  record.workerIDs = [...workerIDs, sessionID]
  yield* persistTrigger(ctx, record, partition.dirKey)
  return true
})

/**
 * Persist one partition's thread affinity record. `dirKey` is required in
 * spirit (a thread id is only meaningful inside a partition): it defaults to
 * the default partition so a pre-2b caller keeps writing the legacy key.
 */
export const saveThread = Effect.fn("superagent.saveThread")(function* (
  ctx: Plugin.Context,
  record: ThreadRecord,
  dirKey: string = DEFAULT_DIR_KEY,
) {
  yield* ctx.storage
    .set(dirScopedKey(threadKey(record.threadID), effectiveDirKey(dirKey)), encodeThread(record))
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
})
