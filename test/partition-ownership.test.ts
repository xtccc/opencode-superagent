import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { buildStatusInjection } from "../src/context.js"
import { DEFAULT_DIR_KEY, aliasConflicts, aliasDirs, dirKeyOf, threadDirs } from "../src/dirs.js"
import { runDispatch, statusText } from "../src/dispatch.js"
import { hydratePending } from "../src/router.js"
import { applySettings, perDirectoryRouterEnabled, resetSettings } from "../src/settings.js"
import { DIR_SCOPE_PREFIX, dirScopedKey } from "../src/scope.js"
import {
  encodeThread,
  encodeWorker,
  hydrate,
  rememberRouter,
  resetPartitions,
  store,
  threadKey,
} from "../src/state.js"
import {
  closeTicket,
  createTicket,
  encodeTicket,
  getTicket,
  hydrateTickets,
  listTicketRecords,
  listTickets,
  resetTickets,
  ticketKey,
  ticketStats,
  updateTicket,
} from "../src/ticket.js"
import { registerTicketTools } from "../src/ticket-tools.js"
import { handleEnded, resetPartitionWarnings } from "../src/watcher.js"
import { runSleep } from "../src/sleep.js"
import { pluginVersion } from "../src/version.js"

/**
 * 归属语义回归网（`perDirectoryRouter` 打开时）：
 *
 * **分区＝派发方 / 创建方 Router 的分区，`directory` 只是工作目录。**
 *
 * 这套用例守的是真实缺陷：旧实现用 `ticket.directory` / `worker.directory`
 * 推导分区，于是
 * 1. 默认分区的 Router 连别的目录的工单都建不了（"cannot operate on …"）；
 * 2. 跨目录派发的完成通知会发给另一个目录的 Router；
 * 3. 开关打开后老工单被按目录打散，默认分区 Router 一张都看不见。
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"
const THREAD = "telegram:9001"

const KEY_A = dirKeyOf(DIR_A)
const KEY_B = dirKeyOf(DIR_B)

const ROUTER_A = "ses_router_a"
const ROUTER_B = "ses_router_b"

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id"],
  source: "telegram",
} as const

// ── fixtures ──────────────────────────────────────────────────────────────────

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  readonly created: Array<{ readonly id: string; readonly directory?: string }>
  readonly synthetic: Array<{ readonly sessionID: string; readonly text: string }>
}

function harness(): Harness {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const created: Array<{ id: string; directory?: string }> = []
  const synthetic: Array<{ sessionID: string; text: string }> = []
  let counter = 0
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
    get: ({ sessionID }: { sessionID: string }) => {
      const info = infos.get(sessionID)
      if (info === undefined) return Effect.fail(new Error(`missing session ${sessionID}`))
      return Effect.succeed({ id: sessionID, time: {}, ...info })
    },
    create: (input: { title?: string; location?: { directory?: string } }) =>
      Effect.sync(() => {
        counter += 1
        const id = `ses_new_${counter}`
        const directory = input.location?.directory
        created.push({ id, ...(directory === undefined ? {} : { directory }) })
        infos.set(id, { title: input.title, ...(directory === undefined ? {} : { location: { directory } }) })
        return { id, title: input.title }
      }),
    context: () => Effect.succeed([]),
    synthetic: (input: { sessionID: string; text: string }) => {
      synthetic.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined)
    },
    prompt: () => Effect.succeed(undefined),
    interrupt: () => Effect.succeed({ interrupted: true }),
    hook: () => Effect.succeed(undefined),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  const ctx = { options: {}, storage, session, agent } as unknown as Plugin.Context
  return { ctx, data, infos, created, synthetic }
}

/** Two Routers, one per partition, without creating real sessions. */
function twoRouters(h: Harness): void {
  rememberRouter(KEY_A, ROUTER_A)
  rememberRouter(KEY_B, ROUTER_B)
  h.infos.set(ROUTER_A, { location: { directory: DIR_A } })
  h.infos.set(ROUTER_B, { location: { directory: DIR_B } })
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(exit.cause)
}

