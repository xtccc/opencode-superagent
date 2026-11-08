import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { store, type WorkerRecord } from "../src/state.js"
import {
  buildReport,
  decodeReport,
  encodeReport,
  hydrateReports,
  loadReport,
  REPORT_SUMMARY_LIMIT,
  REPORT_TEXT_LIMIT,
  reportKey,
  reportNotice,
  reportStats,
  reportSummary,
  saveReport,
  sliceReport,
} from "../src/report.js"
import { runReportRead, runWorkerDetail } from "../src/recall.js"
import { captureReport } from "../src/watcher.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
function memoryContext(sessions: ReadonlyArray<unknown> = []) {
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
  const context = {
    options: {},
    storage,
    data,
    session: {
      context: () => Effect.succeed(sessions),
      get: () => Effect.succeed({ id: "ses_worker" }),
    },
  } as unknown as Plugin.Context & { data: Map<string, Schema.Json> }
  return context
}

const ROUTER = "ses_router"

function worker(sessionID: string, overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    sessionID,
    threads: ["thread:1"],
    state: "done",
    createdAt: 1_000,
    ...overrides,
  }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return JSON.stringify(exit.cause)
}

function reset() {
  store.workers.clear()
  store.routerID = ROUTER
}

// ── capturing ─────────────────────────────────────────────────────────────────

describe("report capture", () => {
  test("short reports are stored whole and summarised verbatim", () => {
    const text = "全部通过：3 个测试。"
    const record = buildReport("ses_a", text, 42)
    expect(record.length).toBe(text.length)
    expect(record.truncated).toBe(false)
    expect(record.text).toBe("全部通过：3 个测试。")
    expect(record.capturedAt).toBe(42)
    expect(reportSummary(record)).toBe(record.text)
    expect(decodeReport(encodeReport(record))).toEqual(record)
  })

  test("long reports are summarised but stored in full", () => {
    const text = "x".repeat(REPORT_SUMMARY_LIMIT + 500)
    const record = buildReport("ses_a", text)
    expect(record.length).toBe(REPORT_SUMMARY_LIMIT + 500)
    expect(record.truncated).toBe(false)
    expect(record.text.length).toBe(REPORT_SUMMARY_LIMIT + 500)
    const summary = reportSummary(record)
    expect(summary.length).toBe(REPORT_SUMMARY_LIMIT + 1)
    expect(summary.endsWith("…")).toBe(true)
    expect(summary.slice(0, REPORT_SUMMARY_LIMIT)).toBe(text.slice(0, REPORT_SUMMARY_LIMIT))
  })

  test("reports above the hard cap are clipped and marked, never silently dropped", () => {
    const text = "y".repeat(REPORT_TEXT_LIMIT + 123)
    const record = buildReport("ses_a", text)
    expect(record.length).toBe(REPORT_TEXT_LIMIT + 123)
    expect(record.text.length).toBe(REPORT_TEXT_LIMIT)
    expect(record.truncated).toBe(true)
    expect(record.clippedAt).toBe(REPORT_TEXT_LIMIT)
    expect(reportNotice(record)).toContain(`全文长度 ${REPORT_TEXT_LIMIT + 123}`)
    expect(reportNotice(record)).toContain("report_read")
  })

  test("captureReport writes the full text to KV and keeps only a summary on the worker", async () => {
    const ctx = memoryContext()
    const text = `结算报告\n${"行".repeat(3_000)}`
    const record = worker("ses_w1")
    const captured = await succeed(captureReport(ctx, record, text))

    const stored = ctx.data.get(reportKey("ses_w1"))
    expect(stored).toBeDefined()
    expect(decodeReport(stored)?.text).toBe(text)
    expect(decodeReport(stored)?.length).toBe(text.length)
    expect(record.lastReport).toBe(reportSummary(captured))
    expect(record.lastReport?.length).toBe(REPORT_SUMMARY_LIMIT + 1)
    expect(record.lastReport).not.toBe(text)
  })

  test("encode/decode rejects values that cannot be read back", () => {
    expect(decodeReport(undefined)).toBeUndefined()
    expect(decodeReport({ sessionID: "ses_a" } as unknown as Schema.Json)).toBeUndefined()
    expect(decodeReport({ sessionID: "ses_a", text: 1 } as unknown as Schema.Json)).toBeUndefined()
  })
})

