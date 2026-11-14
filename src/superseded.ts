import type { Plugin } from "@opencode/plugin/effect"
import { Effect, type Schema } from "effect"
import { sharedSingleton } from "./shared.js"

/**
 * 「被取代的 Router」标记。
 *
 * 认领（claim）时目标分区已经有一个 Router，旧代码会把旧的 KV 指针**删掉**：
 * 旧会话不再是任何分区的 Router，它的 `ticket_list` / `dispatch` / `sleep` /
 * `status` 全部只回一句 `only available to the router session`，用户完全不知情。
 *
 * 现在改成：
 * - 旧指针**保留**（`router` 键的值不变，回滚无损）；
 * - 另写一条独立的标记键 `superseded:router:<sessionID>`，里面记着是谁取代了它；
 * - 旧会话再次被访问（工具调用 / 上下文 hook / status）时给出**可读**的提示，
 *   而不是静默失败。
 *
 * 标记键**不进分区命名空间**：一个会话被取代是全局事实（会话 id 全局唯一），
 * 而且它绝不能被 `dir:` 前缀扫描（`scanDirScoped(ctx, "router")`）当成某个
 * 分区的 Router 指针读回来。
 */

/** KV 前缀：被取代的 Router 会话标记。 */
export const SUPERSEDED_PREFIX = "superseded:router:"

/** 某个会话的标记键。 */
export const supersededKey = (sessionID: string): string => `${SUPERSEDED_PREFIX}${sessionID}`

export interface SupersededInfo {
  /** 被取代的会话（原来的 Router）。 */
  readonly sessionID: string
  /** 取代它的会话（现在这个分区的 Router）。 */
  readonly supersededBy: string
  /** 这个 Router 角色所属的分区。 */
  readonly dirKey: string
  /** 标记时间（毫秒）。 */
  readonly at: number
}

/**
 * 进程内的标记表（跨插件实例共享）：宿主的每个目录都会加载一份插件，
 * 模块级的 Map 只能看到自己那一份。标记是**只读**事实，读多写少，
 * 所以用 shared singleton 直接共享同一个对象。
 */
const registry = sharedSingleton("state.superseded", () => new Map<string, SupersededInfo>())

/** 某个会话是否已被取代；被取代则返回标记内容。 */
export function supersededInfo(sessionID: string | undefined): SupersededInfo | undefined {
  if (sessionID === undefined) return undefined
  return registry.get(sessionID)
}

/**
 * 人类可读的说明（旧会话的用户与模型都会看到）。
 *
 * 中英并列：用户读中文，模型读英文，两边都能立刻明白「这个会话不再是 Router」。
 */
export function supersededNotice(sessionID: string | undefined): string | undefined {
  const info = supersededInfo(sessionID)
  if (info === undefined) return undefined
  return `本会话已不再是 Router，已被 ${info.supersededBy} 取代（分区 ${info.dirKey}）; this session is no longer the Router and its router-only tools are disabled.`
}

/** 测试用：清空整个标记表。 */
export function resetSuperseded(): void {
  registry.clear()
  reported.clear()
  preexisting.clear()
}

/** 所有被取代的会话（启动时汇总成一行给用户看）。 */
export function supersededSessions(): Array<SupersededInfo> {
  return [...registry.values()]
}

/**
 * 已经报告过的会话。宿主的每个目录都会加载一份插件，启动日志必须**每个会话只说一次**，
 * 否则同一个取代事件会被打印 N 遍。
 */
const reported = sharedSingleton("state.superseded-reported", () => new Set<string>())

/**
 * 启动时从 KV 读回的标记（也就是说：上一轮进程里发生的取代事件）。
 *
 * 只有这些需要在启动时汇总报告：本进程里刚发生的取代事件在认领当场就已经
 * 打过日志了（见 `state.ts` 的认领分支），再报一遍就是重复噪音。
 */
const preexisting = sharedSingleton("state.superseded-preexisting", () => new Set<string>())

/**
 * 取出尚未报告过的、**启动时读回**的被取代会话，并把它们标记为已报告。
 *
 * 返回 `[]` 表示没有新事件（已经说过，或本进程里刚发生、已当场报告）。
 */
export function takeUnreportedSuperseded(): Array<SupersededInfo> {
  const out: Array<SupersededInfo> = []
  for (const info of registry.values()) {
    if (!preexisting.has(info.sessionID)) continue
    if (reported.has(info.sessionID)) continue
    reported.add(info.sessionID)
    out.push(info)
  }
  return out
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function decodeSuperseded(value: Schema.Json | undefined): SupersededInfo | undefined {
  if (!isRecord(value)) return undefined
  const sessionID = value["sessionID"]
  const supersededBy = value["supersededBy"]
  const dirKey = value["dirKey"]
  if (typeof sessionID !== "string" || typeof supersededBy !== "string" || typeof dirKey !== "string") return undefined
  const at = value["at"]
  return { sessionID, supersededBy, dirKey, at: typeof at === "number" ? at : 0 }
}

function encodeSuperseded(info: SupersededInfo): Schema.Json {
  return {
    sessionID: info.sessionID,
    supersededBy: info.supersededBy,
    dirKey: info.dirKey,
    at: info.at,
  } as unknown as Schema.Json
}

/**
 * 把标记读回内存。坏条目直接丢掉（不删 KV：标记是历史事实，
 * 删掉只会让旧会话重新变回「静默失败」）。
 */
export const hydrateSuperseded = Effect.fn("superagent.hydrateSuperseded")(function* (ctx: Plugin.Context) {
  let after: string | undefined
  do {
    const page = yield* ctx.storage
      .scan({ prefix: SUPERSEDED_PREFIX, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const info = decodeSuperseded(entry.value)
      if (info === undefined) continue
      registry.set(info.sessionID, info)
      // 从 KV 读回 = 上一轮进程发生的事件：启动时要向用户汇总说明。
      preexisting.add(info.sessionID)
    }
    after = page.next
  } while (after !== undefined)
})

/**
 * 持久化一条标记。
 *
 * 幂等：同一个会话只标记一次（重复认领不会覆盖最初的事实，也不会反复写 KV）。
 * 返回 `true` 表示这是**新**标记（调用方据此只告警一次）。
 */
export const persistSuperseded = Effect.fn("superagent.persistSuperseded")(function* (
  ctx: Plugin.Context,
  input: { readonly sessionID: string; readonly supersededBy: string; readonly dirKey: string },
) {
  const existing = registry.get(input.sessionID)
  if (existing !== undefined) return false
  const info: SupersededInfo = {
    sessionID: input.sessionID,
    supersededBy: input.supersededBy,
    dirKey: input.dirKey,
    at: Date.now(),
  }
  registry.set(info.sessionID, info)
  yield* ctx.storage
    .set(supersededKey(input.sessionID), encodeSuperseded(info))
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to persist superseded router marker", {
          sessionID: input.sessionID,
          cause,
        }),
      ),
    )
  return true
})

/**
 * 删掉一个会话的标记（KV + 内存）：它重新当上了 Router，
 * 旧的「已被取代」提示不该继续留着。
 */
export const removeSuperseded = Effect.fn("superagent.removeSuperseded")(function* (
  ctx: Plugin.Context,
  sessionID: string,
) {
  registry.delete(sessionID)
  yield* ctx.storage.remove(supersededKey(sessionID)).pipe(Effect.catch(() => Effect.void))
})