beforeEach(() => {
  resetSettings()
  resetTickets()
  resetPartitions()
  resetPartitionWarnings()
  threadDirs.clear()
  aliasDirs.clear()
  aliasConflicts.clear()
  store.workers.clear()
  store.dirKey = DEFAULT_DIR_KEY
})

afterEach(() => {
  resetSettings()
  resetPartitions()
})

// ── 1. cross-directory dispatch ──────────────────────────────────────────────

describe("a worker dispatched into another directory stays owned by its dispatcher", () => {
  test("ticket, worker record and completion all belong to Router A; B sees nothing", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)

    // Router A creates a work order whose *working directory* is beta.
    const created = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_A }))
    expect(created.ticket.dirKey).toBe(KEY_A)
    expect(created.ticket.directory).toBe(DIR_B)
    // 归属分区决定 KV 命名空间：A 的命名空间，旧 key / B 的命名空间里都没有。
    expect(h.data.get(dirScopedKey(ticketKey(created.ticket.id), KEY_A))).toBeDefined()
    expect(h.data.get(dirScopedKey(ticketKey(created.ticket.id), KEY_B))).toBeUndefined()
    expect(h.data.get(ticketKey(created.ticket.id))).toBeUndefined()

    const dispatched = await succeed(
      runDispatch(h.ctx, { task: "修日志", ticketID: created.ticket.id, directory: DIR_B }, ROUTER_A),
    )
    const workerID = String(dispatched.output.sessionID)
    const record = store.workers.get(workerID)
    expect(record?.directory).toBe(DIR_B)
    // 关键的归属字段：派发方分区，而不是工作目录。
    expect(record?.ownerDirKey).toBe(KEY_A)
    // worker 会话真的落到了 beta 目录。
    expect(h.created.find((entry) => entry.id === workerID)?.directory).toBe(DIR_B)
    // 亲和表在派发方分区，B 分区没有这条记录。
    expect(store.dirs.get(KEY_A)?.threads.get(THREAD)).toEqual([workerID])
    expect(store.dirs.get(KEY_B)?.threads.has(THREAD) ?? false).toBe(false)

    await succeed(handleEnded(h.ctx, workerID, "done", undefined, 1))

    // 完成通知只回到 A；B 的 Router 即使存在也收不到。
    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(ROUTER_A)
    expect(h.synthetic.some((call) => call.sessionID === ROUTER_B)).toBe(false)
    expect(h.synthetic[0]?.text).toContain(workerID)
    // 工单被自己的 worker 结单，并且仍在 A 分区。
    expect(getTicket(created.ticket.id)?.state).toBe("done")
    expect(ticketStats(KEY_A).closed).toBe(1)
    expect(ticketStats(KEY_B).total).toBe(0)
  })

  test("a default-partition Router can create and dispatch work for any directory", async () => {
    // 真机缺陷的原样复现：开关打开后，开关前创建的老 Router 落在 default 分区，
    // 以前它以 `ticket_create(directory=<别的目录>)` 被直接拒绝。
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    rememberRouter(DEFAULT_DIR_KEY, ROUTER_A)
    h.infos.set(ROUTER_A, { location: { directory: DIR_A } })

    const created = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: DEFAULT_DIR_KEY }))
    expect(created.ticket.dirKey).toBe(DEFAULT_DIR_KEY)
    expect(created.ticket.directory).toBe(DIR_B)

    const dispatched = await succeed(
      runDispatch(h.ctx, { task: "修日志", ticketID: created.ticket.id, directory: DIR_B }, ROUTER_A),
    )
    const workerID = String(dispatched.output.sessionID)
    expect(store.workers.get(workerID)?.directory).toBe(DIR_B)
    expect(store.workers.get(workerID)?.ownerDirKey).toBe(DEFAULT_DIR_KEY)

    await succeed(handleEnded(h.ctx, workerID, "done", undefined, 1))
    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(ROUTER_A)
    // 默认分区的工单仍然写在旧 key 上（回滚兼容）。
    expect(h.data.get(ticketKey(created.ticket.id))).toBeDefined()
  })
})

