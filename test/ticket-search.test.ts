import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Exit, type Schema } from "effect"
import { createTicket, listTickets, renderTicketList, resetTickets } from "../src/ticket.js"
import { parseTicketList, shortTicketID } from "../src/ticket-view.js"
import {
  canonicalTicketID,
  MATCH_EXACT,
  MATCH_MIDDLE,
  MATCH_PREFIX,
  MATCH_SUFFIX,
  MATCH_TITLE,
  rankTicketMatch,
  resolveTicketQuery,
  searchPickerOptions,
  searchTickets,
  type SearchableTicket,
} from "../src/ticket-search.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

function ticket(id: string, title = ""): SearchableTicket {
  return { id, title }
}

/** The two ids from the bug report: the user reads `dc8d` / `vhid` off the sidebar. */
const DC8D = ticket("tk_mwbkve34_dc8d", "修复登录日志")
const VHID = ticket("tk_mwbktp0m_vhid", "重构工单选择器")
const OTHER = ticket("tk_mw7tqs9a_ximd", "侧栏面板")
const ROWS = [DC8D, VHID, OTHER]

// ── canonical form ────────────────────────────────────────────────────────────

describe("canonicalTicketID", () => {
  test("drops the tk prefix, separators and case", () => {
    expect(canonicalTicketID("tk_mwbkve34_dc8d")).toBe("mwbkve34dc8d")
    expect(canonicalTicketID("TK_MWBKVE34-DC8D")).toBe("mwbkve34dc8d")
    expect(canonicalTicketID("  Tk_Mwbkve34_Dc8d ")).toBe("mwbkve34dc8d")
    expect(canonicalTicketID("mwbkve34_dc8d")).toBe("mwbkve34dc8d")
    expect(canonicalTicketID("dc8d")).toBe("dc8d")
  })

  test("a bare tk carries no fragment", () => {
    expect(canonicalTicketID("tk")).toBe("")
    expect(canonicalTicketID("tk_")).toBe("")
  })
})

// ── ranking ───────────────────────────────────────────────────────────────────

describe("rankTicketMatch", () => {
  test("the 4-character short id users see in the sidebar is a suffix hit", () => {
    expect(rankTicketMatch(DC8D, "dc8d")).toBe(MATCH_SUFFIX)
    expect(rankTicketMatch(VHID, "vhid")).toBe(MATCH_SUFFIX)
  })

  test("case is irrelevant", () => {
    expect(rankTicketMatch(DC8D, "DC8D")).toBe(MATCH_SUFFIX)
    expect(rankTicketMatch(DC8D, "Dc8D")).toBe(MATCH_SUFFIX)
    expect(rankTicketMatch(DC8D, "TK_MWBKVE34_DC8D")).toBe(MATCH_EXACT)
  })

  test("full id matches with or without tk_ and separators", () => {
    expect(rankTicketMatch(DC8D, "tk_mwbkve34_dc8d")).toBe(MATCH_EXACT)
    expect(rankTicketMatch(DC8D, "mwbkve34_dc8d")).toBe(MATCH_EXACT)
    expect(rankTicketMatch(DC8D, "mwbkve34dc8d")).toBe(MATCH_EXACT)
  })

  test("a longer suffix and a middle fragment both match", () => {
    expect(rankTicketMatch(DC8D, "ve34_dc8d")).toBe(MATCH_SUFFIX)
    expect(rankTicketMatch(DC8D, "bkve34")).toBe(MATCH_MIDDLE)
    expect(rankTicketMatch(DC8D, "kve34")).toBe(MATCH_MIDDLE)
  })

  test("a prefix matches", () => {
    expect(rankTicketMatch(DC8D, "tk_mwbk")).toBe(MATCH_PREFIX)
    expect(rankTicketMatch(DC8D, "mwb")).toBe(MATCH_PREFIX)
  })

  test("the title still matches, ranked below every id hit", () => {
    expect(rankTicketMatch(DC8D, "登录")).toBe(MATCH_TITLE)
    expect(rankTicketMatch(DC8D, "日志")).toBe(MATCH_TITLE)
  })

  test("no hit and blank queries return undefined", () => {
    expect(rankTicketMatch(DC8D, "zzzz")).toBeUndefined()
    expect(rankTicketMatch(DC8D, "   ")).toBeUndefined()
  })
})

// ── filtering ─────────────────────────────────────────────────────────────────

describe("searchTickets", () => {
  test("locates a ticket by short id", () => {
    expect(searchTickets(ROWS, "dc8d").map((row) => row.id)).toEqual([DC8D.id])
    expect(searchTickets(ROWS, "vhid").map((row) => row.id)).toEqual([VHID.id])
  })

  test("locates a ticket by any middle fragment", () => {
    expect(searchTickets(ROWS, "bkve34").map((row) => row.id)).toEqual([DC8D.id])
    expect(searchTickets(ROWS, "mw7tqs").map((row) => row.id)).toEqual([OTHER.id])
  })

  test("an empty query returns every row in the caller's order", () => {
    expect(searchTickets(ROWS, "").map((row) => row.id)).toEqual(ROWS.map((row) => row.id))
    expect(searchTickets(ROWS, "  ").map((row) => row.id)).toEqual(ROWS.map((row) => row.id))
  })

  test("id hits come before title-only hits", () => {
    const titleHit = ticket("tk_zzzzzzzz_aaaa", "dc8d 相关讨论")
    const found = searchTickets([titleHit, DC8D], "dc8d")
    expect(found.map((row) => row.id)).toEqual([DC8D.id, titleHit.id])
  })

  test("no match returns an empty list", () => {
    expect(searchTickets(ROWS, "nope")).toEqual([])
  })
})

