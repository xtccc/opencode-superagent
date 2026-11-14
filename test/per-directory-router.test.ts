import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, type Schema } from "effect"
import { runAbort } from "../src/abort.js"
import { filterSessionTools } from "../src/context.js"
import { DEFAULT_DIR_KEY, aliasConflicts, aliasDirs, dirKeyOf, threadDirs } from "../src/dirs.js"
import { runDispatch, statusText } from "../src/dispatch.js"
import { requireRouter } from "../src/guard.js"
import {
  ensureRouter,
  enqueuePending,
  flushPending,
  hydratePending,
  lockPartitions,
  registerRouterIdle,
} from "../src/router.js"
import { applySettings, perDirectoryRouterEnabled, resetSettings } from "../src/settings.js"
import {
  ROUTER_KEY,
  dirKeyForRouter,
  dirScopedKey,
  dirState,
  dirStateForDirectory,
  encodeThread,
  hydrate,
  rememberRouter,
  resetPartitions,
  routerIDForDir,
  store,
  threadKey,
  totalPending,
  type WorkerRecord,
} from "../src/state.js"
import { resetSuperseded } from "../src/superseded.js"
import { createTicket, resetTickets } from "../src/ticket.js"
import { pluginVersion } from "../src/version.js"
import { handleEnded, resetPartitionWarnings } from "../src/watcher.js"
import { runWorkerPrompt } from "../src/worker-prompt.js"
import { resetWatchdogAlerts } from "../src/watchdog.js"

/**
 * 阶段 2a：`perDirectoryRouter` 打开时一目录一 Router。
 *
 * 这些用例守的是三条不可回退的承诺：
 * 1. 每个目录有自己的 Router 会话（在正确的 `location.directory` 里），并且
 *    routerID ↔ dirKey 能双向反查；
 * 2. worker 的终态通知只进入其所属目录的 Router —— 跨目录绝不串台；
 * 3. 锁、pending 队列、thread 亲和都按分区独立，一个目录卡住不拖累另一个；
 * 而开关关闭时，行为与阶段 1 逐字节一致。
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"
const THREAD_A = "telegram:1001"
const THREAD_B = "telegram:1002"

// ── fixtures ──────────────────────────────────────────────────────────────────

interface SyntheticCall {
  readonly sessionID: string
  readonly text: string
  readonly id?: string
}

interface Harness {
  readonly ctx: Plugin.Context
  readonly data: Map<string, Schema.Json>
  readonly infos: Map<string, Record<string, unknown>>
  readonly created: Array<{ readonly id: string; readonly directory?: string }>
  readonly synthetic: Array<SyntheticCall>
  readonly prompts: Array<{ readonly sessionID: string; readonly text: string }>
  readonly hooks: Map<string, Array<(event: never) => Effect.Effect<void>>>
  /** Hold `sessions.create` for one directory until the returned release fires. */
  gate(directory: string): { readonly started: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
}

function memoryContext(): {
  data: Map<string, Schema.Json>
  storage: {
    get: (key: string) => Effect.Effect<Schema.Json | undefined>
    set: (key: string, value: Schema.Json) => Effect.Effect<void>
    remove: (key: string) => Effect.Effect<void>
    scan: (options: { prefix: string; after?: string; limit?: number }) => Effect.Effect<{
      entries: Array<{ key: string; value: Schema.Json }>
      next?: string
    }>
  }
} {
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
  return { data, storage }
}

