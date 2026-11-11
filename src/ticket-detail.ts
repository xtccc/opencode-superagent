/**
 * Ticket detail view model for the `/task` detail pane.
 *
 * `renderTicketDetail` (server side) returns ready-to-read text, and the TUI
 * cannot ask for structured fields: the `ticket` RPC is text-only so a TUI can
 * keep working against a deployed gateway. This module parses that text back
 * into the fields the pane shows (short id, full id, title, state, priority,
 * directory, worker session, timestamps, report summary) and re-lays them out
 * for the pane width.
 *
 * `effort` is optional on purpose: the dispatch layer records it separately and
 * an older gateway does not print the line at all, so a missing value must not
 * turn into an empty row.
 */

import { displayWidth, wrapText } from "./tools.js"
import { TICKET_STATE_SYMBOL, truncateCells, type TicketState } from "./ticket-view.js"

/** One ticket as the detail pane needs it. Every field except `id` is optional. */
export interface TicketDetail {
  readonly id: string
  readonly state?: string
  readonly priority?: string
  readonly title?: string
  readonly objective?: string
  readonly acceptance: ReadonlyArray<string>
  readonly threadID?: string
  readonly directory?: string
  readonly workerSessionID?: string
  /** Reasoning effort of the last dispatch, when the gateway prints one. */
  readonly effort?: string
  readonly attempts?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly closedAt?: string
  readonly closeReason?: string
  readonly parentTicketID?: string
  readonly quote?: string
  readonly history: ReadonlyArray<string>
}

/** `tk_xxx · in_progress · p1`: the first line of `renderTicketDetail`. */
const HEADER_LINE = /^(\S+) · ([a-z_]+) · (p[012])$/
/** `目标：…`, `worker：ses_x`, … (the label is followed by its value). */
const LABEL_LINE = /^(目标|thread|目录|worker|effort|档位|尝试|建档|更新|关闭|结论|父单|原话)：/
/** `验收：` and `历史（最近 N 条）：` introduce bullet sections. */
const SECTION_LINE = /^(验收|历史（最近 \d+ 条）)：$/
const BULLET_LINE = /^· (.*)$/

/** Every field a `label：value` line can fill; all of them are plain strings. */
type StringField =
  | "objective"
  | "threadID"
  | "directory"
  | "workerSessionID"
  | "effort"
  | "attempts"
  | "createdAt"
  | "updatedAt"
  | "closedAt"
  | "closeReason"
  | "parentTicketID"
  | "quote"

const FIELD_BY_LABEL: Readonly<Record<string, StringField>> = {
  目标: "objective",
  thread: "threadID",
  目录: "directory",
  worker: "workerSessionID",
  effort: "effort",
  // `renderTicketDetail` labels the dispatch's reasoning level `档位：`; the
  // English key is accepted too so a renamed label does not drop the field.
  档位: "effort",
  尝试: "attempts",
  建档: "createdAt",
  更新: "updatedAt",
  关闭: "closedAt",
  结论: "closeReason",
  父单: "parentTicketID",
  原话: "quote",
}

/** The same record with the immutable fields writable and the lists concrete. */
type Mutable = {
  -readonly [K in keyof TicketDetail]: TicketDetail[K]
} & { title: string; acceptance: string[]; history: string[] }

/** Split `worker：ses_x` into label and value. */
function splitLabel(line: string): { label: string; value: string } {
  const index = line.indexOf("：")
  return index < 0 ? { label: line, value: "" } : { label: line.slice(0, index), value: line.slice(index + 1) }
}

/**
 * Parse `renderTicketDetail` text. `undefined` means "not a ticket detail"
 * (e.g. the `没有找到工单 …` message), so the caller can show a clear notice
 * instead of an empty pane.
 */
