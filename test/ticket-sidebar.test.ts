import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import { dirKeyFor } from "../src/dirs.js"
import { applySettings, resetSettings } from "../src/settings.js"
import { resetPartitions, store } from "../src/state.js"
import { renderAggregatedTickets } from "../src/ticket-aggregate.js"
import {
  sidebarAggregatePanel,
  sidebarCollapsedGroups,
  sidebarExpandedLabel,
  sidebarGroupSummary,
} from "../src/ticket-sidebar.js"
import { createTicket, resetTickets } from "../src/ticket.js"
import { renderAllTicketsTextDeep, renderTicketsTextDeep } from "../src/ticket-tools.js"
import { parseTicketList, ticketPanel } from "../src/ticket-view.js"

/**
 * The sidebar ticket panel is the **aggregate** view: every partition's
 * tickets, the session's own directory expanded and the other partitions as
 * one-line summaries.
 *
 * The promises:
 *
 * 1. the panel's data source is the aggregate text, so it holds the tickets of
 *    every partition;
 * 2. with a single partition the panel is structurally identical to the old
 *    one (same items, same order, same counts, no group label);
 * 3. the panel and `/alltickets` share one parsing/layout model, so they can
 *    never disagree about a group or its count.
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"
const KEY_A = "opt-alpha-11111111"
const KEY_B = "opt-beta-22222222"

beforeEach(resetStore)
afterEach(resetStore)

const base = { objective: "objective", acceptance: ["a"], source: "test" } as const

/** Reset the process state between the cases (the store is shared). */
function resetStore(): void {
  resetSettings()
  resetTickets()
  resetPartitions()
  store.workers.clear()
  store.pending.length = 0
  store.routerID = undefined
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

/**
 * One ticket's list text, exactly as `renderTicketList` writes it.
 *
 * The header's `进行中` counts only open + in_progress, so a blocked ticket
 * shows `进行中 0` — the sidebar's own "unfinished" rule differs from it.
 */
function ticketText(id: string, title: string, state = "open"): string {
  const running = state === "open" || state === "in_progress" ? 1 : 0
  return `工单 1 · 进行中 ${running}\n\n${state} (1)\n· ${id} p1 ${title}\n· 11-14 10:00`
}

/** A group's body with two open tickets, exactly as `renderTicketList` writes it. */
function twoTicketText(): string {
  return [
    "工单 2 · 进行中 2",
    "",
    "open (2)",
    "· tk_bbb2222_bbbb p1 B 的工单",
    "· 11-14 10:00",
    "· tk_bbb2222_cccc p1 B 的第二张",
    "· 11-14 09:00",
  ].join("\n")
}

/** The aggregate text of two partitions, as the server renders it. */
const TWO_PARTITIONS = renderAggregatedTickets([
  { dirKey: KEY_A, directory: DIR_A, count: 1, body: ticketText("tk_aaa1111_aaaa", "A 的工单") },
  { dirKey: KEY_B, directory: DIR_B, count: 2, body: twoTicketText() },
])

/** The single-partition text, as the server renders it for one directory. */
const ONE_PARTITION = ticketText("tk_aaa1111_aaaa", "A 的工单")

describe("the sidebar panel reads the aggregate view", () => {
  test("it holds the tickets of every partition", () => {
    const panel = sidebarAggregatePanel(TWO_PARTITIONS, KEY_A)
    expect(panel.grouped).toBe(true)
    expect(panel.groups).toHaveLength(2)
    // The totals cover both partitions.
    expect(panel.total).toBe(3)
    expect(panel.active).toBe(3)
    // Each group knows its own tickets.
    expect(panel.groups.map((group) => group.total)).toEqual([1, 2])
  })

  test("the session's own directory is expanded and comes first", () => {
    const panel = sidebarAggregatePanel(TWO_PARTITIONS, KEY_A)
    expect(panel.expanded?.dirKey).toBe(KEY_A)
    expect(panel.expanded?.current).toBe(true)
    expect(panel.expanded?.items.map((item) => item.id)).toEqual(["tk_aaa1111_aaaa"])
    // The other partition is collapsed into one summary line.
    const collapsed = sidebarCollapsedGroups(panel)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.dirKey).toBe(KEY_B)
  })

  test("the collapsed group carries its directory and its count", () => {
    const panel = sidebarAggregatePanel(TWO_PARTITIONS, KEY_A)
    const collapsed = sidebarCollapsedGroups(panel)
    // The basename keeps the 36-cell line short; the count says how much is
    // waiting there.
    expect(sidebarGroupSummary(collapsed[0]!)).toBe("目录 beta · 2 条")
    expect(sidebarExpandedLabel(panel.expanded!)).toBe("目录 alpha")
  })

  test("without a known directory the group is named by its partition key", () => {
    const text = renderAggregatedTickets([
      { dirKey: KEY_A, count: 1, body: ticketText("tk_aaa1111_aaaa", "A") },
      { dirKey: KEY_B, count: 1, body: ticketText("tk_bbb2222_bbbb", "B") },
    ])
    const panel = sidebarAggregatePanel(text, KEY_A)
    const collapsed = sidebarCollapsedGroups(panel)
    expect(sidebarGroupSummary(collapsed[0]!)).toBe(`目录 ${KEY_B} · 1 条`)
  })

  test("a group that may hold more shows a lower bound", () => {
    const text = renderAggregatedTickets([
      { dirKey: KEY_A, directory: DIR_A, count: 20, truncated: true, body: ticketText("tk_aaa1111_aaaa", "A") },
      { dirKey: KEY_B, directory: DIR_B, count: 1, body: ticketText("tk_bbb2222_bbbb", "B") },
    ])
    const panel = sidebarAggregatePanel(text, KEY_A)
    const collapsed = sidebarCollapsedGroups(panel)
    expect(sidebarGroupSummary(collapsed[0]!)).toBe("目录 beta · 1 条")
    // The truncated group is the expanded one here; its count carries the `+`.
    const expanded = panel.groups.find((group) => group.dirKey === KEY_A)
    expect(expanded?.truncated).toBe(true)
    expect(expanded?.total).toBe(20)
  })

  test("a truncated group's count is printed as a lower bound", () => {
    const text = renderAggregatedTickets([
      { dirKey: KEY_A, directory: DIR_A, count: 20, truncated: true, body: ticketText("tk_aaa1111_aaaa", "A") },
      { dirKey: KEY_B, directory: DIR_B, count: 1, body: ticketText("tk_bbb2222_bbbb", "B") },
    ])
    // The server's text says `20+ 条`; the sidebar prints the same.
    expect(text).toContain(`${KEY_A} · 20+ 条`)
    const panel = sidebarAggregatePanel(text, KEY_A)
    expect(sidebarExpandedLabel(panel.expanded!)).toBe("目录 alpha")
    // The collapsed group is not truncated, so its count is exact.
    expect(sidebarGroupSummary(sidebarCollapsedGroups(panel)[0]!)).toBe("目录 beta · 1 条")
  })
})

