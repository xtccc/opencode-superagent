import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { partitioningEnabled, perDirectoryRouterEnabled, routerDirectorySetting } from "./settings.js"
import { sharedSingleton } from "./shared.js"

/**
 * Router 自管目录记忆：单网关进程服务多目录，Router 从自然语言推断
 * 项目指向并经 `dispatch({ directory })` 落到目标目录。
 *
 * - `dir:thread:<threadID>` -> 绝对路径：该聊天/话题上次使用的目录，命中则复用。
 * - `dir:alias:<alias小写>` -> 绝对路径：别名（如 `ai-gw`）到目录的映射，basename 自动登记。
 *
 * 网关进程本身的目录（`ctx.location.directory`）只是缺省值，不重要。
 *
 * 路径判定是跨平台的（POSIX 绝对路径 + Windows 盘符路径 + MSYS 的 `/c/` 形式），
 * 统一收敛成 `canonicalDirectory` 的规范形式，这样 `C:\x`、`C:/x` 和 `c:\x` 是同一个
 * 目录，别名冲突检测不会被同一目录的写法差异误导。
 */

export const DIR_THREAD_PREFIX = "dir:thread:"
export const DIR_ALIAS_PREFIX = "dir:alias:"

export const threadDirKey = (threadID: string): string => `${DIR_THREAD_PREFIX}${threadID}`
export const aliasDirKey = (alias: string): string => `${DIR_ALIAS_PREFIX}${alias.toLowerCase()}`

/**
 * Directory memory is process state, not per-module state: the host may load
 * one plugin instance per location, and a Router in instance A must resolve the
 * same thread/alias bindings as the dispatcher in instance B.
 *
 * threadID -> 绝对路径（内存镜像，hydrate 时从 KV 读回）。
 */
export const threadDirs: Map<string, string> = sharedSingleton("dirs.threads", () => new Map<string, string>())
/**
 * 小写别名 -> 路径（内存镜像，hydrate 时从 KV 读回）。
 * 迭代顺序即“最近登记”顺序（最旧在前），状态行据此只显示最近几条。
 */
export const aliasDirs: Map<string, string> = sharedSingleton("dirs.aliases", () => new Map<string, string>())
/**
 * 别名冲突：同名 basename 落在了别的目录。先登记的目录保留映射（稳定），
 * 后到的目录只记在这里，且该别名不再参与自动匹配（避免派发到错误目录）。
 */
export const aliasConflicts: Map<string, Array<string>> = sharedSingleton(
  "dirs.alias-conflicts",
  () => new Map<string, Array<string>>(),
)

/** 目录字符串长度上限， pathologic input 的护栏。 */
const MAX_DIRECTORY_LENGTH = 500
/** 别名表上限：超出后淘汰最久未动的一条（连同它的冲突记录）。 */
export const ALIAS_LIMIT = 24
/** 状态行里最多显示多少条别名，避免一行被别名表撑爆。 */
export const ALIAS_SUMMARY_LIMIT = 5
/** 目录非法时给 Router 的唯一文案，不再暗示某个具体目录。 */
export const DIRECTORY_ERROR =
  "directory must be an absolute path: POSIX (/opt/project), Windows (C:\\project or C:/project) or MSYS (/c/project)"

/** Windows 盘符路径：`C:\x`、`C:/x`、`c:\`。 */
const DRIVE_PATH = /^([A-Za-z]):([\\/])(.*)$/
/** MSYS 盘符形式 `[ /c/x ]`；要求 `/<字母>/` 带斜杠，避免把 POSIX 的 `/c` 当盘符。 */
const MSYS_PATH = /^\/([A-Za-z])\/(.*)$/
/** 控制字符（含 NUL）不是合法路径的一部分。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** `C` + `Users/me` -> `C:\Users\me`：盘符大写、分隔符统一反斜杠、去掉多余分隔符。 */
function joinDrive(letter: string, rest: string): string {
  const drive = `${letter.toUpperCase()}:\\`
  const parts = rest.split(/[\\/]+/).filter((part) => part !== "")
  return parts.length === 0 ? drive : `${drive}${parts.join("\\")}`
}

