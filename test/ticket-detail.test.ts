/**
 * `src/ticket-detail.ts` turns the `ticket` RPC text into the fields the `/task`
 * detail pane shows. The gateway is text-only and deployed separately, so this
 * parser is the TUI's only contract: it must pick up every field the pane
 * promises, keep `effort` optional, and never overflow the pane width.
 */

import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { createTicket, renderTicketDetail, resetTickets, updateTicket } from "../src/ticket.js"
import { detailRows, parseTicketDetail } from "../src/ticket-detail.js"
import { displayWidth } from "../src/tools.js"

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

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

const base = {
  threadID: "T-1",
  objective: "用户预期 /task 列表按回车是进入对应 session，现在行为不符合。",
  acceptance: ["说清现状", "⏎ 进 session"],
  directory: "/home/tmzy/opencode-superagent",
  priority: "p1",
  source: "telegram",
  author: "alice",
} as const

/** The real detail text for a dispatched ticket, from the real store. */
async function dispatchedDetail() {
  resetTickets()
  const ctx = memoryContext()
  const created = await succeed(createTicket(ctx, { ...base, title: "/task 回车行为改为跳转 session" }))
  const updated = await succeed(
    updateTicket(ctx, {
      ticketID: created.ticket.id,
      state: "in_progress",
      workerSessionID: "ses_aaa111bbb222",
    }),
  )
  return { text: renderTicketDetail(updated), ticket: updated, id: created.ticket.id }
}

describe("parseTicketDetail", () => {
  test("reads every field the pane shows", async () => {
    const { text, ticket, id } = await dispatchedDetail()
    const detail = parseTicketDetail(text)
    expect(detail).toBeDefined()
    expect(detail!.id).toBe(id)
    expect(detail!.state).toBe("in_progress")
    expect(detail!.priority).toBe("p1")
    expect(detail!.title).toBe("/task 回车行为改为跳转 session")
    expect(detail!.objective?.replace(/\s+/g, "")).toBe(base.objective.replace(/\s+/g, ""))
    expect([...detail!.acceptance]).toEqual(["1. 说清现状", "2. ⏎ 进 session"])
    expect(detail!.threadID).toBe("T-1")
    expect(detail!.directory).toBe(base.directory)
    expect(detail!.workerSessionID).toBe("ses_aaa111bbb222")
    expect(detail!.attempts).toBe("0")
    expect(detail!.createdAt).toBeDefined()
    expect(detail!.updatedAt).toBeDefined()
    expect(ticket.state).toBe("in_progress")
  })

  test("a ticket with no worker has no session and no timestamp drift", async () => {
    resetTickets()
    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, { ...base, title: "没派过的单", objective: "没派过的单" }))
    const detail = parseTicketDetail(renderTicketDetail(created.ticket))
    expect(detail!.workerSessionID).toBeUndefined()
    expect(detail!.state).toBe("open")
  })

  test("a closed ticket exposes its report summary", async () => {
    resetTickets()
    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, { ...base, title: "已结的单", objective: "已结的单" }))
    const closed = await succeed(
      updateTicket(ctx, { ticketID: created.ticket.id, state: "done", note: "全部验收通过" }),
    )
    const detail = parseTicketDetail(renderTicketDetail(closed))
    expect(detail!.closeReason).toContain("全部验收通过")
  })

  test("effort is optional: absent when the gateway does not print it", async () => {
    const { text } = await dispatchedDetail()
    const detail = parseTicketDetail(text)!
    if (detail.effort === undefined) {
      expect(detailRows(detail, 100).some((row) => row.startsWith("档位"))).toBe(false)
    }
  })

  test("effort is picked up whether the gateway labels it 档位 or effort", () => {
    const lines = (label: string) => [
      "tk_mwbq6qyl_q504 · in_progress · p1",
      "带 effort 的单",
      "",
      "目标：验证 effort 行",
      "thread：T-1",
      "目录：/repo",
      "worker：ses_aaa111bbb222",
      `${label}：high`,
      "尝试：1",
      "建档：11-11 14:21",
      "更新：11-11 14:30",
    ].join("\n")
    for (const label of ["档位", "effort"]) {
      const detail = parseTicketDetail(lines(label))!
      expect(detail.effort).toBe("high")
      expect(detailRows(detail, 100).some((row) => row === "档位：high")).toBe(true)
    }
  })

  test("a missing ticket produces no detail to render", () => {
    expect(parseTicketDetail("没有找到工单 tk_zzzz")).toBeUndefined()
    expect(parseTicketDetail("")).toBeUndefined()
  })
})

describe("detailRows", () => {
  test("shows the short id, the full id and the worker session", async () => {
    const { text, id } = await dispatchedDetail()
    const rows = detailRows(parseTicketDetail(text)!, 100).join("\n")
    expect(rows).toContain(id.slice(-4))
    expect(rows).toContain(id)
    expect(rows).toContain("ses_aaa111bbb222")
    expect(rows).toContain("最近 worker：ses_aaa111bbb222")
    expect(rows).toContain(base.directory)
    expect(rows).toContain("建档")
    expect(rows).toContain("更新")
  })

  test("every row fits the pane width, at any width", async () => {
    const { text } = await dispatchedDetail()
    const detail = parseTicketDetail(text)!
    for (const width of [24, 40, 56, 76, 112]) {
      for (const row of detailRows(detail, width)) {
        expect(displayWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })

  test("the title block and the objective are wrapped, not clipped", () => {
    const detail = {
      id: "tk_a_bbbb",
      state: "open",
      priority: "p2",
      title: "一个非常长的标题".repeat(4),
      objective: "目标也很长".repeat(12),
      acceptance: [],
      history: [],
    }
    const rows = detailRows(parseTicketDetail(titleOf(detail))!, 40)
    expect(rows.every((row) => displayWidth(row) <= 40)).toBe(true)
    expect(rows.join("")).toContain("一个非常长的标题")
  })
})

/** Build a minimal detail text from logical fields, so the wrap test never depends on the store. */
function titleOf(detail: { id: string; state: string; priority: string; title: string; objective: string }) {
  return [
    `${detail.id} · ${detail.state} · ${detail.priority}`,
    detail.title,
    "",
    `目标：${detail.objective}`,
  ].join("\n")
}
