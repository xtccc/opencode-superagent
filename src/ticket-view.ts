/**
 * Sidebar view model for the ticket list.
 *
 * The `tickets` RPC returns `renderTicketList` text rather than structured
 * rows (the server side is deployed separately and needs a service restart to
 * change), so the TUI parses that text back into rows and re-lays them out for
 * the fixed-width sidebar. Everything here is pure and width-aware, which
 * keeps the OpenTUI component in `tui.tsx` to rendering only.
 *
 * `src/ticket.ts` is only imported for types: valuing `TICKET_STATES` here
 * would pull the Effect/KV store into the TUI bundle. `test/ticket-view.test.ts`
 * asserts the local copy stays in step with the real state list.
 */

import { displayWidth } from "./tools.js"
import type { TicketPriority, TicketState } from "./ticket.js"

export type { TicketState }

export const TICKET_STATES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "failed",
  "cancelled",
  "superseded",
] as const satisfies ReadonlyArray<TicketState>

/**
 * `SESSION_SIDEBAR_WIDTH` is 42 columns: 4 of horizontal padding plus the
 * scrollbar column the sidebar reserves on the right leave 37 cells. The panel
 * uses 36 and keeps one cell of slack, so a row can never push the sidebar
 * into a horizontal scroll.
 */
export const TICKET_PANEL_WIDTH = 36
/** Titles are capped below the full remainder so a long one never pushes the id off-screen. */
export const TICKET_TITLE_MAX = 26
/** Terminal tickets are collapsed; the panel is a glance, not an archive. */
export const TICKET_TERMINAL_LIMIT = 3
export const TICKET_PANEL_LIMIT = 20
export const TICKET_PANEL_REFRESH_MS = 4000

const SHORT_ID_LENGTH = 4

export const TICKET_STATE_SYMBOL: Readonly<Record<TicketState, string>> = {
  open: "○",
  in_progress: "●",
  blocked: "◆",
  done: "✓",
  failed: "✗",
  cancelled: "⊘",
  superseded: "·",
}

/** Unfinished states first (running work, then stuck work, then queued), terminal ones last. */
const STATE_RANK: Readonly<Record<TicketState, number>> = {
  in_progress: 0,
  blocked: 1,
  open: 2,
  done: 3,
  failed: 4,
  cancelled: 5,
  superseded: 6,
}

const TERMINAL: ReadonlySet<TicketState> = new Set(["done", "failed", "cancelled", "superseded"])

export interface TicketRow {
  readonly id: string
  readonly title: string
  readonly state: TicketState
  readonly priority: TicketPriority
}

export interface TicketPanelItem {
  readonly id: string
  readonly shortID: string
  readonly title: string
  readonly state: TicketState
}

export interface TicketPanel {
  readonly total: number
  /** Tickets that are not closed yet, i.e. their count in the header. */
  readonly active: number
  readonly items: ReadonlyArray<TicketPanelItem>
  /** Terminal tickets that did not fit under `TICKET_TERMINAL_LIMIT`. */
  readonly hidden: number
}

const GROUP_LINE = /^(open|in_progress|blocked|done|failed|cancelled|superseded) \(\d+\)$/
const ITEM_LINE = /^· (tk_\S+) (p[012])(?: (.*))?$/
/** `renderTicketList` writes `MM-DD HH:MM` (plus an optional worker suffix) under every item. */
const TRAILER_LINE = /^\s{2}\d{2}-\d{2} \d{2}:\d{2}(?: w=\S+)?$/

/**
 * Parse `renderTicketList` output. Rows arrive grouped by state and already
 * sorted newest-first inside a group, so the input order is the time order.
 * Unrecognised lines are ignored: a future format change degrades the panel to
 * "no tickets" instead of breaking the sidebar.
 */
export function parseTicketList(text: string): Array<TicketRow> {
  const rows: Array<{ id: string; title: string; state: TicketState; priority: TicketPriority }> = []
  let state: TicketState | undefined
  for (const line of text.split("\n")) {
    const group = GROUP_LINE.exec(line)
    if (group?.[1] !== undefined) {
      state = group[1] as TicketState
      continue
    }
    const item = ITEM_LINE.exec(line)
    if (item !== null && state !== undefined) {
      rows.push({
        id: item[1]!,
        priority: item[2] as TicketPriority,
        state,
        title: (item[3] ?? "").trim(),
      })
      continue
    }
    // A wrapped title continues on indented lines; trailers are not titles.
    if (state !== undefined && rows.length > 0 && line.startsWith("  ") && !TRAILER_LINE.test(line)) {
      const last = rows[rows.length - 1]!
      const continuation = line.trim()
      if (continuation !== "") last.title = last.title === "" ? continuation : `${last.title} ${continuation}`
    }
  }
  return rows
}

/** Truncate to `max` terminal cells (CJK counts as 2) with a trailing ellipsis. */
export function truncateCells(text: string, max: number): string {
  if (max <= 0) return ""
  if (displayWidth(text) <= max) return text
  let result = ""
  let cells = 0
  for (const char of text) {
    const width = displayWidth(char)
    if (cells + width > max - 1) break
    result += char
    cells += width
  }
  return `${result}…`
}

export function shortTicketID(ticketID: string): string {
  return ticketID.length <= SHORT_ID_LENGTH ? ticketID : ticketID.slice(-SHORT_ID_LENGTH)
}

/** Order, truncate and collapse parsed rows into what the sidebar renders. */
export function ticketPanel(
  rows: ReadonlyArray<TicketRow>,
  width = TICKET_PANEL_WIDTH,
  terminalLimit = TICKET_TERMINAL_LIMIT,
): TicketPanel {
  const titleMax = Math.min(TICKET_TITLE_MAX, width - (1 + 1 + 1 + SHORT_ID_LENGTH))
  // `Array.prototype.sort` is stable, so newest-first survives inside a state.
  const ordered = [...rows].sort((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state])
  const active = ordered.filter((row) => !TERMINAL.has(row.state))
  const terminal = ordered.filter((row) => TERMINAL.has(row.state))
  return {
    total: rows.length,
    active: active.length,
    hidden: Math.max(0, terminal.length - terminalLimit),
    items: [...active, ...terminal.slice(0, terminalLimit)].map((row) => ({
      id: row.id,
      shortID: shortTicketID(row.id),
      title: truncateCells(row.title, titleMax),
      state: row.state,
    })),
  }
}
