import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, type Schema } from "effect"
import { buildRecallInjection, buildStatusInjection } from "../src/context.js"
import { aliasConflicts, aliasDirs, dirKeyOf, DEFAULT_DIR_KEY, threadDirs } from "../src/dirs.js"
import { reservedSlotCount, runDispatch, statusText } from "../src/dispatch.js"
import { runThreadDetail } from "../src/recall.js"
import { enqueuePending, flushPending } from "../src/router.js"
import { applySettings, resetSettings } from "../src/settings.js"
import { dirScopedKey, DIR_SCOPE_PREFIX } from "../src/scope.js"
import {
  detachWorkerThreads,
  dirState,
  hydrate,
  rememberRouter,
  resetPartitions,
  store,
  threadKey,
} from "../src/state.js"
import {
  closeTicket,
  createTicket,
  dirtyTicketIDs,
  encodeTicket,
  getTicket,
  hydrateTickets,
  kvTicketCount,
  listTicketRecords,
  loadTicket,
  requireDispatchTicket,
  resetTickets,
  ticketKey,
  ticketStats,
  tickets,
  updateTicket,
} from "../src/ticket.js"
import { handleEnded, resetPartitionWarnings } from "../src/watcher.js"

/**
 * 阶段 2b：工单 / trigger 历史 / thread 亲和按 `dirKey` 分区 + 每目录 worker 限额。
 *
 * 守的是四条承诺：
 * 1. 工单的 KV、索引、查询、操作都被钉在调用方的分区里，跨目录既不看见也不可操作；
 * 2. 旧 KV（`ticket:<id>`）能被一次性、幂等地迁进分区命名空间，且保留旧 key 供回滚；
 * 3. 同一个 threadID 在两个目录下互不串台（亲和、trigger 历史、完成通知各归各的）；
 * 4. `maxWorkersPerDirectory` 在并发 dispatch 下也不超卖；开关关闭时一切如 2a。
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"
const THREAD = "telegram:7001"

const KEY_A = dirKeyOf(DIR_A)
const KEY_B = dirKeyOf(DIR_B)

const ROUTER_A = "ses_router_a"
const ROUTER_B = "ses_router_b"

// ── fixtures ──────────────────────────────────────────────────────────────────

interface SyntheticCall {
  readonly sessionID: string
  readonly text: string
}

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly writes: Array<string>
  readonly infos: Map<string, Record<string, unknown>>
  readonly created: Array<{ readonly id: string; readonly directory?: string }>
  readonly synthetic: Array<SyntheticCall>
  gate(directory: string): { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
}

function harness(options: Record<string, unknown> = {}): Harness {
  const data = new Map<string, Schema.Json>()
  const writes: Array<string> = []
  const infos = new Map<string, Record<string, unknown>>()
  const created: Array<{ id: string; directory?: string }> = []
  const synthetic: Array<SyntheticCall> = []
  const gates = new Map<string, { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>()
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
    create: (input: { title?: string; location?: { directory?: string } }) =>
      Effect.gen(function* () {
        const directory = input.location?.directory
        const gate = directory === undefined ? undefined : gates.get(directory)
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.started, undefined)
          yield* Deferred.await(gate.release)
        }
        counter += 1
        const id = `ses_new_${counter}`
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
  const ctx = { options, storage, session, agent } as unknown as Plugin.Context
  return {
    ctx,
    data,
    writes,
    infos,
    created,
    synthetic,
    gate(directory: string) {
      const started = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      gates.set(directory, { started, release })
      return { started, release }
    },
  }
}

const base = {
  threadID: THREAD,
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

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(exit.cause)
}

function fork<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.exit(effect).pipe(Effect.forkDetach({ startImmediately: true })))
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

/** Two routers, each in its own directory, without touching `sessions.create`. */
function twoRouters(h: Harness): void {
  rememberRouter(KEY_A, ROUTER_A)
  rememberRouter(KEY_B, ROUTER_B)
  h.infos.set(ROUTER_A, { location: { directory: DIR_A } })
  h.infos.set(ROUTER_B, { location: { directory: DIR_B } })
}

// ── 1. tickets are partitioned ────────────────────────────────────────────────

