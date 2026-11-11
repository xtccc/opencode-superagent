/**
 * Layout math for the Superagent pickers (`/task`, `/ticket`).
 *
 * The host's `dialog.select` frame is a fixed 60 columns wide and its list
 * stops at `floor(rows / 2) - 6` entries, so a 40-row terminal shows 14 rows
 * and an 80x24 terminal shows 6. The pickers therefore render their own dialog
 * and size it here: wide enough for one `short id · state · title` line, tall
 * enough for most of the screen, and never larger than the terminal.
 *
 * Everything in this module is pure, so `test/tui-picker.test.ts` can pin the
 * numbers; `tui.tsx` only renders.
 */

import { displayWidth } from "./tools.js"
import { truncateCells } from "./ticket-view.js"

/** Share of the terminal height the dialog aims for. */
export const PICKER_HEIGHT_RATIO = 0.75
/** Floor in rows: header, search and help plus a workable list. */
export const PICKER_MIN_ROWS = 12
/** Ceiling in rows, so an ultra-tall terminal does not turn the picker into a wall. */
export const PICKER_MAX_ROWS = 30
/** Widest content the host dialog frame publishes (`DialogSize` "xlarge" is 116). */
export const PICKER_MAX_COLS = 112
/** Narrower terminals keep all the columns they have instead of overflowing. */
export const PICKER_MIN_COLS = 40
/**
 * Rows the picker spends outside the list: title, a gap, the search field, a
 * gap, the list's own top gap, and the help line. `height` always equals
 * `listRows + PICKER_CHROME_ROWS`.
 */
export const PICKER_CHROME_ROWS = 6
/** Host dialog frame: bottom padding, header gap and one row of breathing room. */
export const PICKER_FRAME_ROWS = 3
/** Slack on each side so the frame never touches the terminal edge. */
export const PICKER_MARGIN_COLS = 4

/** Width of the state column, i.e. the longest ticket state (`in_progress`). */
export const PICKER_STATUS_COLUMNS = 11
/** Below this the optional columns are dropped so a title stays readable. */
const MIN_TITLE_CELLS = 8
/** One trailing cell kept free; avoids a row that ends exactly on the edge. */
const ROW_SLACK = 1
/** Left gutter of the selected row, so the marker never shifts the title. */
export const PICKER_MARKER = "▸ "
export const PICKER_MARKER_IDLE = "  "

export interface DialogSize {
  /** Content width in cells. */
  readonly width: number
  /** Content height in rows: `listRows + PICKER_CHROME_ROWS`. */
  readonly height: number
  /** Entries that fit in the list at once. */
  readonly listRows: number
}

/**
 * Size the picker dialog for a terminal. Height follows
 * `PICKER_HEIGHT_RATIO`, clamped to `[PICKER_MIN_ROWS, PICKER_MAX_ROWS]`, and
 * both dimensions are capped by what the terminal can show: an 80x24 terminal
 * gets a 76x18 dialog (12 list rows) while a 200x60 one gets 112x30 (24 rows).
 */
export function computeDialogSize(termCols: number, termRows: number): DialogSize {
  const cols = Math.floor(termCols)
  const rows = Math.floor(termRows)
  // A terminal that reports nothing usable still gets a positive box.
  const spaceCols = Math.max(8, cols - PICKER_MARGIN_COLS)
  const spaceRows = Math.max(PICKER_CHROME_ROWS + 1, rows - PICKER_FRAME_ROWS)
  const width = spaceCols >= PICKER_MIN_COLS ? Math.min(spaceCols, PICKER_MAX_COLS) : spaceCols
  const target = Math.round(rows * PICKER_HEIGHT_RATIO)
  const wanted = Math.min(Math.max(target, PICKER_MIN_ROWS), PICKER_MAX_ROWS)
  const height = Math.max(PICKER_CHROME_ROWS + 1, Math.min(wanted, spaceRows))
  return { width, height, listRows: height - PICKER_CHROME_ROWS }
}

/** One picker row, split into the columns the renderer draws. */
export interface PickerRowParts {
  readonly marker: string
  readonly glyph?: string
  readonly code?: string
  readonly status?: string
  readonly title: string
  readonly trailing?: string
}

export interface PickerRowLine {
  readonly marker: string
  readonly glyph: string
  readonly detail: string
  readonly title: string
  readonly trailing: string
}

