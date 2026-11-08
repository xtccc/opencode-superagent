import type { Plugin } from "@opencode/plugin/effect"
import type { Schema } from "effect"
import { Effect } from "effect"

/**
 * Full worker reports ("spill") kept beside the compact `worker:<id>` record.
 *
 * The worker record keeps only a summary (`lastReport`), because it is copied
 * into every router status line and context. The complete text lives under
 * `report:<sessionID>` so `report_read` can page through it after the fact.
 * Reports are intentionally not removed when the worker record disappears: a
 * supervisor may still need the evidence. Growth is only measured and logged
 * (see `hydrateReports`); automatic trimming is a later, separate policy.
 */
export const REPORT_PREFIX = "report:"

/** Hard cap for one stored report. Longer reports are clipped and marked, never silently lost. */
export const REPORT_TEXT_LIMIT = 200_000

/** How much of a report the worker record keeps for status lines and router injections. */
export const REPORT_SUMMARY_LIMIT = 2_000

/** `report_read` paging: default page size, hard cap, and the paging floor. */
export const REPORT_DEFAULT_LIMIT = 4_000
export const REPORT_MAX_LIMIT = 20_000
export const REPORT_MIN_LIMIT = 1

export interface ReportRecord {
  readonly sessionID: string
  /** Stored text: the original, or its first `REPORT_TEXT_LIMIT` characters when clipped. */
  readonly text: string
  /** Length of the original text, before any clipping. */
  readonly length: number
  readonly capturedAt: number
  readonly truncated: boolean
  /** Character offset where the stored text stops, present only when `truncated`. */
  readonly clippedAt?: number
}

export interface ReportSlice {
  readonly text: string
  readonly offset: number
  readonly end: number
  /** Length of the original report. */
  readonly total: number
  /** Length of the stored text, which is smaller than `total` for clipped reports. */
  readonly stored: number
  readonly hasMore: boolean
  readonly nextOffset?: number
}

export interface ReportStats {
  readonly entries: number
  readonly chars: number
  readonly truncated: number
}

export const reportKey = (sessionID: string) => `${REPORT_PREFIX}${sessionID}`

/** Capture-time copy of the text, clipped to the hard cap and tagged with its metadata. */
export function buildReport(sessionID: string, text: string, capturedAt = Date.now()): ReportRecord {
  if (text.length <= REPORT_TEXT_LIMIT) {
    return { sessionID, text, length: text.length, capturedAt, truncated: false }
  }
  return {
    sessionID,
    text: text.slice(0, REPORT_TEXT_LIMIT),
    length: text.length,
    capturedAt,
    truncated: true,
    clippedAt: REPORT_TEXT_LIMIT,
  }
}

/** The compact form kept in `worker:<id>.lastReport`. */
export function reportSummary(record: ReportRecord): string {
  if (record.text.length <= REPORT_SUMMARY_LIMIT) return record.text
  return `${record.text.slice(0, REPORT_SUMMARY_LIMIT)}…`
}

/** One router-facing line that names the full-text handle. */
export function reportNotice(record: ReportRecord): string {
  const clip = record.truncated ? `，超出 ${REPORT_TEXT_LIMIT} 字上限仅存前 ${record.text.length} 字` : ""
  return `全文长度 ${record.length}${clip}，可用 report_read 读取（sessionID: ${record.sessionID}）`
}

/** Page through a stored report; the caller validates offset against `stored`. */
export function sliceReport(record: ReportRecord, offset: number, limit: number): ReportSlice {
  const stored = record.text.length
  const start = Math.min(Math.max(0, offset), stored)
  const end = Math.min(stored, start + Math.max(REPORT_MIN_LIMIT, limit))
  const hasMore = end < stored
  return {
    text: record.text.slice(start, end),
    offset: start,
    end,
    total: record.length,
    stored,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function encodeReport(record: ReportRecord): Schema.Json {
  return {
    sessionID: record.sessionID,
    text: record.text,
    length: record.length,
    capturedAt: record.capturedAt,
    truncated: record.truncated,
    ...(record.clippedAt === undefined ? {} : { clippedAt: record.clippedAt }),
  } as unknown as Schema.Json
}

export function decodeReport(value: Schema.Json | undefined): ReportRecord | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value["sessionID"] !== "string") return undefined
  if (typeof value["text"] !== "string") return undefined
  const length = optionalNumber(value, "length")
  const capturedAt = optionalNumber(value, "capturedAt")
  if (length === undefined || capturedAt === undefined) return undefined
  const clippedAt = optionalNumber(value, "clippedAt")
  return {
    sessionID: value["sessionID"],
    text: value["text"],
    length,
    capturedAt,
    truncated: value["truncated"] === true,
    ...(clippedAt === undefined ? {} : { clippedAt }),
  }
}

export const saveReport = Effect.fn("superagent.saveReport")(function* (ctx: Plugin.Context, record: ReportRecord) {
  yield* ctx.storage
    .set(reportKey(record.sessionID), encodeReport(record))
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to persist report", { sessionID: record.sessionID, cause }),
      ),
    )
})

export const loadReport = Effect.fn("superagent.loadReport")(function* (ctx: Plugin.Context, sessionID: string) {
  const value = yield* ctx.storage.get(reportKey(sessionID)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  return decodeReport(value)
})

let stats: ReportStats = { entries: 0, chars: 0, truncated: 0 }

export const reportStats = (): ReportStats => stats

/** Fixed thresholds used to warn about unbounded spill growth at startup. */
export const REPORT_ENTRY_WARN = 500
export const REPORT_CHARS_WARN = 20_000_000

/**
 * Measure stored reports once at startup. Nothing is deleted here: dropping a
 * report is a deliberate retention decision, not a side effect of hydration.
 * Undecodable values are removed because they can never be read back.
 */
export const hydrateReports = Effect.fn("superagent.hydrateReports")(function* (ctx: Plugin.Context) {
  let entries = 0
  let chars = 0
  let truncated = 0
  let after: string | undefined
  do {
    const page = yield* ctx.storage
      .scan({ prefix: REPORT_PREFIX, after, limit: 100 })
      .pipe(Effect.catch(() => Effect.succeed({ entries: [], next: undefined })))
    for (const entry of page.entries) {
      const record = decodeReport(entry.value)
      if (record === undefined) {
        yield* ctx.storage.remove(entry.key).pipe(Effect.catch(() => Effect.void))
        continue
      }
      entries += 1
      chars += record.length
      if (record.truncated) truncated += 1
    }
    after = page.next
  } while (after !== undefined)
  stats = { entries, chars, truncated }
  yield* Effect.logInfo("superagent report spill measured", stats)
  if (entries > REPORT_ENTRY_WARN || chars > REPORT_CHARS_WARN) {
    yield* Effect.logWarning(
      "superagent report spill is growing; a retention policy (per-thread cap or age) is due",
      stats,
    )
  }
})
