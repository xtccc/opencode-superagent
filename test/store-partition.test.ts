import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { buildStatusInjection } from "../src/context.js"
import { DEFAULT_DIR_KEY, aliasConflicts, aliasDirs, threadDirs } from "../src/dirs.js"
import { statusText } from "../src/dispatch.js"
import {
  DEFAULT_SETTINGS,
  applySettings,
  currentSettings,
  perDirectoryRouterEnabled,
  readSettings,
  resetSettings,
} from "../src/settings.js"
import {
  DIR_SCOPE_PREFIX,
  adoptLegacyStore,
  createDirState,
  dirScopedKey,
  dirState,
  encodeThread,
  encodeWorker,
  hydrate,
  store,
  threadKey,
  workerKey,
  type Store,
  type TriggerRecord,
  type WorkerRecord,
} from "../src/state.js"
import { resetSuperseded } from "../src/superseded.js"
import { resetTickets } from "../src/ticket.js"
import { pluginVersion } from "../src/version.js"

/**
 * 阶段 1 的核心承诺：目录分区结构已经存在，但默认配置下的行为与改造前
 * **完全一致**——一个分区、旧 KV key、旧 status 文案。这些用例就是那条承诺的
 * 回归网：任何让默认路径多出一个分区、多改一个 key 或多加一行 status 的改动
 * 都会在这里失败。
 */

function worker(sessionID: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threadID: "thread:1",
    threads: ["thread:1"],
    state: "running",
    createdAt: 1_000,
    ...overrides,
  }
}

beforeEach(() => {
  resetTickets()
  resetSettings()
  // `superseded` is a process-wide registry: a marker left by an earlier test
  // file would add a status line here and break the byte-for-byte assertions.
  resetSuperseded()
  threadDirs.clear()
  aliasDirs.clear()
  aliasConflicts.clear()
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.pending.length = 0
  store.routerID = undefined
  store.routerBusy = false
  store.dirKey = DEFAULT_DIR_KEY
  store.triggerTotal = 0
  // 用例自身可能造出非默认分区（这正是被测的结构）；每个用例仍从「只有默认
  // 分区」开始，默认分区实例保留，避免测试之间互相串状态。
  for (const key of [...store.dirs.keys()]) if (key !== DEFAULT_DIR_KEY) store.dirs.delete(key)
  dirState(store, DEFAULT_DIR_KEY)
})

afterEach(() => {
  resetSettings()
  store.dirKey = DEFAULT_DIR_KEY
})

// ── store shape ──────────────────────────────────────────────────────────────

describe("store partition skeleton", () => {
  test("the default configuration keeps exactly one partition", () => {
    expect(store.dirKey).toBe(DEFAULT_DIR_KEY)
    expect(store.dirs.size).toBe(1)
    expect(store.dirs.has(DEFAULT_DIR_KEY)).toBe(true)
  })

  test("the flat fields are views on the default partition, not copies", () => {
    const dir = dirState(store, DEFAULT_DIR_KEY)
    expect(store.threads).toBe(dir.threads)
    expect(store.pending).toBe(dir.pending)

    store.routerID = "ses_router"
    store.routerBusy = true
    store.threads.set("thread:7", ["ses_a"])
    store.pending.push({ trigger: { source: "test", threadID: "thread:7", text: "hi" }, arrivedAt: 5 })

    expect(dir.routerID).toBe("ses_router")
    expect(dir.routerBusy).toBe(true)
    expect(dir.threads.get("thread:7")).toEqual(["ses_a"])
    expect(dir.pending).toHaveLength(1)
    // 仍然只有一个分区：accessor 不会顺手创建新分区。
    expect(store.dirs.size).toBe(1)
  })

  test("dirState creates a partition lazily and keeps it", () => {
    const created = dirState(store, "opt-app-0000aaaa")
    expect(store.dirs.size).toBe(2)
    expect(dirState(store, "opt-app-0000aaaa")).toBe(created)
    // 默认分区不受影响。
    expect(dirState(store, DEFAULT_DIR_KEY)).not.toBe(created)
    expect(dirState(store, DEFAULT_DIR_KEY).routerID).toBeUndefined()
  })
})

// ── settings switch ──────────────────────────────────────────────────────────

