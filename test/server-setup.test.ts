import type { Plugin, Rpc } from "@opencode/plugin/effect"
import { Agent } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { Tool } from "@opencode/schema/tool"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Stream, type Schema, type Types } from "effect"
import Server, { ServerDefinition } from "../server.js"
import { ROUTER_AGENT, WORKER_AGENT } from "../src/agents.js"
import { aliasDirs, threadDirs } from "../src/dirs.js"
import { Definition } from "../src/protocol.js"
import { encodeWorker, store } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import { ROUTER_TOOL_SPECS, specFor, toolPermission } from "../src/tools.js"

/**
 * Composition-root coverage for `server.ts`.
 *
 * Nothing else in the suite imports the plugin entry point, so the registration
 * order (tickets → state → agents → pending → dirs → session meta → reports →
 * tools → RPC) and the set of registered tools/agents/hooks were unverified at
 * HEAD. This file boots the real `Plugin.define({...})` effect against a fake
 * host `ctx`: in-memory KV with the same paging contract, an agent kernel that
 * replays transforms like the host does, a tool editor that records additions,
 * a session API that never leaves the process, an RPC domain that captures the
 * registration, and an event stream that ends immediately. No OpenCode host,
 * no network, no timers beyond the scoped watchdog interval.
 */

// ── fake host ────────────────────────────────────────────────────────────────

type MutableAgent = Types.DeepMutable<Agent.Info>

type HookCallback = (event: never) => Effect.Effect<void>
type RegisteredTool = Tool.Info & { readonly id: string }