// ── paging ────────────────────────────────────────────────────────────────────

describe("report paging", () => {
  const record = buildReport("ses_a", "0123456789".repeat(100))

  test("slices by offset and limit and reports the next page", () => {
    const first = sliceReport(record, 0, 40)
    expect(first.text).toBe(record.text.slice(0, 40))
    expect(first.end).toBe(40)
    expect(first.hasMore).toBe(true)
    expect(first.nextOffset).toBe(40)

    const second = sliceReport(record, first.nextOffset ?? 0, 40)
    expect(second.offset).toBe(40)
    expect(second.text).toBe(record.text.slice(40, 80))
  })

  test("the last page has no successor and a tail shorter than the limit", () => {
    const last = sliceReport(record, 960, 4_000)
    expect(last.text.length).toBe(40)
    expect(last.hasMore).toBe(false)
    expect(last.nextOffset).toBeUndefined()
  })

  test("offset at or past the stored length yields an empty slice", () => {
    const beyond = sliceReport(record, record.text.length, 100)
    expect(beyond.text).toBe("")
    expect(beyond.hasMore).toBe(false)
    const clamped = sliceReport(record, record.text.length + 50, 100)
    expect(clamped.text).toBe("")
  })
})

// ── report_read tool ──────────────────────────────────────────────────────────

describe("report_read", () => {
  test("pages through a stored report and flags the end", async () => {
    reset()
    const ctx = memoryContext()
    const text = "abcdefghij".repeat(1_000)
    await succeed(saveReport(ctx, buildReport("ses_w1", text, 1_700_000_000_000)))

    const first = await succeed(runReportRead(ctx, { sessionID: "ses_w1", limit: 4_000 }, ROUTER))
    expect(first.output.text).toContain(`全文 ${text.length} 字`)
    expect(first.output.text).toContain(text.slice(0, 4_000))
    expect(first.output.text).toContain("还有后续")

    const second = await succeed(runReportRead(ctx, { sessionID: "ses_w1", offset: 4_000, limit: 4_000 }, ROUTER))
    expect(second.output.text).toContain(text.slice(4_000, 8_000))
    expect(second.output.text).toContain("还有后续")

    const last = await succeed(runReportRead(ctx, { sessionID: "ses_w1", offset: 8_000, limit: 4_000 }, ROUTER))
    expect(last.output.text).toContain(text.slice(8_000))
    expect(last.output.text).toContain("已到末尾")
  })

  test("caps the page size and rejects a bad offset", async () => {
    reset()
    const ctx = memoryContext()
    await succeed(saveReport(ctx, buildReport("ses_w1", "z".repeat(30_000), 1)))
    const huge = await succeed(runReportRead(ctx, { sessionID: "ses_w1", limit: 999_999 }, ROUTER))
    expect(huge.output.text).toContain("limit=20000")
    const clampedOffset = await succeed(runReportRead(ctx, { sessionID: "ses_w1", offset: -5 }, ROUTER))
    expect(clampedOffset.output.text).toContain("本次 [0,")
    const beyond = await failure(runReportRead(ctx, { sessionID: "ses_w1", offset: 30_000 }, ROUTER))
    expect(beyond).toContain("超出已存全文长度")
  })

  test("a worker without a stored report fails with a hint", async () => {
    reset()
    const ctx = memoryContext()
    const error = await failure(runReportRead(ctx, { sessionID: "ses_missing" }, ROUTER))
    expect(error).toContain("no stored report")
    expect(error).toContain("worker_detail")
  })

  test("a captured report is readable end to end through report_read", async () => {
    reset()
    const ctx = memoryContext()
    const text = `结论：\n${"证据行\n".repeat(1_200)}尾巴`
    const record = worker("ses_w1")
    const captured = await succeed(captureReport(ctx, record, text))
    expect(record.lastReport).toBe(reportSummary(captured))
    expect(record.lastReport?.length).toBeLessThan(text.length)

    const pages: Array<string> = []
    let offset = 0
    for (let guard = 0; guard < 10; guard++) {
      const page = await succeed(runReportRead(ctx, { sessionID: "ses_w1", offset, limit: 4_000 }, ROUTER))
      const expected = text.slice(offset, offset + 4_000)
      expect(page.output.text).toContain(expected)
      pages.push(expected)
      if (page.output.text.includes("已到末尾")) break
      offset += 4_000
    }
    expect(pages.join("")).toBe(text)
  })

  test("only the router may read a report", async () => {
    reset()
    const ctx = memoryContext()
    await succeed(saveReport(ctx, buildReport("ses_w1", "text", 1)))
    const error = await failure(runReportRead(ctx, { sessionID: "ses_w1" }, "ses_someone"))
    expect(error).toContain("only available to the router")
  })
})

