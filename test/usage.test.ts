import { describe, expect, test } from "bun:test"
import {
  compactUsage,
  decodeUsage,
  encodeUsage,
  formatUsage,
  parseTokenUsage,
  usageFromMessages,
  usageFromSession,
  usageTotal,
} from "../src/usage.js"

const tokens = { input: 1_000, output: 500, reasoning: 100, cache: { read: 8_000, write: 200 } }
const snapshot = { tokens, source: "session" as const, cost: 0.0123, capturedAt: 42 }

describe("machine-read token usage", () => {
  test("parseTokenUsage is defensive about shape and defaults cache", () => {
    expect(parseTokenUsage(tokens)).toEqual(tokens)
    expect(parseTokenUsage({ input: 1, output: 2, reasoning: 3 })).toEqual({
      input: 1,
      output: 2,
      reasoning: 3,
      cache: { read: 0, write: 0 },
    })
    for (const bad of [undefined, null, "x", 42, [], { input: 1, output: 2 }, { input: -1, output: 2, reasoning: 0 }]) {
      expect(parseTokenUsage(bad)).toBeUndefined()
    }
  })

  test("usageTotal follows the host's five-part sum", () => {
    expect(usageTotal(tokens)).toBe(9_800)
  })

  test("usageFromSession reads the cumulative counters and cost", () => {
    expect(usageFromSession({ tokens, cost: 0.5, outcome: "succeeded" })).toEqual({
      tokens,
      cost: 0.5,
      source: "session",
      capturedAt: expect.any(Number),
    })
    expect(usageFromSession({ id: "ses_x" })).toBeUndefined()
    expect(usageFromSession(undefined)).toBeUndefined()
  })

  test("usageFromMessages takes the last assistant step after the last compaction", () => {
    const messages = [
      {
        type: "assistant",
        content: [],
        tokens: { input: 9_000, output: 1_000, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { type: "compaction", status: "completed", summary: "older window" },
      {
        type: "assistant",
        content: [],
        tokens: { input: 2_000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      { type: "idle" },
    ]
    const usage = usageFromMessages(messages)
    expect(usage?.source).toBe("step")
    expect(usage?.tokens.input).toBe(2_000)
  })

  test("usageFromMessages follows compaction cards into native.messages", () => {
    const messages = [
      {
        type: "compaction",
        status: "completed",
        summary: "folded",
        native: {
          messages: [
            {
              type: "assistant",
              content: [],
              tokens: { input: 7_000, output: 700, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          ],
        },
      },
    ]
    expect(usageFromMessages(messages)?.tokens.input).toBe(7_000)
  })

  test("formatting stays compact and degrades gracefully", () => {
    expect(formatUsage(snapshot)).toContain("context 9.8k tokens")
    expect(formatUsage(snapshot)).toContain("cost $0.0123")
    expect(formatUsage(snapshot)).toContain("[session]")
    expect(compactUsage(snapshot)).toBe("ctx=9.8k $0.012")
    expect(compactUsage(undefined)).toBeUndefined()
  })

  test("KV round-trip preserves the snapshot", () => {
    expect(decodeUsage(encodeUsage(snapshot))).toEqual(snapshot)
    expect(decodeUsage({ tokens: "broken" })).toBeUndefined()
  })
})