interface Harness {
  readonly ctx: Plugin.Context
  /** KV mirror so tests can seed and inspect persisted state. */
  readonly data: Map<string, Schema.Json>
  /** Effective tool registry, keyed by name like the host's editor. */
  readonly tools: Map<string, RegisteredTool>
  /** Every `editor.add` call, so re-runs can be observed. */
  readonly toolAdds: Array<string>
  readonly hooks: Map<string, Array<HookCallback>>
  readonly registeredEvents: Array<ReadonlyArray<string> | undefined>
  readonly kernel: ReturnType<typeof makeKernel>
  /** Session ids the setup asked the host to create (never a real session). */
  readonly created: Array<{ readonly id: string; readonly metadata?: unknown }>
  readonly prompts: Array<{ readonly sessionID: string; readonly text: string }>
  readonly synthetic: Array<{ readonly sessionID: string; readonly text: string; readonly id?: string }>
  readonly sessions: Map<string, Record<string, unknown>>
  readonly rpc: {
    registrations: number
    definition?: Rpc.Definition
    /** Loosely typed on purpose: the test drives them with plain objects. */
    handlers?: Record<string, (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>>
  }
}

/** Minimal KV stand-in with the same paging contract as `Plugin.Context["storage"]`. */
function memoryStorage() {
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

/**
 * Stand-in for the host's agent state: transforms are replayed in order against
 * a fresh editor, exactly like `Agent.Info.default` materialization does.
 */
function makeKernel() {
  const registrations: Array<(editor: AgentEditor) => void> = []
  const editor = () => {
    const agents = new Map<string, MutableAgent>()
    const target: AgentEditor = {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
      default: () => {},
      update: (id, update) => {
        const existing = agents.get(id)
        const agent = existing ?? ({ ...Agent.Info.default(Agent.ID.make(id)) } as MutableAgent)
        if (existing === undefined) agents.set(id, agent)
        update(agent)
        agent.id = Agent.ID.make(id)
      },
      remove: (id) => void agents.delete(id),
    }
    for (const registration of registrations) registration(target)
    return target
  }
  return {
    register: (registration: (editor: AgentEditor) => void) => void registrations.push(registration),
    snapshot: () => editor().list(),
  }
}

/** The fake host context. Everything the real `server.ts` effect touches is here. */
function harness(): Harness {
  const { storage, data } = memoryStorage()
  const tools = new Map<string, RegisteredTool>()
  const toolAdds: Array<string> = []
  const hooks = new Map<string, Array<HookCallback>>()
  const registeredEvents: Array<ReadonlyArray<string> | undefined> = []
  const created: Array<{ id: string; metadata?: unknown }> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const synthetic: Array<{ sessionID: string; text: string; id?: string }> = []
  const sessions = new Map<string, Record<string, unknown>>()
  const kernel = makeKernel()
  const rpc: Harness["rpc"] = { registrations: 0 }

  const toolEditor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace: () => {},
    add: (tool) => {
      toolAdds.push(tool.name)
      tools.set(tool.name, { ...tool, id: tool.name } as RegisteredTool)
    },
    update: (id, update) => {
      const existing = tools.get(id)
      if (existing !== undefined) update(existing as Types.Mutable<RegisteredTool>)
    },
    remove: (id) => void tools.delete(id),
  }

  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      const info = sessions.get(sessionID)
      return info === undefined
        ? Effect.fail(new Error(`missing session ${sessionID}`))
        : Effect.succeed({ ...info, id: sessionID })
    },
    create: (input: { title?: string; metadata?: unknown }) => {
      const id = `ses_created_${created.length + 1}`
      sessions.set(id, { id, title: input.title, metadata: input.metadata })
      created.push({ id, metadata: input.metadata })
      return Effect.succeed({ id, title: input.title })
    },
    update: ({ sessionID, metadata }: { sessionID: string; metadata: unknown }) =>
      Effect.sync(() => void sessions.set(sessionID, { ...sessions.get(sessionID), metadata })),
    prompt: (input: { sessionID: string; text: string }) => {
      prompts.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed({ sessionID: input.sessionID })
    },
    synthetic: (input: { sessionID: string; text: string; id?: string }) => {
      synthetic.push({ sessionID: input.sessionID, text: input.text, ...(input.id === undefined ? {} : { id: input.id }) })
      return Effect.succeed({ id: input.id ?? `msg_auto_${synthetic.length}` })
    },
    interrupt: ({ sessionID }: { sessionID: string }) => Effect.succeed({ sessionID, interrupted: true }),
    wait: ({ sessionID }: { sessionID: string }) => Effect.succeed({ sessionID }),
    context: () => Effect.succeed([] as ReadonlyArray<unknown>),
    hook: (name: string, callback: HookCallback) =>
      Effect.sync(() => {
        const list = hooks.get(name) ?? []
        list.push(callback)
        hooks.set(name, list)
        return { dispose: Effect.void }
      }),
  }

  const agent = {
    transform: (callback: (editor: AgentEditor) => void) =>
      Effect.sync(() => {
        kernel.register(callback)
        return { dispose: Effect.void }
      }),
    list: () => Effect.succeed({ data: kernel.snapshot() }),
    // `ensureRouter` resolves the agent id through the host API, not the editor.
    get: ({ agentID }: { agentID: unknown }) => Effect.succeed({ data: { id: String(agentID) } }),
  }

  const ctx = {
    // Deliberately minimal: the setup only reads `watchdogIntervalMs`, so the
    // forked watchdog tick never fires inside the test.
    options: { watchdogIntervalMs: 3_600_000 },
    location: { directory: "/opt/superagent-test" },
    storage,
    session,
    agent,
    tool: {
      transform: (callback: (editor: ToolEditor) => void) =>
        Effect.sync(() => {
          callback(toolEditor)
          return { dispose: Effect.void }
        }),
    },
    event: {
      subscribe: (input?: { readonly types?: ReadonlyArray<string> }) => {
        registeredEvents.push(input?.types)
        return Stream.empty
      },
    },
    rpc: {
      register: (
        definition: Rpc.Definition,
        handlers: Record<string, (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>>,
      ) =>
        Effect.sync(() => {
          rpc.registrations += 1
          rpc.definition = definition
          rpc.handlers = handlers
          return { dispose: Effect.void, events: { emit: () => Effect.void } }
        }),
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    data,
    tools,
    toolAdds,
    hooks,
    registeredEvents,
    kernel,
    created,
    prompts,
    synthetic,
    sessions,
    rpc,
  }
}

/** Run the real composition root against the fake host, in its own scope. */
async function setup(h: Harness): Promise<Harness> {
  await Effect.runPromise(Effect.scoped(Server.effect(h.ctx)))
  return h
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failWith<A, E>(effect: Effect.Effect<A, E>): Promise<E> {
  return Effect.runPromise(Effect.flip(effect))
}

function cleanStore(): void {
  resetTickets()
  store.routerID = undefined
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
  store.triggers.clear()
  store.pending.length = 0
  threadDirs.clear()
  aliasDirs.clear()
}

beforeEach(cleanStore)
afterAll(cleanStore)

// ── seeded state: proves hydrate runs before registration and is idempotent ──

const ROUTER = "ses_router_seeded"
const WORKER = "ses_worker_seeded"
const THREAD = "thread:seeded"
const PENDING = "pending:test:seeded:1"

/** Pre-seed KV the way a previous (crashed) gateway process would have left it. */
function seed(h: Harness): void {
  h.data.set("router", ROUTER)
  h.sessions.set(ROUTER, { metadata: { superagent: { role: "router" } } })
  h.sessions.set(WORKER, {
    metadata: { superagent: { role: "worker", threads: [THREAD] } },
    time: { busy: 1, idle: 2 },
  })
  h.data.set(
    `worker:${WORKER}`,
    encodeWorker({
      sessionID: WORKER,
      threadID: THREAD,
      threads: [THREAD],
      state: "done",
      createdAt: 1,
      updatedAt: 2,
      lastReport: "seeded report",
    }),
  )
  h.data.set(`thread:${THREAD}`, { threadID: THREAD, workers: [WORKER], updatedAt: 2 } as unknown as Schema.Json)
  h.data.set(PENDING, {
    trigger: {
      id: "test:seeded:1",
      source: "test",
      threadID: THREAD,
      text: "queued before the restart",
      createdAt: 1,
    },
    // A real crash leaves a recent arrival; an old one is dropped by the replay
    // TTL, which is covered by the router tests, not by this hydrate-ordering one.
    arrivedAt: Date.now(),
  } as unknown as Schema.Json)
}

// ── tools ────────────────────────────────────────────────────────────────────

describe("composition root: tool registration", () => {
  test("registers exactly the catalog tools, with the catalog's description and permission", async () => {
    const h = await setup(harness())

    const expected = [...ROUTER_TOOL_SPECS.map((spec) => spec.name)].sort()
    expect([...h.tools.keys()].sort()).toEqual(expected)
    // No duplicate names survived registration (~12 handlers over 5 transforms).
    expect(h.toolAdds.length).toBe(expected.length)

    for (const spec of ROUTER_TOOL_SPECS) {
      const tool = h.tools.get(spec.name)
      if (tool === undefined) throw new Error(`${spec.name} was not registered`)
      expect(tool.description).toBe(specFor(spec.name).description)
      expect(tool.input).toBeDefined()
      expect(typeof tool.execute).toBe("function")
      // The permission action decides catalog visibility, so it must come from
      // the same source of truth the router permissions are derived from. A
      // tool that passes no `options` defaults to its own name in the host.
      expect(tool.options?.permission ?? spec.name).toBe(toolPermission(specFor(spec.name)))
    }
  })

  test("the registered implementations are callable without a host", async () => {
    const h = await setup(harness())
    store.routerID = ROUTER

    const status = h.tools.get("status")
    const list = h.tools.get("ticket_list")
    if (status === undefined || list === undefined) throw new Error("tools missing")

    const statusResult = (await succeed(
      status.execute({}, { sessionID: ROUTER } as never),
    )) as { output: { text: string } }
    expect(statusResult.output.text).toContain("superagent")

    const listResult = (await succeed(
      list.execute({}, { sessionID: ROUTER } as never),
    )) as { output: { text: string } }
    expect(listResult.output.text.length).toBeGreaterThan(0)

    // The router-only guard is wired through the same registration.
    const refused = await failWith(list.execute({}, { sessionID: "ses_user" } as never))
    expect(String(refused)).toContain("only available to the router session")
  })
})

// ── agents ───────────────────────────────────────────────────────────────────

describe("composition root: agent registration", () => {
  test("registers the router primary and the worker subagent", async () => {
    const h = await setup(harness())

    const agents = h.kernel.snapshot()
    expect(agents.map((agent) => String(agent.id)).sort()).toEqual([ROUTER_AGENT, WORKER_AGENT])
    const router = agents.find((agent) => String(agent.id) === ROUTER_AGENT)
    const worker = agents.find((agent) => String(agent.id) === WORKER_AGENT)
    expect(router).toMatchObject({ mode: "primary", hidden: true })
    expect(worker).toMatchObject({ mode: "subagent", hidden: false })
    expect(worker?.system).toContain("Worker")
  })
})

// ── hydrate + idempotency ────────────────────────────────────────────────────

describe("composition root: hydrate order and idempotency", () => {
  test("restores tickets/state/pending from KV, then registers hooks once", async () => {
    const h = harness()
    seed(h)
    await setup(h)

    expect(store.routerID).toBe(ROUTER)
    expect(store.workers.size).toBe(1)
    expect(store.workers.get(WORKER)?.state).toBe("done")
    expect(store.workers.get(WORKER)?.lastReport).toBe("seeded report")
    expect(store.threads.get(THREAD)).toEqual([WORKER])
    expect(store.pending).toHaveLength(1)
    // Hydrate persisted the router id back unchanged.
    expect(h.data.get("router")).toBe(ROUTER)

    expect([...h.hooks.keys()].sort()).toEqual(["context", "experimental.idle", "prompt"])
    for (const [name, callbacks] of h.hooks) expect(callbacks).toHaveLength(1)
    expect(h.registeredEvents).toHaveLength(1)
    expect(h.registeredEvents[0]).toContain("session.execution.succeeded")
  })

  test("a second setup neither duplicates registrations nor state", async () => {
    const h = harness()
    seed(h)
    await setup(h)

    const toolsAfterFirst = [...h.tools.keys()].sort()
    const addsAfterFirst = h.toolAdds.length
    const agentsAfterFirst = h.kernel.snapshot().length
    const keysAfterFirst = h.data.size

    await setup(h)

    expect([...h.tools.keys()].sort()).toEqual(toolsAfterFirst)
    // The host replays transforms; the registry stays one entry per name.
    expect(h.toolAdds.length).toBe(addsAfterFirst * 2)
    expect(h.tools.size).toBe(toolsAfterFirst.length)
    expect(h.kernel.snapshot()).toHaveLength(agentsAfterFirst)
    expect(store.workers.size).toBe(1)
    expect(store.threads.get(THREAD)).toEqual([WORKER])
    expect(store.pending).toHaveLength(1)
    expect(h.data.size).toBe(keysAfterFirst)
  })
})

// ── RPC surface ──────────────────────────────────────────────────────────────

describe("composition root: RPC surface", () => {
  test("registers the shared Definition and every declared handler", async () => {
    const h = await setup(harness())

    expect(h.rpc.registrations).toBe(1)
    expect(h.rpc.definition).toBe(Definition)
    expect(h.rpc.definition).toBe(ServerDefinition)
    const declared = Object.keys(Definition.methods).sort()
    expect(declared).toEqual(["abort", "dispatch", "router", "status", "stop", "ticket", "tickets", "trigger"])
    expect(Object.keys(h.rpc.handlers ?? {}).sort()).toEqual(declared)
    for (const name of declared) expect(typeof h.rpc.handlers?.[name]).toBe("function")
  })

  test("handlers are callable and keep the router-only RPCs rejected", async () => {
    const h = await setup(harness())
    type Handler = (input: unknown, context: unknown) => Effect.Effect<unknown, unknown>
    const handler = (name: string): Handler => {
      const fn = h.rpc.handlers?.[name]
      if (fn === undefined) throw new Error(`rpc handler ${name} was not registered`)
      return fn
    }
    // The transport never exposes a caller identity; the fake factory mirrors it.
    const context = {
      error: (type: string, message: string, data: unknown) => ({ type, message, data }),
    }

    const status = (await succeed(handler("status")({}, context))) as {
      version?: string
      pending: number
      workers: ReadonlyArray<unknown>
    }
    expect(typeof status.version).toBe("string")
    expect(status.pending).toBe(0)
    expect(status.workers).toEqual([])

    const tickets = (await succeed(handler("tickets")({}, context))) as { text: string }
    expect(tickets.text.length).toBeGreaterThan(0)

    const invalid = (await failWith(handler("tickets")({ status: "nope" }, context))) as { type: string }
    expect(invalid.type).toBe("tickets.invalid_status")

    const ticket = (await succeed(handler("ticket")({ ticketID: "tk_missing" }, context))) as { text: string }
    expect(ticket.text).toContain("tk_missing")

    // Empty text is dropped before touching any session.
    const dropped = (await succeed(handler("trigger")({ source: "test", threadID: THREAD, text: "  " }, context))) as {
      route: string
    }
    expect(dropped.route).toBe("dropped")
    expect(h.created).toHaveLength(0)

    // A real trigger creates the router session and injects one synthetic batch.
    const routed = (await succeed(
      handler("trigger")({ source: "test", threadID: THREAD, text: "hello" }, context),
    )) as { route: string; sessionID?: string }
    expect(routed.route).toBe("router")
    expect(routed.sessionID).toBe(store.routerID as string)
    expect(h.created).toHaveLength(1)
    expect(h.synthetic).toHaveLength(1)
    expect(h.synthetic[0]?.text).toContain("1 new event(s)")

    for (const name of ["dispatch", "stop"] as const) {
      const rejected = (await failWith(handler(name)({ sessionID: WORKER, ticketID: "tk_x" }, context))) as {
        type: string
      }
      expect(rejected.type).toBe(`${name}.rejected`)
    }
    const abort = (await failWith(handler("abort")({ sessionID: WORKER }, context))) as { type: string }
    expect(abort.type).toBe("abort.rejected")
  })
})