describe("tickets live in the caller's partition", () => {
  test("A cannot see, list, count or close B's ticket", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)

    const a = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const b = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_B }))

    // KV：各自的命名空间；默认分区（旧 key）里没有它们。
    expect(h.data.get(`${DIR_SCOPE_PREFIX}${KEY_A}:${ticketKey(a.ticket.id)}`)).toBeDefined()
    expect(h.data.get(`${DIR_SCOPE_PREFIX}${KEY_B}:${ticketKey(b.ticket.id)}`)).toBeDefined()
    expect(h.data.get(ticketKey(a.ticket.id))).toBeUndefined()
    expect(h.data.get(ticketKey(b.ticket.id))).toBeUndefined()

    // 查询：列表 / 计数 / 统计都只看本分区。
    const listedA = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_A))).map((ticket) => ticket.id)
    const listedB = (await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_B))).map((ticket) => ticket.id)
    expect(listedA).toEqual([a.ticket.id])
    expect(listedB).toEqual([b.ticket.id])
    expect(ticketStats(KEY_A).total).toBe(1)
    expect(ticketStats(KEY_B).total).toBe(1)
    // 进程级视图（TUI）仍然看得见两张。
    expect(ticketStats().total).toBe(2)

    // 按 id 读：跨分区等于"不存在"。
    expect(await succeed(loadTicket(h.ctx, b.ticket.id, KEY_A))).toBeUndefined()
    expect((await succeed(loadTicket(h.ctx, b.ticket.id, KEY_B)))?.id).toBe(b.ticket.id)

    // 操作：更新 / 结单 / 派发闸门都拒绝。
    const updateDenied = await failure(updateTicket(h.ctx, { ticketID: b.ticket.id, note: "x", dirKey: KEY_A }))
    expect(updateDenied).toContain("partition")
    expect(updateDenied).toContain(KEY_B)
    const closeDenied = await failure(
      closeTicket(h.ctx, { ticketID: b.ticket.id, outcome: "done", summary: "x", dirKey: KEY_A }),
    )
    expect(closeDenied).toContain("partition")
    const gateDenied = await failure(requireDispatchTicket(b.ticket.id, THREAD, KEY_A))
    expect(gateDenied).toContain("partition")

    // B 自己的 Router 照常操作。
    const closed = await succeed(
      closeTicket(h.ctx, { ticketID: b.ticket.id, outcome: "done", summary: "完成", dirKey: KEY_B }),
    )
    expect(closed.state).toBe("done")
    expect(getTicket(a.ticket.id)?.state).toBe("open")
    // 索引也按分区：A 的 all 桶里不该有 B 的单。
    const indexA = h.data.get(
      `${DIR_SCOPE_PREFIX}${KEY_A}:ticketidx:all`,
    ) as unknown as ReadonlyArray<string>
    expect(indexA).toEqual([a.ticket.id])
  })

  test("status and recall of one partition never mention the other's work", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)
    const a = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const b = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_B }))
    store.workers.set("ses_wa", {
      sessionID: "ses_wa",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
      directory: DIR_A,
    })
    store.workers.set("ses_wb", {
      sessionID: "ses_wb",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 2,
      directory: DIR_B,
    })

    const statusA = statusText({ dirKey: KEY_A })
    expect(statusA).toContain("workers=1 active=1 tickets: open=1")
    expect(statusA).toContain(a.ticket.id)
    expect(statusA).not.toContain(b.ticket.id)
    expect(statusA).not.toContain("ses_wb")

    const recallA = buildRecallInjection(THREAD, KEY_A)
    expect(recallA).toContain("ses_wa")
    expect(recallA).not.toContain("ses_wb")
    const injectionA = buildStatusInjection(THREAD, 0, KEY_A)
    expect(injectionA).toContain("tickets=open1/")
    expect(injectionA).not.toContain(b.ticket.id)
  })
})

// ── 2. legacy KV migrates once, idempotently ─────────────────────────────────

