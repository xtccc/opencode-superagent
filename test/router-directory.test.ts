import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, type Schema } from "effect"
import {
  DEFAULT_DIR_KEY,
  dirKeyFor,
  dirKeyOf,
  routerDirKeySetting,
  routerDirectoryForPartition,
} from "../src/dirs.js"
import { requireRouter } from "../src/guard.js"
import { ensureRouter } from "../src/router.js"
import {
  applySettings,
  partitioningEnabled,
  parseRouterDirectory,
  perDirectoryRouterEnabled,
  resetSettings,
  routerDirectorySetting,
  takeRouterDirectoryWarning,
} from "../src/settings.js"
import {
  resetSuperseded,
  supersededInfo,
  supersededKey,
  supersededNotice,
} from "../src/superseded.js"
import {
  ROUTER_KEY,
  dirKeyForRouter,
  dirScopedKey,
  dirState,
  dirStateForDirectory,
  hydrate,
  resetPartitions,
  routerIDForDir,
  store,
} from "../src/state.js"
import {
  createTicket,
  encodeTicket,
  hydrateTickets,
  listTicketRecords,
  loadTicket,
  resetTickets,
  ticketKey,
  tickets,
} from "../src/ticket.js"

/**
 * 方案 B：`routerDirectory` 把网关的 Router 钉在一个固定目录分区里。
 *
 * 守的承诺：
 * 1. 配置生效时 Router 的分区 = `dirKeyOf(routerDirectory)`，会话创建在该目录；
 * 2. 未配置时行为与以前完全一致（`default` 分区、Router 不带 location）；
 * 3. 旧 `ticket:` 记录（无 `dirKey`）hydrate 后归固定分区，重复 hydrate 幂等，
 *    旧 KV 键仍保留；
 * 4. 旧的无目录 Router 重启后认领到固定分区，不再留在 `default`，也不会出现
 *    两个分区指向同一个会话；
 * 5. 非法配置（相对路径 / 不存在）被忽略，只告警一次。
 */

const OTHER_DIR = "/opt/elsewhere"

const roots: Array<string> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "superagent-router-dir-"))
  roots.push(dir)
  return dir
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

// ── fixtures ──────────────────────────────────────────────────────────────────

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly writes: Array<string>
  readonly infos: Map<string, Record<string, unknown>>
  readonly created: Array<{ readonly id: string; readonly directory?: string }>
}

function harness(): Harness {
  const data = new Map<string, Schema.Json>()
  const writes: Array<string> = []
  const infos = new Map<string, Record<string, unknown>>()
  const created: Array<{ id: string; directory?: string }> = []
  let counter = 0
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) =>
      Effect.sync(() => {
        writes.push(key)
        data.set(key, value)
      }),
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
        infos.set(id, {
          title: input.title,
          ...(directory === undefined ? {} : { location: { directory } }),
          time: {},
        })
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
  return { ctx, data, writes, infos, created }
}

const base = {
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id"],
  source: "telegram",
} as const

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

beforeEach(() => {
  resetSettings()
  resetTickets()
  resetPartitions()
  resetSuperseded()
  store.workers.clear()
})

afterEach(() => {
  resetSettings()
  resetPartitions()
})

// ── 1. settings / validation ─────────────────────────────────────────────────

describe("routerDirectory setting", () => {
  test("an existing absolute path is accepted and exposed", () => {
    const dir = tempDir()
    const settings = applySettings({ routerDirectory: dir })
    expect(settings.routerDirectory).toBe(dir)
    expect(routerDirectorySetting()).toBe(dir)
    expect(routerDirKeySetting()).toBe(dirKeyOf(dir))
    expect(routerDirectoryForPartition(dirKeyOf(dir))).toBe(dir)
    expect(routerDirectoryForPartition(DEFAULT_DIR_KEY)).toBeUndefined()
  })

  test("a relative or missing path is ignored with one warning", () => {
    const missing = join(tempDir(), "not-created")
    expect(applySettings({ routerDirectory: "relative/path" }).routerDirectory).toBeUndefined()
    expect(routerDirectorySetting()).toBeUndefined()
    expect(takeRouterDirectoryWarning()).toContain("relative/path")
    // 同一进程里后续实例/重复读取不得再告警。
    expect(applySettings({ routerDirectory: "relative/path" }).routerDirectory).toBeUndefined()
    expect(takeRouterDirectoryWarning()).toBeUndefined()

    // 绝对但不存在：同样忽略。
    applySettings({ routerDirectory: missing })
    expect(routerDirectorySetting()).toBeUndefined()
    expect(takeRouterDirectoryWarning()).toContain("not-created")
    expect(takeRouterDirectoryWarning()).toBeUndefined()
  })

  test("configuring it enables the partition machinery without the flag", () => {
    const dir = tempDir()
    applySettings({ routerDirectory: dir })
    expect(perDirectoryRouterEnabled()).toBe(false)
    expect(partitioningEnabled()).toBe(true)
    expect(dirKeyFor(undefined)).toBe(dirKeyOf(dir))
    expect(dirKeyFor(dir)).toBe(dirKeyOf(dir))
    // 未配置时又回到单实例（default）语义。
    resetSettings()
    expect(partitioningEnabled()).toBe(false)
    expect(dirKeyFor(dir)).toBe(DEFAULT_DIR_KEY)
  })
})