describe("perDirectoryRouter setting", () => {
  test("defaults to false and only accepts a strict boolean true", () => {
    expect(DEFAULT_SETTINGS.perDirectoryRouter).toBe(false)
    expect(readSettings(undefined).perDirectoryRouter).toBe(false)
    expect(readSettings({}).perDirectoryRouter).toBe(false)
    expect(readSettings({ perDirectoryRouter: false }).perDirectoryRouter).toBe(false)
    // 字符串与数字不做隐式转换：这是行为开关，静默误解比忽略更危险。
    expect(readSettings({ perDirectoryRouter: "true" }).perDirectoryRouter).toBe(false)
    expect(readSettings({ perDirectoryRouter: 1 }).perDirectoryRouter).toBe(false)
    expect(readSettings({ perDirectoryRouter: true }).perDirectoryRouter).toBe(true)
  })

  test("applySettings installs the flag process-wide and resetSettings restores it", () => {
    expect(perDirectoryRouterEnabled()).toBe(false)
    applySettings({ perDirectoryRouter: true })
    expect(perDirectoryRouterEnabled()).toBe(true)
    expect(currentSettings().perDirectoryRouter).toBe(true)
    // 未配置的每目录上限是 0＝不限制（阶段 2a 行为）。
    expect(currentSettings().maxWorkersPerDirectory).toBe(0)
    resetSettings()
    expect(perDirectoryRouterEnabled()).toBe(false)
  })
})

// ── KV key compatibility ─────────────────────────────────────────────────────

describe("KV keys stay legacy-shaped by default", () => {
  test("the key builders are unchanged", () => {
    expect(workerKey("ses_1")).toBe("worker:ses_1")
    expect(threadKey("thread:1")).toBe("thread:thread:1")
  })

  test("dirScopedKey is identity for the default partition, whatever the flag says", () => {
    expect(dirScopedKey("worker:ses_1")).toBe("worker:ses_1")
    applySettings({ perDirectoryRouter: true })
    expect(dirScopedKey("worker:ses_1")).toBe("worker:ses_1")
    expect(dirScopedKey("worker:ses_1", DEFAULT_DIR_KEY)).toBe("worker:ses_1")
  })

  test("a non-default partition is namespaced only when the switch is on", () => {
    expect(dirScopedKey("worker:ses_1", "opt-app-0000aaaa")).toBe("worker:ses_1")
    applySettings({ perDirectoryRouter: true })
    expect(dirScopedKey("worker:ses_1", "opt-app-0000aaaa")).toBe(`${DIR_SCOPE_PREFIX}opt-app-0000aaaa:worker:ses_1`)
  })
})

// ── status output ────────────────────────────────────────────────────────────

describe("status output with the switch off", () => {
  test("statusText is byte-identical to the pre-partition format", () => {
    store.routerID = "ses_router"
    store.workers.set(
      "ses_live",
      worker("ses_live", { title: "在跑", threads: ["telegram:1"], directory: "/opt/app" }),
    )

    const expected = [
      `superagent ${pluginVersion()} — restart the gateway after upgrading (no hot reload)`,
      "router: ses_router pending: 0 workers=1 active=1 tickets: open=0 in_progress=0 blocked=0 closed=0",
      "- ses_live 在跑 [telegram:1] running dir=/opt/app",
    ].join("\n")
    expect(statusText()).toBe(expected)
  })

  test("buildStatusInjection is byte-identical to the pre-partition format", () => {
    const expected =
      "Status: workers=0 pending=0 triggers=0 tickets=open0/in_progress0/blocked0/closed0. dirs: threads=0 aliases=-."
    expect(buildStatusInjection(undefined)).toBe(expected)
  })

  test("switching the flag on adds one line and nothing else changes", () => {
    applySettings({ perDirectoryRouter: true })
    const text = statusText()
    expect(text).toContain("directories: 1 partition(s) active=default")
    // 原有行一字节未变。
    expect(text).toContain(
      "router: none pending: 0 workers=0 active=0 tickets: open=0 in_progress=0 blocked=0 closed=0",
    )
  })
})

// ── hydrate: legacy KV lands in the default partition ────────────────────────

