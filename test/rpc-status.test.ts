import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { Definition } from "../src/protocol.js"
import { store } from "../src/state.js"
import { createTicket, resetTickets, TICKET_STATES, updateTicket, type TicketState } from "../src/ticket.js"
import { renderTicketsText } from "../src/ticket-tools.js"
import { TICKET_STATES as VIEW_TICKET_STATES } from "../src/ticket-view.js"

/**
 * Regression for the `tickets` RPC status filter.
 *
 * `status` used to be a plain string in the protocol, and `server.ts` silently
 * dropped anything outside `TICKET_STATES` before rendering. A caller that
 * passed a typo therefore received the *unfiltered* list with no error, which
 * looks exactly like "there are no tickets in that state". The RPC contract is
 * now a closed enum, so an unknown value fails validation instead of degrading
 * into an unfiltered list.
 */

const ROUTER = "ses_router"
const THREAD = "telegram:42"

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id", "现有测试全绿"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
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
  if (exit._tag === "Failure") throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

interface TicketListInputValue {
  readonly threadID?: string
  readonly status?: TicketState
  readonly limit?: number
}

type TicketsValidation = { readonly value: TicketListInputValue } | { readonly issues: ReadonlyArray<{ message: string }> }

function validateTicketsInput(input: unknown): Promise<TicketsValidation> {
  return Promise.resolve(Definition.methods.tickets.input["~standard"].validate(input) as TicketsValidation)
}

/** Two tickets in different states, so an unfiltered list is visibly wrong. */
async function seedTickets() {
  const ctx = memoryContext()
  const open = await succeed(createTicket(ctx, { ...base, title: "打开的单", objective: "打开的单" }))
  const done = await succeed(createTicket(ctx, { ...base, title: "已完成的单", objective: "已完成的单" }))
  await succeed(updateTicket(ctx, { ticketID: done.ticket.id, state: "done" }))
  return { openID: open.ticket.id, doneID: done.ticket.id }
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
})

describe("tickets RPC status contract", () => {
  test("the RPC enum matches the ticket state machine", () => {
    expect([...VIEW_TICKET_STATES]).toEqual([...TICKET_STATES])
  })

  test("legal statuses validate and filter the rendered list", async () => {
    const { openID, doneID } = await seedTickets()

    for (const status of TICKET_STATES) {
      const parsed = await validateTicketsInput({ status })
      expect("issues" in parsed).toBe(false)
      if ("issues" in parsed) continue
      expect(parsed.value.status).toBe(status)
    }

    const openText = renderTicketsText({ status: "open" })
    expect(openText).toContain(openID)
    expect(openText).not.toContain(doneID)

    const doneText = renderTicketsText({ status: "done" })
    expect(doneText).toContain(doneID)
    expect(doneText).not.toContain(openID)
  })

  test("an unknown status fails validation instead of returning the full list", async () => {
    const { openID, doneID } = await seedTickets()

    for (const status of ["bogus", "DONE", ""]) {
      const parsed = await validateTicketsInput({ status })
      expect("issues" in parsed).toBe(true)
      if (!("issues" in parsed)) continue
      expect(parsed.issues.length).toBeGreaterThan(0)
      expect(parsed.issues[0]?.message).toBeTruthy()
      // No rendered text is produced at all, so neither ticket can leak into a
      // response that the caller mistakes for a filtered (or full) list.
      expect("value" in parsed).toBe(false)
      expect(JSON.stringify(parsed)).not.toContain(openID)
      expect(JSON.stringify(parsed)).not.toContain(doneID)
    }
  })
})
