import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { DEFAULT_DIR_KEY, dirKeyFor } from "../src/dirs.js"
import { Definition } from "../src/protocol.js"
import { applySettings, resetSettings } from "../src/settings.js"
import { statusSnapshot } from "../src/status.js"
import {
  dirStateForDirectory,
  rememberRouter,
  resetPartitions,
  store,
  type WorkerRecord,
} from "../src/state.js"
import { createTicket, resetTickets } from "../src/ticket.js"
import { renderTicketsTextDeep } from "../src/ticket-tools.js"
import { pluginVersion } from "../src/version.js"

/**
 * Stage 3: the `status` / `tickets` RPC directory surface.
 *
 * The promise is twofold: flag off is byte-identical to the stage 2b payload,
 * and flag on can either list every partition (aggregate) or answer for exactly
 * one directory without leaking another directory's workers.
 *
 * The payloads are also validated against the shared `Definition` schemas, so
 * `src/status.ts` and `src/protocol.ts` cannot drift.
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"

function worker(sessionID: string, directory: string | undefined, state: WorkerRecord["state"]): WorkerRecord {
  return {
    sessionID,
    threadID: `thread:${sessionID}`,
    threads: [`thread:${sessionID}`],
    state,
    createdAt: 1_000,
    ...(directory === undefined ? {} : { directory }),
  }
}

function resetStore(): void {
  resetSettings()
  resetTickets()
  resetPartitions()
  store.workers.clear()
  store.pending.length = 0
  store.routerID = undefined
}

beforeEach(resetStore)
afterEach(resetStore)

/** Validate one payload against the RPC's declared output schema. */
function validateStatusOutput(input: unknown): unknown {
  const result = Definition.methods.status.output["~standard"].validate(input) as
    | { value: unknown }
    | { issues: ReadonlyArray<{ message: string }> }
  if ("issues" in result) throw new Error(`status output failed validation: ${JSON.stringify(result.issues)}`)
  return result.value
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (exit._tag === "Failure") throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

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
  return { storage } as unknown as Plugin.Context
}

describe("status RPC: flag off is byte-identical to stage 2b", () => {
  test("single partition payload keeps the exact old keys and values", () => {
    // Flag off (default). One router and one worker, exactly what the old
    // handler serialized.
    store.routerID = "ses_router"
    store.workers.set("ses_w", worker("ses_w", undefined, "running"))
    store.pending.push({
      trigger: { id: "t1", source: "test", threadID: "thread:t1", text: "hi", createdAt: 1 },
      arrivedAt: 1,
    })

    const snapshot = statusSnapshot()
    const expected = {
      version: pluginVersion(),
      router: "ses_router",
      pending: 1,
      workers: [{ sessionID: "ses_w", threads: ["thread:ses_w"], state: "running" }],
    }
    // Key order is part of the payload only insofar as JSON is compared as
    // text, which is exactly how the stage 2b regression pinned it.
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(expected))
    expect("partitions" in snapshot).toBe(false)
    expect(validateStatusOutput(snapshot)).toEqual(snapshot)
  })

  test("flag on with a single active partition still emits the stage 2b shape", () => {
    applySettings({ perDirectoryRouter: true })
    const partition = dirStateForDirectory(DIR_A)
    rememberRouter(partition.dirKey, "ses_only")
    store.workers.set("ses_w", worker("ses_w", DIR_A, "running"))

    const snapshot = statusSnapshot()
    const expected = {
      version: pluginVersion(),
      router: "ses_only",
      pending: 0,
      workers: [{ sessionID: "ses_w", threads: ["thread:ses_w"], state: "running" }],
    }
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(expected))
    expect("partitions" in snapshot).toBe(false)
    expect(store.routerID).toBeUndefined()
    expect(validateStatusOutput(snapshot)).toEqual(snapshot)
  })

  test("a directory argument collapses onto the single default partition", () => {
    store.routerID = "ses_router"
    store.workers.set("ses_w", worker("ses_w", DIR_A, "done"))

    const unscoped = statusSnapshot()
    const scoped = statusSnapshot({ directory: DIR_A })

    expect(scoped.router).toBe(unscoped.router)
    expect(scoped.pending).toBe(unscoped.pending)
    expect(scoped.workers).toEqual(unscoped.workers)
    // Stage 3 echo fields, but no partition summary: the caller asked for one
    // directory and there is only one.
    expect(scoped.dirKey).toBe(DEFAULT_DIR_KEY)
    expect(scoped.directory).toBe(DIR_A)
    expect("partitions" in scoped).toBe(false)
    expect(validateStatusOutput(scoped)).toEqual(scoped)
  })
})

