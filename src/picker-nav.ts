/**
 * `/tickets` navigation: the list pane and the detail pane, and the keys that
 * move between them.
 *
 * The picker is two levels deep. `⏎` on a list row opens that row's detail
 * (never a session — a wrong jump is expensive to undo), and the detail pane is
 * where `⏎` enters the worker session. `q` / `esc` go back one level, so a
 * browse never traps the user: list → detail → back to the list with the same
 * query and cursor, and from the list `q` closes the picker.
 *
 * Everything in this module is pure so the transitions can be pinned by
 * `test/picker-nav.test.ts`; `tui.tsx` only renders the result and awaits RPCs.
 */

import { PICKER_NAV_KEYS } from "./tui-picker.js"

/** Which pane the picker shows. */
export type TicketPane = "list" | "detail"

/** Keys the state machine understands; every other key belongs to the pane. */
export type TicketKey = "enter" | "back" | "quit"

/** The row under the cursor, reduced to what navigation needs. */
export interface TicketNavRow {
  readonly kind: "ticket" | "worker"
  /**
   * Session `⏎` would enter from the detail pane. Known immediately for a
   * worker row; for a ticket it arrives with the loaded detail, so it is
   * absent while the detail is still loading.
   */
  readonly sessionID?: string
}

/** What one key press does; the caller renders it or awaits it. */
export type TicketStep =
  | { readonly kind: "open-detail" }
  | { readonly kind: "back-to-list" }
  | { readonly kind: "close" }
  | { readonly kind: "jump"; readonly sessionID: string }
  | { readonly kind: "notice"; readonly message: string }

/** Shown when a ticket never had a worker, so there is no session to enter. */
export const NO_SESSION_MESSAGE = "该工单暂无会话"

/** Shown when the recorded worker session is gone from the session store. */
export function missingSessionMessage(sessionID: string): string {
  return `该工单的会话 ${sessionID} 不可用（可能已不存在）`
}

/**
 * The transition for one key press. A ticket without a worker (or one whose
 * detail has not loaded yet) keeps the user on the detail pane and says why,
 * instead of silently doing nothing.
 */
export function ticketStep(pane: TicketPane, key: TicketKey, row: TicketNavRow | undefined): TicketStep {
  if (pane === "list") {
    if (key === "enter") return row === undefined ? { kind: "notice", message: "没有可查看的行" } : { kind: "open-detail" }
    return { kind: "close" }
  }
  if (key === "enter") {
    if (row?.sessionID === undefined) return { kind: "notice", message: NO_SESSION_MESSAGE }
    return { kind: "jump", sessionID: row.sessionID }
  }
  return { kind: "back-to-list" }
}

/**
 * Resolve the list's six-character `w=…` tail to a full session id. Only a
 * unique match counts: two worker records can share a tail, and the ticket
 * detail carries the exact id, so a guess is never worth it.
 */
export function workerBySuffix(sessions: ReadonlyArray<string>, suffix: string | undefined): string | undefined {
  const needle = suffix?.trim() ?? ""
  if (needle === "") return undefined
  const matches = sessions.filter((sessionID) => sessionID.endsWith(needle))
  return matches.length === 1 ? matches[0] : undefined
}

/** List pane hint: `⏎` opens a detail, `q` leaves, `/` starts a search. */
export const LIST_HINT = `${PICKER_NAV_KEYS} · ⏎ 详情 · q 退出 · / 搜索`

/** Same pane while the search field owns the keyboard. */
export const SEARCH_HINT = "输入筛选 · ↑↓ 移动 · ⏎ 详情 · esc 结束搜索"

/** Detail pane hint: `⏎` enters the session, `q` goes back to the list. */
export const DETAIL_HINT = "↑↓/PgUp/PgDn 滚动 · ⏎ 进入会话 · q 返回"

/** Footer hint for the current pane and mode; the search field is a third mode. */
export function ticketHint(pane: TicketPane, searching: boolean): string {
  if (pane === "detail") return DETAIL_HINT
  return searching ? SEARCH_HINT : LIST_HINT
}
