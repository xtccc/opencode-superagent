import { Rpc } from "@opencode/plugin/effect"
import { Schema } from "effect"
// `ticket-view` carries the TUI-safe copy of the state list (it must not import
// the KV-backed store); `test/ticket-view.test.ts` keeps it in step with
// `src/ticket.ts`, so reusing it here keeps the RPC enum from drifting.
import { TICKET_STATES } from "./ticket-view.js"

/**
 * Server-side RPC contract for the Super-agent P0 prototype.
 *
 * The TUI (`tui.tsx`) calls these methods through `client.rpc(Definition)`,
 * so the id, method names and field names are fixed. Schemas are wrapped
 * with `Schema.toStandardSchemaV1` exactly like `Goal.Definition`, which is
 * what makes the same definition usable from both the Effect server
 * (`ctx.rpc.register`) and the Promise TUI client.
 */
export const Definition = Rpc.define({
  id: "opencode.superagent",
  methods: {
    router: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
    },
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({})),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          router: Schema.optionalKey(Schema.String),
          pending: Schema.Number,
          workers: Schema.Array(
            Schema.Struct({
              sessionID: Schema.String,
              title: Schema.optionalKey(Schema.String),
              threads: Schema.Array(Schema.String),
              state: Schema.Literals(["running", "idle", "failed", "done", "aborted"]),
            }),
          ),
        }),
      ),
    },
    tickets: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          threadID: Schema.optionalKey(Schema.String),
          status: Schema.optionalKey(Schema.Literals(TICKET_STATES)),
          limit: Schema.optionalKey(Schema.Number),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ text: Schema.String })),
      errors: {
        "tickets.invalid_status": Schema.toStandardSchemaV1(Schema.Struct({ status: Schema.String })),
      },
    },
    ticket: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ ticketID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ text: Schema.String })),
    },
    dispatch: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          task: Schema.String,
          title: Schema.optionalKey(Schema.String),
          threadID: Schema.optionalKey(Schema.String),
          agent: Schema.optionalKey(Schema.String),
          directory: Schema.optionalKey(Schema.String),
          // Required: the RPC path enforces the same work-order gate as the tool.
          ticketID: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      errors: { "dispatch.rejected": Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
    trigger: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          id: Schema.optionalKey(Schema.String),
          source: Schema.String,
          threadID: Schema.String,
          author: Schema.optionalKey(Schema.String),
          text: Schema.String,
          title: Schema.optionalKey(Schema.String),
          createdAt: Schema.optionalKey(Schema.Number),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          route: Schema.Literals(["router", "worker", "dropped"]),
          sessionID: Schema.optionalKey(Schema.String),
        }),
      ),
    },
    stop: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(Schema.Struct({ interrupted: Schema.Boolean })),
    },
    abort: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.optionalKey(Schema.String),
          reason: Schema.optionalKey(Schema.String),
          all: Schema.optionalKey(Schema.Boolean),
          stale: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ text: Schema.String })),
      errors: { "abort.rejected": Schema.toStandardSchemaV1(Schema.Struct({})) },
    },
  },
  events: {},
})
