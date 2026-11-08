import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { store } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import { registerTicketTools } from "../src/ticket-tools.js"

/**
 * End-to-end cover for the Router's ticket tools: the registered `execute`
 * handlers are called exactly as the registry calls them, so the guard,
 * validation, state machine and rendering all run for real. Only KV is a
 * stand-in, matching the paging contract of `Plugin.Context["storage"]`.
 */

const ROUTER = "ses_router"

interface Registered {
  readonly name: string
  readonly execute: (
    input: unknown,
    context: { sessionID: string },
  ) => Effect.Effect<{ output: Record<string, unknown>; content: string }, unknown>
}

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

async function register() {
  resetTickets()
  store.routerID = ROUTER
  const tools: Array<Registered> = []
  const editor = { add: (tool: Registered) => tools.push(tool) }
  const ctx = {
    ...memoryContext(),
    tool: { transform: (fn: (target: typeof editor) => void) => Effect.sync(() => fn(editor)) },
  } as unknown as Plugin.Context
  await Effect.runPromise(Effect.scoped(registerTicketTools(ctx)))
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<string, Registered>
}

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(exit.cause)
}

const create = {
  threadID: "telegram:42",
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id", "现有测试全绿"],
  directory: "/opt/ai-gw",
}

const context = { sessionID: ROUTER }

describe("router ticket tools", () => {
  test("create, list, update and close run end to end", async () => {
    const tools = await register()
    const created = await run(tools["ticket_create"]!.execute(create, context))
    const ticketID = created.output["ticketID"] as string
    expect(ticketID).toMatch(/^tk_/)
    expect(created.output).toEqual({ ticketID, state: "open", reused: false })

    const listed = await run(tools["ticket_list"]!.execute({}, context))
    expect(listed.content).toContain(ticketID)
    expect(listed.content).toContain("修复登录日志")

    const blocked = await run(
      tools["ticket_update"]!.execute({ ticketID, status: "blocked", note: "等用户确认" }, context),
    )
    expect(blocked.output).toMatchObject({ ticketID, state: "blocked" })

    const closed = await run(
      tools["ticket_close"]!.execute({ ticketID, outcome: "done", summary: "日志已补，回归通过" }, context),
    )
    expect(closed.output).toMatchObject({ ticketID, state: "done" })
    expect(closed.content).toContain("日志已补，回归通过")

    const done = await run(tools["ticket_list"]!.execute({ status: "done" }, context))
    expect(done.content).toContain(ticketID)
  })

  test("an empty acceptance list is refused instead of creating a placeholder", async () => {
    const tools = await register()
    expect(await failure(tools["ticket_create"]!.execute({ ...create, acceptance: [] }, context))).toContain(
      "acceptance",
    )
  })

  test("a repeated objective reuses the open ticket in the same thread", async () => {
    const tools = await register()
    const first = await run(tools["ticket_create"]!.execute(create, context))
    const second = await run(tools["ticket_create"]!.execute({ ...create, title: "另一个标题" }, context))
    expect(second.output["ticketID"]).toBe(first.output["ticketID"])
    expect(second.output["reused"]).toBe(true)
  })

  test("workers cannot call the ticket tools", async () => {
    const tools = await register()
    expect(await failure(tools["ticket_create"]!.execute(create, { sessionID: "ses_worker" }))).toContain(
      "only available to the router session",
    )
    expect(await failure(tools["ticket_list"]!.execute({}, { sessionID: "ses_worker" }))).toContain(
      "only available to the router session",
    )
  })
})
