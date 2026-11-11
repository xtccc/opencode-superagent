import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { clipCodePoints, codePointLength, formatTrigger } from "../src/format.js"
import { buildReport, REPORT_SUMMARY_LIMIT, REPORT_TEXT_LIMIT, reportSummary } from "../src/report.js"
import { store } from "../src/state.js"
import {
  blockTicketsForWorker,
  createTicket,
  decodeTicket,
  dirtyTicketIDs,
  dirtyTicketIndexKeys,
  flushTicketWrites,
  getTicket,
  hydrateTickets,
  INTERRUPTED_REASON,
  kvTicketCount,
  linkTicketToWorker,
  listTicketRecords,
  loadTicket,
  noteRouterTrigger,
  QUOTE_MAX,
  requireDispatchTicket,
  resetTickets,
  TITLE_MAX,
  tickets,
  ticketKey,
  updateTicket,
} from "../src/ticket.js"
import { renderTicketTextDeep } from "../src/ticket-tools.js"
import { handleEnded } from "../src/watcher.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const THREAD = "telegram:42"
const WORKER = "ses_worker_1"
const ROUTER = "ses_router"

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id", "现有测试全绿"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

/**
 * KV stand-in with the same paging contract as `Plugin.Context["storage"]`,
 * plus a switch that makes `set` fail (throw) for matching keys so the
 * write-failure paths are testable.
 */
function memoryContext() {
  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, Record<string, unknown>>()
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
        : Effect.succeed({ id: sessionID, ...info })
    },
    context: () => Effect.succeed([] as ReadonlyArray<unknown>),
    synthetic: () => Effect.succeed(undefined),
  }
  const ctx = { options: {}, storage, session } as unknown as Plugin.Context
  return {
    ctx,
    data,
    infos,
    failSet: (predicate: (key: string) => boolean) => {
      failSet = predicate
    },
    heal: () => {
      failSet = () => false
    },
  }
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

