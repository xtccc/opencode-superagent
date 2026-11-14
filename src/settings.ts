/**
 * 插件选项（`ctx.options`）的解析与进程内镜像。
 *
 * 项目里一直没有独立的 settings/config 模块：配置就是 OpenCode 插件条目里的
 * 选项，各处读取 `ctx.options[key]`（`pendingTTLMs`、`watchdogIntervalMs`、
 * `worker_detail_message_limit`、`sources`）。这里把需要跨模块读取的开关集中
 * 一处，避免每个模块都各自解释同一个布尔值，也方便测试直接改写。
 *
 * 解析原则：**只有严格 `true` 才打开**。字符串 `"true"`、`1` 之类一律按关闭处理，
 * 因为这些开关控制的是行为变更（当前阶段是目录分区），静默误解配置比忽略更危险。
 */

import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, normalize } from "node:path"
import { cwd } from "node:process"
import { sharedSingleton } from "./shared.js"

export interface SuperagentSettings {
  /**
   * 「一目录一实例」开关（阶段 2 才真正生效）。
   *
   * `false`（默认）＝ 现状：整个进程共用一份 Router / 队列 / thread 亲和，KV key
   * 保持 `router` / `worker:` / `thread:` / `trigger:` 原样，升级不丢状态。
   */
  readonly perDirectoryRouter: boolean
  /**
   * 每个目录分区同时最多有多少个**非终态** worker（`running` / `idle`）。
   *
   * `0`（默认）＝ 不限制，与阶段 2a 行为一致。正整数时才在 `dispatch` 的
   * claim 之后、`sessions.create` 之前做同步闸门（含并发在途的预留名额），
   * 所以两个并发 dispatch 不可能同时看到"还剩一个空位"而超卖。
   */
  readonly maxWorkersPerDirectory: number
  /**
   * Router 的固定工作目录（可选）。配置后网关的 Router 不再落进 `default`
   * 分区，而是拥有 `dirKeyOf(routerDirectory)` 这个分区，会话也创建在该目录
   * （`location.directory`）。因此用户在同一个目录的 TUI `/tickets` 里就能看到
   * 它的工单（TUI 用会话目录解析分区，两者一致）。
   *
   * 必须是**存在的绝对路径**；非法值（相对路径、不存在、不是目录）被忽略，
   * 启动时只告警一次，行为回到未配置（`default` 分区）。未配置时行为不变。
   */
  readonly routerDirectory: string | undefined
}

export const DEFAULT_SETTINGS: SuperagentSettings = {
  perDirectoryRouter: false,
  maxWorkersPerDirectory: 0,
  routerDirectory: undefined,
}

/** `routerDirectory` 校验失败的具体原因。 */
export type RouterDirectoryInvalidReason =
  | "not-a-string"
  | "empty"
  | "not-absolute"
  | "missing"
  | "not-a-directory"

export interface RouterDirectoryParse {
  /** 生效的绝对路径；`undefined` 表示未配置或配置被忽略。 */
  readonly directory: string | undefined
  /** 配置了但非法：调用方据此告警一次（不抛错）。 */
  readonly invalid: boolean
  /** 非法原因（`invalid` 为真时有效）。 */
  readonly reason: RouterDirectoryInvalidReason | undefined
}

/**
 * 解析 `routerDirectory`：必须是**存在的绝对路径目录**。
 *
 * 只做「能不能安全使用」的判断，不做分词/别名解析：路径本身会在 `dirKeyOf`
 * 里再走一次跨平台规范化（含 realpath）。用 `node:path` 的平台判定（Linux/macOS
 * 上是 POSIX，Windows 上是盘符），因为这是本机网关自己的配置。
 *
 * 任何问题都返回 `{ invalid: true }` 而不是抛错：一个写错的配置项不应该让整个
 * 网关启动失败，回退到 `default` 分区即可（与未配置一致）。
 */