// ── ambiguity ────────────────────────────────────────────────────────────────

describe("resolveTicketQuery", () => {
  test("a unique short id resolves directly", () => {
    const resolution = resolveTicketQuery(ROWS, "dc8d")
    expect(resolution.kind).toBe("one")
    if (resolution.kind === "one") expect(resolution.ticket.id).toBe(DC8D.id)
  })

  test("a full id resolves directly", () => {
    const resolution = resolveTicketQuery(ROWS, "TK_MWBKTP0M_VHID")
    expect(resolution.kind).toBe("one")
    if (resolution.kind === "one") expect(resolution.ticket.id).toBe(VHID.id)
  })

  test("a shared suffix lists every candidate instead of picking one", () => {
    const twin = ticket("tk_aaaaaaaa_dc8d", "另一个 dc8d")
    const resolution = resolveTicketQuery([...ROWS, twin], "dc8d")
    expect(resolution.kind).toBe("many")
    if (resolution.kind === "many") {
      expect(resolution.tickets.map((row) => row.id)).toEqual([DC8D.id, twin.id])
    }
  })

  test("a title that also contains the query does not make a unique id hit ambiguous", () => {
    const titleHit = ticket("tk_zzzzzzzz_aaaa", "dc8d 相关讨论")
    const resolution = resolveTicketQuery([DC8D, titleHit], "dc8d")
    expect(resolution.kind).toBe("one")
    if (resolution.kind === "one") expect(resolution.ticket.id).toBe(DC8D.id)
  })

  test("title-only matches still resolve when no id matches", () => {
    const resolution = resolveTicketQuery(ROWS, "侧栏")
    expect(resolution.kind).toBe("one")
    if (resolution.kind === "one") expect(resolution.ticket.id).toBe(OTHER.id)
  })

  test("several title matches are candidates too", () => {
    const other = ticket("tk_bbbbbbbb_eeee", "侧栏第二轮")
    const resolution = resolveTicketQuery([...ROWS, other], "侧栏")
    expect(resolution.kind).toBe("many")
  })

  test("no hit and blank queries resolve to none", () => {
    expect(resolveTicketQuery(ROWS, "zzzz").kind).toBe("none")
    expect(resolveTicketQuery(ROWS, "").kind).toBe("none")
    expect(resolveTicketQuery([], "dc8d").kind).toBe("none")
  })
})

// ── mixed picker (tickets + workers) ─────────────────────────────────────────

describe("searchPickerOptions", () => {
  const PREFIX = "ticket:"
  const options = [
    { value: `${PREFIX}${DC8D.id}`, title: "dc8d · 修复登录日志", description: DC8D.id },
    { value: `${PREFIX}${VHID.id}`, title: "vhid · 重构工单选择器", description: VHID.id },
    { value: "ses_9f8e7d6c", title: "worker A", description: "running · T-1 · ses_9f8e" },
  ]

  test("a short id finds the ticket row and leaves workers out", () => {
    const found = searchPickerOptions("dc8d", options, ROWS, PREFIX)
    expect(found.map((option) => option.value)).toEqual([`${PREFIX}${DC8D.id}`])
  })

  test("workers stay searchable by label", () => {
    const found = searchPickerOptions("worker a", options, ROWS, PREFIX)
    expect(found.map((option) => option.value)).toEqual(["ses_9f8e7d6c"])
    const bySession = searchPickerOptions("9f8e7d", options, ROWS, PREFIX)
    expect(bySession.map((option) => option.value)).toEqual(["ses_9f8e7d6c"])
  })

  test("an empty query keeps the original order", () => {
    expect(searchPickerOptions("", options, ROWS, PREFIX)).toEqual(options)
  })

  test("no hit filters everything out", () => {
    expect(searchPickerOptions("zzzz", options, ROWS, PREFIX)).toEqual([])
  })
})

// ── end to end: real store → `renderTicketList` → parse → search ─────────────

describe("short id search over the real ticket list", () => {
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

  test("a stored ticket is findable by the 4-character short id the sidebar shows", async () => {
    resetTickets()
    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, { ...base, title: "修复登录日志", objective: "登录日志" }))
    const rows = parseTicketList(renderTicketList(listTickets({ limit: 100 })))
    expect(rows.map((row) => row.id)).toEqual([created.ticket.id])

    const shortID = shortTicketID(created.ticket.id)
    expect(shortTicketID(created.ticket.id)).toHaveLength(4)
    expect(searchTickets(rows, shortID).map((row) => row.id)).toEqual([created.ticket.id])
    expect(searchTickets(rows, shortID.toUpperCase()).map((row) => row.id)).toEqual([created.ticket.id])
    expect(searchTickets(rows, created.ticket.id).map((row) => row.id)).toEqual([created.ticket.id])

    const resolution = resolveTicketQuery(rows, shortID)
    expect(resolution.kind).toBe("one")
    if (resolution.kind === "one") expect(resolution.ticket.id).toBe(created.ticket.id)
  })

  test("a longer suffix of a stored id resolves too", async () => {
    resetTickets()
    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, { ...base, title: "修复登录日志", objective: "登录日志" }))
    const rows = parseTicketList(renderTicketList(listTickets({ limit: 100 })))
    const suffix = created.ticket.id.slice(-6)
    expect(suffix).not.toBe(shortTicketID(created.ticket.id))
    expect(searchTickets(rows, suffix).map((row) => row.id)).toEqual([created.ticket.id])
  })
})
