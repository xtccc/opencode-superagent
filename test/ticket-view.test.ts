import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import {
  createTicket,
  listTickets,
  renderTicketList,
  resetTickets,
  TICKET_STATES as STORE_STATES,
  updateTicket,
} from "../src/ticket.js"
import {
  parseTicketList,
  shortTicketID,
  TICKET_PANEL_WIDTH,
  TICKET_STATE_SYMBOL,
  TICKET_STATES,
  TICKET_TITLE_MAX,
  ticketPanel,
  truncateCells,
} from "../src/ticket-view.js"
import { displayWidth } from "../src/tools.js"

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
  return { storage } as unknown as Plugin.Context
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

const base = {
  threadID: "telegram:42",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id"],
  directory: "/opt/ai-gw",
  source: "telegram",
  author: "alice",
} as const

/** The text `/tickets` and the sidebar both read, produced by the real server formatter. */
async function listText(create: ReadonlyArray<{ title: string; state?: "in_progress" | "blocked" | "done" }>) {
  resetTickets()
  const ctx = memoryContext()
  const created: Array<string> = []
  for (const item of create) {
    const result = await succeed(createTicket(ctx, { ...base, title: item.title, objective: item.title }))
    created.push(result.ticket.id)
    if (item.state !== undefined) {
      await succeed(updateTicket(ctx, { ticketID: result.ticket.id, state: item.state }))
    }
  }
  return { text: renderTicketList(listTickets({ limit: 20 })), ids: created }
}

// ── row width ────────────────────────────────────────────────────────────────

/** Exactly what the sidebar renders per row, so the width assertion covers the real layout. */
function rowText(item: ReturnType<typeof ticketPanel>["items"][number]) {
  return `${TICKET_STATE_SYMBOL[item.state]} ${item.title} ${item.shortID}`
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("ticket sidebar view model", () => {
  test("the local state list matches the store's", () => {
    expect([...TICKET_STATES]).toEqual([...STORE_STATES])
    for (const state of STORE_STATES) expect(TICKET_STATE_SYMBOL[state]).toBeTruthy()
  })

  test("parses the real /tickets text back into rows", async () => {
    const { text, ids } = await listText([
      { title: "修复登录日志" },
      { title: "补齐侧栏工单面板", state: "in_progress" },
      { title: "清理过期 worker", state: "done" },
    ])
    const rows = parseTicketList(text)
    expect(rows.map((row) => row.id).sort()).toEqual([...ids].sort())
    expect(rows.map((row) => row.state).sort()).toEqual(["done", "in_progress", "open"])
    expect(rows.map((row) => row.priority)).toEqual(["p1", "p1", "p1"])
    expect(rows.some((row) => row.title === "修复登录日志")).toBe(true)
  })

  test("an empty list and unrecognised text produce no rows", async () => {
    const { text } = await listText([])
    expect(parseTicketList(text)).toEqual([])
    expect(parseTicketList("")).toEqual([])
    expect(parseTicketList("工单 ????")).toEqual([])
  })

  test("a dispatched ticket carries the tail of its latest worker session", async () => {
    resetTickets()
    const ctx = memoryContext()
    const dispatched = await succeed(createTicket(ctx, { ...base, title: "跑过 worker 的单", objective: "跑过 worker 的单" }))
    const queued = await succeed(createTicket(ctx, { ...base, title: "还没派的单", objective: "还没派的单" }))
    await succeed(
      updateTicket(ctx, {
        ticketID: dispatched.ticket.id,
        state: "in_progress",
        workerSessionID: "ses_aaa111bbb222",
      }),
    )
    // A second dispatch overwrites the field: the row names the newest worker.
    await succeed(
      updateTicket(ctx, {
        ticketID: dispatched.ticket.id,
        state: "blocked",
        workerSessionID: "ses_ccc333ddd444",
      }),
    )
    const rows = parseTicketList(renderTicketList(listTickets({ limit: 20 })))
    const row = rows.find((item) => item.id === dispatched.ticket.id)
    expect(row?.workerSuffix).toBe("ddd444")
    expect(rows.find((item) => item.id === queued.ticket.id)?.workerSuffix).toBeUndefined()
  })

  test("a wrapped title is stitched back onto one row", async () => {
    const long = "把侧栏工单面板做完并把每一项验收都写清楚再交给下游做回归测试"
    const { text } = await listText([{ title: long }])
    const rows = parseTicketList(text)
    expect(rows).toHaveLength(1)
    // Joining wrapped lines drops the wrap point, but the text is re-truncated for display.
    expect(rows[0]!.title.startsWith("把侧栏工单面板做完")).toBe(true)
    expect(rows[0]!.title.length).toBeGreaterThan(0)
  })

  test("running and blocked work comes before queued work, terminal work last", async () => {
    const { text } = await listText([
      { title: "排队中的单" },
      { title: "已经跑完的单", state: "done" },
      { title: "卡住的单", state: "blocked" },
      { title: "正在跑的单", state: "in_progress" },
    ])
    const panel = ticketPanel(parseTicketList(text))
    expect(panel.items.map((item) => item.state)).toEqual(["in_progress", "blocked", "open", "done"])
    expect(panel.total).toBe(4)
    expect(panel.active).toBe(3)
    expect(panel.hidden).toBe(0)
  })

  test("terminal tickets collapse to the newest three", async () => {
    const { text } = await listText([
      { title: "还在跑", state: "in_progress" },
      { title: "完成一", state: "done" },
      { title: "完成二", state: "done" },
      { title: "完成三", state: "done" },
      { title: "完成四", state: "done" },
    ])
    const rows = parseTicketList(text)
    const panel = ticketPanel(rows)
    expect(panel.total).toBe(5)
    expect(panel.active).toBe(1)
    expect(panel.hidden).toBe(1)
    expect(panel.items).toHaveLength(4)
  })

  test("every row fits the 36-cell sidebar, titles included", async () => {
    const { text } = await listText([
      { title: "一个特别长的标题，中文英文混排 mixed English words 也要能塞进侧栏而不换行不溢出" },
      { title: "short", state: "in_progress" },
    ])
    const panel = ticketPanel(parseTicketList(text))
    for (const item of panel.items) {
      expect(displayWidth(item.title)).toBeLessThanOrEqual(TICKET_TITLE_MAX)
      expect(displayWidth(rowText(item))).toBeLessThanOrEqual(TICKET_PANEL_WIDTH)
      expect(displayWidth(item.shortID)).toBe(4)
      expect(item.shortID).toBe(shortTicketID(item.id))
    }
  })

  test("a narrow panel shrinks the title budget with the row", () => {
    const rows = [
      { id: "tk_mw7tqs9a_ximd", title: "一个特别长的标题需要被截断", state: "open" as const, priority: "p1" as const },
    ]
    const panel = ticketPanel(rows, 24)
    for (const item of panel.items) expect(displayWidth(rowText(item))).toBeLessThanOrEqual(24)
    expect(ticketPanel(rows, 8).items[0]!.title).toBe("…")
  })

  test("truncation counts a CJK character as two cells and keeps the ellipsis inside the budget", () => {
    expect(truncateCells("abc", 3)).toBe("abc")
    expect(truncateCells("abcdef", 3)).toBe("ab…")
    expect(displayWidth(truncateCells("中文标题", 4))).toBe(3)
    expect(truncateCells("中文标题", 4)).toBe("中…")
    expect(truncateCells("anything", 0)).toBe("")
  })
})