/** A host stand-in where router creation, synthetic delivery and prompts are observable. */
function partitionContext(): Harness {
  const { data, storage } = memoryContext()
  const infos = new Map<string, Record<string, unknown>>()
  const created: Array<{ id: string; directory?: string }> = []
  const synthetic: Array<SyntheticCall> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const hooks = new Map<string, Array<(event: never) => Effect.Effect<void>>>()
  const gates = new Map<string, { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> }>()
  let counter = 0
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
    synthetic: (input: { sessionID: string; text: string; id?: string }) => {
      synthetic.push({ sessionID: input.sessionID, text: input.text, ...(input.id === undefined ? {} : { id: input.id }) })
      return Effect.succeed(undefined)
    },
    prompt: (input: { sessionID: string; text: string }) => {
      prompts.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined)
    },
    interrupt: () => Effect.succeed({ interrupted: true }),
    hook: (name: string, callback: (event: never) => Effect.Effect<void>) => {
      const list = hooks.get(name) ?? []
      list.push(callback)
      hooks.set(name, list)
      return Effect.succeed(undefined)
    },
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-router" } }) }
  const ctx = { options: {}, storage, session, agent } as unknown as Plugin.Context
  return {
    ctx,
    data,
    infos,
    created,
    synthetic,
    prompts,
    hooks,
    gate(directory: string) {
      const started = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<void>()
      gates.set(directory, { started, release })
      return { started, release }
    },
  }
}

function worker(sessionID: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threadID: THREAD_A,
    threads: [THREAD_A],
    state: "running",
    createdAt: 1_000,
    ...overrides,
  }
}

function trigger(id: string, threadID: string = THREAD_A) {
  return { id, source: "telegram", threadID, text: `事件 ${id}` }
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

function fork<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.exit(effect).pipe(Effect.forkDetach({ startImmediately: true })))
}

beforeEach(() => {
  resetSettings()
  resetTickets()
  resetPartitions()
  resetPartitionWarnings()
  resetWatchdogAlerts()
  // `superseded` is a process-wide registry: a marker left by an earlier test
  // file would add a status line here and break the byte-for-byte assertions.
  resetSuperseded()
  threadDirs.clear()
  aliasDirs.clear()
  aliasConflicts.clear()
  store.workers.clear()
  store.triggers.clear()
  store.triggerTotal = 0
  store.dirKey = DEFAULT_DIR_KEY
})

afterEach(() => {
  resetSettings()
  resetPartitions()
})

// ── 1. one Router per directory ───────────────────────────────────────────────

describe("each directory gets its own router session", () => {
  test("router ids are distinct, live in their directory, and reverse-lookup works", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirKeyOf(DIR_A)
    const keyB = dirKeyOf(DIR_B)

    const routerA = await succeed(ensureRouter(h.ctx, { dirKey: keyA, directory: DIR_A }))
    const routerB = await succeed(ensureRouter(h.ctx, { dirKey: keyB, directory: DIR_B }))

    expect(routerA).not.toBe(routerB)
    // 反查：routerID -> dirKey，dirKey -> routerID，两个方向都成立。
    expect(dirKeyForRouter(routerA)).toBe(keyA)
    expect(dirKeyForRouter(routerB)).toBe(keyB)
    expect(routerIDForDir(keyA)).toBe(routerA)
    expect(routerIDForDir(keyB)).toBe(routerB)
    // Router 会话创建在它自己的目录里（与 worker 创建方式一致）。
    expect(h.created.map((entry) => entry.directory)).toEqual([DIR_A, DIR_B])
    // 分区 KV 命名空间：默认分区的 `router` 键没有被碰过。
    expect(h.data.get(dirScopedKey(ROUTER_KEY, keyA))).toBe(routerA)
    expect(h.data.get(dirScopedKey(ROUTER_KEY, keyB))).toBe(routerB)
    expect(h.data.get(ROUTER_KEY)).toBeUndefined()
    expect(store.routerID).toBeUndefined()

    // 幂等：同一个分区再要一次，复用同一个会话，不新建。
    expect(await succeed(ensureRouter(h.ctx, { dirKey: keyA }))).toBe(routerA)
    expect(h.created).toHaveLength(2)
  })

  test("a hydrated router of a partition comes back into that partition", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirKeyOf(DIR_A)
    h.infos.set("ses_router_a", { location: { directory: DIR_A } })
    h.data.set(dirScopedKey(ROUTER_KEY, keyA), "ses_router_a")

    await succeed(hydrate(h.ctx))

    expect(routerIDForDir(keyA)).toBe("ses_router_a")
    expect(dirKeyForRouter("ses_router_a")).toBe(keyA)
    expect(dirState(store, keyA).directory).toBe(DIR_A)
    expect(store.routerID).toBeUndefined()
  })
})

