import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { statusText } from "../src/dispatch.js"
import { DEFAULT_PENDING_TTL_MS, hydratePending, PENDING_PREFIX } from "../src/router.js"
import { store } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
function memoryContext(options: Record<string, unknown> = {}) {
  const data = new Map<string, Schema.Json>()
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (opts: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(opts.prefix)).sort()
        const start = opts.after === undefined ? 0 : keys.indexOf(opts.after) + 1
        const page = keys.slice(start, start + (opts.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  return { storage, options, data } as unknown as Plugin.Context & { data: Map<string, Schema.Json> }
}

const HOUR = 60 * 60 * 1000

/** KV entry the way `enqueuePending` persists it: `pending:<id>` with a stable trigger id. */
function seedPending(ctx: Plugin.Context & { data: Map<string, Schema.Json> }, id: string, arrivedAt: number): void {
  ctx.data.set(`${PENDING_PREFIX}${id}`, {
    trigger: { id, source: "test", threadID: "thread:1", text: `event ${id}`, createdAt: arrivedAt - 1 },
    arrivedAt,
  } as unknown as Schema.Json)
}

function pendingIDs(): Array<string> {
  return store.pending.map((item) => item.trigger.id ?? "")
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

beforeEach(() => {
  resetTickets()
  store.pending.length = 0
  store.triggers.clear()
  store.triggerTotal = 0
  store.pendingDropped = 0
  store.routerID = undefined
})

afterEach(() => {
  // `store` is shared with every other test file in this process.
  store.pendingDropped = 0
})

// ── replay TTL ────────────────────────────────────────────────────────────────

describe("hydratePending drops triggers that outlived the replay TTL", () => {
  test("a fresh trigger is replayed, a stale one is dropped from memory and KV", async () => {
    const ctx = memoryContext()
    const now = Date.now()
    seedPending(ctx, "fresh", now - HOUR)
    seedPending(ctx, "stale", now - DEFAULT_PENDING_TTL_MS - HOUR)

    await succeed(hydratePending(ctx))

    expect(pendingIDs()).toEqual(["fresh"])
    // The stale entry is gone from KV, so the next restart cannot replay it either.
    expect([...ctx.data.keys()]).toEqual([`${PENDING_PREFIX}fresh`])
    expect(store.pendingDropped).toBe(1)
  })

  test("an entry exactly at the TTL boundary is still replayed", async () => {
    const ctx = memoryContext()
    const now = Date.now()
    seedPending(ctx, "edge", now - DEFAULT_PENDING_TTL_MS + 1_000)

    await succeed(hydratePending(ctx))

    expect(pendingIDs()).toEqual(["edge"])
    expect(store.pendingDropped).toBe(0)
  })

  test("the TTL is configurable through the plugin option", async () => {
    const ctx = memoryContext({ pendingTTLMs: 1_000 })
    const now = Date.now()
    seedPending(ctx, "recent", now - 500)
    seedPending(ctx, "old", now - 5_000)

    await succeed(hydratePending(ctx))

    expect(pendingIDs()).toEqual(["recent"])
    expect(store.pendingDropped).toBe(1)
  })

  test("an unusable TTL option falls back to the default instead of replaying everything", async () => {
    for (const value of [0, -1, "soon", Number.NaN]) {
      const ctx = memoryContext({ pendingTTLMs: value })
      const now = Date.now()
      seedPending(ctx, "too-old", now - DEFAULT_PENDING_TTL_MS - HOUR)

      await succeed(hydratePending(ctx))

      expect(pendingIDs()).toEqual([])
      expect(store.pendingDropped).toBe(1)
      store.pendingDropped = 0
    }
  })

  test("a stale drop is visible in the status text", async () => {
    const ctx = memoryContext()
    seedPending(ctx, "stale", Date.now() - DEFAULT_PENDING_TTL_MS - HOUR)
    await succeed(hydratePending(ctx))

    expect(statusText()).toContain("dropped 1 expired pending trigger(s) at startup")
  })
})