describe("legacy tickets migrate into their partition exactly once", () => {
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

  test("hydrate writes the scoped copy, keeps the legacy key, and is idempotent", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    h.data.set(ticketKey(legacyID), encodeTicket(legacyTicket))
    h.data.set("ticketidx:all", [legacyID] as unknown as Schema.Json)

    await succeed(hydrateTickets(h.ctx))
    const scopedKey = `${DIR_SCOPE_PREFIX}${KEY_B}:${ticketKey(legacyID)}`
    expect(h.data.get(scopedKey)).toBeDefined()
    // 旧 key 保留：老版本回滚后仍能读到自己的数据。
    expect(h.data.get(ticketKey(legacyID))).toBeDefined()
    expect(tickets.size).toBe(1)
    expect(kvTicketCount()).toBe(1)
    expect(dirtyTicketIDs()).toEqual([])
    // 迁移落在正确分区：A 看不见，B 看得见。
    const listedA = await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_A))
    expect(listedA).toEqual([])
    const listedB = await succeed(listTicketRecords(h.ctx, { limit: 10 }, KEY_B))
    expect(listedB.map((ticket) => ticket.id)).toEqual([legacyID])

    // 第二次 hydrate：键集合不变，迁移写入不重复（索引桶每次 hydrate 都会重写，
    // 那是既有的派生加速器行为，与迁移幂等性无关）。
    const before = [...h.data.keys()].sort()
    expect(h.writes.filter((key) => key === scopedKey)).toHaveLength(1)
    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrateTickets(h.ctx))
    expect([...h.data.keys()].sort()).toEqual(before)
    expect(h.writes.filter((key) => key === scopedKey)).toHaveLength(1)
    expect(tickets.size).toBe(1)
    expect(kvTicketCount()).toBe(1)
    expect(dirtyTicketIDs()).toEqual([])
  })

  test("with the switch off nothing is migrated and no dir: key is written", async () => {
    const h = harness()
    h.data.set(ticketKey(legacyID), encodeTicket(legacyTicket))

    await succeed(hydrateTickets(h.ctx))
    await succeed(hydrateTickets(h.ctx))

    expect([...h.data.keys()].filter((key) => key.startsWith(DIR_SCOPE_PREFIX))).toEqual([])
    expect(h.data.get(ticketKey(legacyID))).toBeDefined()
    // 旧布局的索引键照旧（阶段 2a 的默认分区行为）。
    expect(h.data.get("ticketidx:all")).toBeDefined()
    expect(tickets.size).toBe(1)
    expect(ticketStats().total).toBe(1)
    expect([...h.data.keys()].some((key) => key.startsWith(DIR_SCOPE_PREFIX))).toBe(false)
  })
})

// ── 3. one threadID, two directories ─────────────────────────────────────────