// ── 2. worker events are routed by directory ──────────────────────────────────

describe("worker completion is routed to its own directory", () => {
  test("two directories never receive each other's completion", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirKeyOf(DIR_A)
    const keyB = dirKeyOf(DIR_B)
    const routerA = await succeed(ensureRouter(h.ctx, { dirKey: keyA, directory: DIR_A }))
    const routerB = await succeed(ensureRouter(h.ctx, { dirKey: keyB, directory: DIR_B }))

    store.workers.set("ses_wa", worker("ses_wa", { directory: DIR_A, threadID: THREAD_A, threads: [THREAD_A] }))
    store.workers.set("ses_wb", worker("ses_wb", { directory: DIR_B, threadID: THREAD_B, threads: [THREAD_B] }))

    await succeed(handleEnded(h.ctx, "ses_wa", "done", undefined, 1))
    await succeed(handleEnded(h.ctx, "ses_wb", "done", undefined, 2))

    expect(h.synthetic).toHaveLength(2)
    const toA = h.synthetic.filter((call) => call.sessionID === routerA)
    const toB = h.synthetic.filter((call) => call.sessionID === routerB)
    expect(toA).toHaveLength(1)
    expect(toB).toHaveLength(1)
    expect(toA[0]?.text).toContain("ses_wa")
    expect(toA[0]?.text).not.toContain("ses_wb")
    expect(toB[0]?.text).toContain("ses_wb")
    expect(toB[0]?.text).not.toContain("ses_wa")
  })

  test("a directory without a router gets one created for the worker, not the default router", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    store.workers.set("ses_wb", worker("ses_wb", { directory: DIR_B, threadID: THREAD_B, threads: [THREAD_B] }))

    await succeed(handleEnded(h.ctx, "ses_wb", "done", undefined, 1))

    expect(h.synthetic).toHaveLength(1)
    expect(h.created.map((entry) => entry.directory)).toEqual([DIR_B])
    expect(store.routerID).toBeUndefined()
    expect(h.synthetic[0]?.sessionID).toBe(String(routerIDForDir(dirKeyOf(DIR_B))))
  })

  test("a worker with no directory degrades to the default partition (never dropped)", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    store.workers.set("ses_legacy", worker("ses_legacy", { directory: undefined }))

    await succeed(handleEnded(h.ctx, "ses_legacy", "done", undefined, 1))
    // 重复投递不应重复告警，也不应重复通知（notified 去重）。
    await succeed(handleEnded(h.ctx, "ses_legacy", "done", undefined, 1))

    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(String(store.routerID))
    expect(store.routerID).toBeDefined()
    expect(h.created).toHaveLength(1)
  })
})

describe("the idle hook drains one partition only", () => {
  test("router B going idle flushes B, never A", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirStateForDirectory(DIR_A).dirKey
    const keyB = dirStateForDirectory(DIR_B).dirKey
    await succeed(ensureRouter(h.ctx, { dirKey: keyA, directory: DIR_A }))
    const routerB = await succeed(ensureRouter(h.ctx, { dirKey: keyB, directory: DIR_B }))
    await succeed(enqueuePending(h.ctx, trigger("a1"), keyA))
    await succeed(enqueuePending(h.ctx, trigger("b1", THREAD_B), keyB))

    // 注册 hook 只碰 `ctx.session.hook`，作用域是类型层面的要求。
    await Effect.runPromise(Effect.scoped(registerRouterIdle(h.ctx)))
    const idle = h.hooks.get("experimental.idle")?.[0]
    if (idle === undefined) throw new Error("idle hook was not registered")
    await succeed(idle({ sessionID: routerB, background: [] } as never))

    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(routerB)
    expect(dirState(store, keyA).pending).toHaveLength(1)
    expect(dirState(store, keyB).pending).toHaveLength(0)
  })
})

