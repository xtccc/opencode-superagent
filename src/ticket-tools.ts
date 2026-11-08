import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Schema } from "effect"
import { requireRouter } from "./guard.js"
import {
  closeTicket,
  createTicket,
  currentTrigger,
  getTicket,
  listTickets,
  renderTicketDetail,
  renderTicketList,
  TICKET_STATES,
  updateTicket,
  type TicketState,
} from "./ticket.js"
import { specFor } from "./tools.js"

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
  yield* requireRouter(caller, "ticket_create")
  const trigger = currentTrigger()
  const threadID = input.threadID.trim()
  const requester = trigger?.threadID === threadID ? trigger : undefined
  const result = yield* createTicket(ctx, {
    threadID,
    title: input.title,
    objective: input.objective,
    acceptance: input.acceptance,
    directory: input.directory,
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

const runTicketList = Effect.fn("superagent.ticketList")(function* (input: TicketListInput, caller: string) {
  yield* requireRouter(caller, "ticket_list")
  const text = renderTicketList(
    listTickets({
      ...(input.threadID === undefined ? {} : { threadID: input.threadID }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  )
  return { output: { text }, content: text }
})

const runTicketUpdate = Effect.fn("superagent.ticketUpdate")(function* (
  ctx: Plugin.Context,
  input: TicketUpdateInput,
  caller: string,
) {
  yield* requireRouter(caller, "ticket_update")
  const ticket = yield* updateTicket(ctx, {
    ticketID: input.ticketID,
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
  yield* requireRouter(caller, "ticket_close")
  const ticket = yield* closeTicket(ctx, {
    ticketID: input.ticketID,
    outcome: input.outcome,
    summary: input.summary,
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

export const registerTicketTools = Effect.fn("superagent.registerTicketTools")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "ticket_create",
      description: specFor("ticket_create").description,
      input: TicketCreateInput,
      output: TicketRefOutput,
      execute: (input, context) => runTicketCreate(ctx, input, context.sessionID),
    })
    editor.add({
      name: "ticket_list",
      description: specFor("ticket_list").description,
      input: TicketListInput,
      output: TicketTextOutput,
      options: { permission: "status" },
      execute: (input, context) => runTicketList(input, context.sessionID),
    })
    editor.add({
      name: "ticket_update",
      description: specFor("ticket_update").description,
      input: TicketUpdateInput,
      output: TicketRefOutput,
      execute: (input, context) => runTicketUpdate(ctx, input, context.sessionID),
    })
    editor.add({
      name: "ticket_close",
      description: specFor("ticket_close").description,
      input: TicketCloseInput,
      output: TicketRefOutput,
      execute: (input, context) => runTicketClose(ctx, input, context.sessionID),
    })
  })
})