// ── 2. the creator can operate on its own ticket ─────────────────────────────

describe("a Router can drive the tickets it created", () => {
  interface Registered {
    readonly name: string
    readonly execute: (
      input: unknown,
      context: { sessionID: string },
    ) => Effect.Effect<{ output: Record<string, unknown>; content: string }, unknown>
  }

  /** Register the real ticket tools against a memory host. */
  async function tools(h: Harness): Promise<Record<string, Registered>> {
    const registered: Array<Registered> = []
    const editor = { add: (tool: Registered) => registered.push(tool) }
    const ctx = {
      ...(h.ctx as unknown as Record<string, unknown>),
      tool: { transform: (fn: (target: typeof editor) => void) => Effect.sync(() => fn(editor)) },
    } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerTicketTools(ctx)))
    return Object.fromEntries(registered.map((tool) => [tool.name, tool])) as Record<string, Registered>
  }

  test("create → list → update → close with the same Router, for another directory", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)
    const ticketTools = await tools(h)
    const context = { sessionID: ROUTER_A }

    const created = await succeed(
      ticketTools["ticket_create"]!.execute(
        {
          threadID: THREAD,
          title: "跨目录",
          objective: "在 beta 里跑 alpha 的活",
          acceptance: ["跑通"],
          directory: DIR_B,
        },
        context,
      ),
    )
    const ticketID = created.output["ticketID"] as string
    expect(ticketID).toMatch(/^tk_/)
    expect(getTicket(ticketID)?.dirKey).toBe(KEY_A)
    expect(getTicket(ticketID)?.directory).toBe(DIR_B)

    const listed = await succeed(ticketTools["ticket_list"]!.execute({}, context))
    expect(listed.content).toContain(ticketID)

    const blocked = await succeed(
      ticketTools["ticket_update"]!.execute({ ticketID, status: "blocked", note: "等用户确认" }, context),
    )
    expect(blocked.output).toMatchObject({ ticketID, state: "blocked" })

    const closed = await succeed(
      ticketTools["ticket_close"]!.execute({ ticketID, outcome: "done", summary: "完成" }, context),
    )
    expect(closed.output).toMatchObject({ ticketID, state: "done" })

    // 另一个分区的 Router 依旧不可操作它（隔离没被放松）。
    const denied = await failure(
      ticketTools["ticket_close"]!.execute({ ticketID, outcome: "failed", summary: "越权" }, { sessionID: ROUTER_B }),
    )
    expect(denied).toContain("partition")
  })
})

// ── 3. two Routers stay isolated ─────────────────────────────────────────────

describe("two Routers never see each other's work", () => {
  test("tickets, lists and operations are per partition", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)

    const a = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const b = await succeed(
      createTicket(h.ctx, { ...base, objective: "另一件事", directory: DIR_B, dirKey: KEY_B }),
    )

    expect((await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_A))).map((ticket) => ticket.id)).toEqual([
      a.ticket.id,
    ])
    expect((await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_B))).map((ticket) => ticket.id)).toEqual([
      b.ticket.id,
    ])

    // 跨分区操作被拒（走真实的工单层入口）。
    const denied = await failure(
      closeTicket(h.ctx, { ticketID: b.ticket.id, outcome: "done", summary: "x", dirKey: KEY_A }),
    )
    expect(denied).toContain("partition")
    expect(await failure(updateTicket(h.ctx, { ticketID: b.ticket.id, note: "x", dirKey: KEY_A }))).toContain(
      "partition",
    )

    // 进程级视图（TUI）仍然看得见两张。
    expect(ticketStats().total).toBe(2)
    expect(listTickets({}, undefined).map((ticket) => ticket.id).sort()).toEqual(
      [a.ticket.id, b.ticket.id].sort(),
    )
  })
})