// ── 3. auth is per partition ──────────────────────────────────────────────────

describe("router identity is per partition", () => {
  test("requireRouter accepts every partition's router and rejects anything else", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirKeyOf(DIR_A)
    const keyB = dirKeyOf(DIR_B)
    const routerA = await succeed(ensureRouter(h.ctx, { dirKey: keyA, directory: DIR_A }))
    const routerB = await succeed(ensureRouter(h.ctx, { dirKey: keyB, directory: DIR_B }))

    expect(await succeed(requireRouter(routerA, "status"))).toBe(keyA)
    expect(await succeed(requireRouter(routerB, "status"))).toBe(keyB)
    expect(await failure(requireRouter("ses_user", "status"))).toContain("only available to the router session")
  })

  test("no guard ties a router to a directory any more", async () => {
    // 回归守卫：`requireRouterFor(caller, directory)` 把「工作目录」当成「归属分区」，
    // 开关打开后默认分区的 Router 连自己的工作目录都用不了。归属只由调用方决定。
    const guard = (await import("../src/guard.js")) as Record<string, unknown>
    expect("requireRouterFor" in guard).toBe(false)
  })

  test("the tool filter recognises a router of any partition", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const routerB = await succeed(
      ensureRouter(h.ctx, { dirKey: dirKeyOf(DIR_B), directory: DIR_B }),
    )

    const routerTools: Record<string, unknown> = { dispatch: {}, sleep: {}, bash: {} }
    filterSessionTools(routerB, routerTools)
    expect(Object.keys(routerTools).sort()).toEqual(["dispatch", "sleep"])

    const userTools: Record<string, unknown> = { dispatch: {}, sleep: {}, bash: {} }
    filterSessionTools("ses_user", userTools)
    expect(Object.keys(userTools).sort()).toEqual(["bash", "dispatch", "sleep"])
  })

  test("a router cannot dispatch another partition's ticket", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const keyA = dirKeyOf(DIR_A)
    const routerA = await succeed(ensureRouter(h.ctx, { dirKey: keyA, directory: DIR_A }))
    const routerB = await succeed(
      ensureRouter(h.ctx, { dirKey: dirKeyOf(DIR_B), directory: DIR_B }),
    )
    const base = {
      title: "修复登录日志",
      objective: "登录失败时把用户 id 写进日志",
      acceptance: ["日志含 user id"],
      source: "telegram",
    } as const
    const ticketA = await succeed(
      createTicket(h.ctx, { ...base, threadID: THREAD_A, directory: DIR_A, dirKey: keyA }),
    )
    const ticketB = await succeed(
      createTicket(h.ctx, { ...base, threadID: THREAD_B, directory: DIR_B, dirKey: dirKeyOf(DIR_B) }),
    )

    const denied = await failure(runDispatch(h.ctx, { task: "修日志", ticketID: ticketB.ticket.id }, routerA))
    expect(denied).toContain("partition")
    expect(denied).toContain(dirKeyOf(DIR_B))
    expect(store.workers.size).toBe(0)

    // 自己的工单照常派发，并且亲和/worker 记录落在自己的分区。
    const result = await succeed(runDispatch(h.ctx, { task: "修日志", ticketID: ticketA.ticket.id }, routerA))
    const workerID = String(result.output.sessionID)
    expect(store.workers.get(workerID)?.directory).toBe(DIR_A)
    expect(dirState(store, keyA).threads.get(THREAD_A)).toEqual([workerID])
    expect(dirState(store, dirKeyOf(DIR_B)).threads.has(THREAD_B)).toBe(false)
    expect(h.data.get(dirScopedKey(threadKey(THREAD_A), keyA))).toBeDefined()
    expect(h.data.get(threadKey(THREAD_A))).toBeUndefined()

    // 反向：B 的 Router 派发 A 分区的（另一张）工单同样被拒。
    const ticketC = await succeed(
      createTicket(h.ctx, { ...base, objective: "另一件事", threadID: THREAD_A, directory: DIR_A, dirKey: keyA }),
    )
    const deniedB = await failure(runDispatch(h.ctx, { task: "修日志", ticketID: ticketC.ticket.id }, routerB))
    expect(deniedB).toContain("partition")
  })

  test("abort and worker_prompt refuse another partition's worker", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    const routerA = await succeed(ensureRouter(h.ctx, { dirKey: dirKeyOf(DIR_A), directory: DIR_A }))
    store.workers.set("ses_wb", worker("ses_wb", { directory: DIR_B, threadID: THREAD_B, threads: [THREAD_B] }))

    const abortDenied = await failure(runAbort(h.ctx, { sessionID: "ses_wb" }, routerA))
    expect(abortDenied).toContain("another router's partition")
    expect(store.workers.get("ses_wb")?.state).toBe("running")

    const promptDenied = await failure(
      runWorkerPrompt(h.ctx, { sessionID: "ses_wb", text: "继续" }, routerA),
    )
    expect(promptDenied).toContain("another router's partition")
    expect(h.prompts).toHaveLength(0)
  })
})