export function parseTicketDetail(text: string): TicketDetail | undefined {
  const lines = text.split("\n")
  const header = HEADER_LINE.exec(lines[0] ?? "")
  if (header === null) return undefined

  const detail: Mutable = {
    id: header[1]!,
    state: header[2],
    priority: header[3],
    title: "",
    acceptance: [],
    history: [],
  }
  let section: "title" | "objective" | "acceptance" | "history" | "none" = "title"
  let label: StringField | undefined

  // `renderTicketDetail` wraps long text, so a field can span several lines;
  // continuation lines are joined with a space.
  const append = (target: StringField, value: string) => {
    const previous = detail[target]
    detail[target] = previous === undefined || previous === "" ? value : `${previous} ${value}`
  }

  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      // A blank line ends the current field but keeps the title section, which
      // is the only block that starts without a label.
      if (section !== "title") {
        section = "none"
        label = undefined
      }
      continue
    }
    const sectionMatch = SECTION_LINE.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1] === "验收" ? "acceptance" : "history"
      label = undefined
      continue
    }
    if (LABEL_LINE.test(line)) {
      const parts = splitLabel(line)
      label = FIELD_BY_LABEL[parts.label]
      section = label === "objective" ? "objective" : "none"
      const value = parts.value.trim()
      // `renderTicketDetail` prints `-` for an unset field; it must not become a
      // session id (or an empty row) downstream.
      if (label !== undefined && value !== "" && value !== "-") append(label, value)
      continue
    }
    const bullet = BULLET_LINE.exec(line)
    if (bullet !== null) {
      const value = bullet[1]!.trim()
      if (section === "acceptance") detail.acceptance.push(value)
      else if (section === "history") detail.history.push(value)
      continue
    }
    const value = line.trim()
    if (section === "title") detail.title = detail.title === "" ? value : `${detail.title} ${value}`
    else if (section === "objective") append("objective", value)
    else if (label !== undefined) append(label, value)
  }

  return detail
}

/** `建档：11-11 14:21` — the gateway's own label style, so the pane reads like the detail text. */
function stamp(label: string, value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : `${label}：${value}`
}

/**
 * Lay the detail out for a pane `width` cells wide: header, identity, the
 * request itself, then the operational fields. Optional fields vanish when the
 * gateway did not print them, so no row is ever an empty label.
 */
export function detailRows(detail: TicketDetail, width: number): Array<string> {
  const wrap = (text: string) => wrapText(text, Math.max(8, Math.floor(width)))
  const rows: Array<string> = []
  const symbol = TICKET_STATE_SYMBOL[detail.state as TicketState] ?? "·"
  const state = detail.state ?? "unknown"
  rows.push(`${symbol} ${state} · ${detail.priority ?? "-"} · ${detail.id.slice(-4)}`)
  if (detail.title !== undefined && detail.title !== "") rows.push(...wrap(detail.title))
  rows.push(...wrap(`ID：${detail.id}`))
  rows.push("")
  if (detail.objective !== undefined && detail.objective !== "") {
    rows.push(...wrap(`目标：${detail.objective}`))
    rows.push("")
  }
  if (detail.acceptance.length > 0) {
    rows.push("验收：")
    for (const item of detail.acceptance) rows.push(...wrap(`· ${item}`))
    rows.push("")
  }
  const meta: Array<string | undefined> = [
    stamp("thread", detail.threadID),
    stamp("目录", detail.directory),
    stamp("档位", detail.effort),
    stamp("最近 worker", detail.workerSessionID === undefined || detail.workerSessionID === "-" ? undefined : detail.workerSessionID),
    stamp("尝试", detail.attempts),
  ]
  for (const row of meta) if (row !== undefined) rows.push(...wrap(row))
  const times = [stamp("建档", detail.createdAt), stamp("更新", detail.updatedAt), stamp("关闭", detail.closedAt)]
    .filter((value): value is string => value !== undefined)
    .join(" · ")
  if (times !== "") rows.push(...wrap(times))
  if (detail.closeReason !== undefined) {
    rows.push("")
    rows.push(...wrap(`报告摘要：${detail.closeReason}`))
  }
  if (detail.parentTicketID !== undefined) rows.push(...wrap(`父单：${detail.parentTicketID}`))
  if (detail.quote !== undefined) {
    rows.push("")
    rows.push(...wrap(`原话：${detail.quote}`))
  }
  if (detail.history.length > 0) {
    rows.push("")
    rows.push(`历史（最近 ${detail.history.length} 条）：`)
    for (const item of detail.history) rows.push(...wrap(`· ${item}`))
  }
  // A row wider than the pane would wrap on the terminal and break the scroll
  // model, so every row is clipped to the pane here.
  return rows.map((row) => (displayWidth(row) <= width ? row : truncateCells(row, width)))
}