/**
 * 规范形式：
 * - `C:\Users\me` / `C:/Users/me` / `c:\Users\me\` -> `C:\Users\me`
 * - `/c/Users/me` -> `C:\Users\me`
 * - `/opt/app/` -> `/opt/app`（POSIX 保持 `/` 风格）
 * 非法（空、相对路径、纯盘符、超长、含控制字符）返回 `undefined`。
 */
export function canonicalDirectory(dir: string): string | undefined {
  const trimmed = dir.trim()
  if (trimmed === "" || trimmed.length > MAX_DIRECTORY_LENGTH) return undefined
  if (CONTROL_CHARS.test(trimmed)) return undefined
  const drive = DRIVE_PATH.exec(trimmed)
  if (drive !== null) return joinDrive(drive[1] ?? "", drive[3] ?? "")
  const msys = MSYS_PATH.exec(trimmed)
  if (msys !== null) return joinDrive(msys[1] ?? "", msys[2] ?? "")
  if (!trimmed.startsWith("/")) return undefined
  const parts = trimmed.split("/").filter((part) => part !== "")
  return `/${parts.join("/")}`
}

/** 跨平台绝对路径判定：POSIX 绝对路径、Windows 盘符路径、MSYS `/c/` 形式。 */
export function isValidDirectory(dir: string): boolean {
  return canonicalDirectory(dir) !== undefined
}

/** trim + 规范化的绝对路径；非法返回 `undefined`（所有目录校验的唯一入口）。 */
export function normalizeDirectory(dir: string): string | undefined {
  return canonicalDirectory(dir)
}

/** 非法目录的统一错误文案；合法返回 `undefined`。 */
export function directoryError(dir: string | undefined): string | undefined {
  if (dir === undefined || dir.trim() === "") return DIRECTORY_ERROR
  return normalizeDirectory(dir) === undefined ? DIRECTORY_ERROR : undefined
}

// ── directory partition keys（一目录一实例的地基） ────────────────────────────

/**
 * 没有目录（非法目录、相对路径、未指定）时使用的分区 key。固定字面量，
 * 这样升级前后默认分区永远是同一个，旧 KV 状态可以原地归入其中。
 */
export const DEFAULT_DIR_KEY = "default"

/** slug 段上限：可读性由 slug 负责，唯一性由后面的短 hash 负责。 */
const DIR_KEY_SLUG_MAX = 40

/**
 * 目录 → 分区 key（`<slug>-<sha1[0:8]>`），只含 `[a-z0-9-]`：
 * KV key 里不能出现 `/`、`:`、空白，也不能和 `dir:` / `worker:` 这类前缀分段混淆。
 *
 * - 先 `canonicalDirectory` 归一（`C:\x`、`C:/x`、`/c/x`、尾斜杠都收敛）；
 * - 再尝试 `realpathSync`：符号链接与目标目录共用一个分区，大小写不敏感的
 *   文件系统上（Windows / macOS）同一目录的不同写法也在此合并；失败（路径不存在、
 *   权限不足、跨平台路径）就用 canonical 结果；
 * - hash 覆盖**保留大小写**的路径，所以 `App` 与 `app` 在大小写敏感的文件系统上
 *   不会共用一个分区（slug 本身仍小写，只做可读性）。
 *
 * 空串、`undefined`、相对路径等都归到 `DEFAULT_DIR_KEY`，调用方不需要自己判断。
 */
export function dirKeyOf(directory: string | undefined): string {
  if (directory === undefined) return DEFAULT_DIR_KEY
  const canonical = canonicalDirectory(directory)
  if (canonical === undefined) return DEFAULT_DIR_KEY
  const resolved = resolveRealPath(canonical)
  const digest = createHash("sha1").update(resolved).digest("hex").slice(0, 8)
  const key = `${slugFor(resolved)}-${digest}`
  // Reverse index: a partition must be able to answer "which directory am I?"
  // without it, a per-directory Router session could not be created *in* that
  // directory (`location.directory` needs a real path, not a key).
  rememberDirDirectory(key, resolved)
  return key
}

