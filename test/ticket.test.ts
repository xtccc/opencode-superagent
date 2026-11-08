import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { displayWidth } from "../src/tools.js"
import {
  canTransition,
  closeTicket,
  closeTicketsForWorker,
  createTicket,
  dedupeKeyFor,
  findDuplicate,
  getTicket,
  hydrateTickets,
  isTerminalState,
  linkTicketToWorker,
  listTickets,
  renderTicketDetail,
  renderTicketList,
  resetTickets,
  tickets,
  transitionError,
  updateTicket,
  validateCreateInput,
  type TicketState,
} from "../src/ticket.js"

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

// `ticket.ts` owns a module-level store; every test starts from a clean one.
function fresh() {
  resetTickets()
  return memoryContext()
}

// ── state machine ─────────────────────────────────────────────────────────────

describe("ticket state machine", () => {
  test("allows the documented moves and nothing else", () => {
    const allowed: Record<TicketState, ReadonlyArray<TicketState>> = {
      open: ["in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
      in_progress: ["blocked", "done", "failed", "cancelled", "superseded"],
      blocked: ["in_progress", "done", "failed", "cancelled", "superseded"],
      done: [],
      failed: [],
      cancelled: [],
      superseded: [],
    }
    const states = Object.keys(allowed) as Array<TicketState>
    for (const from of states) {
      for (const to of states) {
        const expected = from === to || allowed[from].includes(to)
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({ from, to, allowed: expected })
        expect({ from, to, error: transitionError(from, to) === undefined }).toEqual({ from, to, error: expected })
      }
    }
    expect(isTerminalState("done")).toBe(true)
    expect(isTerminalState("superseded")).toBe(true)
    expect(isTerminalState("blocked")).toBe(false)
  })

  test("a terminal ticket names its own closure in the error", () => {
    expect(transitionError("done", "in_progress")).toContain("already closed")
    expect(transitionError("done", "in_progress")).toContain("already closed")
  })
})

// ── dedupe ────────────────────────────────────────────────────────────────────

describe("ticket dedupe", () => {
  test("the key ignores case and whitespace but not the thread", () => {
    const a = dedupeKeyFor({ source: "telegram", threadID: "t1", objective: "Fix   the LOGIN bug" })
    const b = dedupeKeyFor({ source: "telegram", threadID: "t1", objective: "fix the login bug" })
    const c = dedupeKeyFor({ source: "telegram", threadID: "t2", objective: "fix the login bug" })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatch(/^[0-9a-f]{40}$/)
  })

  test("creating the same objective twice in a thread reuses the open ticket", async () => {
    const ctx = fresh()
    const first = await succeed(createTicket(ctx, base))
    const second = await succeed(createTicket(ctx, { ...base, title: "另一个标题" }))
    expect(second.reused).toBe(true)
    expect(second.ticket.id).toBe(first.ticket.id)
    expect(tickets.size).toBe(1)
    expect(first.ticket.id).toMatch(/^tk_[0-9a-z]+_[0-9a-z]{4}$/)

    // A different thread is a different ticket.
    const other = await succeed(createTicket(ctx, { ...base, threadID: "telegram:43" }))
    expect(other.reused).toBe(false)
    expect(other.ticket.id).not.toBe(first.ticket.id)
  })

  test("a closed ticket no longer absorbs a new request", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "merged" }))
    const again = await succeed(createTicket(ctx, base))
    expect(again.reused).toBe(false)
    expect(again.ticket.id).not.toBe(created.ticket.id)
  })
})

// ── creation guards (the P0 correction) ──────────────────────────────────────

describe("ticket creation", () => {
  test("objective, acceptance and directory are mandatory", async () => {
    expect(validateCreateInput({ ...base, objective: "  " })).toContain("objective")
    expect(validateCreateInput({ ...base, acceptance: [] })).toContain("acceptance")
    expect(validateCreateInput({ ...base, acceptance: ["  ", ""] })).toContain("acceptance")
    expect(validateCreateInput({ ...base, directory: "relative/path" })).toContain("absolute path")
    expect(validateCreateInput(base)).toBeUndefined()

    const ctx = fresh()
    expect(await failure(createTicket(ctx, { ...base, acceptance: [] }))).toContain("acceptance")
    expect(tickets.size).toBe(0)
  })

  test("authorization records the trigger id and a quote", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    expect(created.ticket.authorization.triggerID).toBe("unknown")
    const explicit = await succeed(
      createTicket(ctx, {
        ...base,
        threadID: "telegram:99",
        authorization: { triggerID: "tg:99:1", quote: "帮我把登录日志补上", at: 1 },
      }),
    )
    expect(explicit.ticket.authorization.quote).toBe("帮我把登录日志补上")
  })
})