export function parseRouterDirectory(raw: unknown): RouterDirectoryParse {
  if (raw === undefined || raw === null)
    return { directory: undefined, invalid: false, reason: undefined }
  if (typeof raw !== "string")
    return { directory: undefined, invalid: true, reason: "not-a-string" }
  const trimmed = raw.trim()
  if (trimmed === "") return { directory: undefined, invalid: true, reason: "empty" }
  if (!isAbsolute(trimmed)) return { directory: undefined, invalid: true, reason: "not-absolute" }
  const normalized = normalize(trimmed)
  try {
    if (!statSync(normalized).isDirectory())
      return { directory: undefined, invalid: true, reason: "not-a-directory" }
  } catch {
    // stat 失败：路径不存在，或父路径某一层是文件（ENOTDIR）。
    return {
      directory: undefined,
      invalid: true,
      reason: existsSync(normalized) ? "not-a-directory" : "missing",
    }
  }
  return { directory: normalized, invalid: false, reason: undefined }
}

/** 失败原因对应的可操作建议（英文，与既有日志风格一致）。 */
const ROUTER_DIRECTORY_REASON_TEXT: Record<RouterDirectoryInvalidReason, string> = {
  "not-a-string": "it must be a string path",
  empty: "it must not be empty",
  "not-absolute": "it must be an absolute path (it looks relative)",
  missing: "the directory does not exist",
  "not-a-directory": "the path exists but is not a directory",
}

/**
 * 失败原因对应的**可操作**建议：尽量给出用户复制即可执行的命令。
 *
 * - 目录不存在 → `mkdir -p <path>`（父目录一起建）。
 * - 不是目录 → 让用户自己选一个目录（不能替用户删文件），只给检查命令。
 * - 相对路径 → 让用户改写成绝对路径（给 `pwd` 提示）。
 */
function routerDirectoryAdvice(
  reason: RouterDirectoryInvalidReason,
  raw: string,
): string {
  switch (reason) {
    case "missing": {
      const target = raw.trim()
      return `create it with: mkdir -p "${target}" (then restart the gateway)`
    }
    case "not-a-directory": {
      const target = raw.trim()
      return `point routerDirectory at a real directory instead (check with: ls -ld "${target}")`
    }
    case "not-absolute": {
      const target = raw.trim()
      return `use an absolute path, e.g. "${normalize(join(cwd(), target))}" (check with: pwd)`
    }
    case "empty":
      return "remove the empty value or set it to an existing absolute directory path"
    case "not-a-string":
      return "set routerDirectory to a string path, e.g. \"/abs/path/to/dir\""
  }
}

/**
 * Effective settings for the **process**, not for one plugin instance. The host
 * loads the plugin once per location with the same plugin config; a per-module
 * mirror would still diverge if one instance hydrated before another, and the
 * partition rule (`effectiveDirKey`) is read from here by the ticket, dir and
 * worker layers. One shared value keeps every instance partitioning the same
 * way — otherwise an instance that thinks the switch is off parks a worker in
 * the default partition and never finds (or closes) its ticket.
 *
 * `invalidRouterDirectory` carries the raw bad value until the first caller
 * takes it (`takeRouterDirectoryWarning`), so the startup warning is emitted
 * once per process even though the host loads the plugin once per location.
 */
interface SharedSettings {
  value: SuperagentSettings
  invalidRouterDirectory: string | undefined
  /** The failure reason for `invalidRouterDirectory`. */
  invalidRouterDirectoryReason: RouterDirectoryInvalidReason | undefined
  /** The exact raw value already reported, so one bad config warns once. */
  warnedRaw: string | undefined
}

const current: SharedSettings = sharedSingleton("settings.current", () => ({
  value: DEFAULT_SETTINGS,
  invalidRouterDirectory: undefined,
  invalidRouterDirectoryReason: undefined,
  warnedRaw: undefined,
}))