/**
 * 分区 key → 目录的进程内反向索引。
 *
 * 只服务运行期（创建该分区的 Router 会话要用真实路径）：不持久化，重启后由
 * `dirKeyOf` 的再次命中、hydrate 到的 Router 会话 `location.directory` 或该分区
 * worker 的 `directory` 重新填充。首次写入优先，避免符号链接与其目标互相覆盖。
 */
const dirKeyDirectories: Map<string, string> = sharedSingleton(
  "dirs.dir-key-directories",
  () => new Map<string, string>(),
)

/** 登记（首次优先）某个分区的目录。 */
export function rememberDirDirectory(dirKey: string, directory: string): void {
  if (dirKey === DEFAULT_DIR_KEY) return
  if (dirKeyDirectories.has(dirKey)) return
  const canonical = canonicalDirectory(directory)
  if (canonical === undefined) return
  dirKeyDirectories.set(dirKey, canonical)
}

/** 某个分区对应的目录；未知返回 `undefined`。 */
export function directoryOfDirKey(dirKey: string): string | undefined {
  return dirKeyDirectories.get(dirKey)
}

/** 测试用：清空反向索引（分区表被清空时同步调用）。 */
export function resetDirDirectories(): void {
  dirKeyDirectories.clear()
}

/**
 * Router 的固定分区（`routerDirectory` 配置后），未配置时为 `undefined`。
 *
 * 结果缓存到配置的目录字符串上：`dirKeyOf` 会做 realpath + sha1，而分区规则
 * 在每次工单/worker/dispatch 判定时都会被读到。配置是进程启动时读一次的，
 * 所以只要目录不变就不需要重算（`resetSettings` 会让目录变回 `undefined`）。
 */
let pinnedRouter: { readonly directory: string; readonly dirKey: string } | undefined

/** `routerDirectory` 对应的分区 key；未配置（或配置被忽略）返回 `undefined`。 */
export function routerDirKeySetting(): string | undefined {
  const directory = routerDirectorySetting()
  if (directory === undefined) {
    pinnedRouter = undefined
    return undefined
  }
  if (pinnedRouter?.directory === directory) return pinnedRouter.dirKey
  const dirKey = dirKeyOf(directory)
  pinnedRouter = { directory, dirKey }
  return dirKey
}

/**
 * 某个分区是不是 Router 的固定分区；是则返回它的目录，否则 `undefined`。
 * 创建/认领 Router 会话时用它补上 `location.directory`。
 */
export function routerDirectoryForPartition(dirKey: string | undefined): string | undefined {
  const directory = routerDirectorySetting()
  if (directory === undefined) return undefined
  return routerDirKeySetting() === (dirKey ?? DEFAULT_DIR_KEY) ? directory : undefined
}

/**
 * 目录 → 分区 key。
 *
 * - 未启用分区（`perDirectoryRouter` 关闭且没有 `routerDirectory`）：一切归默认
 *   分区，阶段 1 的单实例行为不会因为某个调用点忘了判断开关而被绕开。
 * - 只配置了 `routerDirectory`（开关关闭）：整个进程仍然只有一个分区，但它就是
 *   那个固定目录的分区 —— 固定目录若没有落点，`/tickets` 依旧看不到 Router 的工单。
 * - 分区启用后：缺省目录（`undefined`）归 Router 的固定分区（没有固定目录时归
 *   `default`），显式目录按 `dirKeyOf` 各自成区。
 *
 * 定义放在 `dirs.ts`（而不是 `state.ts`）是为了让**不能** import `state.ts` 的模块
 * （工单层 `ticket.ts`，它与 `state.ts` 互相引用）用同一份实现，而不是各自复制
 * 一份"开关关闭就落到默认分区"的判断。
 */