// ── worker_detail ─────────────────────────────────────────────────────────────

describe("worker_detail report handle", () => {
  test("shows the full-report handle and points truncation at report_read", async () => {
    reset()
    const longMessage = "m".repeat(3_000)
    const ctx = memoryContext([{ type: "assistant", content: [{ type: "text", text: longMessage }] }])
    store.workers.set("ses_w1", worker("ses_w1"))
    await succeed(saveReport(ctx, buildReport("ses_w1", "r".repeat(9_000), 1)))

    const detail = await succeed(runWorkerDetail(ctx, { sessionID: "ses_w1" }, ROUTER))
    expect(detail.output.text).toContain("report full: 9000 chars")
    expect(detail.output.text).toContain("report_read")
    expect(detail.output.text).toContain("1500 chars truncated")
    expect(detail.output.text).toContain('用 report_read(sessionID: "ses_w1") 读取全文')
  })

  test("names a missing report instead of pretending it exists", async () => {
    reset()
    const ctx = memoryContext()
    store.workers.set("ses_w1", worker("ses_w1"))
    const detail = await succeed(runWorkerDetail(ctx, { sessionID: "ses_w1" }, ROUTER))
    expect(detail.output.text).toContain("report full: none")
    expect(detail.output.text).not.toContain("report_read(sessionID:")
  })
})

// ── hydration ─────────────────────────────────────────────────────────────────

describe("report hydration", () => {
  test("measures stored reports and drops unreadable entries", async () => {
    const ctx = memoryContext()
    await succeed(saveReport(ctx, buildReport("ses_a", "a".repeat(1_000), 1)))
    await succeed(saveReport(ctx, buildReport("ses_b", "b".repeat(REPORT_TEXT_LIMIT + 10), 2)))
    ctx.data.set(reportKey("ses_bad"), { nope: true } as unknown as Schema.Json)

    await succeed(hydrateReports(ctx))
    const stats = reportStats()
    expect(stats.entries).toBe(2)
    expect(stats.chars).toBe(1_000 + REPORT_TEXT_LIMIT + 10)
    expect(stats.truncated).toBe(1)
    expect(ctx.data.has(reportKey("ses_bad"))).toBe(false)
    expect(ctx.data.has(reportKey("ses_a"))).toBe(true)
  })

  test("loading a report round-trips through KV", async () => {
    const ctx = memoryContext()
    const record = buildReport("ses_a", "hello", 7)
    await succeed(saveReport(ctx, record))
    expect(await succeed(loadReport(ctx, "ses_a"))).toEqual(record)
    expect(await succeed(loadReport(ctx, "ses_absent"))).toBeUndefined()
  })
})