/** 只接受正整数；其它（0、负数、小数、字符串）一律视为不限制。 */
export function parseWorkerLimit(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0
}

/** 从插件选项解析设置（纯函数，不写进程状态）。非法 `routerDirectory` 直接忽略。 */
export function readSettings(options: Readonly<Record<string, unknown>> | undefined): SuperagentSettings {
  return {
    perDirectoryRouter: options?.["perDirectoryRouter"] === true,
    maxWorkersPerDirectory: parseWorkerLimit(options?.["maxWorkersPerDirectory"]),
    routerDirectory: parseRouterDirectory(options?.["routerDirectory"]).directory,
  }
}

/** 记录本次进程的生效设置；`server.ts` 在 setup 最早处调用一次。 */
export function applySettings(options: Readonly<Record<string, unknown>> | undefined): SuperagentSettings {
  const parsed = parseRouterDirectory(options?.["routerDirectory"])
  const next: SuperagentSettings = {
    perDirectoryRouter: options?.["perDirectoryRouter"] === true,
    maxWorkersPerDirectory: parseWorkerLimit(options?.["maxWorkersPerDirectory"]),
    routerDirectory: parsed.directory,
  }
  current.value = next
  // The host calls this once per plugin instance (one per location), with the
  // same value; report each distinct bad value once, not once per instance.
  if (parsed.invalid) {
    const raw = options?.["routerDirectory"]
    const text = typeof raw === "string" ? raw.trim() : String(raw)
    if (text !== current.warnedRaw) {
      current.invalidRouterDirectory = text
      current.invalidRouterDirectoryReason = parsed.reason
    }
  }
  return next
}

/**
 * The one-shot warning for an ignored `routerDirectory`, or `undefined`.
 * Taking it marks the warning as delivered; later calls (and later plugin
 * instances with the same bad value) get nothing.
 */
export function takeRouterDirectoryWarning(): string | undefined {
  const raw = current.invalidRouterDirectory
  if (raw === undefined) return undefined
  const reason = current.invalidRouterDirectoryReason
  current.invalidRouterDirectory = undefined
  current.invalidRouterDirectoryReason = undefined
  current.warnedRaw = raw
  if (reason === undefined) {
    return `routerDirectory ${JSON.stringify(raw)} ignored: it must be an existing absolute path to a directory; keeping the default partition`
  }
  const why = ROUTER_DIRECTORY_REASON_TEXT[reason]
  const advice = routerDirectoryAdvice(reason, raw)
  return `routerDirectory ${JSON.stringify(raw)} ignored: ${why}; ${advice}; keeping the default partition`
}

/** 当前生效设置（只读）。 */
export function currentSettings(): SuperagentSettings {
  return current.value
}

/** `perDirectoryRouter` 是否打开；默认 `false`。 */
export function perDirectoryRouterEnabled(): boolean {
  return current.value.perDirectoryRouter
}

/**
 * 目录分区是否生效。`routerDirectory` 本身就把网关的 Router 钉在一个非默认
 * 分区上，所以配置它等同于启用「分区」这套机制（只有一个分区），否则固定目录
 * 就没有落点。未配置时严格等于 `perDirectoryRouter`。
 */
export function partitioningEnabled(): boolean {
  return current.value.perDirectoryRouter || current.value.routerDirectory !== undefined
}

/** Router 的固定目录；未配置或配置被忽略时为 `undefined`。 */
export function routerDirectorySetting(): string | undefined {
  return current.value.routerDirectory
}

/** 每目录 worker 上限；`0` 表示不限制。 */
export function maxWorkersPerDirectorySetting(): number {
  return current.value.maxWorkersPerDirectory
}

/** 测试用：回到默认设置。 */
export function resetSettings(): void {
  current.value = DEFAULT_SETTINGS
  current.invalidRouterDirectory = undefined
  current.invalidRouterDirectoryReason = undefined
  current.warnedRaw = undefined
}
