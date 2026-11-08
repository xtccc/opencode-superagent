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
 */

export const DIR_THREAD_PREFIX = "dir:thread:"
export const DIR_ALIAS_PREFIX = "dir:alias:"

export const threadDirKey = (threadID: string): string => `${DIR_THREAD_PREFIX}${threadID}`
export const aliasDirKey = (alias: string): string => `${DIR_ALIAS_PREFIX}${alias.toLowerCase()}`

/** threadID -> 绝对路径（内存镜像，hydrate 时从 KV 读回）。 */
export const threadDirs = new Map<string, string>()
/** 小写别名 -> 绝对路径（内存镜像，hydrate 时从 KV 读回）。 */
export const aliasDirs = new Map<string, string>()

export function isValidDirectory(dir: string): boolean {
  return dir.startsWith("/") && dir.length >= 1 && dir.length <= 500
}

export function normalizeDirectory(dir: string): string | undefined {
  const trimmed = dir.trim()
  if (!isValidDirectory(trimmed)) return undefined
  if (trimmed.length > 1 && trimmed.endsWith("/")) return trimmed.slice(0, -1)
  return trimmed
}

/** 目录 basename 小写即默认别名（`/opt/ai-gw` -> `ai-gw`）。 */
export function basenameAlias(dir: string): string {
  const clean = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir
  const parts = clean.split("/").filter((part) => part !== "")
  return (parts[parts.length - 1] ?? "").toLowerCase()
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
        if (prefix === DIR_THREAD_PREFIX) threadDirs.set(entry.key.slice(prefix.length), dir)
        else aliasDirs.set(entry.key.slice(prefix.length).toLowerCase(), dir)
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
  const task = input.task?.toLowerCase() ?? ""
  if (task !== "") {
    const aliases = [...aliasDirs.entries()].sort((left, right) => right[0].length - left[0].length)
    for (const [alias, dir] of aliases) {
      if (alias.length >= 2 && task.includes(alias)) return dir
    }
  }
  return undefined
}

/** 状态行/Spill 用的紧凑摘要（别名全列，thread 只记数量避免刷屏）。 */
export function directorySummary(): string {
  const aliases = [...aliasDirs.entries()].map(([alias, dir]) => `${alias}=${dir}`).join(",")
  return `dirs: threads=${threadDirs.size} aliases=${aliases === "" ? "-" : aliases}`
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
  if (alias !== "") {
    aliasDirs.set(alias, normalized)
    yield* ctx.storage
      .set(aliasDirKey(alias), normalized)
      .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist alias directory", { cause })))
  }
})

/** `/dir` 手动切 Router 目录时同步记住 basename 别名，不改 thread 绑定。 */
export const rememberAlias = Effect.fn("superagent.rememberAlias")(function* (ctx: Plugin.Context, directory: string) {
  const normalized = normalizeDirectory(directory)
  if (normalized === undefined) return
  const alias = basenameAlias(normalized)
  if (alias === "") return
  aliasDirs.set(alias, normalized)
  yield* ctx.storage
    .set(aliasDirKey(alias), normalized)
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist alias directory", { cause })))
})
