import type { Plugin } from "@opencode/plugin/effect"
import type { Schema } from "effect"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AbortInput } from "../src/abort.js"
import { DispatchInput } from "../src/dispatch.js"
import { ReportReadInput, ThreadDetailInput, WorkerDetailInput } from "../src/recall.js"
import { SleepInput } from "../src/sleep.js"
import {
  registerTicketTools,
  TicketCloseInput,
  TicketCreateInput,
  TicketListInput,
  TicketUpdateInput,
} from "../src/ticket-tools.js"
import {
  describeLimits,
  describeTool,
  displayWidth,
  GROUP_LABELS,
  RISK_LABELS,
  ROUTER_LIMITS,
  ROUTER_PERMISSION_ACTIONS,
  ROUTER_PERMISSIONS,
  ROUTER_TOOL_SPECS,
  ROUTER_TOOLS,
  specFor,
  toolPermission,
  type ToolParam,
} from "../src/tools.js"

/** Registered input schemas, which the catalog parameter tables must mirror. */
const schemas = {
  dispatch: DispatchInput,
  ticket_create: TicketCreateInput,
  ticket_list: TicketListInput,
  ticket_update: TicketUpdateInput,
  ticket_close: TicketCloseInput,
  thread_detail: ThreadDetailInput,
  worker_detail: WorkerDetailInput,
  report_read: ReportReadInput,
  abort_session: AbortInput,
  sleep: SleepInput,
} as Record<string, Schema.Schema<unknown>>

interface Field {
  readonly ast: { readonly _tag: string; readonly context?: { readonly isOptional: boolean } }
}

function fieldsOf(schema: Schema.Schema<unknown>): Record<string, Field> {
  return (schema as unknown as { fields: Record<string, Field> }).fields
}

/** Catalog type spellings for a schema field: `Schema.Array` and literal unions need mapping. */
function expectedTypes(field: Field, param: ToolParam): Array<string> {
  if (field.ast._tag === "Arrays") return ["string[]"]
  // A literal union is a set of allowed string values, rendered via `values`.
  if (field.ast._tag === "Union") return ["string"]
  return [field.ast._tag.toLowerCase()]
}

describe("superagent tool catalog", () => {
  test("every registered tool has exactly one spec and vice versa", () => {
    const names = ROUTER_TOOL_SPECS.map((spec) => spec.name)
    expect(new Set(names).size).toBe(names.length)
    expect([...ROUTER_TOOLS].sort()).toEqual(Object.keys(schemas).concat("status").sort())
    expect(() => specFor("nope")).toThrow()
  })

  test("spec parameters match the registered input schema", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const fields = fieldsOf(schema)
      const spec = specFor(name)
      expect({ tool: name, params: spec.params.map((param) => param.name) }).toEqual({
        tool: name,
        params: Object.keys(fields),
      })
      for (const param of spec.params) {
        const field = fields[param.name]
        if (field === undefined) throw new Error(`${name}.${param.name} is not in the schema`)
        expect({ name: `${name}.${param.name}`, required: param.required }).toEqual({
          name: `${name}.${param.name}`,
          required: field.ast.context?.isOptional !== true,
        })
        expect({ name: `${name}.${param.name}`, allowed: expectedTypes(field, param) }).toEqual({
          name: `${name}.${param.name}`,
          allowed: [param.type],
        })
      }
    }
    // `status` takes no input at all.
    expect(specFor("status").params).toEqual([])
  })

  test("detail views fit the dialog column on a narrow terminal", () => {
    const views = [...ROUTER_TOOL_SPECS.map((spec) => describeTool(spec)), describeLimits()]
    for (const view of views) {
      for (const line of view.split("\n")) {
        expect(displayWidth(line)).toBeLessThanOrEqual(52)
        // CJK punctuation may not open a line.
        expect("，。、；：！？）》」』】…".includes(line.slice(0, 1)) && line !== "").toBe(false)
      }
    }
  })

  test("ticket_create requires objective, acceptance and directory", () => {
    const required = specFor("ticket_create")
      .params.filter((param) => param.required)
      .map((param) => param.name)
    expect(required).toEqual(["threadID", "title", "objective", "acceptance", "directory"])
    // No dispatch without a ticket: the parameter is mandatory in the catalog.
    expect(specFor("dispatch").params.find((param) => param.name === "ticketID")?.required).toBe(true)
  })

  test("every spec is renderable and documented", () => {
    for (const spec of ROUTER_TOOL_SPECS) {
      expect(spec.summary.length).toBeGreaterThan(0)
      expect(spec.confirmation.length).toBeGreaterThan(0)
      expect(GROUP_LABELS[spec.group]).toBeString()
      expect(RISK_LABELS[spec.risk]).toBeString()
    }
    expect(ROUTER_LIMITS.length).toBeGreaterThan(0)
    expect(displayWidth("abort")).toBe(5)
    expect(displayWidth("能力边界")).toBe(8)
  })

  test("every catalog tool declares an action the router session allows", () => {
    expect(ROUTER_PERMISSIONS[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    for (const spec of ROUTER_TOOL_SPECS) {
      const action = toolPermission(spec)
      expect({ tool: spec.name, allowed: ROUTER_PERMISSION_ACTIONS.includes(action) }).toEqual({
        tool: spec.name,
        allowed: true,
      })
      // Last matching rule decides, exactly like Tool.snapshot's filter.
      const deciding = ROUTER_PERMISSIONS.filter((rule) => rule.action === "*" || rule.action === action).at(-1)
      expect({ tool: spec.name, effect: deciding?.effect }).toEqual({ tool: spec.name, effect: "allow" })
    }
    // Actions no tool declares stay denied, so file and shell tools never appear.
    expect(ROUTER_PERMISSIONS.some((rule) => rule.action === "edit" || rule.action === "read")).toBe(false)
  })

  test("the ticket tools register the catalog permission action", async () => {
    const registered: Array<{ name: string; options?: { permission?: string } }> = []
    const editor = { add: (tool: (typeof registered)[number]) => registered.push(tool) }
    const ctx = {
      tool: { transform: (fn: (target: typeof editor) => void) => Effect.sync(() => fn(editor)) },
    } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerTicketTools(ctx)))
    expect(registered.map((tool) => tool.name)).toEqual([
      "ticket_create",
      "ticket_list",
      "ticket_update",
      "ticket_close",
    ])
    // Without a permission option the tool's action is its own name, which the
    // router denies: ticket_create/ticket_update/ticket_close disappear from
    // the model's toolset while ticket_list stays.
    for (const tool of registered) {
      expect({ tool: tool.name, permission: tool.options?.permission }).toEqual({
        tool: tool.name,
        permission: "status",
      })
    }
  })
})
