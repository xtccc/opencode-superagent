import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { runDispatch } from "../src/dispatch.js"
import { store } from "../src/state.js"
import { createTicket, getTicket, resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

const ROUTER = "ses_router"
const THREAD = "telegram:42"
const WORKER = "ses_worker_new"

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
  return { storage, data }
}

/** A context whose worker session is created but whose first prompt fails. */
function promptFailureContext() {
  const { storage, data } = memoryContext()
  const prompts: Array<string> = []
  const interrupted: Array<string> = []
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({ id: sessionID, model: undefined, location: { directory: "/opt/ai-gw" } }),
    create: (input: { title?: string }) => Effect.succeed({ id: WORKER, title: input.title }),
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.fail(new Error("prompt delivery failed"))
    },
    interrupt: ({ sessionID }: { sessionID: string }) => {
      interrupted.push(sessionID)
      return Effect.succeed({ interrupted: true })
    },
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  return { storage, session, agent, data, prompts, interrupted } as unknown as Plugin.Context & {
    data: Map<string, Schema.Json>
    prompts: Array<string>
    interrupted: Array<string>
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
  return String(exit.cause)
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

// ── prompt rollback ─────────────────────────────────────────────────────────

describe("a failed prompt rolls the dispatch back", () => {
  test("worker, ticket and thread affinity do not stay half-created", async () => {
    const ctx = promptFailureContext()
    const created = await succeed(createTicket(ctx, base))

    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))

    // The dispatch reports the prompt failure instead of claiming success.
    expect(message).toContain("dispatch aborted")
    expect(message).toContain("failed to prompt worker session")

    // The worker record is gone from memory and KV, and nothing is running.
    expect(store.workers.has(WORKER)).toBe(false)
    expect(ctx.data.get(`worker:${WORKER}`)).toBeUndefined()
    expect([...store.workers.values()].some((worker) => worker.state === "running")).toBe(false)

    // The ticket is explicitly failed with the reason recorded, not stuck in_progress.
    const ticket = getTicket(created.ticket.id)
    expect(ticket?.state).toBe("failed")
    expect(ticket?.workerSessionID).toBe(WORKER)
    expect(ticket?.closeReason).toContain("dispatch rollback")
    expect(ticket?.closeReason).toContain("failed to prompt worker session")

    // Thread affinity no longer points at the dead worker (and the empty list
    // is removed from KV entirely).
    expect(store.threads.get(THREAD) ?? []).not.toContain(WORKER)
    expect(ctx.data.get(`thread:${THREAD}`)).toBeUndefined()

    // The session was interrupted, not left running without a task.
    expect(ctx.interrupted).toContain(WORKER)
    expect(ctx.prompts).toHaveLength(1)
  })

  test("the ticket can be re-dispatched after the failed rollback", async () => {
    const ctx = promptFailureContext()
    const created = await succeed(createTicket(ctx, base))
    await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))

    // A failed ticket is terminal, so a retry needs a fresh work order rather
    // than silently reusing the half-dispatched one.
    expect(getTicket(created.ticket.id)?.state).toBe("failed")
    const replacement = await succeed(createTicket(ctx, { ...base, objective: "重新修复登录日志" }))
    expect(replacement.reused).toBe(false)
    expect(replacement.ticket.id).not.toBe(created.ticket.id)
  })
})