export function dirKeyFor(directory: string | undefined): string {
  if (!partitioningEnabled()) return DEFAULT_DIR_KEY
  const pinned = routerDirKeySetting()
  if (!perDirectoryRouterEnabled()) return pinned ?? DEFAULT_DIR_KEY
  if (directory === undefined) return pinned ?? DEFAULT_DIR_KEY
  return dirKeyOf(directory)
}

/**
 * 把「调用方给的分区」收敛成生效分区。
 *
 * 关闭分区时一切归默认分区（单实例，接受第二个 key 只会把状态写进一个没人读的
 * 命名空间）。只配置了 `routerDirectory` 时唯一的分区就是那个固定目录；分区
 * 打开后只有**缺省**分区被替换成固定分区，显式分区（含 `default`）保持原样——
 * 那样历史 `default` 工单才有明确的"不在这里"语义。
 */
export function effectiveDirKey(dirKey: string | undefined): string {
  if (!partitioningEnabled()) return DEFAULT_DIR_KEY
  const pinned = routerDirKeySetting()
  if (!perDirectoryRouterEnabled()) return pinned ?? DEFAULT_DIR_KEY
  return dirKey ?? pinned ?? DEFAULT_DIR_KEY
}

/**
 * The record shape a worker partition can be derived from. Structural (not the
 * `WorkerRecord` type) because this module must stay a leaf: `ticket.ts` and
 * `worker-state.ts` both need the rule and neither may import `state.ts`.
 */
export interface WorkerOwnerRef {
  /**
   * Partition of the Router that dispatched this worker. **This** is the
   * ownership field: a worker may run in any directory, so its working
   * directory says nothing about which Router gets its report.
   */
  readonly ownerDirKey?: string
  /** Legacy only: used when `ownerDirKey` is absent (records from before it). */
  readonly directory?: string
}

/**
 * Partition that owns a worker record: the dispatching Router's partition.
 *
 * - new records carry `ownerDirKey` and it always wins;
 * - records written before that field fall back to deriving it from
 *   `directory` (the pre-fix behaviour, kept so an upgrade does not lose the
 *   routing of workers that are still running);
 * - neither present → the default partition (the caller warns once).
 */
export function workerOwnerDirKey(record: WorkerOwnerRef | undefined): string {
  if (!partitioningEnabled()) return DEFAULT_DIR_KEY
  const owner = record?.ownerDirKey
  if (owner !== undefined && owner !== "") return owner
  return dirKeyFor(record?.directory)
}

/** Whether a worker record states its own partition (either field), for the one-shot degradation warning. */
export function workerOwnerKnown(record: WorkerOwnerRef | undefined): boolean {
  if (record === undefined) return false
  const owner = record.ownerDirKey
  return (owner !== undefined && owner !== "") || record.directory !== undefined
}

/**
 * The directory a partition's Router should be created in, when the worker's
 * record can tell: only if its `directory` really is that partition's own
 * directory (the legacy rule). A cross-directory dispatch must never move the
 * dispatcher's Router into the worker's working directory — that is exactly the
 * bug that made a completion notice arrive "from" another directory.
 */
export function workerHomeDirectory(record: WorkerOwnerRef | undefined, dirKey: string): string | undefined {
  const directory = record?.directory
  if (directory === undefined) return undefined
  return dirKeyOf(directory) === dirKey ? directory : undefined
}

/** realpath 优先，失败或结果非法时退回规范形式（磁盘上不存在的目录很常见）。 */
function resolveRealPath(canonical: string): string {
  try {
    return canonicalDirectory(realpathSync(canonical)) ?? canonical
  } catch {
    return canonical
  }
}

/** 小写 slug：非 `[a-z0-9]` 连续段压成一个 `-`，空结果用 `dir` 兜底（如根目录）。 */
function slugFor(path: string): string {
  const slug = path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DIR_KEY_SLUG_MAX)
    .replace(/-+$/g, "")
  return slug === "" ? "dir" : slug
}