// ── 4. locks and queues are independent ──────────────────────────────────────

describe("partitions have independent locks and queues", () => {
  test("a stuck router creation in one directory does not block another's flush", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    // `runTrigger`/`dispatch` register the directory on the partition; the
    // Router session is then created *in* it, which is what the gate matches.
    const keyA = dirStateForDirectory(DIR_A).dirKey
    const keyB = dirStateForDirectory(DIR_B).dirKey
    await succeed(enqueuePending(h.ctx, trigger("a1"), keyA))
    await succeed(enqueuePending(h.ctx, trigger("a2"), keyA))
    await succeed(enqueuePending(h.ctx, trigger("b1", THREAD_B), keyB))

    const gate = h.gate(DIR_A)
    const pendingA = await fork(flushPending(h.ctx, { dirKey: keyA }))
    await Effect.runPromise(Deferred.await(gate.started))
    // A 卡在 sessions.create 里并持有 A 的 flush + router 锁；B 必须照常跑完。
    await Effect.runPromise(Effect.yieldNow)
    expect(h.synthetic).toHaveLength(0)
    await succeed(flushPending(h.ctx, { dirKey: keyB }))
    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.sessionID).toBe(String(routerIDForDir(keyB)))
    expect(dirState(store, keyA).pending).toHaveLength(2)
    expect(dirState(store, keyB).pending).toHaveLength(0)
    // 锁按分区登记（全局注册表跨用例保留，所以只断言两个分区各有自己的锁）。
    const locks = lockPartitions()
    expect(locks.flush).toBeGreaterThanOrEqual(2)
    expect(locks.router).toBeGreaterThanOrEqual(2)

    await Effect.runPromise(Deferred.succeed(gate.release, undefined))
    const exit = await Effect.runPromise(Fiber.join(pendingA))
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(h.synthetic).toHaveLength(2)
    expect(h.synthetic[1]?.sessionID).toBe(String(routerIDForDir(keyA)))
    expect(h.synthetic[1]?.text).toContain("2 new event(s)")
    expect(dirState(store, keyA).pending).toHaveLength(0)
    expect(totalPending()).toBe(0)
  })

  test("pending triggers are persisted per partition and replay into their own queue", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = partitionContext()
    // `runTrigger`/`dispatch` register the directory on the partition; the
    // Router session is then created *in* it, which is what the gate matches.
    const keyA = dirStateForDirectory(DIR_A).dirKey
    const keyB = dirStateForDirectory(DIR_B).dirKey
    await succeed(enqueuePending(h.ctx, trigger("a1"), keyA))
    await succeed(enqueuePending(h.ctx, trigger("b1", THREAD_B), keyB))

    const keys = [...h.data.keys()].filter((key) => key.includes("pending:"))
    expect(keys.filter((key) => key.startsWith(`dir:${keyA}:pending:`))).toHaveLength(1)
    expect(keys.filter((key) => key.startsWith(`dir:${keyB}:pending:`))).toHaveLength(1)
    expect(keys.filter((key) => key.startsWith("pending:"))).toHaveLength(0)

    // 重启：内存清空后按分区回放。
    dirState(store, keyA).pending.length = 0
    dirState(store, keyB).pending.length = 0
    await succeed(hydratePending(h.ctx))
    expect(dirState(store, keyA).pending.map((item) => item.trigger.id)).toEqual(["a1"])
    expect(dirState(store, keyB).pending.map((item) => item.trigger.id)).toEqual(["b1"])
  })
})