describe("status RPC: per-directory aggregate and scoping", () => {
  function seedTwoPartitions(): { keyA: string; keyB: string } {
    applySettings({ perDirectoryRouter: true })
    const a = dirStateForDirectory(DIR_A)
    const b = dirStateForDirectory(DIR_B)
    rememberRouter(a.dirKey, "ses_router_a")
    rememberRouter(b.dirKey, "ses_router_b")
    store.workers.set("ses_wa", worker("ses_wa", DIR_A, "running"))
    store.workers.set("ses_wa2", worker("ses_wa2", DIR_A, "done"))
    store.workers.set("ses_wb", worker("ses_wb", DIR_B, "idle"))
    a.pending.push({
      trigger: { id: "a1", source: "test", threadID: "thread:a1", text: "a", createdAt: 1 },
      arrivedAt: 1,
    })
    return { keyA: a.dirKey, keyB: b.dirKey }
  }

  test("no directory lists both partitions with router/pending/worker counts", () => {
    const { keyA, keyB } = seedTwoPartitions()

    const snapshot = statusSnapshot()
    expect(snapshot.workers).toHaveLength(3)
    expect(snapshot.pending).toBe(1)
    const partitions = snapshot.partitions ?? []
    expect(partitions.map((entry) => entry.dirKey).sort()).toEqual([keyA, keyB].sort())

    const a = partitions.find((entry) => entry.dirKey === keyA)
    expect(a).toMatchObject({
      directory: DIR_A,
      router: "ses_router_a",
      pending: 1,
      workers: 2,
      running: 1,
    })
    const b = partitions.find((entry) => entry.dirKey === keyB)
    expect(b).toMatchObject({
      directory: DIR_B,
      router: "ses_router_b",
      pending: 0,
      workers: 1,
      running: 0,
    })
    expect(validateStatusOutput(snapshot)).toEqual(snapshot)
  })

  test("passing directory returns only that partition", () => {
    const { keyA } = seedTwoPartitions()

    const a = statusSnapshot({ directory: DIR_A })
    expect(a.dirKey).toBe(keyA)
    expect(a.directory).toBe(DIR_A)
    expect(a.router).toBe("ses_router_a")
    expect(a.pending).toBe(1)
    expect(a.workers.map((entry) => entry.sessionID).sort()).toEqual(["ses_wa", "ses_wa2"])
    // No aggregate summary and no other directory's workers.
    expect("partitions" in a).toBe(false)
    expect(JSON.stringify(a)).not.toContain("ses_wb")
    expect(JSON.stringify(a)).not.toContain("ses_router_b")
    expect(validateStatusOutput(a)).toEqual(a)

    const b = statusSnapshot({ directory: DIR_B })
    expect(b.router).toBe("ses_router_b")
    expect(b.workers.map((entry) => entry.sessionID)).toEqual(["ses_wb"])
    expect(JSON.stringify(b)).not.toContain("ses_wa")
  })

  test("an unknown directory is empty, not the default partition", () => {
    seedTwoPartitions()
    const snapshot = statusSnapshot({ directory: "/opt/unknown" })
    expect(snapshot.dirKey).not.toBe(DEFAULT_DIR_KEY)
    expect(snapshot.workers).toEqual([])
    expect(snapshot.pending).toBe(0)
    expect(snapshot.router).toBeUndefined()
  })
})

describe("status RPC input contract", () => {
  function validateStatusInput(input: unknown): { value?: { directory?: string } } | { issues?: unknown } {
    return Definition.methods.status.input["~standard"].validate(input) as never
  }

  test("directory is optional and accepted when present", () => {
    expect(validateStatusInput({})).toEqual({ value: {} })
    expect(validateStatusInput({ directory: DIR_A })).toEqual({ value: { directory: DIR_A } })
  })

  test("tickets accepts the same optional directory", () => {
    const validated = Definition.methods.tickets.input["~standard"].validate({ directory: DIR_A }) as {
      value?: { directory?: string }
    }
    expect(validated.value?.directory).toBe(DIR_A)
  })
})

describe("tickets RPC: directory scoping", () => {
  const base = {
    threadID: "telegram:1",
    objective: "objective",
    acceptance: ["a"],
    source: "test",
  } as const

  test("a directory only lists its own tickets; omitted stays process-wide", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    const ticketA = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A }),
    )
    const ticketB = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:b", title: "B", directory: DIR_B }),
    )

    const scopedA = await succeed(renderTicketsTextDeep(ctx, {}, dirKeyFor(DIR_A)))
    expect(scopedA).toContain(ticketA.ticket.id)
    expect(scopedA).not.toContain(ticketB.ticket.id)

    const scopedB = await succeed(renderTicketsTextDeep(ctx, {}, dirKeyFor(DIR_B)))
    expect(scopedB).toContain(ticketB.ticket.id)
    expect(scopedB).not.toContain(ticketA.ticket.id)

    const all = await succeed(renderTicketsTextDeep(ctx, {}))
    expect(all).toContain(ticketA.ticket.id)
    expect(all).toContain(ticketB.ticket.id)
  })
})
