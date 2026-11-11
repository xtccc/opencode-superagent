/**
 * `src/tui-picker.ts` pins the picker geometry: the dialog must be much larger
 * than the host's fixed select frame, and a narrow terminal must degrade into
 * fewer columns and rows instead of overflowing.
 */

import { describe, expect, test } from "bun:test"
import {
  computeDialogSize,
  layoutHelp,
  layoutPickerRow,
  PICKER_CHROME_ROWS,
  PICKER_FRAME_ROWS,
  PICKER_HELP,
  PICKER_MARGIN_COLS,
  PICKER_MARKER,
  PICKER_MARKER_IDLE,
  PICKER_MAX_COLS,
  PICKER_MAX_ROWS,
  PICKER_MIN_COLS,
  PICKER_MIN_ROWS,
  moveSelection,
  windowStart,
  layoutTitle,
} from "../src/tui-picker"
import { displayWidth } from "../src/tools"

/** Visible entries the built-in `dialog.select` list fits for a terminal height. */
function builtinListRows(termRows: number): number {
  return Math.floor(termRows / 2) - 6
}

describe("computeDialogSize", () => {
  test("standard 120x40 terminal uses the ratio clamp and the widest frame", () => {
    const size = computeDialogSize(120, 40)
    expect(size.width).toBe(PICKER_MAX_COLS)
    expect(size.height).toBe(PICKER_MAX_ROWS)
    expect(size.listRows).toBe(PICKER_MAX_ROWS - PICKER_CHROME_ROWS)
  })

  test("narrow 80x24 terminal stays inside the screen and beats the built-in list", () => {
    const size = computeDialogSize(80, 24)
    expect(size.width).toBe(76)
    expect(size.height).toBe(18)
    expect(size.listRows).toBe(12)
    // The built-in list shows 6 rows here; the picker doubles it.
    expect(size.listRows).toBeGreaterThan(builtinListRows(24))
    expect(size.width).toBeLessThanOrEqual(80 - 2)
    expect(size.height).toBeLessThanOrEqual(24 - 2)
  })

  test("every terminal size stays inside the screen", () => {
    for (const cols of [20, 30, 40, 60, 80, 100, 120, 160, 200, 400]) {
      for (const rows of [10, 12, 16, 24, 30, 40, 60, 90]) {
        const size = computeDialogSize(cols, rows)
        expect(size.width).toBeGreaterThan(0)
        expect(size.width).toBeLessThanOrEqual(Math.max(8, cols - 4))
        expect(size.height).toBeLessThanOrEqual(Math.max(PICKER_CHROME_ROWS + 1, rows - 3))
        expect(size.listRows).toBeGreaterThanOrEqual(1)
        expect(size.height).toBe(size.listRows + PICKER_CHROME_ROWS)
        // The 75% target is honoured whenever the terminal allows it.
        if (rows >= 30) expect(size.height).toBeGreaterThanOrEqual(PICKER_MIN_ROWS)
      }
    }
  })

  test("ultra-wide and ultra-tall terminals are capped, not stretched", () => {
    const size = computeDialogSize(400, 120)
    expect(size.width).toBe(PICKER_MAX_COLS)
    expect(size.height).toBe(PICKER_MAX_ROWS)
  })

  test("tiny terminals degrade instead of overflowing", () => {
    const size = computeDialogSize(40, 12)
    expect(size.width).toBe(36)
    expect(size.width).toBeLessThanOrEqual(40 - 2)
    expect(size.height).toBeLessThanOrEqual(12 - 2)
    expect(size.listRows).toBeGreaterThanOrEqual(1)
    // No width clamp is applied below PICKER_MIN_COLS: all columns are used.
    expect(size.width).toBeLessThan(PICKER_MIN_COLS)
  })

  test("growth is monotonic in terminal height until the cap", () => {
    let previous = 0
    for (const rows of [14, 18, 24, 30, 34, 40]) {
      const size = computeDialogSize(120, rows)
      expect(size.listRows).toBeGreaterThanOrEqual(previous)
      previous = size.listRows
    }
  })

  test("list rows beat the built-in select on common terminal heights", () => {
    for (const rows of [24, 30, 40, 50]) {
      expect(computeDialogSize(120, rows).listRows).toBeGreaterThan(builtinListRows(rows))
    }
  })

  test("the dialog body takes 70-80% of the terminal on common heights", () => {
    for (const rows of [24, 30, 36, 40]) {
      const share = computeDialogSize(120, rows).height / rows
      expect(share).toBeGreaterThanOrEqual(0.7)
      expect(share).toBeLessThanOrEqual(0.8)
    }
  })

  test("the body plus the host frame and margins always fits the screen", () => {
    for (const cols of [24, 40, 60, 80, 120, 200]) {
      for (const rows of [10, 12, 24, 40, 60]) {
        const size = computeDialogSize(cols, rows)
        expect(size.width + PICKER_MARGIN_COLS).toBeLessThanOrEqual(cols)
        expect(size.height + PICKER_FRAME_ROWS).toBeLessThanOrEqual(rows)
      }
    }
  })
})