// ── transitions through the store ────────────────────────────────────────────

describe("ticket transitions", () => {
  test("a closed ticket is terminal; close records the outcome", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    const closed = await succeed(
      closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "日志已补，测试通过" }),
    )
    expect(closed.state).toBe("done")
    expect(closed.closeReason).toBe("日志已补，测试通过")
    expect(typeof closed.closedAt).toBe("number")
    expect(closed.history.at(-1)?.kind).toBe("closed")
    expect(getTicket(created.ticket.id)?.state).toBe("done")
    expect(await failure(updateTicket(ctx, { ticketID: created.ticket.id, state: "in_progress" }))).toContain(
      "already closed",
    )
  })

  test("a terminal ticket rejects any further move", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    await succeed(updateTicket(ctx, { ticketID: created.ticket.id, state: "superseded", note: "改单了" }))
    expect(await failure(updateTicket(ctx, { ticketID: created.ticket.id, state: "open" }))).toContain("already closed")
  })

  test("re-closing is idempotent for the same outcome and a conflict otherwise", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "failed", summary: "模型不可用" }))
    const again = await succeed(
      closeTicket(ctx, { ticketID: created.ticket.id, outcome: "failed", summary: "模型不可用" }),
    )
    expect(again.closeReason).toBe("模型不可用")
    expect(await failure(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "x" }))).toContain(
      "already closed",
    )
  })

  test("dispatch links the worker and moves open to in_progress", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    const linked = await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: "ses_worker_1" }))
    expect(linked.state).toBe("in_progress")
    expect(linked.workerSessionID).toBe("ses_worker_1")
    expect(linked.attempts).toHaveLength(1)
    expect(findDuplicate("telegram:42", created.ticket.dedupeKey)?.id).toBe(created.ticket.id)

    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "ok" }))
    expect(
      await failure(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: "ses_worker_2" })),
    ).toContain("only open/in_progress")
  })

  test("a worker ending closes only its in-progress ticket", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: "ses_worker_1" }))
    const closed = await succeed(
      closeTicketsForWorker(ctx, { sessionID: "ses_worker_1", outcome: "done", summary: "全部通过" }),
    )
    expect(closed?.state).toBe("done")
    expect(getTicket(created.ticket.id)?.state).toBe("done")
    // A different worker has nothing to close.
    expect(await succeed(closeTicketsForWorker(ctx, { sessionID: "ses_unknown", outcome: "failed" }))).toBeUndefined()
  })

  test("list filters by thread, state and limit", async () => {
    const ctx = fresh()
    const first = await succeed(createTicket(ctx, base))
    await succeed(createTicket(ctx, { ...base, threadID: "telegram:43", objective: "另一件事" }))
    expect(listTickets().length).toBe(2)
    expect(listTickets({ threadID: "telegram:42" }).map((ticket) => ticket.id)).toEqual([first.ticket.id])
    expect(listTickets({ status: "open" }).length).toBe(2)
    expect(listTickets({ limit: 1 }).length).toBe(1)
    expect(listTickets({ since: Date.now() + 60_000 })).toEqual([])
  })
})

// ── persistence ──────────────────────────────────────────────────────────────

describe("ticket persistence", () => {
  test("hydrate reloads records and rebuilds indexes", async () => {
    const ctx = fresh()
    const created = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "done" }))
    expect(ctx.data.get(`ticket:${created.ticket.id}`)).toBeDefined()

    resetTickets()
    expect(tickets.size).toBe(0)
    await succeed(hydrateTickets(ctx))
    expect(getTicket(created.ticket.id)?.state).toBe("done")
    expect(ctx.data.get("ticketidx:all")).toEqual([created.ticket.id])
    expect(ctx.data.get("ticketidx:status:done")).toEqual([created.ticket.id])
    expect(ctx.data.get("ticketidx:thread:telegram:42")).toEqual([created.ticket.id])
  })
})

// ── rendering ────────────────────────────────────────────────────────────────

describe("ticket rendering", () => {
  test("list and detail fit a narrow terminal", async () => {
    const ctx = fresh()
    const created = await succeed(
      createTicket(ctx, { ...base, objective: "把登录失败的用户 id 写进日志，并补充一条回归用例检查日志字段" }),
    )
    await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: "ses_worker_1" }))
    for (const view of [renderTicketList(listTickets()), renderTicketDetail(created.ticket)]) {
      for (const line of view.split("\n")) {
        expect(displayWidth(line)).toBeLessThanOrEqual(52)
      }
    }
    expect(renderTicketList([])).toContain("暂无工单")
  })
})
