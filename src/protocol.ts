import { Rpc } from "@opencode/plugin/effect"
import { Schema } from "effect"
import { DISPATCH_EFFORTS } from "./effort.js"
// `ticket-view` carries the TUI-safe copy of the state list (it must not import
// the KV-backed store); `test/ticket-view.test.ts` keeps it in step with
// `src/ticket.ts`, so reusing it here keeps the RPC enum from drifting.
import { TICKET_STATES } from "./ticket-view.js"

/**
 * The single RPC contract shared by the server and the TUI.
 *
 * The TUI (`tui.tsx`) calls these methods through `client.rpc(Definition)`,
 * and `server.ts` registers the very same object (`ServerDefinition =
 * Definition`), so method names, input/output schemas and declared errors
 * cannot drift between the two halves. Schemas are wrapped with
 * `Schema.toStandardSchemaV1` exactly like `Goal.Definition`, which is what
 * makes the same definition usable from both the Effect server
 * (`ctx.rpc.register`) and the Promise TUI client.
 */
export const Definition = Rpc.define({
  id: "opencode.superagent",
  methods: {
    router: {
      // Optional `directory` (stage 3): the TUI opens the Router of the session's
      // own directory under `perDirectoryRouter`; with the flag off it falls back
      // to the single default Router, so old callers are unaffected.
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          directory: Schema.optionalKey(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
    },
    status: {
      // No `directory` = process-wide aggregate; with `directory` = that
      // directory's partition only. See `src/status.ts`.
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          directory: Schema.optionalKey(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          // Optional so an older server that predates the version notice still
          // satisfies the contract; the current server always sends it.
          version: Schema.optionalKey(Schema.String),
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
          // Stage 3 additions. Both are optional so the pre-3 shape still
          // validates (older clients keep working against a new server).
          partitions: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                dirKey: Schema.String,
                directory: Schema.optionalKey(Schema.String),
                router: Schema.optionalKey(Schema.String),
                pending: Schema.Number,
                workers: Schema.Number,
                running: Schema.Number,
              }),
            ),
          ),
          dirKey: Schema.optionalKey(Schema.String),
          directory: Schema.optionalKey(Schema.String),
        }),
      ),
    },
    tickets: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          threadID: Schema.optionalKey(Schema.String),
          status: Schema.optionalKey(Schema.Literals(TICKET_STATES)),
          limit: Schema.optionalKey(Schema.Number),
          // Stage 3: scope the list to one directory's partition. Omitted =
          // process-wide list, exactly the pre-3 behaviour.
          directory: Schema.optionalKey(Schema.String),
          // Aggregate view: list **every** partition, grouped by directory.
          // Omitted = the current behaviour (the caller's partition only, or
          // the process-wide list when no directory is given).
          all: Schema.optionalKey(Schema.Boolean),
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
          // Optional so older clients keep working; the tool path applies the
          // `variants` whitelist before it reaches `sessions.create`.
          effort: Schema.optionalKey(Schema.Literals(DISPATCH_EFFORTS)),
          directory: Schema.optionalKey(Schema.String),
          // Required by the shape, but the RPC handler never runs it: RPC
          // cannot prove router identity, so `dispatch` fails closed with
          // `dispatch.rejected` and the router uses its tool instead.
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
      // Declared in the shared contract, not only on the server: the TUI and
      // the server register the same `Definition`, so a client can tell that
      // `stop` is router-only without importing server internals.
      errors: { "stop.rejected": Schema.toStandardSchemaV1(Schema.Struct({})) },
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