// ── 5. switch off: identical to stage 1 ──────────────────────────────────────

describe("with the switch off nothing is partitioned", () => {
  test("every directory shares the single default router and the legacy KV", async () => {
    const h = partitionContext()
    expect(perDirectoryRouterEnabled()).toBe(false)

    const routerID = await succeed(ensureRouter(h.ctx, { directory: DIR_A }))
    const same = await succeed(ensureRouter(h.ctx, { directory: DIR_B, dirKey: dirKeyOf(DIR_B) }))

    expect(same).toBe(routerID)
    expect(store.dirs.size).toBe(1)
    expect(dirKeyForRouter(routerID)).toBe(DEFAULT_DIR_KEY)
    expect(store.routerID).toBe(routerID)
    // 阶段 1 的取键方式：没有任何 `dir:` 命名空间。
    expect(h.data.get(ROUTER_KEY)).toBe(routerID)
    expect([...h.data.keys()].some((key) => key.startsWith("dir:"))).toBe(false)
    // Router 会话不带 location（沿用宿主默认目录）。
    expect(h.created).toHaveLength(1)
    expect(h.created[0]?.directory).toBeUndefined()
  })

  test("the status snapshot is byte-identical to stage 1", async () => {
    const h = partitionContext()
    const routerID = await succeed(ensureRouter(h.ctx, { directory: DIR_A }))
    store.workers.set("ses_w", worker("ses_w", { state: "running", directory: DIR_A, title: "在跑" }))

    const expected = [
      `superagent ${pluginVersion()} — restart the gateway after upgrading (no hot reload)`,
      `router: ${routerID} pending: 0 workers=1 active=1 tickets: open=0 in_progress=0 blocked=0 closed=0`,
      `- ses_w 在跑 [${THREAD_A}] running dir=${DIR_A}`,
    ].join("\n")
    expect(statusText()).toBe(expected)
  })

  test("legacy thread affinity and pending queues stay in the default partition", async () => {
    const h = partitionContext()
    h.data.set(threadKey(THREAD_A), encodeThread({ threadID: THREAD_A, workers: [], updatedAt: 1 }))
    store.workers.set("ses_w", worker("ses_w", { state: "done", directory: DIR_A }))
    h.data.set(threadKey(THREAD_A), encodeThread({ threadID: THREAD_A, workers: ["ses_w"], updatedAt: 1 }))

    await succeed(hydrate(h.ctx))
    expect(store.dirs.size).toBe(1)
    expect(store.threads.get(THREAD_A)).toEqual(["ses_w"])

    await succeed(enqueuePending(h.ctx, trigger("t1"), dirKeyOf(DIR_A)))
    expect(store.pending).toHaveLength(1)
    expect([...h.data.keys()].some((key) => key.startsWith("dir:"))).toBe(false)
  })

  test("a remembered router keeps working through the flat accessors", () => {
    rememberRouter(DEFAULT_DIR_KEY, "ses_router")
    expect(store.routerID).toBe("ses_router")
    expect(dirKeyForRouter("ses_router")).toBe(DEFAULT_DIR_KEY)
    rememberRouter(DEFAULT_DIR_KEY, undefined)
    expect(store.routerID).toBeUndefined()
    // 忘记 Router 后索引也要干净，否则被删会话的事件仍会被当成 Router 事件。
    expect(dirKeyForRouter("ses_router")).toBeUndefined()
  })
})
