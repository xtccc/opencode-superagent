import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { buildRecallInjection } from "../src/context.js"
import { runDispatch } from "../src/dispatch.js"
import { runThreadDetail } from "../src/recall.js"
import { hydrate, store, type TriggerRecord } from "../src/state.js"
import { createTicket, noteRouterTrigger, resetTickets } from "../src/ticket.js"
import { displayWidth } from "../src/tools.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const ROUTER = "ses_router"
const THREAD = "telegram:42"

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
function memoryContext(sessionIDs: ReadonlyArray<string> = []) {
  const data = new Map<string, Schema.Json>()
  const writes: Array<string> = []
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) =>
      Effect.sync(() => {
        writes.push(key)
        data.set(key, value)
      }),
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
  const known = new Set(sessionIDs)
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      known.has(sessionID) ? Effect.succeed({ id: sessionID }) : Effect.fail(new Error("missing")),
  }
  const context = { options: {}, storage, session, data, writes } as unknown as Plugin.Context & {
    data: Map<string, Schema.Json>
    writes: Array<string>
  }
  return context
}

function dispatchContext() {
  const context = memoryContext()
  const prompts: Array<string> = []
  const session = {
    get: () => Effect.succeed({ id: ROUTER, model: undefined, location: { directory: "/opt/ai-gw" } }),
    create: (input: { title?: string }) => Effect.succeed({ id: "ses_worker_new", title: input.title }),
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: () => Effect.succeed({ interrupted: true }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  return Object.assign(context, { prompts, session, agent }) as typeof context & {
    prompts: Array<string>
    session: unknown
    agent: unknown
  }
}

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.triggerTotal = 0
})

// ── reference graph ──────────────────────────────────────────────────────────