// ── 1b. the warning explains the reason and how to fix it ────────────────────

describe("routerDirectory warning text", () => {
  test("a missing directory is reported with a mkdir -p suggestion", () => {
    const missing = join(tempDir(), "not-created")
    applySettings({ routerDirectory: missing })
    const warning = takeRouterDirectoryWarning()
    expect(warning).toBeDefined()
    expect(warning).toContain("does not exist")
    expect(warning).toContain(`mkdir -p "${missing}"`)
    expect(warning).toContain("keeping the default partition")
  })

  test("a relative path is reported as relative with an absolute-path hint", () => {
    applySettings({ routerDirectory: "relative/path" })
    const warning = takeRouterDirectoryWarning()
    expect(warning).toContain("absolute")
    expect(warning).toContain("keeping the default partition")
  })

  test("an existing file is reported as not a directory", () => {
    const file = join(tempDir(), "a-file")
    writeFileSync(file, "x")
    applySettings({ routerDirectory: file })
    const warning = takeRouterDirectoryWarning()
    expect(warning).toContain("not a directory")
    expect(warning).toContain("keeping the default partition")
  })

  test("an empty value is reported as empty", () => {
    applySettings({ routerDirectory: "   " })
    const warning = takeRouterDirectoryWarning()
    expect(warning).toContain("empty")
    expect(warning).toContain("keeping the default partition")
  })

  test("a non-string value is reported as not a string", () => {
    applySettings({ routerDirectory: 42 })
    const warning = takeRouterDirectoryWarning()
    expect(warning).toContain("string")
    expect(warning).toContain("keeping the default partition")
  })

  test("the warning is emitted once per distinct bad value", () => {
    applySettings({ routerDirectory: "relative/path" })
    expect(takeRouterDirectoryWarning()).toBeDefined()
    expect(takeRouterDirectoryWarning()).toBeUndefined()
    applySettings({ routerDirectory: "relative/path" })
    expect(takeRouterDirectoryWarning()).toBeUndefined()
    applySettings({ routerDirectory: "other/relative" })
    expect(takeRouterDirectoryWarning()).toBeDefined()
  })

  test("parseRouterDirectory reports the failure reason", () => {
    expect(parseRouterDirectory(undefined).reason).toBeUndefined()
    expect(parseRouterDirectory(undefined).invalid).toBe(false)
    expect(parseRouterDirectory("relative").reason).toBe("not-absolute")
    expect(parseRouterDirectory("").reason).toBe("empty")
    expect(parseRouterDirectory(7).reason).toBe("not-a-string")
    expect(parseRouterDirectory(join(tempDir(), "nope")).reason).toBe("missing")
    const file = join(tempDir(), "file")
    writeFileSync(file, "x")
    expect(parseRouterDirectory(file).reason).toBe("not-a-directory")
    expect(parseRouterDirectory(tempDir()).reason).toBeUndefined()
  })
})

// ── 2. the Router owns the fixed partition ───────────────────────────────────

describe("the Router is pinned to routerDirectory", () => {
  test("a Router created without a directory lands in routerDirectory", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)

    const router = await succeed(ensureRouter(h.ctx, {}))
    expect(h.created).toEqual([{ id: router, directory: dir }])
    expect(dirKeyForRouter(router)).toBe(key)
    expect(routerIDForDir(key)).toBe(router)
    expect(store.routerID).toBeUndefined()
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe(router)
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()

    // 归属由调用方 Router 决定：工单创建走 requireRouter。
    expect(await succeed(requireRouter(router, "ticket_create"))).toBe(key)
  })

  test("without the setting the Router keeps the pre-configuration shape", async () => {
    const h = harness()
    const router = await succeed(ensureRouter(h.ctx, {}))
    expect(h.created).toEqual([{ id: router }])
    expect(routerDirKeySetting()).toBeUndefined()
    expect(dirKeyForRouter(router)).toBe(DEFAULT_DIR_KEY)
    expect(h.data.get(ROUTER_KEY)).toBe(router)
    expect([...h.data.keys()].some((entry) => entry.startsWith("dir:"))).toBe(false)
  })

  test("routerDirectory alone pins the single Router (flag off)", async () => {
    const dir = tempDir()
    applySettings({ routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)

    // The partition keeps the configured directory even when a caller passes
    // a work directory (status and worker routing read this field).
    expect(dirStateForDirectory(OTHER_DIR).directory).toBe(dir)
    const router = await succeed(ensureRouter(h.ctx, { directory: OTHER_DIR }))
    // One partition only: the flag-off collapse still holds, but its home is
    // the configured directory.
    expect(dirState(store, key).directory).toBe(dir)
    expect(h.created).toEqual([{ id: router, directory: dir }])
    expect(dirKeyForRouter(router)).toBe(key)
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe(router)

    const created = await succeed(
      createTicket(h.ctx, { ...base, threadID: "telegram:3", directory: OTHER_DIR, dirKey: key }),
    )
    expect(created.ticket.dirKey).toBe(key)
    expect(dirKeyFor(dir)).toBe(key)
    expect(
      (await succeed(listTicketRecords(h.ctx, { limit: 10 }, dirKeyFor(dir)))).map((ticket) => ticket.id),
    ).toEqual([created.ticket.id])
  })
})