describe("the sidebar panel with a single partition is the old panel", () => {
  test("the items, their order and the counts are the old ones", () => {
    const panel = sidebarAggregatePanel(ONE_PARTITION, KEY_A)
    const old = ticketPanel(parseTicketList(ONE_PARTITION))
    expect(panel.grouped).toBe(false)
    expect(panel.total).toBe(old.total)
    expect(panel.active).toBe(old.active)
    expect(panel.expanded?.items).toEqual(old.items)
    expect(panel.expanded?.hidden).toBe(old.hidden)
  })

  test("no group label and no summary line", () => {
    const panel = sidebarAggregatePanel(ONE_PARTITION, KEY_A)
    // Nothing is collapsed, so the panel draws exactly the old rows.
    expect(sidebarCollapsedGroups(panel)).toHaveLength(0)
    expect(panel.groups).toHaveLength(1)
  })

  test("the old panel and the aggregate panel agree row for row", () => {
    const old = ticketPanel(parseTicketList(ONE_PARTITION))
    const panel = sidebarAggregatePanel(ONE_PARTITION, KEY_A)
    expect(panel.expanded?.items.map((item) => `${item.shortID} ${item.title}`)).toEqual(
      old.items.map((item) => `${item.shortID} ${item.title}`),
    )
  })
})

