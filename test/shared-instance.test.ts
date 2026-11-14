/**
 * Cross-instance state sharing (the per-location plugin-load bug).
 *
 * The host loads one plugin instance per location inside a single `server` run
 * (22 loads were observed on the gateway). Every load re-evaluates this
 * package's modules, so a module-level `Map` gave each instance its own ticket
 * mirror: a ticket created by one instance's Router was invisible to another
 * instance's `ticket_list`, and the watcher instance could not find the ticket
 * to close, leaving it `in_progress` after the worker finished.
 *
 * `src/shared.ts` puts every mutable singleton on `globalThis`. The tests below
 * load a **second module instance** of `ticket.ts` / `dirs.ts` / `settings.ts`
 * (Bun keeps `?instance=2` as a distinct ESM module instance in the same
 * process) and assert the two instances see one shared state.
 *
 * Confidence: this reproduces the production mechanism exactly at the module
 * level (two independent evaluations of the module, one `globalThis`). It does
 * not spawn two OS processes — impossible to share memory that way anyway — and
 * it does not re-load the real host plugin, which the E2E covers separately.
 */
import type { Plugin } from "@opencode/plugin/effect"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import * as A from "../src/ticket.js"
import { aliasDirs, DEFAULT_DIR_KEY, registerAlias, threadDirs } from "../src/dirs.js"
import { handleEnded } from "../src/watcher.js"
import { dirKeyFor, rememberRouter, store } from "../src/state.js"
import { applySettings, perDirectoryRouterEnabled, resetSettings } from "../src/settings.js"
import { hasSharedSingleton, sharedKey } from "../src/shared.js"

/**
 * A second evaluation of the same modules, keyed by a query string. The
 * specifier is computed at runtime on purpose: `tsc` only type-checks a
 * non-literal dynamic import as `any`, whereas a literal `…ticket.ts?instance=2`
 * would be reported as an unresolvable module.
 */
const instanceSpecifier = (file: string, tag: string): string => ["..", "src", file].join("/") + `?${tag}`

const B = (await import(instanceSpecifier("ticket.ts", "instance=2"))) as typeof import("../src/ticket.js")
const dirsB = (await import(instanceSpecifier("dirs.ts", "instance=2"))) as typeof import("../src/dirs.js")
const settingsB = (await import(instanceSpecifier("settings.ts", "instance=2"))) as typeof import("../src/settings.js")

const THREAD = "telegram:shared"
const WORKER = "ses_shared_worker"
const ROUTER = "ses_shared_router"
const DIR = "/opt/alpha"

const base = {
  threadID: THREAD,
  title: "跨实例可见",
  objective: "实例 A 建的工单实例 B 也看得到",
  acceptance: ["B 能 list 到", "B 关闭后 A 读到 done"],
  directory: DIR,
  source: "telegram",
} as const

/** KV + session stand-in with the same paging contract the ticket layer uses. */
function memoryContext() {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
  const synthetic: Array<{ sessionID: string; text: string }> = []
  let failSet: (key: string) => boolean = () => false
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) =>
      Effect.sync(() => {
        if (failSet(key)) throw new Error(`kv set failed: ${key}`)
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
  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      const info = infos.get(sessionID)
      return info === undefined
        ? Effect.fail(new Error(`missing session ${sessionID}`))
        : Effect.succeed({ id: sessionID, time: {}, ...info })
    },
    context: () => Effect.succeed([] as ReadonlyArray<unknown>),
    synthetic: (input: { sessionID: string; text: string }) => {
      synthetic.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined)
    },
  }
  const ctx = { options: {}, storage, session } as unknown as Plugin.Context
  return {
    ctx,
    data,
    infos,
    synthetic,
    failSet: (predicate: (key: string) => boolean) => {
      failSet = predicate
    },
    heal: () => {
      failSet = () => false
    },
  }
}

async function succeed<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

beforeEach(() => {
  A.resetTickets()
  store.workers.clear()
  store.routerID = undefined
  resetSettings()
})

afterAll(() => {
  resetSettings()
})

// ── 1. the two module instances share the same objects ───────────────────────

