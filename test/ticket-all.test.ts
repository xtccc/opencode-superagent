import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, type Schema } from "effect"
import { DEFAULT_DIR_KEY, dirKeyFor } from "../src/dirs.js"
import { Definition } from "../src/protocol.js"
import { applySettings, resetSettings } from "../src/settings.js"
import { resetPartitions, store } from "../src/state.js"
import {
  parseAggregateHeader,
  parseAggregatedTicketList,
  renderAggregatedTickets,
} from "../src/ticket-aggregate.js"
import { createTicket, resetTickets } from "../src/ticket.js"
import { renderAllTicketsTextDeep, renderTicketsTextDeep } from "../src/ticket-tools.js"

/**
 * `/alltickets`: the aggregate view over every partition.
 *
 * The promises:
 *
 * 1. `tickets({ all: true })` returns **every** partition's tickets, grouped by
 *    directory, with a total line on top.
 * 2. `tickets({})` / `tickets({ directory })` keep their old meaning: the
 *    current partition only. The new parameter changes nothing when it is
 *    absent.
 * 3. With a single partition the aggregate output is **byte-identical** to the
 *    default output — the aggregate view must not add noise to a gateway that
 *    only ever has one directory.
 */

const DIR_A = "/opt/alpha"
const DIR_B = "/opt/beta"

function resetStore(): void {
  resetSettings()
  resetTickets()
  resetPartitions()
  store.workers.clear()
  store.pending.length = 0
  store.routerID = undefined
}

beforeEach(resetStore)
afterEach(resetStore)

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (exit._tag === "Failure") throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

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

const base = {
  objective: "objective",
  acceptance: ["a"],
  source: "test",
} as const

/** Two partitions, one ticket each. */
async function seedTwoPartitions(): Promise<{ ctx: Plugin.Context; idA: string; idB: string }> {
  applySettings({ perDirectoryRouter: true })
  const ctx = memoryContext()
  const a = await succeed(
    createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
  )
  const b = await succeed(
    createTicket(ctx, { ...base, threadID: "telegram:b", title: "B", directory: DIR_B, dirKey: dirKeyFor(DIR_B) }),
  )
  return { ctx, idA: a.ticket.id, idB: b.ticket.id }
}

describe("tickets RPC: the `all` parameter", () => {
  test("the protocol accepts `all` and keeps every old input valid", () => {
    const validate = (input: unknown) =>
      Definition.methods.tickets.input["~standard"].validate(input) as {
        value?: { all?: boolean; directory?: string }
      }
    expect(validate({}).value).toEqual({})
    expect(validate({ all: true }).value?.all).toBe(true)
    expect(validate({ all: false }).value?.all).toBe(false)
    expect(validate({ directory: DIR_A }).value?.directory).toBe(DIR_A)
    // `all` is a boolean, nothing else.
    expect((validate({ all: "yes" }) as { issues?: unknown }).issues).toBeDefined()
  })

  test("`all: true` returns both partitions, grouped by directory", async () => {
    const { ctx, idA, idB } = await seedTwoPartitions()

    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    expect(aggregate).toContain(idA)
    expect(aggregate).toContain(idB)
    // The total line names both the ticket count and the directory count.
    const header = parseAggregateHeader(aggregate)
    expect(header).toEqual({ total: 2, directories: 2 })
    // One group header per directory, each with its own count.
    expect(aggregate).toContain(`目录 ${DIR_A} · ${dirKeyFor(DIR_A)} · 1 条`)
    expect(aggregate).toContain(`目录 ${DIR_B} · ${dirKeyFor(DIR_B)} · 1 条`)
  })

  test("the default call still returns the current partition only", async () => {
    const { ctx, idA, idB } = await seedTwoPartitions()

    const scoped = await succeed(renderTicketsTextDeep(ctx, {}, dirKeyFor(DIR_A)))
    expect(scoped).toContain(idA)
    expect(scoped).not.toContain(idB)
    // The default output carries no aggregate header.
    expect(parseAggregateHeader(scoped)).toBeUndefined()
  })

  test("a single partition degrades to the default output byte for byte", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    const a = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
    )

    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const scoped = await succeed(renderTicketsTextDeep(ctx, {}, dirKeyFor(DIR_A)))
    expect(aggregate).toBe(scoped)
    expect(aggregate).toContain(a.ticket.id)
    // No total line, no group header: exactly the old output.
    expect(parseAggregateHeader(aggregate)).toBeUndefined()
    expect(aggregate).not.toContain("共 ")
    expect(aggregate).not.toContain("目录 ")
  })

  test("an empty process renders the same empty text as the default view", async () => {
    const ctx = memoryContext()
    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const scoped = await succeed(renderTicketsTextDeep(ctx, {}))
    expect(aggregate).toBe(scoped)
  })

  test("the limit applies per partition, not to the whole aggregate", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    // Three tickets in alpha, one in beta.
    for (let index = 0; index < 3; index += 1) {
      await succeed(
        createTicket(ctx, {
          ...base,
          threadID: `telegram:a${index}`,
          title: `A${index}`,
          directory: DIR_A,
          dirKey: dirKeyFor(DIR_A),
          now: 1_000 + index,
        }),
      )
    }
    await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:b", title: "B", directory: DIR_B, dirKey: dirKeyFor(DIR_B) }),
    )

    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, { limit: 2 }))
    const header = parseAggregateHeader(aggregate)
    // 2 from alpha + 1 from beta = 3 in total, over 2 directories.
    expect(header).toEqual({ total: 3, directories: 2 })
    // Alpha keeps its two newest tickets, beta its one.
    expect(aggregate).toContain("A2")
    expect(aggregate).toContain("A1")
    expect(aggregate).not.toContain("A0")
    expect(aggregate).toContain("B")
  })

  test("a ticket that was trimmed out of memory still shows up in its group", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    const a = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
    )
    const b = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:b", title: "B", directory: DIR_B, dirKey: dirKeyFor(DIR_B) }),
    )
    // Simulate memory trimming: the records stay in KV, the mirror forgets them.
    resetTickets()

    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    expect(aggregate).toContain(a.ticket.id)
    expect(aggregate).toContain(b.ticket.id)
    expect(parseAggregateHeader(aggregate)).toEqual({ total: 2, directories: 2 })
  })
})

