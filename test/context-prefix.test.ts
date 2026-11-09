import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { buildStatusInjection, registerContext } from "../src/context.js"
import { aliasDirs, threadDirs } from "../src/dirs.js"
import { ROUTER_PROMPT } from "../src/prompts.js"
import { enqueuePending, flushPending } from "../src/router.js"
import { store, type TriggerInput } from "../src/state.js"
import { createTicket, resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const ROUTER = "ses_router"
const THREAD = "telegram:42"

interface ContextEvent {
  sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: string; text: string }>
  messages: Array<unknown>
}

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
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
  return { storage, data }
}

interface Delivered {
  readonly id: string | undefined
  readonly text: string
}

/** Context that captures the real context hook and mimics the host's message-id dedupe. */
function harness() {
  const { storage, data } = memoryContext()
  const hooks = new Map<string, (event: ContextEvent) => Effect.Effect<void>>()
  const editor = { add: () => {} }
  const delivered: Array<Delivered> = []
  const seenIDs = new Set<string>()
  const session = {
    get: ({ sessionID }: { sessionID: string }) => Effect.succeed({ id: sessionID }),
    hook: (name: string, callback: (event: ContextEvent) => Effect.Effect<void>) =>
      Effect.sync(() => {
        hooks.set(name, callback)
        return { dispose: Effect.void }
      }),
    // The host appends by id: a replayed batch with the same id is a no-op.
    synthetic: (input: { id?: string; text: string }) => {
      if (input.id !== undefined && seenIDs.has(input.id)) return Effect.succeed({ id: input.id })
      if (input.id !== undefined) seenIDs.add(input.id)
      delivered.push({ id: input.id, text: input.text })
      return Effect.succeed({ id: input.id ?? `msg_auto_${delivered.length}` })
    },
  }
  const ctx = {
    storage,
    session,
    data,
    tool: {
      transform: (fn: (target: typeof editor) => void) =>
        Effect.sync(() => {
          fn(editor)
          return { dispose: Effect.void }
        }),
    },
  } as unknown as Plugin.Context & { data: Map<string, Schema.Json>; session: typeof session }
  return { ctx, hooks, delivered, data }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

function trigger(id: string, threadID: string = THREAD, text: string = `event ${id}`): TriggerInput {
  return { id, source: "test", threadID, text, createdAt: 1 }
}

function worker(sessionID: string, threadID: string): void {
  store.workers.set(sessionID, {
    sessionID,
    threadID,
    threads: [threadID],
    state: "running",
    createdAt: 1,
    lastReport: `report for ${sessionID}`,
  })
}

async function registerHarness() {
  const h = harness()
  await Effect.runPromise(Effect.scoped(registerContext(h.ctx)))
  const handler = h.hooks.get("context")
  if (handler === undefined) throw new Error("context hook was not registered")
  return { ...h, handler }
}

function request(sessionID: string): ContextEvent {
  return { sessionID, tools: { sleep: {}, dispatch: {}, read: {} }, system: [], messages: [] }
}

beforeEach(() => {
  resetTickets()
  store.pending.length = 0
  store.triggers.clear()
  store.triggerTotal = 0
  store.workers.clear()
  store.threads.clear()
  store.routerID = ROUTER
  store.routerBusy = false
  threadDirs.clear()
  aliasDirs.clear()
})

// ── system prefix is byte-stable ─────────────────────────────────────────────

describe("router system prefix", () => {
  test("two consecutive requests keep a byte-identical system block after state changes", async () => {
    const { ctx, handler } = await registerHarness()
    threadDirs.set(THREAD, "/opt/ai-gw")
    aliasDirs.set("ai-gw", "/opt/ai-gw")
    await succeed(
      createTicket(ctx, {
        threadID: THREAD,
        title: "第一个任务",
        objective: "完成它",
        acceptance: ["测试全绿"],
        directory: "/opt/ai-gw",
        source: "telegram",
      }),
    )

    const first = request(ROUTER)
    await Effect.runPromise(handler(first))

    // Everything the old status line reported changes between turns: worker
    // count, ticket stores, the ever-growing trigger counter and the queue.
    worker("ses_w1", THREAD)
    worker("ses_w2", "telegram:other")
    store.triggerTotal = 991
    await succeed(enqueuePending(ctx, trigger("t1")))

    const second = request(ROUTER)
    await Effect.runPromise(handler(second))

    expect(first.system).toHaveLength(1)
    expect(second.system).toHaveLength(1)
    const before = first.system[0]?.text ?? ""
    const after = second.system[0]?.text ?? ""
    // Byte for byte: no counter, ticket, directory or recall text in `system`.
    expect(after).toBe(before)
    expect(after).toBe(ROUTER_PROMPT)
    expect(after).not.toContain("Status:")
    expect(after).not.toContain("workers=")
    expect(after).not.toContain("triggers=")
    expect(after).not.toContain("ses_w1")
  })

  test("a worker session gets no system block and keeps its tool filtering", async () => {
    const { handler } = await registerHarness()
    worker("ses_w1", THREAD)
    const event = request("ses_w1")
    await Effect.runPromise(handler(event))
    expect(event.system).toHaveLength(0)
    expect(Object.keys(event.tools)).toEqual(["read"])
  })
})

// ── status rides at the tail of the synthetic batch message ──────────────────

describe("router status injection", () => {
  test("a batch appends the status block once, at the tail of the message", async () => {
    const { ctx, delivered } = await harness()
    worker("ses_w1", THREAD)
    worker("ses_other", "telegram:other")
    const created = await succeed(
      createTicket(ctx, {
        threadID: THREAD,
        title: "当前 thread 的任务",
        objective: "做完",
        acceptance: ["通过"],
        directory: "/opt/ai-gw",
        source: "telegram",
      }),
    )
    const foreign = await succeed(
      createTicket(ctx, {
        threadID: "telegram:other",
        title: "别的 thread",
        objective: "别混进来",
        acceptance: ["隔离"],
        directory: "/opt/aw",
        source: "telegram",
      }),
    )
    await succeed(enqueuePending(ctx, trigger("t1")))
    await succeed(enqueuePending(ctx, trigger("t2")))

    await succeed(flushPending(ctx))

    expect(delivered).toHaveLength(1)
    const text = delivered[0]?.text ?? ""
    expect(text).toContain("event t1")
    expect(text).toContain("event t2")
    // Tail order: triggers first, then the status block as the last section.
    expect(text.indexOf("event t2")).toBeLessThan(text.indexOf("Status:"))
    // Information is preserved: counters, ticket counts, active ticket and recall.
    expect(text).toContain("workers=2 pending=0 triggers=2")
    expect(text).toContain("tickets=open2/in_progress0/blocked0/closed0")
    expect(text).toContain(`进行中工单（当前 thread）：${created.ticket.id}`)
    expect(text).toContain("ses_w1")
    expect(text).toContain("report_read")
    // Only the batch's thread is in scope.
    expect(text).not.toContain(foreign.ticket.id)
    expect(text.split("Status:")).toHaveLength(2)
  })

  test("pending counts the queue left after the delivered batch", async () => {
    const { ctx, delivered } = await harness()
    // `flushPending` takes at most 20 events per batch, so the queue keeps a tail.
    for (let index = 0; index < 22; index++) await succeed(enqueuePending(ctx, trigger(`t${index}`)))

    await succeed(flushPending(ctx))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.text).toContain("pending=2")
  })

  test("an empty queue appends nothing, so history does not grow without new triggers", async () => {
    const { ctx, delivered } = await harness()
    await succeed(flushPending(ctx))
    expect(delivered).toHaveLength(0)

    await succeed(enqueuePending(ctx, trigger("t1")))
    await succeed(flushPending(ctx))
    expect(delivered).toHaveLength(1)

    await succeed(flushPending(ctx))
    expect(delivered).toHaveLength(1)
  })

  test("the batch id is stable, so a replayed batch is deduped instead of doubled", async () => {
    const { ctx, delivered } = await harness()
    await succeed(enqueuePending(ctx, trigger("t1")))
    await succeed(enqueuePending(ctx, trigger("t2")))
    // Snapshot exactly what KV would hand back after a crash: same trigger ids
    // and the same persisted `arrivedAt`/`createdAt`.
    const replay = store.pending.slice()
    await succeed(flushPending(ctx))
    const firstID = delivered[0]?.id
    expect(firstID).toBeDefined()
    // The host only accepts ids starting with `msg_`; keep the 12+14 layout.
    expect(firstID).toMatch(/^msg_[0-9a-f]{26}$/)

    // Hydration replays the same queued batch: same id, so the host dedupes it.
    for (const item of replay) store.pending.push(item)
    await succeed(flushPending(ctx))

    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.id).toBe(firstID)
  })

  test("buildStatusInjection omits thread-scoped parts without a thread", () => {
    worker("ses_w1", THREAD)
    const text = buildStatusInjection(undefined, 0)
    expect(text).toContain("workers=1 pending=0")
    expect(text).toContain("dirs:")
    expect(text).not.toContain("进行中工单")
    expect(text).not.toContain("链式召回")
  })
})