// ── 4. legacy data lands in the default partition ────────────────────────────

describe("legacy KV hydrates into the default partition", () => {
  const legacyID = "tk_legacy_b"
  const legacyTicket = {
    id: legacyID,
    state: "open" as const,
    title: "旧工单",
    objective: "升级前就在 KV 里的工单",
    acceptance: ["能读回来"],
    requester: { source: "telegram", threadID: THREAD },
    authorization: { triggerID: "unknown", quote: "", at: 1_000 },
    threadID: THREAD,
    attempts: [],
    priority: "p1" as const,
    directory: DIR_B,
    dedupeKey: "legacy-key",
    tags: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    history: [{ at: 1_000, kind: "created" as const, to: "open" as const }],
  }

  test("a ticket whose directory points at /b is visible in default, not in B, and hydrate is idempotent", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    h.data.set(ticketKey(legacyID), encodeTicket(legacyTicket))
    h.data.set(threadKey(THREAD), encodeThread({ threadID: THREAD, workers: [], updatedAt: 1_000 }))
    h.data.set("pending:legacy", {
      trigger: { id: "legacy", source: "telegram", threadID: THREAD, text: "旧消息" },
      arrivedAt: Date.now(),
    } as unknown as Schema.Json)

    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrate(h.ctx))
    await succeed(hydratePending(h.ctx))

    // 工单：默认分区可见，B 分区不可见，且没有写任何分区副本。
    expect(ticketStats(DEFAULT_DIR_KEY).total).toBe(1)
    expect(ticketStats(KEY_B).total).toBe(0)
    expect(
      (await succeed(listTicketRecords(h.ctx, { limit: 10 }, DEFAULT_DIR_KEY))).map((ticket) => ticket.id),
    ).toEqual([legacyID])
    expect(await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_B))).toEqual([])
    expect([...h.data.keys()].filter((key) => key.includes(ticketKey(legacyID)))).toEqual([ticketKey(legacyID)])
    // 旧键保留（回滚兼容），并且 B 分区命名空间里什么都没被写出来。
    expect(h.data.get(ticketKey(legacyID))).toBeDefined()
    expect([...h.data.keys()].filter((key) => key.startsWith(`${DIR_SCOPE_PREFIX}${KEY_B}:`))).toEqual([])
    // `pending:` 旧键回放到默认分区的队列。
    expect(store.pending.map((item) => item.trigger.id)).toEqual(["legacy"])

    // 幂等：重复 hydrate 不产生副本、不改变归属。
    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrate(h.ctx))
    expect([...h.data.keys()].filter((key) => key.includes(ticketKey(legacyID)))).toEqual([ticketKey(legacyID)])
    expect(ticketStats(DEFAULT_DIR_KEY).total).toBe(1)
    expect(ticketStats(KEY_B).total).toBe(0)
  })
})

// ── 5. legacy worker records fall back to their directory ────────────────────