describe("the aggregate layout", () => {
  test("one group is rendered as its body alone", () => {
    expect(renderAggregatedTickets([{ dirKey: "a", count: 1, body: "BODY" }])).toBe("BODY")
  })

  test("no group is empty", () => {
    expect(renderAggregatedTickets([])).toBe("")
  })

  test("several groups carry a total line and one header each", () => {
    const text = renderAggregatedTickets([
      { dirKey: "a", directory: "/opt/alpha", count: 1, body: "BODY-A" },
      { dirKey: "b", directory: "/opt/beta", count: 2, body: "BODY-B" },
    ])
    expect(text.split("\n")[0]).toBe("共 3 条，2 个目录")
    expect(text).toContain("目录 /opt/alpha · a · 1 条")
    expect(text).toContain("目录 /opt/beta · b · 2 条")
    expect(text).toContain("BODY-A")
    expect(text).toContain("BODY-B")
  })

  test("a group without a known directory still names its partition", () => {
    const text = renderAggregatedTickets([
      { dirKey: "default", count: 1, body: "BODY" },
      { dirKey: "other", count: 1, body: "BODY" },
    ])
    expect(text).toContain("目录 - · default · 1 条")
  })
})

describe("the aggregate text parses back into groups", () => {
  test("the group headers and the ticket rows survive the round trip", async () => {
    const { ctx, idA, idB } = await seedTwoPartitions()
    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const groups = parseAggregatedTicketList(aggregate)

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.dirKey).sort()).toEqual(
      [dirKeyFor(DIR_A), dirKeyFor(DIR_B)].sort(),
    )
    expect(groups.flatMap((group) => group.rows.map((row) => row.id)).sort()).toEqual([idA, idB].sort())
    // Each group knows its directory.
    expect(groups.map((group) => group.directory).sort()).toEqual([DIR_A, DIR_B].sort())
    // The group headers carry the server's own count, so a surface that shows
    // it never disagrees with the command.
    expect(groups.map((group) => group.count).sort()).toEqual([1, 1])
  })

  test("the single-partition text parses into one group without a partition key", async () => {
    applySettings({ perDirectoryRouter: true })
    const ctx = memoryContext()
    const a = await succeed(
      createTicket(ctx, { ...base, threadID: "telegram:a", title: "A", directory: DIR_A, dirKey: dirKeyFor(DIR_A) }),
    )
    const aggregate = await succeed(renderAllTicketsTextDeep(ctx, {}))
    const groups = parseAggregatedTicketList(aggregate)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.dirKey).toBeUndefined()
    expect(groups[0]!.rows.map((row) => row.id)).toEqual([a.ticket.id])
  })
})
