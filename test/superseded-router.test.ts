import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, type Schema } from "effect"
import { DEFAULT_DIR_KEY, dirKeyOf } from "../src/dirs.js"
import { statusText } from "../src/dispatch.js"
import { requireRouter } from "../src/guard.js"
import { ensureRouter } from "../src/router.js"
import { applySettings, resetSettings } from "../src/settings.js"
import {
  ROUTER_KEY,
  dirKeyForRouter,
  dirScopedKey,
  hydrate,
  resetPartitions,
  routerIDForDir,
  store,
} from "../src/state.js"
import {
  resetSuperseded,
  supersededInfo,
  supersededKey,
  supersededNotice,
  supersededSessions,
  takeUnreportedSuperseded,
} from "../src/superseded.js"

/**
 * P0-1「认领时静默夺权」。
 *
 * 认领（claim）时如果目标分区已经有 Router，旧代码会**删掉**旧 Router 的
 * 持久化 KV 指针：旧会话不再是任何分区的 Router，它的所有 router-only 工具
 * 只回一句 `only available to the router session`，用户完全不知情。
 *
 * 这里守的是修复后的三条承诺：
 * 1. 旧指针**保留**（回滚无损），旧会话被标记为 `superseded`；
 * 2. 旧会话再被访问时给出**可读**提示（点名取代者），不是静默失败；
 * 3. 认领/启动时有一条对用户可读的日志说明。
 */

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  readonly created: Array<{ readonly id: string; readonly directory?: string }>
}

function harness(): Harness {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const created: Array<{ id: string; directory?: string }> = []
  let counter = 0
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (input: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(input.prefix)).sort()
        const start = input.after === undefined ? 0 : keys.indexOf(input.after) + 1
        const page = keys.slice(start, start + (input.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      const info = infos.get(sessionID)
      if (info === undefined) return Effect.fail(new Error(`missing session ${sessionID}`))
      return Effect.succeed({ id: sessionID, time: {}, ...info })
    },
    create: (input: { title?: string; location?: { directory: string } }) =>
      Effect.sync(() => {
        counter += 1
        const id = `ses_router_${counter}`
        const directory = input.location?.directory
        created.push({ id, ...(directory === undefined ? {} : { directory }) })
        infos.set(id, { title: input.title, ...(directory === undefined ? {} : { location: { directory } }), time: {} })
        return { id, title: input.title }
      }),
    context: () => Effect.succeed([]),
    synthetic: () => Effect.succeed(undefined),
    prompt: () => Effect.succeed(undefined),
    interrupt: () => Effect.succeed({ interrupted: true }),
    hook: () => Effect.succeed(undefined),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  const ctx = { options: {}, storage, session, agent } as unknown as Plugin.Context
  return { ctx, data, infos, created }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(JSON.stringify(exit.cause))
}

const roots: Array<string> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "superagent-superseded-"))
  roots.push(dir)
  return dir
}

beforeEach(() => {
  resetSettings()
  resetPartitions()
  resetSuperseded()
  store.workers.clear()
})

