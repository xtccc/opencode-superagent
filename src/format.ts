import type { TriggerInput } from "./state.js"

const LIMIT = 800

const HIGH_SURROGATE_START = 0xd800
const HIGH_SURROGATE_END = 0xdbff

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END
}

/**
 * UTF-16 index just past `limit` code points. Splitting a string by UTF-16
 * length cuts a surrogate pair (emoji, CJK extension B, …) in half and leaves
 * a lone surrogate behind, so every truncation goes through code points.
 */
function indexAfterCodePoints(text: string, limit: number): number {
  if (limit <= 0) return 0
  let index = 0
  let counted = 0
  while (index < text.length && counted < limit) {
    const wide = isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length
    index += wide ? 2 : 1
    counted += 1
  }
  return index
}

/** Number of code points, so an emoji counts as one character, not two. */
export function codePointLength(text: string): number {
  if (text.length === 0) return 0
  let count = 0
  let index = 0
  while (index < text.length) {
    index += isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length ? 2 : 1
    count += 1
  }
  return count
}

/** First `limit` code points; a surrogate pair is kept together or dropped whole. */
export function clipCodePoints(text: string, limit: number): string {
  if (limit <= 0) return ""
  if (text.length <= limit) return text
  return text.slice(0, indexAfterCodePoints(text, limit))
}

/**
 * First `limit` UTF-16 units, for caps that exist to bound stored size rather
 * than to count characters. A cut that would land inside a surrogate pair
 * backs off by one unit, so the stored text never ends in a lone half-emoji.
 */
export function clipUtf16(text: string, limit: number): string {
  if (limit <= 0) return ""
  if (text.length <= limit) return text
  const last = text.charCodeAt(limit - 1)
  const end = isHighSurrogate(last) && limit < text.length ? limit - 1 : limit
  return text.slice(0, end)
}

function truncate(text: string): string {
  const total = codePointLength(text)
  if (total <= LIMIT) return text
  return `${clipCodePoints(text, LIMIT)}...(${total - LIMIT} chars truncated)`
}

/** Single-line header plus the (possibly truncated) body. */
export function formatTrigger(trigger: TriggerInput): string {
  const id = trigger.id ?? `${trigger.source}:${trigger.threadID}:${trigger.createdAt ?? Date.now()}`
  const author = trigger.author ?? "unknown"
  const at = new Date(trigger.createdAt ?? Date.now()).toISOString()
  const header = `[trigger:${id}] source=${trigger.source} thread=${trigger.threadID} author=${author} at=${at}`
  return `${header}\n${truncate(trigger.text)}`
}
