import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { requireRouter, requireRouterFor } from "./guard.js"
import {
  closeTicket,
  createTicket,
  currentTrigger,
  getTicket,
  listTicketRecords,
  listTickets,
  loadTicket,
  renderTicketDetail,
  renderTicketList,
  TICKET_STATES,
  updateTicket,
  type TicketState,
} from "./ticket.js"
import { specFor, toolPermission } from "./tools.js"

/**
 * Router-only ticket tools. They are a thin adapter: validation, the state
 * machine, dedupe and KV persistence all live in `src/ticket.ts`, so the same
 * rules apply to the dispatch and watcher links.
 */

export const TicketCreateInput = Schema.Struct({
  threadID: Schema.String,
  title: Schema.String,
  objective: Schema.String,
  acceptance: Schema.Array(Schema.String),
  directory: Schema.String,
  priority: Schema.optionalKey(Schema.Literals(["p0", "p1", "p2"])),
  parentTicketID: Schema.optionalKey(Schema.String),
  dedupeKey: Schema.optionalKey(Schema.String),
})

export const TicketListInput = Schema.Struct({
  threadID: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(TICKET_STATES)),
  since: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
})

export const TicketUpdateInput = Schema.Struct({
  ticketID: Schema.String,
  status: Schema.optionalKey(Schema.Literals(TICKET_STATES)),
  note: Schema.optionalKey(Schema.String),
})

export const TicketCloseInput = Schema.Struct({
  ticketID: Schema.String,
  outcome: Schema.Literals(["done", "failed", "cancelled"]),
  summary: Schema.String,
})

const TicketRefOutput = Schema.Struct({
  ticketID: Schema.String,
  state: Schema.String,
  reused: Schema.Boolean,
})

const TicketTextOutput = Schema.Struct({ text: Schema.String })

interface TicketCreateInput {
  readonly threadID: string
  readonly title: string
  readonly objective: string
  readonly acceptance: ReadonlyArray<string>
  readonly directory: string
  readonly priority?: "p0" | "p1" | "p2"
  readonly parentTicketID?: string
  readonly dedupeKey?: string
}

interface TicketListInput {
  readonly threadID?: string
  readonly status?: TicketState
  readonly since?: number
  readonly limit?: number
}

interface TicketUpdateInput {
  readonly ticketID: string
  readonly status?: TicketState
  readonly note?: string
}

interface TicketCloseInput {
  readonly ticketID: string
  readonly outcome: "done" | "failed" | "cancelled"
  readonly summary: string
}

const runTicketCreate = Effect.fn("superagent.ticketCreate")(function* (
  ctx: Plugin.Context,
  input: TicketCreateInput,
  caller: string,
) {
  // A Router only creates work orders for its own directory. With the switch
  // off `requireRouterFor` always returns the single default partition, so this
  // is the historical behaviour.
  const dirKey = yield* requireRouterFor(caller, input.directory, "ticket_create")
  const trigger = currentTrigger(dirKey)
  const threadID = input.threadID.trim()
  const requester = trigger?.threadID === threadID ? trigger : undefined
  const result = yield* createTicket(ctx, {
    threadID,
    title: input.title,
    objective: input.objective,
    acceptance: input.acceptance,
    directory: input.directory,
    dirKey,
    source: requester?.source ?? "router",
    ...(requester?.author === undefined ? {} : { author: requester.author }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.parentTicketID === undefined ? {} : { parentTicketID: input.parentTicketID }),
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
  })
  const ticket = result.ticket
  const content = result.reused
    ? `工单 ${ticket.id} 已存在（reused，state=${ticket.state}，priority=${ticket.priority}）：${ticket.title}。dispatch 时带上 ticketID=${ticket.id}。`
    : `工单 ${ticket.id} 已建立（state=${ticket.state}，priority=${ticket.priority}）：${ticket.title}。下一步 dispatch 时带上 ticketID=${ticket.id}。`
  return {
    output: { ticketID: ticket.id, state: ticket.state, reused: result.reused },
    content,
  }
})

