import type { Plugin } from "@opencode/plugin/effect"
import { Effect, type Schema } from "effect"
import { DEFAULT_DIR_KEY } from "./dirs.js"
import { perDirectoryRouterEnabled } from "./settings.js"

/**
 * KV key 的分区命名空间：`dir:<dirKey>:<原来的 key>`。
 *
 * 单独成模块（而不是留在 `state.ts`）是因为工单层 `ticket.ts` 也要用它，而
 * `state.ts` 与 `ticket.ts` 互相引用（`state.ts` 需要 `closeTicketsForWorker`）。
 * 把纯粹的 key 映射与扫描放在叶子模块里，两层共用同一份实现，谁都不用为了
 * 一个字符串前缀去打破那条单向依赖。
 *
 * **兼容策略**：默认分区（`default`）永远保持旧 key，非默认分区才加前缀。
 * 开关关闭时 `dirScopedKey` 对任何分区都是恒等映射，所以键名逐字节不变。
 */
export const DIR_SCOPE_PREFIX = "dir:"

/** 把 KV key 映射到目录分区。默认分区或开关关闭时原样返回入参。 */
export function dirScopedKey(key: string, dirKey: string = DEFAULT_DIR_KEY): string {
  if (dirKey === DEFAULT_DIR_KEY || !perDirectoryRouterEnabled()) return key
  return `${DIR_SCOPE_PREFIX}${dirKey}:${key}`
}

/** 一条扫描结果（`storage.scan` 的结构副本，测试替身也满足）。 */
export interface ScannedEntry {
  readonly key: string
  readonly value: Schema.Json | undefined
}

/**
 * 分页读完一个前缀下的全部 KV 条目。
 *
 * 显式标注返回类型不是风格问题：本模块里 `scanDirScoped` 会调用它，两个 `Effect.fn`
 * 互相引用时 TS 的推断会退化成 `Effect<…, unknown, unknown>`，这个 `unknown` 会
 * 顺着 `hydrate`/`hydratePending` 一路污染到 `Plugin.define`（要求 `never`）。
 */
export const scanEntries: (
  ctx: Plugin.Context,
  prefix: string,
) => Effect.Effect<Array<ScannedEntry>> = Effect.fn("superagent.scanEntries")(function* (
  ctx: Plugin.Context,
  prefix: string,
) {
  const out: Array<ScannedEntry> = []
  let after: string | undefined
  do {
    const page = yield* ctx.storage
      .scan({ prefix, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) out.push({ key: entry.key, value: entry.value })
    after = page.next
  } while (after !== undefined)
  return out
})

export interface ScopedEntry extends ScannedEntry {
  readonly dirKey: string
  /** `dir:<dirKey>:` 之后的部分，即原来的 key。 */
  readonly suffix: string
}

/** `dir:<dirKey>:<suffix>` -> 三段；形状不合法返回 `undefined`。 */
function parseScopedKey(key: string): { dirKey: string; suffix: string } | undefined {
  if (!key.startsWith(DIR_SCOPE_PREFIX)) return undefined
  const rest = key.slice(DIR_SCOPE_PREFIX.length)
  const split = rest.indexOf(":")
  if (split <= 0 || split === rest.length - 1) return undefined
  const dirKey = rest.slice(0, split)
  if (!/^[a-z0-9-]+$/.test(dirKey)) return undefined
  return { dirKey, suffix: rest.slice(split + 1) }
}

/**
 * 开关打开时读回 `dir:<dirKey>:<suffixPrefix>…` 的分区条目；关闭时返回空数组，
 * 所以 hydrate 的两条路径共用同一段代码而不改变旧行为。
 */
export const scanDirScoped: (
  ctx: Plugin.Context,
  suffixPrefix: string,
) => Effect.Effect<Array<ScopedEntry>> = Effect.fn("superagent.scanDirScoped")(function* (
  ctx: Plugin.Context,
  suffixPrefix: string,
) {
  const out: Array<ScopedEntry> = []
  if (!perDirectoryRouterEnabled()) return out
  for (const entry of yield* scanEntries(ctx, DIR_SCOPE_PREFIX)) {
    const parsed = parseScopedKey(entry.key)
    if (parsed === undefined) continue
    if (!parsed.suffix.startsWith(suffixPrefix)) continue
    out.push({ ...entry, dirKey: parsed.dirKey, suffix: parsed.suffix })
  }
  return out
})