describe("the same threadID stays on its own side of the partition line", () => {
  test("affinity, completion notices and detach all stay local", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)

    const ticketA = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const ticketB = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_B }))

    const dispatchA = await succeed(
      runDispatch(h.ctx, { task: "修日志", ticketID: ticketA.ticket.id, directory: DIR_A }, ROUTER_A),
    )
    const dispatchB = await succeed(
      runDispatch(h.ctx, { task: "修日志", ticketID: ticketB.ticket.id, directory: DIR_B }, ROUTER_B),
    )
    const workerA = String(dispatchA.output.sessionID)
    const workerB = String(dispatchB.output.sessionID)
    expect(workerA).not.toBe(workerB)

    // 亲和：每个分区各一份，互不覆盖。
    expect(dirState(store, KEY_A).threads.get(THREAD)).toEqual([workerA])
    expect(dirState(store, KEY_B).threads.get(THREAD)).toEqual([workerB])
    expect(
      h.data.get(dirScopedKey(threadKey(THREAD), KEY_A)),
    ).toBeDefined()
    expect(h.data.get(dirScopedKey(threadKey(THREAD), KEY_B))).toBeDefined()
    expect(h.data.get(threadKey(THREAD))).toBeUndefined()

    // 完成通知：各回各的 Router。
    await succeed(handleEnded(h.ctx, workerA, "done", undefined, 1))
    await succeed(handleEnded(h.ctx, workerB, "done", undefined, 2))
    const toA = h.synthetic.filter((call) => call.sessionID === ROUTER_A)
    const toB = h.synthetic.filter((call) => call.sessionID === ROUTER_B)
    expect(toA).toHaveLength(1)
    expect(toB).toHaveLength(1)
    expect(toA[0]?.text).toContain(workerA)
    expect(toA[0]?.text).not.toContain(workerB)
    expect(toB[0]?.text).toContain(workerB)
    expect(toB[0]?.text).not.toContain(workerA)

    // 结单同样各归各的分区（worker → 目录 → 分区 → 自己的工单）。
    expect(getTicket(ticketA.ticket.id)?.state).toBe("done")
    expect(getTicket(ticketB.ticket.id)?.state).toBe("done")
    const storedB = h.data.get(`${DIR_SCOPE_PREFIX}${KEY_B}:${ticketKey(ticketB.ticket.id)}`) as unknown as {
      state?: string
    }
    expect(storedB?.state).toBe("done")

    // detach 只清自己那条：A 从 A 的亲和表消失，B 完全不动。
    const detached = await succeed(detachWorkerThreads(h.ctx, workerA, [THREAD], KEY_A))
    expect(detached).toEqual([THREAD])
    expect(dirState(store, KEY_A).threads.has(THREAD)).toBe(false)
    expect(dirState(store, KEY_B).threads.get(THREAD)).toEqual([workerB])
    expect(h.data.get(dirScopedKey(threadKey(THREAD), KEY_A))).toBeUndefined()
    expect(h.data.get(dirScopedKey(threadKey(THREAD), KEY_B))).toBeDefined()
  })

  test("trigger history of one partition is invisible to the other", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness()
    twoRouters(h)

    await succeed(enqueuePending(h.ctx, { id: "trig_a", source: "telegram", threadID: THREAD, text: "A 的消息" }, KEY_A))
    await succeed(enqueuePending(h.ctx, { id: "trig_b", source: "telegram", threadID: THREAD, text: "B 的消息" }, KEY_B))
    // flush 会写入 trigger 历史（route=router / sessionID=本分区 Router）。
    await succeed(flushPending(h.ctx, { dirKey: KEY_A }))
    await succeed(flushPending(h.ctx, { dirKey: KEY_B }))

    const heldA = [...dirState(store, KEY_A).triggers.keys()]
    const heldB = [...dirState(store, KEY_B).triggers.keys()]
    expect(heldA).toEqual(["trig_a"])
    expect(heldB).toEqual(["trig_b"])
    expect(dirState(store, KEY_A).triggers.get("trig_a")?.sessionID).toBe(ROUTER_A)
    expect(dirState(store, KEY_B).triggers.get("trig_b")?.sessionID).toBe(ROUTER_B)

    const detailA = await succeed(runThreadDetail(h.ctx, { threadID: THREAD }, ROUTER_A))
    expect(detailA.output.text).toContain("A 的消息")
    expect(detailA.output.text).not.toContain("B 的消息")
    const detailB = await succeed(runThreadDetail(h.ctx, { threadID: THREAD }, ROUTER_B))
    expect(detailB.output.text).toContain("B 的消息")
    expect(detailB.output.text).not.toContain("A 的消息")
  })
})

// ── 4. per-directory worker limit ────────────────────────────────────────────