describe("reference graph", () => {
  test("dispatch records worker.threadID/triggerID and backfills trigger.workerIDs", async () => {
    const ctx = dispatchContext()
    const triggerID = `${THREAD}:1000`
    const trigger: TriggerRecord = {
      id: triggerID,
      source: "telegram",
      threadID: THREAD,
      text: "修日志",
      createdAt: 1_000,
    }
    store.triggers.set(triggerID, trigger)
    noteRouterTrigger(trigger)

    const created = await succeed(createTicket(ctx, base))
    const result = await succeed(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    const sessionID = String(result.output.sessionID)

    const worker = store.workers.get(sessionID)
    expect(worker?.threadID).toBe(THREAD)
    expect(worker?.triggerID).toBe(triggerID)
    expect(worker?.threads).toEqual([THREAD])
    expect(store.triggers.get(triggerID)?.workerIDs).toEqual([sessionID])

    // The reverse edge is persisted, not only kept in memory.
    const stored = ctx.data.get(`trigger:${triggerID}`) as { workerIDs?: Array<string> } | undefined
    expect(stored?.workerIDs).toEqual([sessionID])
    expect((ctx.data.get(`worker:${sessionID}`) as { threadID?: string } | undefined)?.threadID).toBe(THREAD)

    // Dispatch stays idempotent for the same edge: no duplicate worker id.
    expect(worker?.threadID).toBe(THREAD)
    expect(store.triggers.get(triggerID)?.workerIDs).toEqual([sessionID])
  })

  test("hydrate backfills legacy records once and is idempotent on a second run", async () => {
    const ctx = memoryContext(["ses_a", "ses_b", "ses_c"])
    const legacy = { source: "telegram", threadID: "telegram:9", text: "hi", createdAt: 1 }
    ctx.data.set("worker:ses_a", {
      sessionID: "ses_a",
      threads: ["telegram:9"],
      state: "done",
      createdAt: 1,
    } as unknown as Schema.Json)
    // Worker → trigger edge already exists; the trigger lacks workerIDs.
    ctx.data.set("worker:ses_b", {
      sessionID: "ses_b",
      triggerID: "trigger:old",
      threads: ["telegram:9"],
      state: "done",
      createdAt: 2,
    } as unknown as Schema.Json)
    // Trigger → worker edge already exists; the worker lacks triggerID.
    ctx.data.set("worker:ses_c", {
      sessionID: "ses_c",
      threads: ["telegram:9"],
      state: "done",
      createdAt: 3,
    } as unknown as Schema.Json)
    ctx.data.set("thread:telegram:9", {
      threadID: "telegram:9",
      workers: ["ses_a", "ses_b", "ses_c"],
      updatedAt: 1,
    } as unknown as Schema.Json)
    ctx.data.set("trigger:old", {
      ...legacy,
      id: "trigger:old",
      workerIDs: ["ses_c"],
    } as unknown as Schema.Json)

    await succeed(hydrate(ctx))

    for (const sessionID of ["ses_a", "ses_b", "ses_c"]) {
      expect(store.workers.get(sessionID)?.threadID).toBe("telegram:9")
    }
    expect(store.workers.get("ses_b")?.triggerID).toBe("trigger:old")
    expect(store.workers.get("ses_c")?.triggerID).toBe("trigger:old")
    expect(store.triggers.get("trigger:old")?.workerIDs).toEqual(["ses_c", "ses_b"])

    const firstWrites = ctx.writes.length
    expect(firstWrites).toBeGreaterThan(0)
    const firstSnapshot = new Map(ctx.data)

    await succeed(hydrate(ctx))
    // A re-run writes nothing and leaves the persisted values untouched.
    expect(ctx.writes.length).toBe(firstWrites)
    expect(ctx.data).toEqual(firstSnapshot)
  })
})

// ── chain recall injection ────────────────────────────────────────────────────

describe("context chain recall", () => {
  test("injects active ticket ids and recent worker ids within the line and block budget", async () => {
    const ctx = memoryContext()
    noteRouterTrigger({ id: "tctx", source: "telegram", threadID: THREAD, text: "继续" })
    const created = await succeed(createTicket(ctx, base))

    store.workers.set("ses_w_old", {
      sessionID: "ses_w_old",
      threadID: THREAD,
      threads: [THREAD],
      state: "done",
      createdAt: 10,
      lastReport: "旧 Worker 已完成同步",
    })
    store.workers.set("ses_w_new", {
      sessionID: "ses_w_new",
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 20,
      lastReport: "x".repeat(5_000),
    })
    store.workers.set("ses_other", {
      sessionID: "ses_other",
      threadID: "telegram:other",
      threads: ["telegram:other"],
      state: "done",
      createdAt: 30,
      lastReport: "别的 thread",
    })

    const text = buildRecallInjection(THREAD)
    expect(text).toContain(created.ticket.id)
    expect(text).toContain("ses_w_new")
    expect(text).toContain("ses_w_old")
    expect(text).toContain("report_read")
    expect(text).not.toContain("ses_other")
    expect(text.length).toBeLessThanOrEqual(800)
    for (const line of text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(100)
  })

  test("no current thread means no injected block", () => {
    expect(buildRecallInjection(undefined)).toBe("")
  })
})

// ── thread_detail KV fallback ─────────────────────────────────────────────────

describe("thread_detail KV fallback", () => {
  test("recalls trigger bodies older than the 200-entry memory window", async () => {
    const ctx = memoryContext()
    const threadID = "telegram:big"
    const total = 240
    const memoryCount = 200
    for (let index = 0; index < total; index++) {
      const record: TriggerRecord = {
        id: `t${index}`,
        source: "telegram",
        threadID,
        text: `text-${index}`,
        createdAt: index,
      }
      ctx.data.set(`trigger:t${index}`, record as unknown as Schema.Json)
      // Memory only has the newest 200, exactly like hydrate.
      if (index >= total - memoryCount) store.triggers.set(record.id, record)
    }

    const page = await succeed(runThreadDetail(ctx, { threadID, limit: 20, offset: 200 }, ROUTER))
    // Memory keeps the newest 200 (t40..t239). The KV fallback adds the newest
    // 20 missing records (t20..t39), so offset 200 reaches that band.
    expect(page.content).toContain("text-20")
    expect(page.content).toContain("text-39")
    expect(page.content).toContain("KV 20")
    expect(page.content).toContain("KV 回源已截断")

    const newest = await succeed(runThreadDetail(ctx, { threadID, limit: 20 }, ROUTER))
    expect(newest.content).toContain("text-239")
    expect(newest.content).not.toContain("KV ")
  })

  test("an offset beyond the recall cap reports the gap instead of inventing text", async () => {
    const ctx = memoryContext()
    const threadID = "telegram:big"
    for (let index = 0; index < 220; index++) {
      const record: TriggerRecord = {
        id: `t${index}`,
        source: "telegram",
        threadID,
        text: `text-${index}`,
        createdAt: index,
      }
      ctx.data.set(`trigger:t${index}`, record as unknown as Schema.Json)
      if (index >= 20) store.triggers.set(record.id, record)
    }
    const page = await succeed(runThreadDetail(ctx, { threadID, limit: 5, offset: 999 }, ROUTER))
    expect(page.content).toContain("offset 999 超出已知")
  })
})
