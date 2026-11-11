import type { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"

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

/** threadID -> 绝对路径（内存镜像，hydrate 时从 KV 读回）。 */
export const threadDirs = new Map<string, string>()
/**
 * 小写别名 -> 路径（内存镜像，hydrate 时从 KV 读回）。
 * 迭代顺序即“最近登记”顺序（最旧在前），状态行据此只显示最近几条。
 */
export const aliasDirs = new Map<string, string>()
/**
 * 别名冲突：同名 basename 落在了别的目录。先登记的目录保留映射（稳定），
 * 后到的目录只记在这里，且该别名不再参与自动匹配（避免派发到错误目录）。
 */
export const aliasConflicts = new Map<string, Array<string>>()

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
