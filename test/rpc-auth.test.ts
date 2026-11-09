import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { rejectedRouterRpc, ServerDefinition } from "../server.js"
import { registerTools } from "../src/dispatch.js"
import { Definition } from "../src/protocol.js"
import { store } from "../src/state.js"
import { createTicket, getTicket, resetTickets } from "../src/ticket.js"

/**
 * Regression for the RPC router-only bypass.
 *
 * `server.ts` used to call `runDispatch(ctx, input, store.routerID)` from the
 * `dispatch` RPC handler. The RPC transport (`RpcCallContext`) carries no
 * caller session id, so that argument was not proof of anything: every RPC
 * client was treated as the router. Input fields such as `caller`/`routerID`
 * are just as forgeable. Router-only RPC methods now fail before touching any
 * session; the real router keeps using its tools, whose `context.sessionID`
 * is supplied by the host.
 */

const ROUTER = "ses_router"
const WORKER = "ses_worker_1"
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

/** A context whose worker-session creation and interruption are observable. */
function dispatchContext() {
  const { storage, data } = memoryContext()
  const prompts: Array<string> = []
  let creates = 0
  let interrupts = 0
  const tools = new Map<string, unknown>()
  const session = {
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({ id: sessionID, model: undefined, location: { directory: "/opt/ai-gw" } }),
    create: (input: { title?: string }) => {
      creates += 1
      return Effect.succeed({ id: "ses_worker_new", title: input.title })
    },
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: () => {
      interrupts += 1
      return Effect.succeed({ interrupted: true })
    },
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  const tool = {
    transform: (callback: (editor: { add: (spec: { name: string }) => void }) => void) =>
      Effect.sync(() => {
        callback({ add: (spec) => void tools.set(spec.name, spec) })
        return { dispose: Effect.void }
      }),
  }
  return {
    storage,
    session,
    agent,
    tool,
    data,
    prompts,
    tools,
    get creates() {
      return creates
    },
    get interrupts() {
      return interrupts
    },
  } as unknown as Plugin.Context & {
    data: Map<string, Schema.Json>
    prompts: Array<string>
    tools: Map<string, { execute: (input: unknown, context: unknown) => Effect.Effect<unknown, unknown> }>
    readonly creates: number
    readonly interrupts: number
  }
}

/** A stand-in for the RPC error factory; the handlers only need `error`. */
function rpcContext() {
  return {
    error: (type: string, message: string, data: unknown) => ({ type, message, data }),
  } as never
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failWith<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(effect))
}

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

describe("router-only RPC methods reject forged callers", () => {
  test("dispatch ignores a forged caller/routerID, fails explicitly and creates nothing", async () => {
    const ctx = dispatchContext()
    const error = (await failWith(
      rejectedRouterRpc.dispatch(
        {
          task: "修日志",
          ticketID: "tk_any",
          // Both fields are attacker-controlled. Neither is identity proof.
          caller: ROUTER,
          routerID: ROUTER,
        } as never,
        rpcContext(),
      ),
    )) as { type: string; message: string }

    expect(error.type).toBe("dispatch.rejected")
    expect(error.message).toContain("only available to the router session")
    expect(ctx.creates).toBe(0)
    expect(store.workers.size).toBe(0)
    expect(store.threads.size).toBe(0)
  })

  test("stop ignores a forged caller/routerID, fails explicitly and leaves the worker running", async () => {
    const ctx = dispatchContext()
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "running",
      createdAt: 1,
    })

    const error = (await failWith(
      rejectedRouterRpc.stop(
        {
          sessionID: WORKER,
          caller: ROUTER,
          routerID: ROUTER,
        } as never,
        rpcContext(),
      ),
    )) as { type: string; message: string }

    expect(error.type).toBe("stop.rejected")
    expect(error.message).toContain("only available to the router session")
    expect(ctx.interrupts).toBe(0)
    expect(store.workers.get(WORKER)?.state).toBe("running")
  })

  test("the shared contract declares the stop rejection, server and TUI included", () => {
    // One definition object for both halves: `server.ts` registers exactly what
    // `tui.tsx` calls, so `stop.rejected` cannot exist on only one side.
    expect(ServerDefinition).toBe(Definition)
    expect(Object.keys(Definition.methods.stop.errors ?? {})).toContain("stop.rejected")
    expect(Object.keys(ServerDefinition.methods.stop.errors ?? {})).toContain("stop.rejected")
    // `dispatch` keeps its own rejection declaration.
    expect(Object.keys(Definition.methods.dispatch.errors ?? {})).toContain("dispatch.rejected")
  })
})

describe("the real router keeps dispatching through its tool", () => {
  test("a router tool call dispatches and binds the ticket", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    await Effect.runPromise(Effect.scoped(registerTools(ctx)))
    const dispatchTool = ctx.tools.get("dispatch")
    if (dispatchTool === undefined) throw new Error("dispatch tool was not registered")

    const result = (await succeed(
      dispatchTool.execute(
        { task: "修日志", ticketID: created.ticket.id, title: "修日志" },
        { sessionID: ROUTER },
      ),
    )) as { output: { sessionID: string } }

    expect(result.output.sessionID).toBe("ses_worker_new")
    expect(ctx.creates).toBe(1)
    expect(store.workers.get("ses_worker_new")?.state).toBe("running")
    expect(getTicket(created.ticket.id)?.state).toBe("in_progress")
    expect(getTicket(created.ticket.id)?.workerSessionID).toBe("ses_worker_new")
    expect(ctx.prompts[0]).toContain(`工单 ${created.ticket.id}`)
  })

  test("a non-router tool caller is still refused without side effects", async () => {
    const ctx = dispatchContext()
    const created = await succeed(createTicket(ctx, base))
    await Effect.runPromise(Effect.scoped(registerTools(ctx)))
    const dispatchTool = ctx.tools.get("dispatch")
    if (dispatchTool === undefined) throw new Error("dispatch tool was not registered")

    const error = (await failWith(
      dispatchTool.execute({ task: "修日志", ticketID: created.ticket.id }, { sessionID: "ses_worker_other" }),
    )) as Error

    expect(String(error)).toContain("only available to the router session")
    expect(ctx.creates).toBe(0)
    expect(store.workers.size).toBe(0)
    expect(getTicket(created.ticket.id)?.state).toBe("open")
  })
})