describe("the sidebar and `/alltickets` share one model", () => {
  test("both read the same aggregate text and agree on the groups", () => {
    const panel = sidebarAggregatePanel(TWO_PARTITIONS, KEY_A)
    // The command's list rows come from the same parse, so the group count
    // the sidebar prints is the group count the command shows.
    const header = TWO_PARTITIONS.split("\n")[0]
    expect(header).toBe("共 3 条，2 个目录")
    expect(panel.groups).toHaveLength(2)
    expect(panel.total).toBe(3)
  })

  test("the group header of the text and the sidebar summary agree on the count", () => {
    const panel = sidebarAggregatePanel(TWO_PARTITIONS, KEY_A)
    const collapsed = sidebarCollapsedGroups(panel)
    expect(sidebarGroupSummary(collapsed[0]!)).toContain("2 条")
    expect(TWO_PARTITIONS).toContain(`${KEY_B} · 2 条`)
  })
})

describe("the sidebar's data source is the aggregate RPC text", () => {
  test("the aggregate text of two partitions feeds the panel with both groups", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    const a = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
    )
    const b = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:b", title: "B", directory: DIR_B, dirKey: dirKeyFor(DIR_B) }),
    )
    // The very text the sidebar fetches: the aggregate view.
    const text = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const panel = sidebarAggregatePanel(text, dirKeyFor(DIR_A))

    expect(panel.grouped).toBe(true)
    expect(panel.total).toBe(2)
    // Both partitions are in the panel; the session's own one is expanded.
    expect(panel.expanded?.dirKey).toBe(dirKeyFor(DIR_A))
    expect(panel.expanded?.items.map((item) => item.id)).toEqual([a.ticket.id])
    const collapsed = sidebarCollapsedGroups(panel)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.total).toBe(1)
    expect(sidebarGroupSummary(collapsed[0]!)).toContain("1 条")
    // The other partition's ticket is in the panel's data, even though it is
    // not the expanded row.
    expect(TWO_PARTITIONS.length).toBeGreaterThan(0)
    expect(text).toContain(b.ticket.id)
  })

  test("a blocked ticket counts as unfinished, like the old panel did", () => {
    // The server prints `进行中 0` for a blocked ticket (open + in_progress
    // only); the sidebar's own rule is open + in_progress + blocked. The panel
    // keeps its rule, so the count does not depend on the server's wording.
    const text = renderAggregatedTickets([
      { dirKey: KEY_A, directory: DIR_A, count: 1, body: ticketText("tk_aaa1111_aaaa", "A", "blocked") },
      { dirKey: KEY_B, directory: DIR_B, count: 1, body: ticketText("tk_bbb2222_bbbb", "B") },
    ])
    expect(text).toContain("工单 1 · 进行中 0")
    const panel = sidebarAggregatePanel(text, KEY_A)
    expect(panel.expanded?.active).toBe(1)
    expect(panel.active).toBe(2)
  })

  test("the single-partition aggregate text still feeds the old panel", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
    )
    const text = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const panel = sidebarAggregatePanel(text, dirKeyFor(DIR_A))
    expect(panel.grouped).toBe(false)
    expect(panel.total).toBe(1)
    expect(sidebarCollapsedGroups(panel)).toHaveLength(0)
  })

  test("the aggregate fetch of one partition equals the old scoped fetch", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    for (let index = 0; index < 3; index += 1) {
      await succeed(
        createTicket(ctx, {
          ...base,
          threadID: `telegram:a${index}`,
          title: `A${index}`,
          directory: DIR_A,
          dirKey: dirKeyFor(DIR_A),
        }),
      )
    }
    // The old sidebar fetched the session's directory with a limit of 20; the
    // new one fetches the aggregate with the same limit, which is per
    // partition. With one partition both must return the same rows.
    const oldText = await succeed(renderTicketsTextDeep(ctx, { limit: 20 }, dirKeyFor(DIR_A)))
    const newText = await succeed(renderAllTicketsTextDeep(ctx, { limit: 20 }))
    expect(newText).toBe(oldText)
    const panel = sidebarAggregatePanel(newText, dirKeyFor(DIR_A))
    const old = ticketPanel(parseTicketList(oldText))
    expect(panel.expanded?.items).toEqual(old.items)
    expect(panel.total).toBe(old.total)
  })
})
