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
}

export const DEFAULT_SETTINGS: SuperagentSettings = { perDirectoryRouter: false, maxWorkersPerDirectory: 0 }

let current: SuperagentSettings = DEFAULT_SETTINGS

/** 只接受正整数；其它（0、负数、小数、字符串）一律视为不限制。 */
export function parseWorkerLimit(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 0
}

/** 从插件选项解析设置（纯函数，不写进程状态）。 */
export function readSettings(options: Readonly<Record<string, unknown>> | undefined): SuperagentSettings {
  return {
    perDirectoryRouter: options?.["perDirectoryRouter"] === true,
    maxWorkersPerDirectory: parseWorkerLimit(options?.["maxWorkersPerDirectory"]),
  }
}

/** 记录本次进程的生效设置；`server.ts` 在 setup 最早处调用一次。 */
export function applySettings(options: Readonly<Record<string, unknown>> | undefined): SuperagentSettings {
  current = readSettings(options)
  return current
}

/** 当前生效设置（只读）。 */
export function currentSettings(): SuperagentSettings {
  return current
}

/** `perDirectoryRouter` 是否打开；默认 `false`。 */
export function perDirectoryRouterEnabled(): boolean {
  return current.perDirectoryRouter
}

/** 每目录 worker 上限；`0` 表示不限制。 */
export function maxWorkersPerDirectorySetting(): number {
  return current.maxWorkersPerDirectory
}

/** 测试用：回到默认设置。 */
export function resetSettings(): void {
  current = DEFAULT_SETTINGS
}