describe("layoutPickerRow", () => {
  const parts = {
    marker: PICKER_MARKER,
    glyph: "●",
    code: "dc8d",
    status: "in_progress",
    title: "放大 /tickets 选择器窗口并做窄终端自适应",
    trailing: "p1",
  }

  test("a wide row keeps the short id, the state and the whole title", () => {
    const line = layoutPickerRow(parts, 112)
    expect(line.detail).toContain("dc8d")
    expect(line.detail).toContain("in_progress")
    expect(line.title.trimEnd()).toBe(parts.title)
    expect(line.trailing.trim()).toBe("p1")
  })

  test("the title column is padded so the trailing column lines up", () => {
    const short = layoutPickerRow({ ...parts, title: "短" }, 112)
    const long = layoutPickerRow({ ...parts, title: "放大 /tickets 选择器窗口并做窄终端自适应" }, 112)
    expect(displayWidth(short.title)).toBe(displayWidth(long.title))
    expect(displayWidth(short.title) + displayWidth(short.trailing)).toBe(112 - 1 - displayWidth(short.marker) - displayWidth(short.glyph) - displayWidth(short.detail))
  })

  test("rows never exceed the given width, at any width or title length", () => {
    const titles = [parts.title, "短标题", "", "x".repeat(300), "标题".repeat(120)]
    for (const width of [12, 20, 30, 40, 60, 76, 112]) {
      for (const title of titles) {
        const line = layoutPickerRow({ ...parts, title }, width)
        const used =
          displayWidth(line.marker) +
          displayWidth(line.glyph) +
          displayWidth(line.detail) +
          displayWidth(line.title) +
          displayWidth(line.trailing)
        expect(used).toBeLessThanOrEqual(width)
      }
    }
  })

  test("narrow rows drop the trailing column first, then the state", () => {
    const wide = layoutPickerRow(parts, 112)
    const medium = layoutPickerRow(parts, 30)
    const narrow = layoutPickerRow(parts, 18)
    expect(wide.trailing).not.toBe("")
    expect(medium.trailing).toBe("")
    expect(medium.detail).toContain("dc8d")
    expect(medium.detail).not.toContain("in_progress")
    expect(narrow.detail).toBe("")
    expect(narrow.title).not.toBe("")
  })

  test("the title never gets less than a few cells", () => {
    const line = layoutPickerRow(parts, 30)
    expect(displayWidth(line.title.trimEnd())).toBeGreaterThanOrEqual(8)
    expect(line.title.trimEnd().endsWith("…")).toBe(true)
  })

  test("an idle row keeps the same gutter as the selected one", () => {
    const idle = layoutPickerRow({ ...parts, marker: PICKER_MARKER_IDLE }, 76)
    const active = layoutPickerRow(parts, 76)
    expect(displayWidth(idle.marker)).toBe(displayWidth(active.marker))
  })

  test("an 80x24 picker still fits short id, state and a whole title on one line", () => {
    const size = computeDialogSize(80, 24)
    const line = layoutPickerRow(
      { marker: PICKER_MARKER, glyph: "●", code: "dc8d", status: "in_progress", title: "放大 /tickets 选择器窗口并做窄终端自适应", trailing: "p1" },
      size.width,
    )
    // Nothing is dropped or clipped at the narrow-terminal width.
    expect(line.detail).toContain("dc8d")
    expect(line.detail).toContain("in_progress")
    expect(line.title.trimEnd()).toBe("放大 /tickets 选择器窗口并做窄终端自适应")
    expect(line.title).not.toContain("…")
    expect(line.trailing.trim()).toBe("p1")
    const used =
      displayWidth(line.marker) +
      displayWidth(line.glyph) +
      displayWidth(line.detail) +
      displayWidth(line.title) +
      displayWidth(line.trailing)
    expect(used).toBeLessThanOrEqual(size.width)
  })
})

