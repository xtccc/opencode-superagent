import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { DispatchInput, runDispatch } from "../src/dispatch.js"
import { Definition } from "../src/protocol.js"
import { store } from "../src/state.js"
import { closeTicket, createTicket, getTicket, linkTicketToWorker, resetTickets } from "../src/ticket.js"

// ── fixtures ──────────────────────────────────────────────────────────────────

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
  return { storage, data }
}

/** A context where the worker session creation succeeds and its prompt text is captured. */
function dispatchContext() {
  const { storage, data } = memoryContext()
  const prompts: Array<string> = []
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({ id: sessionID, model: undefined, location: { directory: "/opt/ai-gw" } }),
    create: (input: { title?: string }) => Effect.succeed({ id: "ses_worker_new", title: input.title }),
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: () => Effect.succeed({ interrupted: true }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  return { storage, session, agent, data, prompts } as unknown as Plugin.Context & {
    data: Map<string, Schema.Json>
    prompts: Array<string>
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

// `ticket.ts` and `state.ts` own module-level stores; every test starts clean.
beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

// ── the ticket gate ──────────────────────────────────────────────────────────

describe("dispatch requires a work ticket", () => {
  test("a dispatch without ticketID is refused", async () => {
    const ctx = dispatchContext()
    const message = await failure(runDispatch(ctx, { task: "修日志" } as never, ROUTER))
    expect(message).toContain("dispatch requires ticketID")
    expect(message).toContain("ticket_create")
  })

  test("an unknown ticket is refused", async () => {
    const ctx = dispatchContext()
    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: "tk_nope" }, ROUTER))
    expect(message).toContain("unknown ticket tk_nope")
    expect(message).toContain("ticket_create")
  })

  test("a closed ticket is refused", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "done", summary: "merged" }))
    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(message).toContain("only open/in_progress")
    expect(message).toContain("ticket_create")
  })

  test("a ticket from another thread is refused", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    const message = await failure(
      runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id, threadID: "telegram:43" }, ROUTER),
    )
    expect(message).toContain("belongs to thread telegram:42")
    expect(message).toContain("threadID=telegram:42")
  })

  test("a ticket with a running worker is refused until that worker is terminal", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    await succeed(linkTicketToWorker(ctx, { ticketID: created.ticket.id, sessionID: "ses_worker_1" }))
    store.workers.set("ses_worker_1", {
      sessionID: "ses_worker_1",
      threads: [THREAD],
      state: "running",
      createdAt: 1,
    })

    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(message).toContain("already has a running worker ses_worker_1")
    expect(message).toContain("abort_session")
    expect(store.workers.has("ses_worker_new")).toBe(false)

    // Once the previous worker is terminal, the same ticket can be re-dispatched.
    const previous = store.workers.get("ses_worker_1")
    if (previous !== undefined) previous.state = "done"
    const result = await succeed(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(String(result.output.sessionID)).toBe("ses_worker_new")
    expect(getTicket(created.ticket.id)?.attempts).toHaveLength(2)
  })

  test("a successful dispatch binds the ticket atomically", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    const result = await succeed(
      runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id, title: "修日志" }, ROUTER),
    )
    expect(String(result.output.sessionID)).toBe("ses_worker_new")

    const ticket = getTicket(created.ticket.id)
    expect(ticket?.state).toBe("in_progress")
    expect(ticket?.workerSessionID).toBe("ses_worker_new")
    expect(ticket?.attempts).toHaveLength(1)
    expect(ticket?.attempts[0]?.sessionID).toBe("ses_worker_new")
    expect(store.workers.get("ses_worker_new")?.state).toBe("running")
    expect(ctx.data.get("worker:ses_worker_new")).toBeDefined()

    // The worker sees the ticket header (objective + acceptance) first.
    expect(ctx.prompts[0]).toContain(`工单 ${created.ticket.id}`)
    expect(ctx.prompts[0]).toContain("日志含 user id")
  })
})

// ── the RPC path ─────────────────────────────────────────────────────────────

describe("the dispatch RPC shares the gate", () => {
  test("a direct RPC dispatch of a closed ticket is refused", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    await succeed(closeTicket(ctx, { ticketID: created.ticket.id, outcome: "cancelled", summary: "用户取消" }))
    // `server.ts` runs this exact function with the router id as the caller.
    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id }, ROUTER))
    expect(message).toContain("only open/in_progress")
    expect(store.workers.size).toBe(0)
  })

  test("without a router the RPC dispatch is refused", async () => {
    const ctx = dispatchContext()
    store.routerID = undefined
    const message = await failure(runDispatch(ctx, { task: "修日志", ticketID: "tk_any" }, ""))
    expect(message).toContain("only available to the router session")
  })

  test("the dispatch input schema and the RPC contract require ticketID", async () => {
    const fields = (
      DispatchInput as unknown as { fields: Record<string, { ast: { context?: { isOptional: boolean } } }> }
    ).fields
    expect(fields["ticketID"]?.ast.context?.isOptional).not.toBe(true)

    const parsed = await Definition.methods.dispatch.input["~standard"].validate({ task: "修日志" })
    const issues = parsed.issues?.length ?? 0
    expect(issues).toBeGreaterThan(0)
  })
})
