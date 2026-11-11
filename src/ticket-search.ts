/**
 * Ticket search shared by the TUI pickers (`/task`, `/ticket`).
 *
 * Ticket ids look like `tk_mwbkve34_dc8d`: a `tk_` prefix, an 8-character
 * random middle, and a 4-character suffix that the sidebar renders as the
 * short id. Users read the short id off the sidebar and type it back, so the
 * matcher accepts the full id, a prefix, a suffix, or any middle fragment,
 * ignores case, and ignores `tk_` / `_` / `-` separators.
 *
 * Everything here is pure: `tui.tsx` only renders and awaits, and
 * `test/ticket-search.test.ts` pins the ranking rules.
 */

export interface SearchableTicket {
  readonly id: string
  readonly title: string
}

/** Minimal shape of a dialog row; mirrors `DialogSelectOption` without importing the SDK. */
export interface PickerOption {
  readonly value: string
  readonly title: string
  readonly description?: string
}

/** A full-id hit (with or without `tk_` and separators). */
export const MATCH_EXACT = 0
/** The query is the tail of the id: the 4-character short id, or a longer suffix. */
export const MATCH_SUFFIX = 1
/** The query starts the id: `tk_mwbk`, `mwbkve34`. */
export const MATCH_PREFIX = 2
/** The query sits somewhere inside the id: `bkve34`. */
export const MATCH_MIDDLE = 3
/** Only the title matches. */
export const MATCH_TITLE = 4
/** Free-text fallback for non-ticket rows (workers): the label contains the query. */
export const MATCH_TEXT = 5

const SEPARATORS = /[\s_-]+/g

/**
 * Lower case, drop separators, drop the `tk` prefix: `TK_mwbk-ve34` becomes
 * `mwbkve34`. Used for id comparison only, never for display.
 */
export function canonicalTicketID(ticketID: string): string {
  return ticketID.trim().toLowerCase().replace(SEPARATORS, "").replace(/^tk/, "")
}

/**
 * Rank one ticket against a query, or `undefined` when it does not match.
 * Lower is better; an empty query never matches (`searchTickets` treats it as
 * "no filter" instead).
 */
export function rankTicketMatch(ticket: SearchableTicket, query: string): number | undefined {
  const needle = query.trim().toLowerCase()
  if (needle === "") return undefined
  const canonical = canonicalTicketID(needle)
  // `tk` alone canonicalises to the empty string: it carries no id fragment.
  if (canonical !== "") {
    const id = canonicalTicketID(ticket.id)
    if (id === canonical) return MATCH_EXACT
    if (id.endsWith(canonical)) return MATCH_SUFFIX
    if (id.startsWith(canonical)) return MATCH_PREFIX
    if (id.includes(canonical)) return MATCH_MIDDLE
  }
  const title = ticket.title.toLowerCase()
  if (title.includes(needle)) return MATCH_TITLE
  return undefined
}

export interface TicketMatch<T extends SearchableTicket> {
  readonly ticket: T
  readonly rank: number
}

/** Every match, best rank first; ties keep the caller's order (state grouping, newest first). */
export function matchTickets<T extends SearchableTicket>(
  rows: ReadonlyArray<T>,
  query: string,
): Array<TicketMatch<T>> {
  const ranked: Array<{ ticket: T; rank: number; index: number }> = []
  rows.forEach((ticket, index) => {
    const rank = rankTicketMatch(ticket, query)
    if (rank !== undefined) ranked.push({ ticket, rank, index })
  })
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return ranked.map(({ ticket, rank }) => ({ ticket, rank }))
}

/** Matches in rank order; an empty / blank query returns every row unfiltered. */
export function searchTickets<T extends SearchableTicket>(rows: ReadonlyArray<T>, query: string): Array<T> {
  if (query.trim() === "") return [...rows]
  return matchTickets(rows, query).map((match) => match.ticket)
}

export type TicketResolution<T extends SearchableTicket> =
  | { readonly kind: "none" }
  | { readonly kind: "one"; readonly ticket: T }
  | { readonly kind: "many"; readonly tickets: ReadonlyArray<T> }

/**
 * Resolve one typed query to a ticket: a unique hit may be opened directly,
 * several hits must be shown as candidates instead of silently picking the
 * first one (two tickets can share a 4-character suffix).
 */
export function resolveTicketQuery<T extends SearchableTicket>(
  rows: ReadonlyArray<T>,
  query: string,
): TicketResolution<T> {
  const needle = query.trim()
  if (needle === "") return { kind: "none" }

  const canonical = canonicalTicketID(needle)
  if (canonical !== "") {
    const exact = rows.filter((row) => canonicalTicketID(row.id) === canonical)
    if (exact.length === 1) return { kind: "one", ticket: exact[0]! }
    if (exact.length > 1) return { kind: "many", tickets: exact }
  }

  // Id fragments win over titles: a title that happens to contain "dc8d" must
  // not turn a unique short-id hit into an ambiguous result.
  const byID = matchTickets(rows, needle)
    .filter((match) => match.rank < MATCH_TITLE)
    .map((match) => match.ticket)
  const pool = byID.length > 0 ? byID : searchTickets(rows, needle)
  if (pool.length === 0) return { kind: "none" }
  if (pool.length === 1) return { kind: "one", ticket: pool[0]! }
  return { kind: "many", tickets: pool }
}

/** Rank a free-text match on a label such as `title · description`. */
export function rankTextMatch(text: string, query: string): number | undefined {
  const needle = query.trim().toLowerCase()
  if (needle === "") return undefined
  const haystack = text.toLowerCase()
  return haystack.includes(needle) ? MATCH_TEXT : undefined
}

/**
 * `dialog.select`'s `search` callback for a mixed picker (tickets first, then
 * workers). Ticket rows are ranked with the id rules; every other row falls
 * back to a plain label match, so worker titles and session ids stay findable.
 * An empty query keeps the caller's order untouched.
 */
export function searchPickerOptions<T extends PickerOption>(
  query: string,
  options: ReadonlyArray<T>,
  tickets: ReadonlyArray<SearchableTicket>,
  ticketValuePrefix: string,
): ReadonlyArray<T> {
  if (query.trim() === "") return options
  const ticketByValue = new Map<string, SearchableTicket>()
  for (const ticket of tickets) ticketByValue.set(`${ticketValuePrefix}${ticket.id}`, ticket)
  const ranked: Array<{ option: T; rank: number; index: number }> = []
  options.forEach((option, index) => {
    const ticket = ticketByValue.get(option.value)
    const rank =
      ticket === undefined
        ? rankTextMatch(`${option.title} ${option.description ?? ""} ${option.value}`, query)
        : rankTicketMatch(ticket, query)
    if (rank !== undefined) ranked.push({ option, rank, index })
  })
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return ranked.map((entry) => entry.option)
}