/** A lone high or low surrogate is what a naive UTF-16 slice leaves behind. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

beforeEach(() => {
  resetTickets()
  store.workers.clear()
  store.routerID = undefined
})

// ── 1. interruption parks the ticket instead of freezing it ──────────────────

describe("an interrupted worker parks its ticket", () => {
  async function interrupted() {
    const h = memoryContext()
    store.routerID = ROUTER
    h.infos.set(ROUTER, {})
    const created = await succeed(createTicket(h.ctx, base))
    const ticketID = created.ticket.id
    await succeed(linkTicketToWorker(h.ctx, { ticketID, sessionID: WORKER }))
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
    })
    await succeed(handleEnded(h.ctx, WORKER, "idle", "context canceled"))
    return { ...h, ticketID }
  }

  test("in_progress becomes blocked with the interruption recorded", async () => {
    const h = await interrupted()
    const ticket = getTicket(h.ticketID)
    expect(ticket?.state).toBe("blocked")
    expect(ticket?.closedAt).toBeUndefined()
    const last = ticket?.history.at(-1)
    expect(last?.kind).toBe("state")
    expect(last?.from).toBe("in_progress")
    expect(last?.to).toBe("blocked")
    expect(last?.note).toBe(`${INTERRUPTED_REASON}: context canceled`)
    // The worker stays resumable; the ticket keeps the trace of who ran it.
    expect(store.workers.get(WORKER)?.state).toBe("idle")
    expect(ticket?.workerSessionID).toBe(WORKER)
  })

  test("the parked state reaches KV and can be reopened and re-dispatched", async () => {
    const h = await interrupted()
    expect(decodeTicket(h.data.get(ticketKey(h.ticketID)))?.state).toBe("blocked")

    // Not dispatchable while blocked, but the hint is a real path forward.
    const blocked = await failure(requireDispatchTicket(h.ticketID, THREAD))
    expect(blocked).toContain("is blocked")
    expect(blocked).toContain("ticket_update")

    await succeed(updateTicket(h.ctx, { ticketID: h.ticketID, state: "in_progress" }))
    // The interrupted worker is still `idle` in the registry; it must not gate
    // the re-dispatch any more, because the ticket was parked after it ran.
    const gated = await succeed(requireDispatchTicket(h.ticketID, THREAD))
    expect(gated.id).toBe(h.ticketID)
    expect(gated.state).toBe("in_progress")
  })

  test("blockTicketsForWorker is a no-op for a ticket that is not in progress", async () => {
    const h = memoryContext()
    const created = await succeed(createTicket(h.ctx, base))
    // Nothing dispatched: no in-progress ticket for that worker.
    expect(await succeed(blockTicketsForWorker(h.ctx, { sessionID: WORKER, reason: "x" }))).toBeUndefined()
    expect(getTicket(created.ticket.id)?.state).toBe("open")
  })

  test("a finished worker still closes the ticket as done", async () => {
    const h = memoryContext()
    store.routerID = ROUTER
    h.infos.set(ROUTER, {})
    const created = await succeed(createTicket(h.ctx, base))
    await succeed(linkTicketToWorker(h.ctx, { ticketID: created.ticket.id, sessionID: WORKER }))
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
    })
    await succeed(handleEnded(h.ctx, WORKER, "done"))
    expect(getTicket(created.ticket.id)?.state).toBe("done")
  })
})

// ── 2. a query consults KV when memory was trimmed ───────────────────────────

describe("ticket queries fall back to KV", () => {
  async function hydrated() {
    const h = memoryContext()
    const first = await succeed(createTicket(h.ctx, { ...base, objective: "第一个工单" }))
    const second = await succeed(createTicket(h.ctx, { ...base, objective: "第二个工单" }))
    await succeed(hydrateTickets(h.ctx))
    return { ...h, first: first.ticket.id, second: second.ticket.id }
  }

  test("hydrate counts every record in KV, not just what memory keeps", async () => {
    const h = await hydrated()
    expect(kvTicketCount()).toBe(2)
    expect(tickets.size).toBe(2)
  })

  test("a trimmed record is still found by id, by list and by the TUI render", async () => {
    const h = await hydrated()
    // Emulate the trim: the record leaves memory, KV still holds it.
    tickets.delete(h.first)
    expect(getTicket(h.first)).toBeUndefined()

    const loaded = await succeed(loadTicket(h.ctx, h.first))
    expect(loaded?.id).toBe(h.first)
    expect(getTicket(h.first)?.id).toBe(h.first)

    tickets.delete(h.first)
    const listed = (await succeed(listTicketRecords(h.ctx, { limit: 10 }))).map((ticket) => ticket.id)
    expect(listed).toContain(h.first)
    expect(listed).toContain(h.second)

    tickets.delete(h.first)
    const text = await succeed(renderTicketTextDeep(h.ctx, h.first))
    expect(text).not.toContain("没有找到工单")
    expect(text).toContain(h.first)
  })

  test("a record that is in neither memory nor KV is still reported missing", async () => {
    const h = await hydrated()
    expect(await succeed(loadTicket(h.ctx, "tk_absent"))).toBeUndefined()
    expect(await succeed(renderTicketTextDeep(h.ctx, "tk_absent"))).toContain("没有找到工单")
  })

  test("a complete memory answers the page without touching KV", async () => {
    const h = await hydrated()
    const listed = await succeed(listTicketRecords(h.ctx, { limit: 10 }))
    expect(listed.length).toBe(kvTicketCount())
  })
})

// ── 3. a failed KV write is queued, not swallowed ────────────────────────────

describe("failed ticket writes are queued and retried", () => {
  test("a failed record write keeps memory and lands after the retry", async () => {
    const h = memoryContext()
    h.failSet((key) => key.startsWith("ticket:"))
    const created = await succeed(createTicket(h.ctx, base))
    expect(dirtyTicketIDs()).toEqual([created.ticket.id])
    // Memory already moved on: dropping the write would resurrect `open`.
    expect(getTicket(created.ticket.id)?.state).toBe("open")
    expect(h.data.has(ticketKey(created.ticket.id))).toBe(false)

    h.heal()
    await succeed(flushTicketWrites(h.ctx))
    expect(dirtyTicketIDs()).toEqual([])
    expect(decodeTicket(h.data.get(ticketKey(created.ticket.id)))?.state).toBe("open")
  })

  test("the next mutation retries the queued write with the newest state", async () => {
    const h = memoryContext()
    let failures = 1
    h.failSet((key) => key.startsWith("ticket:") && failures-- > 0)
    const created = await succeed(createTicket(h.ctx, base))
    expect(dirtyTicketIDs()).toEqual([created.ticket.id])

    await succeed(updateTicket(h.ctx, { ticketID: created.ticket.id, state: "in_progress" }))
    expect(dirtyTicketIDs()).toEqual([])
    expect(decodeTicket(h.data.get(ticketKey(created.ticket.id)))?.state).toBe("in_progress")
  })

  test("a failed index write is queued and retried separately", async () => {
    const h = memoryContext()
    h.failSet((key) => key.startsWith("ticketidx:status:"))
    const created = await succeed(createTicket(h.ctx, base))
    expect(dirtyTicketIndexKeys()).toContain("ticketidx:status:open")
    // The record itself was written, so the ticket is not lost.
    expect(decodeTicket(h.data.get(ticketKey(created.ticket.id)))?.id).toBe(created.ticket.id)

    h.heal()
    await succeed(flushTicketWrites(h.ctx))
    expect(dirtyTicketIndexKeys()).toEqual([])
    expect(h.data.get("ticketidx:status:open")).toEqual([created.ticket.id] as unknown as Schema.Json)
  })

  test("a flush with nothing queued writes nothing", async () => {
    const h = memoryContext()
    await succeed(createTicket(h.ctx, base))
    const before = h.data.size
    await succeed(flushTicketWrites(h.ctx))
    expect(h.data.size).toBe(before)
  })

  test("listing retries a queued write even when nothing else happens", async () => {
    const h = memoryContext()
    h.failSet((key) => key.startsWith("ticket:"))
    const created = await succeed(createTicket(h.ctx, base))
    expect(dirtyTicketIDs()).toEqual([created.ticket.id])

    h.heal()
    const listed = await succeed(listTicketRecords(h.ctx, { limit: 10 }))
    expect(listed.map((ticket) => ticket.id)).toContain(created.ticket.id)
    expect(dirtyTicketIDs()).toEqual([])
    expect(decodeTicket(h.data.get(ticketKey(created.ticket.id)))?.id).toBe(created.ticket.id)
  })
})

// ── 4. truncation never splits a surrogate pair ─────────────────────────────

describe("truncation is code-point safe", () => {
  test("clipCodePoints keeps surrogate pairs together", () => {
    expect(codePointLength("🎉")).toBe(1)
    expect(codePointLength("a🎉b")).toBe(3)
    expect(clipCodePoints("a🎉b", 1)).toBe("a")
    expect(clipCodePoints("a🎉b", 2)).toBe("a🎉")
    expect(clipCodePoints("🎉🎉🎉", 2)).toBe("🎉🎉")
    expect(clipCodePoints("short", 100)).toBe("short")
    expect(clipCodePoints("🎉", 0)).toBe("")
    expect(hasLoneSurrogate(clipCodePoints("🎉🎉", 1))).toBe(false)
  })

  test("a stored report is clipped at a code point and marked", () => {
    // 200k UTF-16 units of emoji: the cut lands exactly between two pairs.
    const text = "🎉".repeat(REPORT_TEXT_LIMIT / 2 + 5)
    const record = buildReport("ses_a", text)
    expect(record.truncated).toBe(true)
    expect(hasLoneSurrogate(record.text)).toBe(false)
    expect(record.text.length).toBeLessThanOrEqual(REPORT_TEXT_LIMIT)
    expect(record.text.endsWith("🎉")).toBe(true)
    expect(record.clippedAt).toBe(record.text.length)
    expect(record.length).toBe(text.length)
  })

  test("the worker summary is clipped at a code point", () => {
    const record = buildReport("ses_a", "🎉".repeat(REPORT_SUMMARY_LIMIT))
    const summary = reportSummary(record)
    expect(summary.endsWith("…")).toBe(true)
    expect(hasLoneSurrogate(summary)).toBe(false)
    expect(summary.length).toBe(REPORT_SUMMARY_LIMIT + 1)
  })

  test("a ticket title counts and clips by code points", async () => {
    const h = memoryContext()
    const emojiTitle = "🎉".repeat(TITLE_MAX)
    // 80 emoji are 80 characters, not the 160 UTF-16 units a naive count sees.
    const created = await succeed(createTicket(h.ctx, { ...base, title: emojiTitle }))
    expect(created.ticket.title).toBe(emojiTitle)
    expect(hasLoneSurrogate(created.ticket.title)).toBe(false)

    // Over the limit is still refused, now measured in characters.
    const rejected = await failure(createTicket(h.ctx, { ...base, objective: "超长标题", title: "🎉".repeat(90) }))
    expect(rejected).toContain(`at most ${TITLE_MAX} characters`)

    // A long quote is clipped (not rejected) and never splits a pair.
    noteRouterTrigger({
      source: "telegram",
      threadID: THREAD,
      text: "🎉".repeat(QUOTE_MAX + 40),
    })
    const quoted = await succeed(createTicket(h.ctx, { ...base, objective: "带引用" }))
    const quote = quoted.ticket.authorization.quote
    expect(quote.endsWith("…")).toBe(true)
    expect(hasLoneSurrogate(quote)).toBe(false)
    expect(codePointLength(quote)).toBeLessThanOrEqual(QUOTE_MAX)
  })

  test("the trigger body is clipped at a code point", () => {
    const text = "🎉".repeat(900)
    const formatted = formatTrigger({ source: "telegram", threadID: THREAD, text } as never)
    const body = formatted.split("\n")[1] ?? ""
    expect(body).toContain("chars truncated")
    expect(hasLoneSurrogate(body)).toBe(false)
    const kept = body.slice(0, body.indexOf("...("))
    expect(kept.endsWith("🎉")).toBe(true)
  })
})