describe("maxWorkersPerDirectory", () => {
  test("limit=1 blocks the second dispatch of one directory and nothing else", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness({ maxWorkersPerDirectory: 1 })
    twoRouters(h)
    const a1 = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const a2 = await succeed(
      createTicket(h.ctx, { ...base, objective: "第二件事", directory: DIR_A, dirKey: KEY_A }),
    )
    const b1 = await succeed(createTicket(h.ctx, { ...base, directory: DIR_B, dirKey: KEY_B }))

    await succeed(runDispatch(h.ctx, { task: "修日志", ticketID: a1.ticket.id, directory: DIR_A }, ROUTER_A))

    const denied = await failure(
      runDispatch(h.ctx, { task: "第二件事", ticketID: a2.ticket.id, directory: DIR_A }, ROUTER_A),
    )
    // 文案带上限与当前占用数（"already has 1 live worker(s)"）。
    expect(denied).toContain("maxWorkersPerDirectory=1")
    expect(denied).toContain("already has 1 live worker(s)")
    expect(denied).toContain(KEY_A)
    expect(h.created.filter((entry) => entry.directory === DIR_A)).toHaveLength(1)

    // 另一个目录不受影响。
    await succeed(runDispatch(h.ctx, { task: "修日志", ticketID: b1.ticket.id, directory: DIR_B }, ROUTER_B))
    expect(h.created.filter((entry) => entry.directory === DIR_B)).toHaveLength(1)
    expect(reservedSlotCount(KEY_A)).toBe(0)
    expect(reservedSlotCount(KEY_B)).toBe(0)
  })

  test("two concurrent dispatches into one directory cannot oversell the last slot", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = harness({ maxWorkersPerDirectory: 2 })
    twoRouters(h)
    const t1 = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A, dirKey: KEY_A }))
    const t2 = await succeed(
      createTicket(h.ctx, { ...base, objective: "第二件事", directory: DIR_A, dirKey: KEY_A }),
    )
    const t3 = await succeed(
      createTicket(h.ctx, { ...base, objective: "第三件事", directory: DIR_A, dirKey: KEY_A }),
    )

    // 两路都停在 `sessions.create` 里（已各占一个名额），第三路必须被拒。
    const gate = h.gate(DIR_A)
    const first = await fork(runDispatch(h.ctx, { task: "一", ticketID: t1.ticket.id, directory: DIR_A }, ROUTER_A))
    await Effect.runPromise(Deferred.await(gate.started))
    const second = await fork(runDispatch(h.ctx, { task: "二", ticketID: t2.ticket.id, directory: DIR_A }, ROUTER_A))
    await Effect.runPromise(Deferred.await(gate.started))
    expect(reservedSlotCount(KEY_A)).toBe(2)

    const denied = await failure(
      runDispatch(h.ctx, { task: "三", ticketID: t3.ticket.id, directory: DIR_A }, ROUTER_A),
    )
    expect(denied).toContain("maxWorkersPerDirectory")
    expect(reservedSlotCount(KEY_A)).toBe(2)

    await Effect.runPromise(Deferred.succeed(gate.release, undefined))
    const firstExit = await Effect.runPromise(Fiber.join(first))
    const secondExit = await Effect.runPromise(Fiber.join(second))
    expect(Exit.isSuccess(firstExit)).toBe(true)
    expect(Exit.isSuccess(secondExit)).toBe(true)
    // 名额全部归还，实际创建的 worker 数正好等于上限。
    expect(reservedSlotCount(KEY_A)).toBe(0)
    expect(h.created.filter((entry) => entry.directory === DIR_A)).toHaveLength(2)
    expect(ticketStats(KEY_A).inProgress).toBe(2)
  })
})

// ── 5. switch off: stage 2a behaviour, byte for byte ─────────────────────────

describe("with the switch off nothing changes", () => {
  test("tickets and triggers stay in the legacy namespace", async () => {
    const h = harness()
    twoRouters(h)
    const created = await succeed(createTicket(h.ctx, { ...base, directory: DIR_A }))
    await succeed(enqueuePending(h.ctx, { id: "legacy_trig", source: "telegram", threadID: THREAD, text: "hi" }))
    expect(h.data.get(ticketKey(created.ticket.id))).toBeDefined()
    expect([...h.data.keys()].some((key) => key.startsWith(DIR_SCOPE_PREFIX))).toBe(false)
    expect(ticketStats().total).toBe(1)
    expect(ticketStats(DEFAULT_DIR_KEY).total).toBe(1)
    // 所有目录的工单归入同一个（默认）分区：跨"目录"不是跨分区。
    const other = await succeed(createTicket(h.ctx, { ...base, objective: "另一个目录", directory: DIR_B }))
    expect(ticketStats(KEY_B).total).toBe(2)
    expect(await succeed(updateTicket(h.ctx, { ticketID: other.ticket.id, note: "ok", dirKey: KEY_A }))).toBeDefined()
  })

  test("status and hydrate keep the stage 2a snapshot", async () => {
    const h = harness()
    await succeed(hydrate(h.ctx))
    expect(store.dirs.size).toBe(1)
    expect(store.triggerTotal).toBe(0)
    expect([...h.data.keys()].some((key) => key.startsWith(DIR_SCOPE_PREFIX))).toBe(false)
    expect(buildStatusInjection(undefined, 0)).toBe(
      "Status: workers=0 pending=0 triggers=0 tickets=open0/in_progress0/blocked0/closed0. dirs: threads=0 aliases=-.",
    )
  })
})