// ── 3. tickets follow the partition (and the TUI sees them there) ────────────

describe("tickets land in the routerDirectory partition", () => {
  test("created ticket is visible from that directory and not from default", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    const router = await succeed(ensureRouter(h.ctx, {}))
    const dirKey = await succeed(requireRouter(router, "ticket_create"))

    const created = await succeed(
      createTicket(h.ctx, { ...base, threadID: "telegram:1", directory: dir, dirKey }),
    )
    expect(created.ticket.dirKey).toBe(key)

    // `ticket_list` on the Router's partition.
    const listed = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, dirKey))).map((ticket) => ticket.id)
    expect(listed).toEqual([created.ticket.id])
    // The default partition does not see it.
    expect(await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).toEqual([])
    // TUI visibility: the session directory resolves to the Router's partition.
    expect(dirKeyFor(dir)).toBe(key)
    const viaTui = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, dirKeyFor(dir)))).map(
      (ticket) => ticket.id,
    )
    expect(viaTui).toEqual([created.ticket.id])
    expect(await succeed(listTicketRecords(h.ctx, { limit: 10 }, dirKeyFor(OTHER_DIR)))).toEqual([])
  })

  test("with the setting unset a ticket stays in the default partition", async () => {
    const h = harness()
    const router = await succeed(ensureRouter(h.ctx, {}))
    const dirKey = await succeed(requireRouter(router, "ticket_create"))
    expect(dirKey).toBe(DEFAULT_DIR_KEY)
    const created = await succeed(
      createTicket(h.ctx, { ...base, threadID: "telegram:2", directory: OTHER_DIR, dirKey }),
    )
    expect(created.ticket.dirKey).toBe(DEFAULT_DIR_KEY)
    expect(
      (await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).map((ticket) => ticket.id),
    ).toEqual([created.ticket.id])
  })
})

// ── 4. legacy records and the legacy Router ──────────────────────────────────

function legacyTicket(id: string, now: number) {
  return {
    id,
    state: "done" as const,
    title: "旧工单",
    objective: "旧目标",
    acceptance: ["旧的验收"],
    requester: { source: "telegram", threadID: "telegram:legacy" },
    authorization: { triggerID: "unknown", quote: "", at: now },
    threadID: "telegram:legacy",
    attempts: [],
    priority: "p1" as const,
    directory: OTHER_DIR,
    dedupeKey: "legacy",
    tags: [],
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, kind: "created" as const, to: "open" as const }],
  }
}

