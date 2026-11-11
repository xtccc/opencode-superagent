/**
 * `src/picker-nav.ts` pins the two-level `/task` navigation: `⏎` on a list row
 * opens the detail, the detail's `⏎` enters that row's worker session, and
 * `q` / `esc` go back one level. A ticket whose session is unknown must say so
 * instead of jumping nowhere, and the list's query/cursor survive a round trip
 * because only the pane changes.
 */

import { describe, expect, test } from "bun:test"
import {
  DETAIL_HINT,
  LIST_HINT,
  missingSessionMessage,
  NO_SESSION_MESSAGE,
  SEARCH_HINT,
  taskHint,
  taskStep,
  workerBySuffix,
  type TaskNavRow,
} from "../src/picker-nav"
import { computeDialogSize, layoutHint } from "../src/tui-picker"
import { displayWidth } from "../src/tools"

const ticketWithWorker: TaskNavRow = { kind: "ticket", sessionID: "ses_worker" }
const ticketWithoutWorker: TaskNavRow = { kind: "ticket" }

describe("taskStep: list pane", () => {
  test("⏎ opens the detail and never jumps straight to a session", () => {
    expect(taskStep("list", "enter", ticketWithWorker)).toEqual({ kind: "open-detail" })
    expect(taskStep("list", "enter", ticketWithoutWorker)).toEqual({ kind: "open-detail" })
  })

  test("q and esc close the browser", () => {
    expect(taskStep("list", "quit", ticketWithWorker)).toEqual({ kind: "close" })
    expect(taskStep("list", "back", ticketWithWorker)).toEqual({ kind: "close" })
  })

  test("an empty list has nothing to open", () => {
    const step = taskStep("list", "enter", undefined)
    expect(step.kind).toBe("notice")
  })
})

describe("taskStep: detail pane", () => {
  test("⏎ enters the session of the row", () => {
    expect(taskStep("detail", "enter", ticketWithWorker)).toEqual({
      kind: "jump",
      sessionID: "ses_worker",
    })
    expect(taskStep("detail", "enter", { kind: "worker", sessionID: "ses_w2" })).toEqual({
      kind: "jump",
      sessionID: "ses_w2",
    })
  })

  test("a ticket without a worker says so instead of navigating", () => {
    const step = taskStep("detail", "enter", ticketWithoutWorker)
    expect(step).toEqual({ kind: "notice", message: NO_SESSION_MESSAGE })
    // Still loading reads the same way: no silent no-op.
    expect(taskStep("detail", "enter", undefined).kind).toBe("notice")
  })

  test("q and esc go back to the list, one level only", () => {
    expect(taskStep("detail", "quit", ticketWithWorker)).toEqual({ kind: "back-to-list" })
    expect(taskStep("detail", "back", ticketWithWorker)).toEqual({ kind: "back-to-list" })
  })

  test("the round trip list → detail → list is stable", () => {
    const state: { pane: "list" | "detail" } = { pane: "list" }
    /** Read through a function so the assertion is not narrowed by the writes below. */
    const pane = (): "list" | "detail" => state.pane
    const apply = (key: "enter" | "back" | "quit", row: TaskNavRow) => {
      const step = taskStep(state.pane, key, row)
      if (step.kind === "open-detail") state.pane = "detail"
      if (step.kind === "back-to-list") state.pane = "list"
      return step
    }
    expect(apply("enter", ticketWithWorker).kind).toBe("open-detail")
    expect(pane()).toBe("detail")
    expect(apply("quit", ticketWithWorker).kind).toBe("back-to-list")
    expect(pane()).toBe("list")
    // The same row still opens the same detail afterwards.
    expect(apply("enter", ticketWithWorker).kind).toBe("open-detail")
    expect(pane()).toBe("detail")
  })

  test("a deleted session is reported with its id", () => {
    expect(missingSessionMessage("ses_gone")).toContain("ses_gone")
  })
})

describe("workerBySuffix", () => {
  const sessions = ["ses_aaaaaa111111", "ses_bbbbbb222222"]

  test("a unique tail resolves to the full id", () => {
    expect(workerBySuffix(sessions, "111111")).toBe("ses_aaaaaa111111")
  })

  test("nothing, an empty tail and an ambiguous tail resolve to nothing", () => {
    expect(workerBySuffix(sessions, "999999")).toBeUndefined()
    expect(workerBySuffix(sessions, "")).toBeUndefined()
    expect(workerBySuffix(sessions, undefined)).toBeUndefined()
    expect(workerBySuffix(["ses_aaa111111", "ses_bbb111111"], "111111")).toBeUndefined()
  })
})

describe("taskHint", () => {
  test("the list advertises detail, quit and search", () => {
    expect(taskHint("list", false)).toBe(LIST_HINT)
    expect(LIST_HINT).toContain("⏎ 详情")
    expect(LIST_HINT).toContain("q 退出")
    expect(LIST_HINT).toContain("/ 搜索")
  })

  test("the search field gets its own hint", () => {
    expect(taskHint("list", true)).toBe(SEARCH_HINT)
    expect(SEARCH_HINT).toContain("esc")
  })

  test("the detail pane advertises the session and the way back", () => {
    expect(taskHint("detail", false)).toBe(DETAIL_HINT)
    expect(DETAIL_HINT).toContain("⏎ 进入会话")
    expect(DETAIL_HINT).toContain("q 返回")
    // Scrolling is the only movement in the detail pane.
    expect(DETAIL_HINT).toContain("PgUp/PgDn 滚动")
    expect(DETAIL_HINT).not.toContain("移动")
  })

  test("no hint claims ⏎ opens a detail on the detail pane", () => {
    expect(taskHint("detail", false)).not.toContain("⏎ 详情")
  })

  test("every hint fits the 80x24 picker", () => {
    const width = computeDialogSize(80, 24).width
    for (const hint of [taskHint("list", false), taskHint("list", true), taskHint("detail", false)]) {
      expect(displayWidth(layoutHint(width, hint))).toBeLessThanOrEqual(width)
      expect(layoutHint(width, hint)).toBe(hint)
    }
  })
})
