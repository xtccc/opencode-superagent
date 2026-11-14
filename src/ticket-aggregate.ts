/**
 * Aggregated ("all partitions") ticket list layout.
 *
 * `/tickets` shows one partition (the session's own directory); `/alltickets`
 * shows every partition at once, grouped by directory. The group bodies are the
 * very same `renderTicketList` output as the single-partition view, so the two
 * commands only differ in the group headers and the total count.
 *
 * The **sidebar** reads the very same text (it is the aggregate view too), so
 * both surfaces parse it with the functions here and can never disagree about
 * what a group is, how many tickets it holds, or how it is labelled.
 *
 * This module is pure: the server renders each group body and hands it over,
 * and the TUI parses the header back without pulling the KV-backed ticket store
 * into its bundle.
 */

import { parseTicketList, type TicketRow } from "./ticket-view.js"

/** One partition of the aggregated view, already rendered. */
export interface TicketGroup {
  /** Partition key (`dirKey`); the stable identity of the group. */
  readonly dirKey: string
  /** Directory the partition belongs to, when the process knows it. */
  readonly directory?: string
  /** How many tickets the group holds. */
  readonly count: number
  /**
   * True when the group may hold more tickets than it shows (it reached the
   * fetch limit). The count is then a lower bound and is printed as `N+`.
   */
  readonly truncated?: boolean
  /** The group's own `renderTicketList` output. */
  readonly body: string
}

/** The header line of an aggregate list: `共 N 条，K 个目录`. */
export const AGGREGATE_HEADER_PATTERN = /^共 (\d+) 条，(\d+) 个目录$/

/** The group header of one partition: `目录 <path> · <dirKey> · <n> 条`. */
export const AGGREGATE_GROUP_PATTERN = /^目录 (.+?) · (\S+) · (\d+)(\+)? 条$/

/**
 * The header of one group's body: `工单 <n> · 进行中 <m>`.
 *
 * This is the server's own count of the group, so a surface that shows it
 * never disagrees with the command.
 */
export const AGGREGATE_BODY_HEADER_PATTERN = /^工单 (\d+) · 进行中 (\d+)$/

export interface AggregateHeader {
  /** Total number of tickets shown. */
  readonly total: number
  /** Number of directory groups shown. */
  readonly directories: number
}

/**
 * The count of a group as it is printed.
 *
 * A group that hit the fetch limit may hold more tickets than it shows, so its
 * count is a lower bound: `20+ 条` instead of `20 条`. The rule lives here so
 * the server's renderer and the TUI's parser agree on what a count means.
 */
export function aggregateGroupCount(count: number, truncated: boolean): string {
  return truncated ? `${count}+` : `${count}`
}

/**
 * Lay the aggregated list out.
 *
 * - No group at all: an empty string — the caller renders the empty-list text
 *   itself (the module stays free of the ticket store).
 * - Exactly one partition: **byte-identical** to the single-partition output
 *   (no group header, no total line) — the aggregate view must not add noise
 *   to a gateway that only ever has one directory.
 * - Several partitions: a total line, then one block per partition with its
 *   directory, its partition key and its own count.
 */
export function renderAggregatedTickets(groups: ReadonlyArray<TicketGroup>): string {
  const populated = groups.filter((group) => group.count > 0)
  if (populated.length === 0) return ""
  if (populated.length === 1) return populated[0]!.body
  const total = populated.reduce((sum, group) => sum + group.count, 0)
  const lines: Array<string> = [`共 ${total} 条，${populated.length} 个目录`]
  for (const group of populated) {
    const count = aggregateGroupCount(group.count, group.truncated === true)
    lines.push("", `目录 ${group.directory ?? "-"} · ${group.dirKey} · ${count} 条`)
    lines.push(group.body)
  }
  return lines.join("\n")
}

/** The `共 N 条，K 个目录` line, when the text is an aggregate list. */
export function parseAggregateHeader(text: string): AggregateHeader | undefined {
  const first = text.split("\n")[0] ?? ""
  const match = AGGREGATE_HEADER_PATTERN.exec(first)
  if (match === null) return undefined
  const total = Number(match[1])
  const directories = Number(match[2])
  if (!Number.isFinite(total) || !Number.isFinite(directories)) return undefined
  return { total, directories }
}

/** One partition of the parsed aggregate list, with its ticket rows. */
export interface AggregateTicketGroup {
  /** Partition key; absent when the text carried no group header. */
  readonly dirKey?: string
  /** Directory the partition belongs to; absent when unknown. */
  readonly directory?: string
  /**
   * The ticket count the group header printed. This is the **server's** count,
   * so a surface that shows it never disagrees with the command. Absent for
   * the single-partition shape (no group header), where the rows are the only
   * source.
   */
  readonly count?: number
  /**
   * The unfinished-ticket count of the group, from the body header the server
   * printed. Absent when the body carries no header.
   */
  readonly active?: number
  /** The group's own ticket rows. */
  readonly rows: ReadonlyArray<TicketRow>
  /** True when the group header carried a `+` (the count is a lower bound). */
  readonly truncated: boolean
}

/**
 * Parse the aggregated list back into groups.
 *
 * The single-partition text (one directory, no group header) parses into one
 * group without a `dirKey` — that is how the TUI knows there is nothing to
 * group by and must not print a partition header.
 */
export function parseAggregatedTicketList(text: string): ReadonlyArray<AggregateTicketGroup> {
  const groups: Array<AggregateTicketGroup & { body: string }> = []
  let current: (AggregateTicketGroup & { body: string }) | undefined
  const append = (line: string): void => {
    if (current === undefined) {
      // No group header yet: the text is a plain single-partition list.
      current = { rows: [], body: "", truncated: false }
      groups.push(current)
    }
    current.body += `${current.body === "" ? "" : "\n"}${line}`
  }
  for (const line of text.split("\n")) {
    // The total line belongs to no group; skip it.
    if (AGGREGATE_HEADER_PATTERN.test(line)) continue
    const header = AGGREGATE_GROUP_PATTERN.exec(line)
    if (header !== null) {
      current = {
        dirKey: header[2],
        directory: header[1] === "-" ? undefined : header[1],
        count: Number(header[3]),
        rows: [],
        body: "",
        truncated: header[4] === "+",
      }
      groups.push(current)
      continue
    }
    // The blank line between the total line and the first group header must
    // not open a group of its own.
    if (current === undefined && line.trim() === "") continue
    append(line)
  }
  // A group without a header line is the single-partition view; keep it.
  return groups.map((group) => {
    // The body's own header carries the server's counts for this group.
    const body = AGGREGATE_BODY_HEADER_PATTERN.exec(group.body.split("\n")[0] ?? "")
    return {
      ...(group.dirKey === undefined ? {} : { dirKey: group.dirKey }),
      ...(group.directory === undefined ? {} : { directory: group.directory }),
      ...(group.count === undefined ? {} : { count: group.count }),
      ...(body === null ? {} : { active: Number(body[2]) }),
      rows: parseTicketList(group.body),
      truncated: group.truncated,
    }
  })
}

/**
 * The label of a group: its directory, or its partition key when the process
 * does not know the directory. The basename keeps the line short.
 */
export function aggregateGroupLabel(group: {
  readonly dirKey?: string
  readonly directory?: string
}): string {
  if (group.directory !== undefined) return aggregateBasename(group.directory)
  return group.dirKey ?? "-"
}

/** The last path segment of a directory; the path itself when there is none. */
export function aggregateBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "")
  const last = parts[parts.length - 1]
  return last === undefined || last === "" ? path : last
}
