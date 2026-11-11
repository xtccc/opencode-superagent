import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import { DispatchInput, runDispatch } from "../src/dispatch.js"
import { Definition } from "../src/protocol.js"
import { store } from "../src/state.js"
import { createTicket, getTicket, renderTicketDetail, resetTickets } from "../src/ticket.js"

/**
 * `dispatch({ effort })` maps a reasoning effort onto the worker's
 * `model.variant`. The server stores an unknown variant instead of rejecting
 * it, so these tests pin the plugin-side whitelist (`ctx.model.list()`), the
 * unchanged inherited path when no effort is passed, and the degradation when
 * the catalog is unavailable.
 */

const ROUTER = "ses_router"
const THREAD = "telegram:42"
const PROVIDER = "workbuddy"
const MODEL = "deepseek-v4.1-flash"

const base = {
  threadID: THREAD,
  title: "整理发布说明",
  objective: "把本周变更写成一份发布说明",
  acceptance: ["覆盖所有 PR", "中文 200 字内"],
  directory: "/opt/ai-gw",
  source: "telegram",
} as const

const routerModel = { providerID: PROVIDER, id: MODEL, variant: "high" }

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

interface ModelInfo {
  readonly id: string
  readonly providerID: string
  readonly variants: ReadonlyArray<{ readonly id: string }>
}

const catalog = (variants: ReadonlyArray<string>): ModelInfo => ({
  id: MODEL,
  providerID: PROVIDER,
  variants: variants.map((id) => ({ id })),
})

type CreateInput = { readonly model?: { providerID: string; id: string; variant?: string } }

/**
 * Harness: the router inherits `routerModel`, the catalog advertises
 * `variants`, and every `sessions.create` input is captured so the test can
 * assert what the host would have stored.
 */
function effortContext(options: {
  readonly model?: typeof routerModel | undefined
  readonly variants?: ReadonlyArray<string> | "throws" | "absent"
  readonly defaultModel?: { readonly providerID: string; readonly id: string } | undefined
}) {
  const { storage } = memoryContext()
  const prompts: Array<string> = []
  const creates: Array<CreateInput> = []
  const session = {
    get: () =>
      Effect.succeed({
        id: ROUTER,
        model: options.model === undefined ? undefined : options.model,
        location: { directory: "/opt/ai-gw" },
      }),
    create: (input: CreateInput) => {
      creates.push(input)
      return Effect.succeed({ id: "ses_worker_new", title: undefined })
    },
    prompt: (input: { text: string }) => {
      prompts.push(input.text)
      return Effect.succeed(undefined)
    },
    interrupt: () => Effect.succeed({ interrupted: true }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  const variants = options.variants ?? ["low", "medium", "high"]
  const model =
    variants === "absent"
      ? undefined
      : {
          list: () =>
            variants === "throws"
              ? Effect.fail("catalog down")
              : Effect.succeed({ data: [catalog(variants)] }),
          default: () =>
            Effect.succeed({
              data:
                options.defaultModel === undefined
                  ? undefined
                  : { ...catalog(["low", "medium", "high"]), ...options.defaultModel },
            }),
        }
  return { storage, session, agent, ...(model === undefined ? {} : { model }), creates, prompts } as unknown as Plugin.Context & {
    creates: Array<CreateInput>
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

beforeEach(() => {
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

describe("dispatch effort maps to the worker model variant", () => {
  test("an advertised effort becomes model.variant on sessions.create", async () => {
    const ctx = effortContext({ model: routerModel })
    const created = await succeed(createTicket(ctx, base))
    const result = await succeed(
      runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "low" }, ROUTER),
    )
    expect(String(result.output.sessionID)).toBe("ses_worker_new")
    expect(ctx.creates).toHaveLength(1)
    expect(ctx.creates[0]?.model).toEqual({ providerID: PROVIDER, id: MODEL, variant: "low" })
  })

  test("an effort the model does not advertise fails with the available levels", async () => {
    const ctx = effortContext({ model: routerModel, variants: ["low", "medium", "high"] })
    const created = await succeed(createTicket(ctx, base))
    const message = await failure(
      runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "max" }, ROUTER),
    )
    expect(message).toContain(`effort max is not available for ${PROVIDER}/${MODEL}`)
    expect(message).toContain("low, medium, high")
    expect(message).toContain("omit effort")
    // Nothing was created and the ticket is untouched.
    expect(ctx.creates).toHaveLength(0)
    expect(store.workers.size).toBe(0)
    expect(getTicket(created.ticket.id)?.state).toBe("open")
    expect(getTicket(created.ticket.id)?.attempts).toHaveLength(0)
  })

  test("without effort the worker inherits the router model exactly as before", async () => {
    const ctx = effortContext({ model: routerModel })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id }, ROUTER))
    expect(ctx.creates[0]?.model).toEqual(routerModel)
    expect(ctx.creates[0]?.model?.variant).toBe("high")
    // No effort was requested, so the history says nothing about it.
    const dispatch = getTicket(created.ticket.id)?.history.find((entry) => entry.kind === "dispatch")
    expect(dispatch?.note).toBe("worker ses_worker_new")
    expect(dispatch?.note).not.toContain("effort")
  })

  test("a failing model catalog degrades to the inherited level instead of blocking", async () => {
    const ctx = effortContext({ model: routerModel, variants: "throws" })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "max" }, ROUTER))
    expect(ctx.creates[0]?.model).toEqual(routerModel)
    const dispatch = getTicket(created.ticket.id)?.history.find((entry) => entry.kind === "dispatch")
    // The history never claims an effort that was not applied.
    expect(dispatch?.note).toContain("effort=max (unverified: inherited)")
  })

  test("a host without ctx.model degrades the same way", async () => {
    const ctx = effortContext({ model: routerModel, variants: "absent" })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "high" }, ROUTER))
    expect(ctx.creates[0]?.model).toEqual(routerModel)
  })

  test("a model missing from the catalog degrades instead of guessing", async () => {
    const ctx = effortContext({ model: { providerID: PROVIDER, id: "other-model", variant: "high" } })
    const created = await succeed(createTicket(ctx, base))
    await succeed(
      runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "low" }, ROUTER),
    )
    expect(ctx.creates[0]?.model).toEqual({ providerID: PROVIDER, id: "other-model", variant: "high" })
  })

  test("with no router model the catalog default supplies the model for the variant", async () => {
    const ctx = effortContext({ model: undefined, defaultModel: { providerID: PROVIDER, id: MODEL } })
    const created = await succeed(createTicket(ctx, base))
    await succeed(
      runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "medium" }, ROUTER),
    )
    expect(ctx.creates[0]?.model).toEqual({ providerID: PROVIDER, id: MODEL, variant: "medium" })
  })

  test("effort without any resolvable model degrades to no explicit model", async () => {
    const ctx = effortContext({ model: undefined, defaultModel: undefined })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "low" }, ROUTER))
    expect(ctx.creates[0]?.model).toBeUndefined()
    const dispatch = getTicket(created.ticket.id)?.history.find((entry) => entry.kind === "dispatch")
    expect(dispatch?.note).toContain("effort=low (unresolved: inherited)")
  })

  test("effort cannot be combined with an explicit agent override", async () => {
    const ctx = effortContext({ model: routerModel })
    const created = await succeed(createTicket(ctx, base))
    const message = await failure(
      runDispatch(
        ctx,
        { task: "写发布说明", ticketID: created.ticket.id, agent: "superagent-worker", effort: "low" },
        ROUTER,
      ),
    )
    expect(message).toContain("cannot be combined with an explicit agent override")
    expect(ctx.creates).toHaveLength(0)
  })
})

