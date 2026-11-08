import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { closeTicket, createTicket, findDuplicate, getTicket, resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

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
  return { storage, data } as unknown as Plugin.Context & { data: Map<string, Schema.Json> }
}

const base = {
  threadID: "telegram:42",
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id", "现有测试全绿"],
  directory: "/opt/ai-gw",
  source: "telegram",
  author: "alice",
  dedupeKey: "shared-key",
} as const

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

// `ticket.ts` owns a module-level store; every test starts from a clean one.
function fresh() {
  resetTickets()
  return memoryContext()
}

// ── dedupe scoping ───────────────────────────────────────────────────────────

describe("ticket dedupe is scoped to one thread", () => {
  test("reuses an active same-key ticket in the same thread", async () => {
    const ctx = fresh()
    const first = await succeed(createTicket(ctx, base))
    expect(first.reused).toBe(false)

    const second = await succeed(createTicket(ctx, { ...base, title: "同义改写" }))
    expect(second.reused).toBe(true)
    expect(second.ticket.id).toBe(first.ticket.id)

    expect(findDuplicate("telegram:42", "shared-key")?.id).toBe(first.ticket.id)
  })

  test("does not reuse a same-key ticket from another thread", async () => {
    const ctx = fresh()
    const first = await succeed(createTicket(ctx, base))

    // The bug: with no in-memory ticket for the queried thread the old code
    // fell back to every ticket, matching `first` across the thread boundary.
    expect(findDuplicate("telegram:99", "shared-key")).toBeUndefined()

    const other = await succeed(createTicket(ctx, { ...base, threadID: "telegram:99" }))
    expect(other.reused).toBe(false)
    expect(other.ticket.id).not.toBe(first.ticket.id)
    expect(other.ticket.threadID).toBe("telegram:99")
    expect(getTicket(first.ticket.id)?.threadID).toBe("telegram:42")

    // Each thread still dedupes against its own ticket only.
    const again42 = await succeed(createTicket(ctx, base))
    expect(again42.reused).toBe(true)
    expect(again42.ticket.id).toBe(first.ticket.id)
    const again99 = await succeed(createTicket(ctx, { ...base, threadID: "telegram:99" }))
    expect(again99.reused).toBe(true)
    expect(again99.ticket.id).toBe(other.ticket.id)
  })

  test("a closed same-key ticket is not reused in any thread", async () => {
    const ctx = fresh()
    const first = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: first.ticket.id, outcome: "done", summary: "ok" }))

    expect(findDuplicate("telegram:42", "shared-key")).toBeUndefined()
    const next = await succeed(createTicket(ctx, base))
    expect(next.reused).toBe(false)
    expect(next.ticket.id).not.toBe(first.ticket.id)
  })

  test("an empty store has no duplicate", () => {
    fresh()
    expect(findDuplicate("telegram:42", "shared-key")).toBeUndefined()
  })
})