/** 目录 basename 小写即默认别名（`/opt/ai-gw` -> `ai-gw`，`C:\work\App` -> `app`）。 */
export function basenameAlias(dir: string): string {
  const canonical = canonicalDirectory(dir)
  if (canonical === undefined) return ""
  const parts = canonical.split(/[\\/]+/).filter((part) => part !== "")
  const alias = (parts[parts.length - 1] ?? "").toLowerCase()
  // 盘符根目录（`C:\`）的 basename 是 `c:`，没有信息量，不登记别名。
  return /^[a-z]:$/.test(alias) ? "" : alias
}

function touchAlias(alias: string, dir: string): void {
  // 重新插入到 Map 末尾 = 标记为“最近登记”，顺序即状态行的展示顺序。
  aliasDirs.delete(alias)
  aliasDirs.set(alias, dir)
}

/** 超过上限时淘汰最久未动的别名，连同它的冲突记录。 */
function evictAliases(): void {
  while (aliasDirs.size > ALIAS_LIMIT) {
    const oldest = aliasDirs.keys().next()
    if (oldest.done === true) return
    aliasDirs.delete(oldest.value)
    aliasConflicts.delete(oldest.value)
  }
}

/**
 * 登记别名（hydrate、dispatch 自动登记、`/dir` 手动登记共用）：
 * - 同别名同目录：只刷新“最近使用”位置；
 * - 同别名不同目录：保留先登记的那条（稳定，不覆盖），把新目录记入冲突表；
 * - 别名表超过 `ALIAS_LIMIT`：淘汰最久未动的一条。
 */
export function registerAlias(alias: string, directory: string): void {
  const key = alias.trim().toLowerCase()
  if (key.length < 2) return
  const dir = canonicalDirectory(directory)
  if (dir === undefined) return
  const existing = aliasDirs.get(key)
  if (existing === undefined) {
    aliasDirs.set(key, dir)
    evictAliases()
    return
  }
  if (existing === dir) {
    touchAlias(key, dir)
    return
  }
  const conflicts = aliasConflicts.get(key) ?? []
  if (!conflicts.includes(dir)) conflicts.push(dir)
  aliasConflicts.set(key, conflicts)
  touchAlias(key, existing)
}

