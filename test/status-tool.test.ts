import { beforeEach, describe, expect, test } from "bun:test"
import { statusText } from "../src/dispatch.js"
import { store, type WorkerRecord, type WorkerState } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import { WORKER_STATES } from "../src/worker-state.js"

/**
 * The `status` tool reply lands in the Router history as a tool result, so its
 * size is a permanent input-token cost. These tests pin the compaction rules:
 * live workers only by default, bounded optional history, no reports by
 * default, and a hard cap on the whole text.
 */

const TEXT_LIMIT = 2000
const FINISHED_LIMIT = 20
const REPORT_LIMIT = 120

function worker(sessionID: string, state: WorkerState, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threadID: "thread:1",
    threads: ["thread:1"],
    state,
    createdAt: 1_000,
    ...overrides,
  }
}

beforeEach(() => {
  resetTickets()
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.pending.length = 0
  store.routerID = undefined
})

describe("status tool text", () => {
  test("default lists only active workers and no reports", () => {
    store.routerID = "ses_router"
    store.workers.set("ses_running", worker("ses_running", "running", { title: "在跑", lastReport: "旧的中间报告" }))
    store.workers.set("ses_idle", worker("ses_idle", "idle", { title: "待唤醒" }))
    for (const state of ["done", "failed", "aborted"] as const) {
      store.workers.set(`ses_${state}`, worker(`ses_${state}`, state, { title: state, lastReport: `${state} 结论` }))
    }

    const text = statusText()

    expect(text).toContain("workers=5 active=2")
    expect(text).toContain("ses_running")
    expect(text).toContain("ses_idle")
    for (const state of ["done", "failed", "aborted"]) {
      expect(text).not.toContain(`ses_${state}`)
    }
    // No worker report text at all: reports are what made the reply huge.
    expect(text).not.toContain("旧的中间报告")
    expect(text).not.toContain("结论")
    expect(text).toContain("3 finished worker(s) hidden")
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT)
  })

  test("a gateway with only finished workers stays tiny", () => {
    for (let i = 0; i < 30; i++) {
      store.workers.set(`ses_done_${i}`, worker(`ses_done_${i}`, "done", { lastReport: "x".repeat(4_000) }))
    }
    const text = statusText()
    expect(text).toContain("(no active workers)")
    expect(text).toContain("workers=30 active=0")
    expect(text).toContain("30 finished worker(s) hidden")
    expect(text).not.toContain("ses_done_")
    expect(text.length).toBeLessThan(400)
  })

  test("includeFinished lists recent finished workers, capped and shortened", () => {
    store.workers.set("ses_live", worker("ses_live", "running", { title: "活跃" }))
    for (let i = 0; i < 25; i++) {
      const report = `report-${i} ` + "y".repeat(500)
      store.workers.set(
        `ses_done_${i}`,
        worker(`ses_done_${i}`, "done", { title: `完成任务${i}`, lastReport: report, updatedAt: 2_000 + i }),
      )
    }

    const text = statusText({ includeFinished: true })

    // Newest first: 24..5 fit in the 20-row window, 0..4 are dropped.
    expect(text).toContain("ses_done_24")
    expect(text).toContain("ses_done_5")
    expect(text).not.toContain("ses_done_4 ")
    expect(text).toContain("... 5 more finished worker(s)")
    // Active workers stay report-free even with includeFinished.
    expect(text).toContain("ses_live")
    expect(text).not.toContain("y".repeat(REPORT_LIMIT + 1))
    expect(text).toContain("report-24")
    expect(text.length).toBeLessThanOrEqual(TEXT_LIMIT)
  })

  test("no active worker report leaks into the finished view", () => {
    store.workers.set("ses_live", worker("ses_live", "running", { lastReport: "活跃报告不该出现" }))
    store.workers.set("ses_done", worker("ses_done", "done", { lastReport: "已完成报告" }))
    const text = statusText({ includeFinished: true })
    expect(text).not.toContain("活跃报告不该出现")
    expect(text).toContain("已完成报告")
  })

  test("50 workers never exceed the hard cap, with or without finished", () => {
    for (let i = 0; i < 25; i++) {
      store.workers.set(
        `ses_live_${i}`,
        worker(`ses_live_${i}`, "running", {
          title: `很长的标题-${i}`.repeat(4),
          threads: ["thread:aaaaaaaaaaaa", "thread:bbbbbbbbbbbb"],
          directory: "/tmp/opencode/a/very/long/working/directory/name/for/the/test",
          lastReport: "z".repeat(2_000),
        }),
      )
      store.workers.set(
        `ses_done_${i}`,
        worker(`ses_done_${i}`, "done", {
          title: `终态任务-${i}`,
          lastReport: "z".repeat(2_000),
          updatedAt: 3_000 + i,
        }),
      )
    }
    expect(store.workers.size).toBe(50)

    const compact = statusText()
    expect(compact).toContain("workers=50 active=25")
    expect(compact.length).toBeLessThanOrEqual(TEXT_LIMIT)
    expect(compact).not.toContain("z".repeat(200))

    const full = statusText({ includeFinished: true })
    expect(full.length).toBeLessThanOrEqual(TEXT_LIMIT)
    // 25 long live rows cannot fit: the cap truncates instead of growing.
    expect(full).toContain("... truncated")
  })

  test("every terminal state is hidden unless asked for", () => {
    for (const state of WORKER_STATES) {
      store.workers.set(`ses_${state}`, worker(`ses_${state}`, state))
    }
    const compact = statusText()
    expect(compact).toContain("active=2") // running + idle only
    for (const state of ["done", "failed", "aborted"] as const) {
      expect(compact).not.toContain(`ses_${state}`)
    }
    const full = statusText({ includeFinished: true })
    for (const state of WORKER_STATES) expect(full).toContain(`ses_${state}`)
  })
})
