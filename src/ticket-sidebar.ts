/**
 * The sidebar's aggregate ("all partitions") ticket panel.
 *
 * The panel is 36 cells wide, so it cannot show every partition's tickets in
 * full. The rule this module implements:
 *
 * - **the session's own directory comes first** — its tickets are shown in
 *   full, because they are the ones the user is working on;
 * - **every other partition is a one-line summary** (`目录 · 计数`), so the
 *   user still sees that work is waiting elsewhere and how much of it there
 *   is, without the panel growing past the terminal;
 * - with a single partition the panel is **structurally identical** to the old
 *   one: no group label, no summary line, the same items in the same order
 *   and the same counts (the aggregate fetch uses the same per-partition
 *   limit, so a single partition yields exactly the rows the old fetch did).
 *
 * The panel reads the **same** aggregate text `/alltickets` renders and parses
 * it with the same functions (`src/ticket-aggregate.ts`), so the sidebar and
 * the command can never disagree about a group or its count.
 *
 * Everything here is pure, so `test/ticket-sidebar.test.ts` can pin the
 * layout without the Solid renderer.
 */

import {
  aggregateGroupCount,
  aggregateGroupLabel,
  parseAggregatedTicketList,
  type AggregateTicketGroup,
} from "./ticket-aggregate.js"
import { ticketPanel, type TicketPanelItem } from "./ticket-view.js"

/** One group of the sidebar panel. */
export interface SidebarTicketGroup {
  /** Partition key; absent for the single-partition (legacy) shape. */
  readonly dirKey?: string
  /** Directory the partition belongs to; absent when unknown. */
  readonly directory?: string
  /** Tickets of this partition in the aggregate view. */
  readonly total: number
  /** Tickets that are not closed yet. */
  readonly active: number
  /** The rows the panel shows for this group (already ordered and truncated). */
  readonly items: ReadonlyArray<TicketPanelItem>
  /** Terminal tickets of this group that did not fit. */
  readonly hidden: number
  /** True when this is the session's own directory. */
  readonly current: boolean
  /**
   * True when the group may hold more tickets than it shows (it reached the
   * fetch limit). Its count is then a lower bound (`20+ 条`).
   */
  readonly truncated: boolean
}

export interface SidebarAggregatePanel {
  /** Every ticket the aggregate view holds. */
  readonly total: number
  /** Tickets that are not closed yet. */
  readonly active: number
  /** The groups, the session's own directory first. */
  readonly groups: ReadonlyArray<SidebarTicketGroup>
  /** True when there is more than one partition, i.e. the grouped layout. */
  readonly grouped: boolean
  /** The group the panel expands (the session's own directory). */
  readonly expanded?: SidebarTicketGroup
}

/**
 * Build the sidebar panel from the aggregate RPC text.
 *
 * `currentDirKey` is the session's own partition (`status({ directory })`
 * echoes it). The groups keep the text's order except that the session's own
 * directory is moved to the front.
 */
export function sidebarAggregatePanel(
  text: string,
  currentDirKey?: string,
): SidebarAggregatePanel {
  const groups = parseAggregatedTicketList(text)
  // The legacy shape: one partition, no group header. The panel then renders
  // exactly what it rendered before the aggregate view existed.
  if (groups.length <= 1) {
    const rows = groups[0]?.rows ?? []
    const panel = ticketPanel(rows)
    const group: SidebarTicketGroup = {
      total: panel.total,
      active: panel.active,
      items: panel.items,
      hidden: panel.hidden,
      current: true,
      truncated: groups[0]?.truncated === true,
    }
    return { total: panel.total, active: panel.active, grouped: false, groups: [group], expanded: group }
  }
  const ordered = orderGroups(groups, currentDirKey)
  const built = ordered.map((group) => {
    const panel = ticketPanel(group.rows)
    // The header carries the **server's** count (which may be a lower bound);
    // the rows only carry what fits in the panel. Both are needed: the count
    // is what the panel announces, the rows are what it shows.
    const total = group.count ?? panel.total
    return {
      ...(group.dirKey === undefined ? {} : { dirKey: group.dirKey }),
      ...(group.directory === undefined ? {} : { directory: group.directory }),
      total,
      // The panel's own "unfinished" rule (open + in_progress + blocked) is
      // **not** the server's "进行中" (open + in_progress): the sidebar has
      // always counted a blocked ticket as unfinished, so it keeps its rule
      // and counts the rows it received. The server's number is only the
      // fallback for a group whose rows could not be parsed at all.
      active: group.rows.length === 0 ? (group.active ?? panel.active) : panel.active,
      items: panel.items,
      hidden: panel.hidden,
      current: group.dirKey !== undefined && group.dirKey === currentDirKey,
      truncated: group.truncated,
    } satisfies SidebarTicketGroup
  })
  const expanded = built.find((group) => group.current) ?? built[0]
  return {
    // The header's total is the **server's** count per partition, summed: it
    // is the real number of work orders the gateway holds (a lower bound only
    // for a partition that hit the fetch limit).
    total: built.reduce((sum, group) => sum + group.total, 0),
    // The "unfinished" count is what the panel's own rule says about the rows
    // it received; a partition that hit the fetch limit can hold more, so this
    // number is a lower bound too.
    active: built.reduce((sum, group) => sum + group.active, 0),
    grouped: true,
    groups: built,
    expanded,
  }
}

/** The session's own directory first, the others in the order the text lists them. */
function orderGroups(
  groups: ReadonlyArray<AggregateTicketGroup>,
  currentDirKey: string | undefined,
): ReadonlyArray<AggregateTicketGroup> {
  if (currentDirKey === undefined) return groups
  const index = groups.findIndex((group) => group.dirKey === currentDirKey)
  if (index <= 0) return groups
  return [groups[index]!, ...groups.slice(0, index), ...groups.slice(index + 1)]
}

/**
 * The one-line summary of a group the sidebar does not expand.
 *
 * `目录 <basename> · <n> 条` — the basename keeps the line short, and the
 * count says how much work is waiting there. A group that may hold more than
 * the fetch limit shows `20+ 条`, so the number is never a wrong claim.
 */
export function sidebarGroupSummary(group: SidebarTicketGroup): string {
  const count = aggregateGroupCount(group.total, group.truncated)
  return `目录 ${aggregateGroupLabel(group)} · ${count} 条`
}

/**
 * The label of the expanded group (the session's own directory).
 *
 * `目录 <basename>` — the panel shows this group's tickets right below it.
 */
export function sidebarExpandedLabel(group: SidebarTicketGroup): string {
  return `目录 ${aggregateGroupLabel(group)}`
}

/** The groups the sidebar shows as one-line summaries (everything but the expanded one). */
export function sidebarCollapsedGroups(panel: SidebarAggregatePanel): ReadonlyArray<SidebarTicketGroup> {
  return panel.groups.filter((group) => group !== panel.expanded)
}