afterEach(() => {
  resetSettings()
  resetPartitions()
  resetSuperseded()
  while (roots.length > 0) {
    const dir = roots.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe("claiming a partition keeps the old router pointer and marks it superseded", () => {
  test("the legacy pointer survives and the old session is marked", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    // 1. 旧指针保留（回滚无损），新指针照旧指向真正的 Router。
    expect(h.data.get(ROUTER_KEY)).toBe("ses_old")
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe("ses_new")
    // 分区归属只有一个：旧会话不是任何分区的 Router。
    expect(routerIDForDir(key)).toBe("ses_new")
    expect(dirKeyForRouter("ses_old")).toBeUndefined()
    // 2. 标记已持久化。
    expect(supersededInfo("ses_old")).toMatchObject({
      sessionID: "ses_old",
      supersededBy: "ses_new",
      dirKey: key,
    })
    expect(h.data.get(supersededKey("ses_old"))).toBeDefined()
  })

  test("the marker survives a restart (hydrate reads it back)", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))
    // Simulate a restart: the in-memory marker table is gone, KV is not.
    resetSuperseded()
    expect(supersededInfo("ses_old")).toBeUndefined()

    await succeed(hydrate(h.ctx))
    expect(supersededInfo("ses_old")).toMatchObject({ supersededBy: "ses_new", dirKey: key })
    // 幂等：再认领一次不会覆盖事实，也不会重复写 KV。
    expect(h.data.get(ROUTER_KEY)).toBe("ses_old")
  })

  test("the default partition's KV key name is byte-identical", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    // 默认分区的键名还是 `router`（没有 `dir:` 前缀）；非默认分区仍是
    // `dir:<dirKey>:` 前缀。
    expect([...h.data.keys()].filter((entry) => entry === ROUTER_KEY)).toHaveLength(1)
    expect(h.data.has(dirScopedKey(ROUTER_KEY, key))).toBe(true)
    expect([...h.data.keys()].some((entry) => entry === "dir:default:router")).toBe(false)
  })

  test("the old session gets a readable notice instead of a silent refusal", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    const notice = supersededNotice("ses_old")
    expect(notice).toBeDefined()
    expect(notice).toContain("ses_new")
    expect(notice).toContain("不再是 Router")

    // router-only 工具的报错点名取代者，而不是泛泛的 "only available to the
    // router session"。
    const message = await failure(requireRouter("ses_old", "ticket_list"))
    expect(message).toContain("ses_new")
    expect(message).not.toContain("only available to the router session")

    // 新 Router 照常工作。
    expect(await succeed(requireRouter("ses_new", "ticket_list"))).toBe(key)
  })

  test("a session that was never superseded keeps the old error message", async () => {
    const message = await failure(requireRouter("ses_random", "ticket_list"))
    expect(message).toContain("only available to the router session")
  })

  test("the status view names the replaced session", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    const text = statusText()
    expect(text).toContain("superseded router session ses_old")
    expect(text).toContain("ses_new")
  })

  test("the startup summary reports each superseded session once", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    // 本进程里刚发生的取代事件在认领当场已经打过日志，不再重复汇总。
    expect(takeUnreportedSuperseded()).toEqual([])
  })

  test("a marker read back from KV is summarized at startup, once", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")
    h.data.set(supersededKey("ses_old"), {
      sessionID: "ses_old",
      supersededBy: "ses_new",
      dirKey: key,
      at: 1,
    } as unknown as Schema.Json)

    // Simulate a restart: the in-memory marker table is gone, KV is not.
    resetSuperseded()
    await succeed(hydrate(h.ctx))

    const first = takeUnreportedSuperseded()
    expect(first.map((info) => info.sessionID)).toEqual(["ses_old"])
    expect(first[0]?.supersededBy).toBe("ses_new")
    // 第二次没有新事件（宿主的每个目录都会加载一份插件）。
    expect(takeUnreportedSuperseded()).toEqual([])
  })
})

describe("a superseded pointer is never adopted by two partitions", () => {
  test("ensureRouter does not hand the superseded session to another partition", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))

    // The pinned partition keeps `ses_new`; the legacy pointer is not adopted
    // anywhere else either.
    expect(await succeed(ensureRouter(h.ctx, { dirKey: key, directory: dir }))).toBe("ses_new")
    expect(dirKeyForRouter("ses_old")).toBeUndefined()
    expect(h.created).toHaveLength(0)
  })

  test("the pointer is reclaimed when its successor is gone", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))
    expect(supersededInfo("ses_old")).toBeDefined()

    // The successor is deleted by the user: the marker is stale, so the
    // legacy pointer is adopted again instead of leaving the partition
    // without a Router forever.
    h.infos.delete("ses_new")
    h.data.delete(dirScopedKey(ROUTER_KEY, key))
    const adopted = await succeed(ensureRouter(h.ctx, { dirKey: DEFAULT_DIR_KEY }))
    expect(adopted).toBe("ses_old")
    expect(supersededInfo("ses_old")).toBeUndefined()
  })
})