function padCells(text: string, cells: number): string {
  const width = displayWidth(text)
  return width >= cells ? text : `${text}${" ".repeat(cells - width)}`
}

/**
 * Fit one row into `width` cells. Optional columns are dropped widest-first
 * (`trailing`, then `status`, then `code`) so the title keeps at least
 * `MIN_TITLE_CELLS` before it is truncated with an ellipsis. The title is then
 * padded, which pins the trailing column to one column, and the sum of every
 * returned segment always stays within `width`.
 */
export function layoutPickerRow(parts: PickerRowParts, width: number): PickerRowLine {
  const total = Math.max(1, Math.floor(width))
  const marker = parts.marker
  const glyph = parts.glyph === undefined || parts.glyph === "" ? "" : `${parts.glyph} `
  const code = parts.code === undefined || parts.code === "" ? "" : `${parts.code} · `
  const status =
    parts.status === undefined || parts.status === "" ? "" : `${padCells(parts.status, PICKER_STATUS_COLUMNS)} · `
  const trailing = parts.trailing === undefined || parts.trailing === "" ? "" : `  ${parts.trailing}`
  const candidates = [
    { code, status, trailing },
    { code, status, trailing: "" },
    { code, status: "", trailing: "" },
    { code: "", status: "", trailing: "" },
  ]
  const lead = displayWidth(marker) + displayWidth(glyph)
  for (const candidate of candidates) {
    const detail = candidate.code + candidate.status
    const fixed = lead + displayWidth(detail) + displayWidth(candidate.trailing)
    const budget = total - fixed - ROW_SLACK
    if (budget >= MIN_TITLE_CELLS) {
      return {
        marker,
        glyph,
        detail,
        title: padCells(truncateCells(parts.title, budget), budget),
        trailing: candidate.trailing,
      }
    }
  }
  // Narrower than any readable layout: keep a one-cell title and let the
  // marker absorb the overflow so the row can never wrap or misalign.
  const room = Math.max(1, total - ROW_SLACK)
  const narrowMarker = truncateCells(`${marker}${glyph}`, Math.max(0, room - 1))
  const narrowBudget = Math.max(1, room - displayWidth(narrowMarker))
  return {
    marker: narrowMarker,
    glyph: "",
    detail: "",
    title: padCells(truncateCells(parts.title, narrowBudget), narrowBudget),
    trailing: "",
  }
}

/** Header title, truncated so the `esc` close label always has room. */
export function layoutTitle(title: string, width: number): string {
  return truncateCells(title, Math.max(1, Math.floor(width) - 4))
}

/** Footer hint; the same keys the built-in select dialog listens for. */
export const PICKER_HELP = "↑↓ 移动 · PgUp/PgDn 翻页 · Home/End · ⏎ 选择 · esc 取消"

/**
 * Move the cursor by `delta` and clamp it to the result set. The built-in
 * select list clamps the same way (no wrap), and an empty list keeps the
 * cursor at zero.
 */
export function moveSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return Math.min(Math.max(0, current + delta), count - 1)
}

/**
 * First row of the visible window once the cursor at `index` has to be on
 * screen. `start` is kept while the cursor is inside the window, so scrolling
 * feels like the built-in list: it only moves when the cursor leaves.
 */
export function windowStart(index: number, start: number, visible: number): number {
  if (visible <= 0) return Math.max(0, index)
  if (index < start) return Math.max(0, index)
  if (index >= start + visible) return Math.max(0, index - visible + 1)
  return Math.max(0, start)
}

export interface PickerHelpLine {
  readonly hint: string
  readonly counter: string
}

/** Fit the help line and the match counter into one row, dropping the counter first. */
export function layoutHelp(width: number, matched: number, total: number): PickerHelpLine {
  const room = Math.max(1, Math.floor(width))
  const counter = matched === total ? `${total} 项` : `${matched}/${total} 项`
  const counterWidth = displayWidth(counter)
  if (displayWidth(PICKER_HELP) + counterWidth + 2 <= room) return { hint: PICKER_HELP, counter }
  const hint = truncateCells(PICKER_HELP, Math.max(0, room - counterWidth - 1))
  if (displayWidth(hint) + counterWidth + 1 <= room) return { hint, counter }
  return { hint: truncateCells(PICKER_HELP, room), counter: "" }
}