function memoryContext() {
  const data = new Map<string, Schema.Json>()
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (options: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort()
        const start = options.after === undefined ? 0 : keys.indexOf(options.after) + 1
        const page = keys.slice(start, start + (options.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  const session = {
    get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ id: sessionID, time: {} }),
    context: () => Effect.succeed([]),
  }
  return { ctx: { storage, session } as unknown as Plugin.Context, data }
}

describe("hydrate keeps old KV in the default partition", () => {
  test("router, workers and thread affinity all land in the default partition", async () => {
    const { ctx, data } = memoryContext()
    data.set("router", "ses_router")
    data.set(workerKey("ses_w1"), encodeWorker(worker("ses_w1", { state: "done" })))
    data.set(threadKey("thread:1"), encodeThread({ threadID: "thread:1", workers: ["ses_w1"], updatedAt: 1_000 }))

    await Effect.runPromise(hydrate(ctx))

    expect(store.dirs.size).toBe(1)
    const dir = dirState(store, DEFAULT_DIR_KEY)
    expect(dir.routerID).toBe("ses_router")
    expect(store.routerID).toBe("ses_router")
    expect(dir.threads.get("thread:1")).toEqual(["ses_w1"])
    expect(store.threads.get("thread:1")).toEqual(["ses_w1"])
    expect(store.workers.has("ses_w1")).toBe(true)

    // 旧 key 原样保留：没有迁移、没有重写成 dir:<key>: 前缀，升级不丢状态。
    expect([...data.keys()].sort()).toEqual(["router", "thread:thread:1", "worker:ses_w1"])
    expect([...data.keys()].some((key) => key.startsWith(DIR_SCOPE_PREFIX))).toBe(false)
  })

  test("hydrate reads back into the same default partition twice", async () => {
    const { ctx, data } = memoryContext()
    data.set("router", "ses_router")
    data.set(workerKey("ses_w1"), encodeWorker(worker("ses_w1", { state: "done" })))
    data.set(threadKey("thread:1"), encodeThread({ threadID: "thread:1", workers: ["ses_w1"], updatedAt: 1_000 }))

    await Effect.runPromise(hydrate(ctx))
    const first = dirState(store, DEFAULT_DIR_KEY)
    await Effect.runPromise(hydrate(ctx))

    expect(dirState(store, DEFAULT_DIR_KEY)).toBe(first)
    expect(store.dirs.size).toBe(1)
    expect(store.threads.get("thread:1")).toEqual(["ses_w1"])
  })
})

// ── in-memory upgrade path ───────────────────────────────────────────────────

describe("a store created by an older copy is adopted, not dropped", () => {
  test("flat fields move into the default partition and stay writable", () => {
    const threads = new Map<string, Array<string>>([["thread:9", ["ses_old_worker"]]])
    const pending: Array<{ trigger: { source: string; threadID: string; text: string }; arrivedAt: number }> = []
    const legacy = {
      routerID: "ses_old_router",
      routerBusy: true,
      workers: new Map(),
      threads,
      pending,
      triggers: new Map(),
      triggerTotal: 3,
      pendingDropped: 1,
    } as unknown as Store

    adoptLegacyStore(legacy)

    expect(legacy.dirKey).toBe(DEFAULT_DIR_KEY)
    expect(legacy.dirs.size).toBe(1)
    const dir = dirState(legacy, DEFAULT_DIR_KEY)
    expect(dir.routerID).toBe("ses_old_router")
    expect(dir.routerBusy).toBe(true)
    // 同一批对象，不是拷贝：升级后 Router 看到的队列/亲和表就是原来那份。
    expect(dir.threads).toBe(threads)
    expect(dir.pending).toBe(pending)
    expect(legacy.triggerTotal).toBe(3)
    expect(legacy.pendingDropped).toBe(1)

    // accessor 已重新绑定：旧写法继续有效。
    legacy.routerID = "ses_new_router"
    expect(dir.routerID).toBe("ses_new_router")
    legacy.pending.push({ trigger: { source: "test", threadID: "thread:9", text: "hi" }, arrivedAt: 1 })
    expect(dir.pending).toHaveLength(1)

    // 幂等：再跑一次不会造出第二个分区，也不会清空状态。
    adoptLegacyStore(legacy)
    expect(legacy.dirs.size).toBe(1)
    expect(dirState(legacy, DEFAULT_DIR_KEY).threads.get("thread:9")).toEqual(["ses_old_worker"])
  })

  test("a 2a-shaped store adopts its flat trigger history into the default partition", () => {
    const triggers = new Map<string, TriggerRecord>([
      [
        "trig:1",
        { id: "trig:1", source: "telegram", threadID: "thread:1", text: "hi", createdAt: 1 },
      ],
    ])
    const earlier = createDirState(DEFAULT_DIR_KEY)
    const store2a = {
      dirKey: DEFAULT_DIR_KEY,
      dirs: new Map([[DEFAULT_DIR_KEY, { ...earlier, triggers: undefined, triggerTotal: undefined }]]),
      workers: new Map(),
      triggers,
      triggerTotal: 7,
      pendingDropped: 0,
    } as unknown as Store

    adoptLegacyStore(store2a)

    const dir = dirState(store2a, DEFAULT_DIR_KEY)
    // 旧的内存 trigger 表被接管，不是丢掉后换成空表。
    expect(dir.triggers).toBe(triggers)
    expect(dir.triggerTotal).toBe(7)
    expect(store2a.triggers).toBe(triggers)
    expect(store2a.triggerTotal).toBe(7)
  })
})
