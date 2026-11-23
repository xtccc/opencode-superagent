/**
 * Mechanically captured context/token usage for worker sessions.
 *
 * Nothing here asks the worker to describe its own consumption: the numbers
 * come straight from the host's session API (`Session.Info.tokens` from
 * `session.get()`, or the `tokens` field on assistant messages returned by
 * `session.context()`). OpenCode normalises provider differences into one
 * `TokenUsage.Info` shape, so there is no per-provider branching here.
 *
 * The snapshot is deliberately small: it is copied into every worker record,
 * status line and router status reply, so it stays a handful of numbers.
 */

import type { Schema } from "effect"

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface UsageSnapshot {
  readonly tokens: TokenUsage
  /** Cost in USD, when the host reports one. */
  readonly cost?: number
  /** Which host field produced the snapshot (session cumulative vs last assistant step). */
  readonly source: "session" | "step"
  readonly capturedAt: number
}

/** Provider differences are already normalised by OpenCode; this only guards the shape. */
function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined
  const input = nonNegative(value["input"])
  const output = nonNegative(value["output"])
  const reasoning = nonNegative(value["reasoning"])
  if (input === undefined || output === undefined || reasoning === undefined) return undefined
  const cache = isRecord(value["cache"]) ? value["cache"] : {}
  return {
    input,
    output,
    reasoning,
    cache: {
      read: nonNegative(cache["read"]) ?? 0,
      write: nonNegative(cache["write"]) ?? 0,
    },
  }
}

/** Matches `@opencode/schema` TokenUsage.total: cache and reasoning are already net figures. */
export function usageTotal(tokens: TokenUsage): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

/** Cumulative usage from `session.get()`; the primary, always-present source. */
export function usageFromSession(info: unknown): UsageSnapshot | undefined {
  if (!isRecord(info)) return undefined
  const tokens = parseTokenUsage(info["tokens"])
  if (tokens === undefined) return undefined
  const cost = nonNegative(info["cost"])
  return {
    tokens,
    ...(cost === undefined ? {} : { cost }),
    source: "session",
    capturedAt: Date.now(),
  }
}

/** A compaction window can nest its replacement inside another one; bound the scan. */
const NATIVE_COMPACTION_DEPTH = 4

function assistantTokens(message: unknown): TokenUsage | undefined {
  if (!isRecord(message) || message["type"] !== "assistant") return undefined
  return parseTokenUsage(message["tokens"])
}

function isCompletedCompaction(message: unknown): boolean {
  return isRecord(message) && message["type"] === "compaction" && message["status"] === "completed"
}

function nestedMessages(message: unknown): ReadonlyArray<unknown> | undefined {
  if (!isRecord(message) || message["type"] !== "compaction") return undefined
  const native = message["native"]
  if (!isRecord(native) || !Array.isArray(native["messages"])) return undefined
  return native["messages"] as ReadonlyArray<unknown>
}

/**
 * Usage of the step that currently fills the context window: the last assistant
 * message with tokens after the last completed compaction. Follows the host's
 * own `lastAssistantWithUsage` rule, plus a bounded fallback into a compaction
 * card's `native.messages` (where a finished answer may have been folded away).
 */
export function usageFromMessages(
  messages: ReadonlyArray<unknown> | undefined,
  depth = 0,
): UsageSnapshot | undefined {
  if (messages === undefined) return undefined
  let boundary = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompletedCompaction(messages[index])) {
      boundary = index
      break
    }
  }
  for (let index = messages.length - 1; index > boundary; index--) {
    const tokens = assistantTokens(messages[index])
    if (tokens === undefined) continue
    const message = messages[index]
    const cost = isRecord(message) ? nonNegative(message["cost"]) : undefined
    return {
      tokens,
      ...(cost === undefined ? {} : { cost }),
      source: "step",
      capturedAt: Date.now(),
    }
  }
  if (depth < NATIVE_COMPACTION_DEPTH) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const inner = nestedMessages(messages[index])
      if (inner === undefined) continue
      const nested = usageFromMessages(inner, depth + 1)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Prefer the session's cumulative counter; fall back to the message-derived step. */
export function pickUsage(info: unknown, messages?: ReadonlyArray<unknown>): UsageSnapshot | undefined {
  return usageFromSession(info) ?? usageFromMessages(messages)
}

function formatCount(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`
  return `${(value / 1_000_000).toFixed(2)}M`
}

/** Router-facing one-liner: total plus the breakdown, with cost when available. */
export function formatUsage(snapshot: UsageSnapshot): string {
  const { tokens } = snapshot
  const parts = [
    `in ${formatCount(tokens.input)}`,
    `out ${formatCount(tokens.output)}`,
    `reason ${formatCount(tokens.reasoning)}`,
    `cache ${formatCount(tokens.cache.read)}/${formatCount(tokens.cache.write)}`,
  ]
  const cost = snapshot.cost === undefined ? "" : ` cost $${snapshot.cost.toFixed(4)}`
  return `context ${formatCount(usageTotal(tokens))} tokens (${parts.join(" ")})${cost} [${snapshot.source}]`
}

/** Compact form for status rows, where a long breakdown would eat the report budget. */
export function compactUsage(snapshot: UsageSnapshot | undefined): string | undefined {
  if (snapshot === undefined) return undefined
  const cost = snapshot.cost === undefined ? "" : ` $${snapshot.cost.toFixed(3)}`
  return `ctx=${formatCount(usageTotal(snapshot.tokens))}${cost}`
}

// ── KV encoding ────────────────────────────────────────────────────────────────

export function encodeUsage(snapshot: UsageSnapshot): Schema.Json {
  return {
    tokens: {
      input: snapshot.tokens.input,
      output: snapshot.tokens.output,
      reasoning: snapshot.tokens.reasoning,
      cache: { read: snapshot.tokens.cache.read, write: snapshot.tokens.cache.write },
    },
    ...(snapshot.cost === undefined ? {} : { cost: snapshot.cost }),
    source: snapshot.source,
    capturedAt: snapshot.capturedAt,
  } as unknown as Schema.Json
}

export function decodeUsage(value: unknown): UsageSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const tokens = parseTokenUsage(value["tokens"])
  if (tokens === undefined) return undefined
  const source = value["source"] === "step" ? "step" : "session"
  const cost = nonNegative(value["cost"])
  const capturedAt = nonNegative(value["capturedAt"]) ?? 0
  return {
    tokens,
    ...(cost === undefined ? {} : { cost }),
    source,
    capturedAt,
  }
}