const runTicketList = Effect.fn("superagent.ticketList")(function* (
  ctx: Plugin.Context,
  input: TicketListInput,
  caller: string,
) {
  const dirKey = yield* requireRouter(caller, "ticket_list")
  const text = renderTicketList(
    yield* listTicketRecords(
      ctx,
      {
        ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.since === undefined ? {} : { since: input.since }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
      dirKey,
    ),
  )
  return { output: { text }, content: text }
})

const runTicketUpdate = Effect.fn("superagent.ticketUpdate")(function* (
  ctx: Plugin.Context,
  input: TicketUpdateInput,
  caller: string,
) {
  const dirKey = yield* requireRouter(caller, "ticket_update")
  const ticket = yield* updateTicket(ctx, {
    ticketID: input.ticketID,
    dirKey,
    ...(input.status === undefined ? {} : { state: input.status }),
    ...(input.note === undefined ? {} : { note: input.note }),
  })
  const content = `工单 ${ticket.id} → ${ticket.state}：${ticket.title}`
  return { output: { ticketID: ticket.id, state: ticket.state, reused: false }, content }
})

const runTicketClose = Effect.fn("superagent.ticketClose")(function* (
  ctx: Plugin.Context,
  input: TicketCloseInput,
  caller: string,
) {
  const dirKey = yield* requireRouter(caller, "ticket_close")
  const ticket = yield* closeTicket(ctx, {
    ticketID: input.ticketID,
    outcome: input.outcome,
    summary: input.summary,
    dirKey,
  })
  const content = `工单 ${ticket.id} 已结单（${ticket.state}）：${ticket.closeReason ?? input.summary}`
  return { output: { ticketID: ticket.id, state: ticket.state, reused: false }, content }
})

/** RPC helper for the TUI: ready-to-render text, no router check (the user drove it). */
export function renderTicketsText(input: TicketListInput = {}): string {
  return renderTicketList(
    listTickets({
      ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  )
}

export function renderTicketText(ticketID: string): string {
  const ticket = getTicket(ticketID.trim())
  if (ticket === undefined) return `没有找到工单 ${ticketID}`
  return renderTicketDetail(ticket)
}

/**
 * RPC helpers that consult KV when memory no longer holds the record (it is
 * trimmed to the newest `MEMORY_LIMIT` tickets). The TUI reads through these
 * so a closed ticket that still exists in KV is never reported as missing.
 */
export const renderTicketsTextDeep = (
  ctx: Plugin.Context,
  input: TicketListInput = {},
  // Stage 3: `dirKey` scopes the read to one directory's partition (the RPC
  // passes it when the TUI sends its session directory). Omitted = the
  // process-wide list that the sidebar used before the split.
  dirKey?: string,
) =>
  listTicketRecords(
    ctx,
    {
      ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    dirKey,
  ).pipe(Effect.map(renderTicketList))

export const renderTicketTextDeep = (ctx: Plugin.Context, ticketID: string) =>
  loadTicket(ctx, ticketID).pipe(
    Effect.map((ticket) =>
      ticket === undefined ? `没有找到工单 ${ticketID}` : renderTicketDetail(ticket),
    ),
  )

export const registerTicketTools = Effect.fn("superagent.registerTicketTools")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "ticket_create",
      description: specFor("ticket_create").description,
      input: TicketCreateInput,
      output: TicketRefOutput,
      options: { permission: toolPermission(specFor("ticket_create")) },
      execute: (input, context) => runTicketCreate(ctx, input, context.sessionID),
    })
    editor.add({
      name: "ticket_list",
      description: specFor("ticket_list").description,
      input: TicketListInput,
      output: TicketTextOutput,
      options: { permission: toolPermission(specFor("ticket_list")) },
      execute: (input, context) => runTicketList(ctx, input, context.sessionID),
    })
    editor.add({
      name: "ticket_update",
      description: specFor("ticket_update").description,
      input: TicketUpdateInput,
      output: TicketRefOutput,
      options: { permission: toolPermission(specFor("ticket_update")) },
      execute: (input, context) => runTicketUpdate(ctx, input, context.sessionID),
    })
    editor.add({
      name: "ticket_close",
      description: specFor("ticket_close").description,
      input: TicketCloseInput,
      output: TicketRefOutput,
      options: { permission: toolPermission(specFor("ticket_close")) },
      execute: (input, context) => runTicketClose(ctx, input, context.sessionID),
    })
  })
})