describe("module-level singletons are process-wide", () => {
  test("ticket tables, dir maps and settings resolve to one shared object", () => {
    // The query-string import really is a second module evaluation: its
    // functions are different objects. Without this the rest would be vacuous.
    expect(B.createTicket).not.toBe(A.createTicket)
    expect(settingsB.applySettings).not.toBe(applySettings)
    expect(dirsB.registerAlias).not.toBe(registerAlias)

    // Same Map object, not a copy: this is the whole fix in one assertion.
    expect(B.tickets).toBe(A.tickets)
    expect((globalThis as Record<symbol, unknown>)[sharedKey("ticket.records")]).toBe(A.tickets)
    expect((globalThis as Record<symbol, unknown>)[sharedKey("ticket.kv-totals")]).toBeDefined()
    expect((globalThis as Record<symbol, unknown>)[sharedKey("ticket.threads")]).toBeDefined()
    expect((globalThis as Record<symbol, unknown>)[sharedKey("ticket.dirty-records")]).toBeDefined()
    expect(hasSharedSingleton("ticket.hydrate-gate")).toBe(true)

    // Directory memory is the same story (thread binding + alias + reverse index).
    expect(dirsB.threadDirs).toBe(threadDirs)
    expect(dirsB.aliasDirs).toBe(aliasDirs)
    expect((globalThis as Record<symbol, unknown>)[sharedKey("dirs.dir-key-directories")]).toBeDefined()

    // Settings are read by the partition rule on every layer; they must agree.
    settingsB.applySettings({ perDirectoryRouter: true })
    expect(perDirectoryRouterEnabled()).toBe(true)
  })
})

// ── 2. a ticket created by A is visible to B ─────────────────────────────────

describe("cross-instance ticket visibility", () => {
  test("A creates, B lists and gets it; counters and KV agree", async () => {
    const h = memoryContext()
    const created = await succeed(A.createTicket(h.ctx, base))
    const id = created.ticket.id

    expect(B.getTicket(id)?.id).toBe(id)
    expect(B.getTicket(id)).toBe(A.getTicket(id))
    expect(B.listTickets({}).map((ticket) => ticket.id)).toEqual([id])
    expect(B.findDuplicate(base.threadID, created.ticket.dedupeKey)?.id).toBe(id)
    expect(B.ticketStats().total).toBe(A.ticketStats().total)
    expect(B.ticketStats().inProgress + B.ticketStats().open).toBe(1)
    expect(B.kvTicketCount()).toBe(1)
    expect(A.kvTicketCount()).toBe(1)
    expect(B.dirtyTicketIDs()).toEqual([])

    // A dedupe through B must return the same ticket: presence is shared, so
    // the Router cannot create a second work order for the same objective.
    const again = await succeed(B.createTicket(h.ctx, base))
    expect(again.reused).toBe(true)
    expect(again.ticket.id).toBe(id)
    expect([...h.data.keys()].filter((key) => key.endsWith(id))).toHaveLength(1)
  })

  test("B closes what A created; A immediately reads the terminal state", async () => {
    const h = memoryContext()
    const created = await succeed(A.createTicket(h.ctx, base))
    const id = created.ticket.id

    const closed = await succeed(B.closeTicket(h.ctx, { ticketID: id, outcome: "done", summary: "B 结单" }))
    expect(closed.state).toBe("done")

    // A's view moved without any reload.
    expect(A.getTicket(id)?.state).toBe("done")
    expect(A.getTicket(id)?.closeReason).toBe("B 结单")
    expect(A.listTickets({ status: "done" }).map((ticket) => ticket.id)).toEqual([id])
    expect(A.ticketStats().closed).toBe(1)
    expect(A.dirtyTicketIDs()).toEqual(B.dirtyTicketIDs())
    expect(A.kvTicketCount()).toBe(B.kvTicketCount())

    // Idempotent: re-closing from either instance does not append a second
    // `closed` history entry or rewrite the reason.
    const again = await succeed(A.closeTicket(h.ctx, { ticketID: id, outcome: "done", summary: "重复结单" }))
    expect(again.history.filter((entry) => entry.kind === "closed")).toHaveLength(1)
    expect(again.closeReason).toBe("B 结单")
    expect(B.getTicket(id)?.state).toBe("done")
  })
})

// ── 3. hydrate is single-flight across instances ─────────────────────────────