/** 该别名是否因为同名不同目录而变得歧义（歧义别名不参与自动匹配）。 */
export function aliasIsAmbiguous(alias: string): boolean {
  return (aliasConflicts.get(alias.toLowerCase())?.length ?? 0) > 0
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 词边界精确匹配：别名两侧不能紧邻 ASCII 字母/数字/下划线，
 * 所以 `app` 不会命中 `appstore` 或 `myapp`，但仍能命中 `修复app的问题`、
 * `app/web` 这类用标点/中文分隔的写法。
 */
export function matchesAlias(task: string, alias: string): boolean {
  const key = alias.toLowerCase()
  if (key.length < 2) return false
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key)}(?![A-Za-z0-9_])`).test(task.toLowerCase())
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** 启动时把 KV 中的目录映射读回内存；坏条目直接清理。 */
export const hydrateDirs = Effect.fn("superagent.hydrateDirs")(function* (ctx: Plugin.Context) {
  for (const prefix of [DIR_THREAD_PREFIX, DIR_ALIAS_PREFIX] as const) {
    let after: string | undefined
    do {
      const page = yield* ctx.storage
        .scan({ prefix, after, limit: 100 })
        .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
      for (const entry of page.entries) {
        const dir = asString(entry.value)
        if (dir === undefined || !isValidDirectory(dir)) {
          yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
          continue
        }
        if (prefix === DIR_THREAD_PREFIX) threadDirs.set(entry.key.slice(prefix.length), normalizeDirectory(dir) ?? dir)
        else registerAlias(entry.key.slice(prefix.length), dir)
      }
      after = page.next
    } while (after !== undefined)
  }
})

export interface ResolveDirectoryInput {
  readonly threadID?: string
  readonly task?: string
  readonly requested?: string
}

/**
 * 目录解析优先级：显式 directory > thread 绑定 > 任务文本中的已知别名 >
 * 调用方缺省（网关目录）。返回 `undefined` 时调用方用网关默认目录。
 * 别名按词边界精确匹配，长别名优先；歧义别名（同名不同目录）跳过。
 */
export function resolveDirectory(input: ResolveDirectoryInput): string | undefined {
  if (input.requested !== undefined) {
    const normalized = normalizeDirectory(input.requested)
    if (normalized !== undefined) return normalized
  }
  if (input.threadID !== undefined) {
    const bound = threadDirs.get(input.threadID)
    if (bound !== undefined) return bound
  }
  const task = input.task ?? ""
  if (task !== "") {
    const aliases = [...aliasDirs.keys()]
      .filter((alias) => !aliasIsAmbiguous(alias))
      .sort((left, right) => right.length - left.length)
    for (const alias of aliases) {
      if (!matchesAlias(task, alias)) continue
      const dir = aliasDirs.get(alias)
      if (dir !== undefined) return dir
    }
  }
  return undefined
}

/**
 * 状态行/Spill 用的紧凑摘要：thread 只记数量，别名只列最近 `ALIAS_SUMMARY_LIMIT`
 * 条（新的在前），被折叠的条数与冲突数单独标注，避免整表刷屏。
 */
export function directorySummary(): string {
  const all = [...aliasDirs.keys()]
  const shown = all.slice(-ALIAS_SUMMARY_LIMIT).reverse()
  const rendered = shown.map((alias) => {
    const dir = aliasDirs.get(alias) ?? "-"
    const conflicts = aliasConflicts.get(alias) ?? []
    return conflicts.length === 0 ? `${alias}=${dir}` : `${alias}=${dir}(conflict:${conflicts.join("|")})`
  })
  const hidden = all.length - shown.length
  const conflicts = all.filter((alias) => aliasIsAmbiguous(alias)).length
  const parts = [`threads=${threadDirs.size}`, `aliases=${rendered.length === 0 ? "-" : rendered.join(",")}`]
  if (hidden > 0) parts.push(`+${hidden} older`)
  if (conflicts > 0) parts.push(`conflicts=${conflicts}`)
  return `dirs: ${parts.join(" ")}`
}

/** 已知 thread 绑定的单行提示，拼到 flush 给 Router 的 trigger 文本后面。 */
export function threadDirHint(threadID: string): string | undefined {
  const bound = threadDirs.get(threadID)
  if (bound === undefined) return undefined
  return `已知目录：${bound}（该 thread 上次使用，命中则复用 dispatch directory=${bound}；换目录需用户确认）`
}

export const rememberDirectory = Effect.fn("superagent.rememberDirectory")(function* (
  ctx: Plugin.Context,
  input: { readonly threadID?: string; readonly directory: string },
) {
  const normalized = normalizeDirectory(input.directory)
  if (normalized === undefined) return
  if (input.threadID !== undefined) {
    threadDirs.set(input.threadID, normalized)
    yield* ctx.storage
      .set(threadDirKey(input.threadID), normalized)
      .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread directory", { cause })))
  }
  const alias = basenameAlias(normalized)
  if (alias === "") return
  registerAlias(alias, normalized)
  // Persist the mapping memory actually kept: on a conflict the first directory
  // wins, so writing the loser would make a restart resolve the other way.
  const persisted = aliasDirs.get(alias) ?? normalized
  yield* ctx.storage
    .set(aliasDirKey(alias), persisted)
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist alias directory", { cause })))
})

/** `/dir` 手动切 Router 目录时同步记住 basename 别名，不改 thread 绑定。 */
export const rememberAlias = Effect.fn("superagent.rememberAlias")(function* (ctx: Plugin.Context, directory: string) {
  const normalized = normalizeDirectory(directory)
  if (normalized === undefined) return
  const alias = basenameAlias(normalized)
  if (alias === "") return
  registerAlias(alias, normalized)
  const persisted = aliasDirs.get(alias) ?? normalized
  yield* ctx.storage
    .set(aliasDirKey(alias), persisted)
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist alias directory", { cause })))
})