describe("layoutTitle", () => {
  test("short titles are untouched", () => {
    expect(layoutTitle("Superagent tickets · 工单 4", 76)).toBe("Superagent tickets · 工单 4")
  })

  test("long titles leave room for the esc label", () => {
    const title = layoutTitle("Superagent tickets · 工单 40 · worker 12 · 很长的标题".repeat(3), 36)
    expect(displayWidth(title) + 3).toBeLessThanOrEqual(36)
    expect(title.endsWith("…")).toBe(true)
  })
})

describe("selection and scrolling", () => {
  test("the cursor clamps at both ends instead of wrapping", () => {
    expect(moveSelection(0, -1, 5)).toBe(0)
    expect(moveSelection(4, 1, 5)).toBe(4)
    expect(moveSelection(2, -1, 5)).toBe(1)
    expect(moveSelection(2, 1, 5)).toBe(3)
  })

  test("page and home/end jumps clamp like the built-in list", () => {
    expect(moveSelection(0, 12, 40)).toBe(12)
    expect(moveSelection(3, -12, 40)).toBe(0)
    expect(moveSelection(9, 40, 40)).toBe(39)
    expect(moveSelection(9, -40, 40)).toBe(0)
  })

  test("an empty result set keeps the cursor at zero", () => {
    expect(moveSelection(3, 1, 0)).toBe(0)
    expect(moveSelection(0, -1, 0)).toBe(0)
  })

  test("the window only moves when the cursor leaves it", () => {
    // Inside the window: nothing scrolls.
    expect(windowStart(3, 0, 12)).toBe(0)
    expect(windowStart(11, 0, 12)).toBe(0)
    // Leaving at the bottom: the window follows one row at a time.
    expect(windowStart(12, 0, 12)).toBe(1)
    expect(windowStart(20, 0, 12)).toBe(9)
    // Leaving at the top: the cursor becomes the first visible row.
    expect(windowStart(4, 9, 12)).toBe(4)
    expect(windowStart(0, 9, 12)).toBe(0)
  })

  test("a narrowed terminal keeps the cursor visible after shrinking", () => {
    // 24-row terminal: 12 list rows; 60-row terminal: 24.
    const small = computeDialogSize(80, 24).listRows
    const large = computeDialogSize(200, 60).listRows
    const start = windowStart(20, 0, large)
    expect(start + large).toBeGreaterThan(20)
    // The same cursor still fits the smaller window after the resize.
    expect(windowStart(20, start, small) + small).toBeGreaterThan(20)
  })
})

describe("layoutHelp", () => {
  test("keeps the whole help line and the counter when there is room", () => {
    const help = layoutHelp(112, 4, 9)
    expect(help.hint).toBe(PICKER_HELP)
    expect(help.counter).toBe("4/9 项")
    expect(displayWidth(help.hint) + displayWidth(help.counter)).toBeLessThanOrEqual(112)
  })

  test("shows a plain count when every row matches", () => {
    expect(layoutHelp(112, 9, 9).counter).toBe("9 项")
  })

  test("drops the counter before it can overflow a narrow terminal", () => {
    const help = layoutHelp(30, 4, 9)
    expect(displayWidth(help.hint) + displayWidth(help.counter)).toBeLessThanOrEqual(30)
    expect(help.hint.length).toBeGreaterThan(0)
  })

  test("never exceeds the width it was given", () => {
    for (const width of [8, 16, 24, 40, 76, 112]) {
      const help = layoutHelp(width, 3, 40)
      expect(displayWidth(help.hint) + displayWidth(help.counter)).toBeLessThanOrEqual(width)
    }
  })

  test("the 80x24 help line keeps every key hint and the counter", () => {
    const width = computeDialogSize(80, 24).width
    const help = layoutHelp(width, 40, 40)
    expect(help.hint).toBe(PICKER_HELP)
    expect(help.counter).toBe("40 项")
    expect(displayWidth(help.hint) + displayWidth(help.counter)).toBeLessThanOrEqual(width)
  })
})