describe("legacy state is adopted by routerDirectory", () => {
  test("a ticket without dirKey is rewritten to that partition, idempotently", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    const now = 1_000
    h.data.set(ticketKey("tk_legacy"), encodeTicket(legacyTicket("tk_legacy", now)))

    await succeed(hydrateTickets(h.ctx))
    expect(tickets.get("tk_legacy")?.dirKey).toBe(key)
    // 旧 KV 键名保留，内容改写为带 dirKey 的记录。
    const stored = h.data.get(ticketKey("tk_legacy")) as Record<string, Schema.Json>
    expect(stored["dirKey"]).toBe(key)
    expect([...h.data.keys()].filter((entry) => entry.includes(ticketKey("tk_legacy")))).toEqual([
      ticketKey("tk_legacy"),
    ])

    const listed = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, key))).map((ticket) => ticket.id)
    expect(listed).toEqual(["tk_legacy"])
    expect(await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).toEqual([])

    // 幂等：重复 hydrate 的键集合与归属都不变，记录不再重写。
    const keysBefore = [...h.data.keys()].sort()
    const writesBefore = h.writes.length
    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrateTickets(h.ctx))
    expect([...h.data.keys()].sort()).toEqual(keysBefore)
    expect(h.writes.slice(writesBefore).filter((entry) => entry.includes(ticketKey("tk_legacy")))).toEqual([])
    expect(tickets.get("tk_legacy")?.dirKey).toBe(key)
  })

  test("a migrated legacy ticket stays readable after memory trimming", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    const now = 3_000
    h.data.set(ticketKey("tk_trimmed"), encodeTicket(legacyTicket("tk_trimmed", now)))
    await succeed(hydrateTickets(h.ctx))
    // Simulate the memory cap: the record is still in KV under the legacy key.
    tickets.clear()

    const listed = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, key))).map((ticket) => ticket.id)
    expect(listed).toEqual(["tk_trimmed"])
    expect((await succeed(loadTicket(h.ctx, "tk_trimmed", key)))?.dirKey).toBe(key)
    // ...and still invisible in the default partition.
    expect(await succeed(loadTicket(h.ctx, "tk_trimmed", DEFAULT_DIR_KEY))).toBeUndefined()
    expect(await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).toEqual([])
  })

  test("without the setting legacy tickets still belong to default", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    const now = 2_000
    h.data.set(ticketKey("tk_legacy"), encodeTicket(legacyTicket("tk_legacy", now)))
    await succeed(hydrateTickets(h.ctx))
    expect(tickets.get("tk_legacy")?.dirKey).toBeUndefined()
    expect(
      (await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).map((ticket) => ticket.id),
    ).toEqual(["tk_legacy"])
  })

  test("a legacy Router without a location is claimed, never left in default", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_legacy_router", {})
    h.data.set(ROUTER_KEY, "ses_legacy_router")

    await succeed(hydrate(h.ctx))
    expect(routerIDForDir(key)).toBe("ses_legacy_router")
    expect(dirKeyForRouter("ses_legacy_router")).toBe(key)
    expect(store.routerID).toBeUndefined()
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe("ses_legacy_router")
    expect(dirState(store, key).directory).toBe(dir)

    // 幂等：重启再读一次仍是同一个会话、同一个分区。
    await succeed(hydrate(h.ctx))
    expect(routerIDForDir(key)).toBe("ses_legacy_router")
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()

    // The claimed Router owns the pinned partition's work orders.
    expect(await succeed(requireRouter("ses_legacy_router", "ticket_list"))).toBe(key)
  })

  test("a Router already created in routerDirectory is claimed too", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_in_dir", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_in_dir")

    await succeed(hydrate(h.ctx))
    expect(routerIDForDir(key)).toBe("ses_in_dir")
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe("ses_in_dir")
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()
  })

  test("a legacy Router whose host location is elsewhere is still claimed", async () => {
    // A pre-flag session created without `location` may be reported by the host
    // with its own default directory. That is not a partition ownership claim:
    // the legacy `router` pointer belongs to the default partition, so the
    // configured directory takes it over.
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_host_default", { location: { directory: OTHER_DIR } })
    h.data.set(ROUTER_KEY, "ses_host_default")

    await succeed(hydrate(h.ctx))
    expect(routerIDForDir(key)).toBe("ses_host_default")
    expect(store.routerID).toBeUndefined()
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()
  })

  test("an already-scoped Router wins over a stale legacy pointer", async () => {
    const dir = tempDir()
    applySettings({ perDirectoryRouter: true, routerDirectory: dir })
    const h = harness()
    const key = dirKeyOf(dir)
    h.infos.set("ses_old", {})
    h.infos.set("ses_new", { location: { directory: dir } })
    h.data.set(ROUTER_KEY, "ses_old")
    h.data.set(dirScopedKey(ROUTER_KEY, key), "ses_new")

    await succeed(hydrate(h.ctx))
    expect(routerIDForDir(key)).toBe("ses_new")
    expect(dirKeyForRouter("ses_old")).toBeUndefined()
    // The legacy pointer is **kept** (not deleted): rolling back to the
    // previous plugin version still finds a valid `router` pointer.
    expect(h.data.get(ROUTER_KEY)).toBe("ses_old")
    expect(h.data.get(dirScopedKey(ROUTER_KEY, key))).toBe("ses_new")
    // ...and the old session is marked superseded instead of failing silently.
    expect(supersededInfo("ses_old")).toMatchObject({
      sessionID: "ses_old",
      supersededBy: "ses_new",
      dirKey: key,
    })
    expect(h.data.get(supersededKey("ses_old"))).toBeDefined()
    // The old session says so in plain words instead of a generic refusal.
    expect(supersededNotice("ses_old")).toContain("ses_new")
    expect(supersededNotice("ses_old")).toContain("不再是 Router")
  })
})
