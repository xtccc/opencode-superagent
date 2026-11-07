import type { TriggerInput } from "./state.js"

const LIMIT = 800

function truncate(text: string): string {
  if (text.length <= LIMIT) return text
  return `${text.slice(0, LIMIT)}...(${text.length - LIMIT} chars truncated)`
}

/** Single-line header plus the (possibly truncated) body. */
export function formatTrigger(trigger: TriggerInput): string {
  const id = trigger.id ?? `${trigger.source}:${trigger.threadID}:${trigger.createdAt ?? Date.now()}`
  const author = trigger.author ?? "unknown"
  const at = new Date(trigger.createdAt ?? Date.now()).toISOString()
  const header = `[trigger:${id}] source=${trigger.source} thread=${trigger.threadID} author=${author} at=${at}`
  return `${header}\n${truncate(trigger.text)}`
}