describe("effort is visible on the ticket", () => {
  test("the dispatch history records the effort and the detail view shows it", async () => {
    const ctx = effortContext({ model: routerModel })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "medium" }, ROUTER))
    const ticket = getTicket(created.ticket.id)
    const dispatch = ticket?.history.find((entry) => entry.kind === "dispatch")
    expect(dispatch?.note).toBe("worker ses_worker_new effort=medium")
    expect(renderTicketDetail(ticket!)).toContain("档位：medium")
  })

  test("a re-dispatch records its own effort instead of the previous one", async () => {
    const ctx = effortContext({ model: routerModel })
    const created = await succeed(createTicket(ctx, base))
    await succeed(runDispatch(ctx, { task: "写发布说明", ticketID: created.ticket.id, effort: "low" }, ROUTER))
    const first = store.workers.get("ses_worker_new")
    if (first !== undefined) first.state = "failed"
    await succeed(runDispatch(ctx, { task: "再写一次", ticketID: created.ticket.id, effort: "high" }, ROUTER))
    const notes = (getTicket(created.ticket.id)?.history ?? [])
      .filter((entry) => entry.kind === "dispatch")
      .map((entry) => entry.note)
    expect(notes).toEqual(["worker ses_worker_new effort=low", "worker ses_worker_new effort=high"])
  })
})

describe("effort is exposed but optional", () => {
  test("the tool schema and the RPC contract both accept and validate it", async () => {
    const fields = (DispatchInput as unknown as { fields: Record<string, { ast: { context?: { isOptional: boolean } } }> })
      .fields
    expect(Object.keys(fields)).toContain("effort")
    expect(fields["effort"]?.ast.context?.isOptional).toBe(true)

    // Old clients that never send effort keep working.
    const bare = await Definition.methods.dispatch.input["~standard"].validate({ task: "写发布说明", ticketID: "tk_x" })
    expect(bare.issues ?? []).toHaveLength(0)
    const withEffort = await Definition.methods.dispatch.input["~standard"].validate({
      task: "写发布说明",
      ticketID: "tk_x",
      effort: "high",
    })
    expect(withEffort.issues ?? []).toHaveLength(0)
    const bogus = await Definition.methods.dispatch.input["~standard"].validate({
      task: "写发布说明",
      ticketID: "tk_x",
      effort: "ultra",
    })
    expect(bogus.issues?.length ?? 0).toBeGreaterThan(0)
  })
})