describe("a worker record without ownerDirKey still routes by its directory", () => {
  const legacyWorker = {
    sessionID: "ses_old_worker",
    threadID: THREAD,
    threads: [THREAD],
    state: "running" as const,
    createdAt: 1_000,
    directory: DIR_B,
  }

  test("its completion goes to the Router of that directory", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)
    // 旧记录确实没有这个字段（encode 也不会凭空补出来）。
    expect((encodeWorker(legacyWorker) as Record<string, unknown>)["ownerDirKey"]).toBeUndefined()
    store.workers.set("ses_old_worker", { ...legacyWorker })

    await succeed(handleEnded(h.ctx, "ses_old_worker", "done", undefined, 1))

    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(ROUTER_B)
  })

  test("an explicit ownerDirKey wins over the directory", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)
    store.workers.set("ses_moved", {
      sessionID: "ses_moved",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1_000,
      directory: DIR_B,
      ownerDirKey: KEY_A,
    })

    await succeed(handleEnded(h.ctx, "ses_moved", "done", undefined, 1))

    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(ROUTER_A)
  })

  test("a record with neither field degrades to the default partition", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    rememberRouter(DEFAULT_DIR_KEY, ROUTER_A)
    h.infos.set(ROUTER_A, { location: { directory: DIR_A } })
    store.workers.set("ses_nowhere", {
      sessionID: "ses_nowhere",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1_000,
    })

    await succeed(handleEnded(h.ctx, "ses_nowhere", "done", undefined, 1))
    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(ROUTER_A)
  })

  test("sleep of Router A is not woken by another partition's worker", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)
    store.workers.set("ses_wb", {
      sessionID: "ses_wb",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1_000,
      directory: DIR_B,
      ownerDirKey: KEY_B,
    })
    store.workers.set("ses_wa", {
      sessionID: "ses_wa",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1_000,
      directory: DIR_A,
      ownerDirKey: KEY_A,
    })

    /** Advance a virtual clock; finish the worker named in `finish` on the first poll. */
    function sleeper(finish: string | undefined) {
      let current = 0
      let polls = 0
      return {
        deps: {
          now: () => current,
          poll: (millis: number) =>
            Effect.sync(() => {
              current += millis
              polls += 1
              const worker = finish === undefined ? undefined : store.workers.get(finish)
              if (polls === 1 && worker !== undefined) worker.state = "done"
            }),
        },
      }
    }

    // 其他分区的 worker 完成不该唤醒 A。
    const quiet = await succeed(runSleep({ seconds: 2 }, ROUTER_A, sleeper("ses_wb").deps))
    expect(quiet.content).toBe("slept 2s")
    expect(quiet.output["woken"]).toBeUndefined()

    // 反过来：自己的 worker 完成会立即唤醒。
    store.workers.get("ses_wa")!.state = "running"
    const woke = await succeed(runSleep({ seconds: 2 }, ROUTER_A, sleeper("ses_wa").deps))
    expect(woke.output["woken"]).toContain("worker completed")
  })
})

// ── 6. switch off: unchanged ─────────────────────────────────────────────────

describe("with the switch off nothing about the output changes", () => {
  test("statusText and the status injection keep the pre-partition bytes", async () => {
    const h = harness()
    rememberRouter(DEFAULT_DIR_KEY, ROUTER_A)
    h.infos.set(ROUTER_A, { location: { directory: DIR_A } })
    store.workers.set("ses_w", {
      sessionID: "ses_w",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1_000,
      directory: DIR_B,
      ownerDirKey: KEY_A,
    })
    expect(perDirectoryRouterEnabled()).toBe(false)

    const expected = [
      `superagent ${pluginVersion()} — restart the gateway after upgrading (no hot reload)`,
      `router: ${ROUTER_A} pending: 0 workers=1 active=1 tickets: open=0 in_progress=0 blocked=0 closed=0`,
      `- ses_w - [${THREAD}] running dir=${DIR_B}`,
    ].join("\n")
    expect(statusText()).toBe(expected)
    expect(buildStatusInjection(undefined, 0)).toBe(
      "Status: workers=1 pending=0 triggers=0 tickets=open0/in_progress0/blocked0/closed0. dirs: threads=0 aliases=-.",
    )
  })

  test("a ticket created with a working directory elsewhere still lands in the legacy key", async () => {
    const h = harness()
    const created = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_A }))
    expect(h.data.get(ticketKey(created.ticket.id))).toBeDefined()
    expect([...h.data.keys()].some((key) => key.startsWith(DIR_SCOPE_PREFIX))).toBe(false)
    // 开关关闭时 `dirKey` 收敛为默认分区，所以跨"分区"其实是同一个分区。
    expect(
      await succeed(updateTicket(h.ctx, { ticketID: created.ticket.id, note: "ok", dirKey: KEY_B })),
    ).toBeDefined()
  })
})