describe("hydration across instances", () => {
  test("repeat and concurrent hydrates never duplicate or drop a record", async () => {
    const h = memoryContext()
    const created = await succeed(A.createTicket(h.ctx, base))
    const id = created.ticket.id

    // Simulate a fresh process: memory gone, KV keeps the record.
    A.resetTickets()
    expect(A.getTicket(id)).toBeUndefined()

    await Promise.all([succeed(A.hydrateTickets(h.ctx)), succeed(B.hydrateTickets(h.ctx))])
    expect(B.tickets.size).toBe(1)
    expect(A.kvTicketCount()).toBe(1)
    expect(B.getTicket(id)?.id).toBe(id)
    expect(h.data.get("ticketidx:all")).toEqual([id] as unknown as Schema.Json)

    // Another instance hydrating later is a no-op, not a second rebuild.
    await succeed(B.hydrateTickets(h.ctx))
    await succeed(A.hydrateTickets(h.ctx))
    expect(A.tickets.size).toBe(1)
    expect(B.kvTicketCount()).toBe(1)
    expect(h.data.get("ticketidx:all")).toEqual([id] as unknown as Schema.Json)
  })

  test("a later instance's hydrate does not clear a ticket that only exists in memory", async () => {
    const h = memoryContext()
    // The process already hydrated (every instance does so at setup).
    await succeed(A.hydrateTickets(h.ctx))
    h.failSet((key) => key.startsWith("ticket:"))

    const created = await succeed(A.createTicket(h.ctx, base))
    const id = created.ticket.id
    expect(h.data.has(A.ticketKey(id))).toBe(false)
    expect(A.dirtyTicketIDs()).toEqual([id])

    // A second instance hydrating must not reset the shared tables: the record
    // exists only in memory, so a rebuild would lose it for good.
    await succeed(B.hydrateTickets(h.ctx))
    expect(B.getTicket(id)?.id).toBe(id)
    expect(B.dirtyTicketIDs()).toEqual([id])

    // The write-behind queue is shared too: B retries what A queued.
    h.heal()
    await succeed(B.flushTicketWrites(h.ctx))
    expect(B.dirtyTicketIDs()).toEqual([])
    expect(h.data.has(A.ticketKey(id))).toBe(true)
  })

  test("an instance that never hydrated falls back to KV instead of claiming 暂无工单", async () => {
    const h = memoryContext()
    const created = await succeed(A.createTicket(h.ctx, base))
    const id = created.ticket.id
    // Fresh process: nothing in memory, the record is only in KV.
    A.resetTickets()

    // The empty in-memory mirror must not be mistaken for a complete one: the
    // KV total is unknown before hydration, so the list has to consult KV.
    const listed = await succeed(B.listTicketRecords(h.ctx, { limit: 10 }))
    expect(listed.map((ticket) => ticket.id)).toEqual([id])
  })
})

// ── 4. a worker finishing closes its ticket, whichever instance sees it ──────

describe("worker terminal state closes the ticket across instances", () => {
  test("ticket created by B is closed by A's watcher exactly once", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = memoryContext()
    const dirKey = dirKeyFor(DIR)
    rememberRouter(dirKey, ROUTER)
    h.infos.set(ROUTER, { outcome: "succeeded" })

    // Instance B's Router created the work order and dispatched the worker.
    const created = await succeed(B.createTicket(h.ctx, { ...base, dirKey }))
    const id = created.ticket.id
    await succeed(B.linkTicketToWorker(h.ctx, { ticketID: id, sessionID: WORKER, dirKey }))
    expect(B.getTicket(id)?.state).toBe("in_progress")
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
      ownerDirKey: dirKey,
    })

    // Instance A's watcher receives the completion event.
    expect(A.activeTicketForWorker(WORKER)?.id).toBe(id)
    await succeed(handleEnded(h.ctx, WORKER, "done"))

    expect(A.getTicket(id)?.state).toBe("done")
    expect(B.getTicket(id)?.state).toBe("done")
    expect(A.ticketStats(dirKey).inProgress).toBe(0)
    expect(A.ticketStats(dirKey).closed).toBe(1)
    expect(B.ticketStats(dirKey).closed).toBe(1)
    expect(store.workers.get(WORKER)?.state).toBe("done")

    // A duplicate delivery must not close it a second time.
    await succeed(handleEnded(h.ctx, WORKER, "done"))
    expect(B.getTicket(id)?.history.filter((entry) => entry.kind === "closed")).toHaveLength(1)
    expect(B.getTicket(id)?.closeReason?.length).toBeGreaterThan(0)
  })

  test("a worker record claiming another partition still closes its ticket", async () => {
    applySettings({ perDirectoryRouter: true })
    const h = memoryContext()
    const dirKey = dirKeyFor("/opt/beta")
    // The worker record is (mis)attributed to the default partition (legacy
    // shape: no ownerDirKey, no directory); the ticket belongs to `dirKey`.
    rememberRouter(DEFAULT_DIR_KEY, ROUTER)
    h.infos.set(ROUTER, { outcome: "succeeded" })

    const created = await succeed(A.createTicket(h.ctx, { ...base, dirKey }))
    const id = created.ticket.id
    await succeed(A.linkTicketToWorker(h.ctx, { ticketID: id, sessionID: WORKER, dirKey }))
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
    })

    // The scoped lookup misses; the ticket names the worker, so it is found.
    expect(A.activeTicketForWorker(WORKER)?.id).toBe(id)
    await succeed(handleEnded(h.ctx, WORKER, "done"))
    expect(A.getTicket(id)?.state).toBe("done")
    expect(A.ticketStats(dirKey).closed).toBe(1)
  })
})
