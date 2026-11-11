import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, type Types } from "effect"
import {
  AGENT_DEFINITIONS,
  applyAgentDefinitions,
  registerAgents,
  ROUTER_AGENT,
  WORKER_AGENT,
  type AgentDefinition,
} from "../src/agents.js"
import { ROUTER_PROMPT } from "../src/prompts.js"

// Both agents are registered by the plugin at setup, so the runtime no longer
// needs `.opencode/agent/*.md` copies. The markdown files stay as templates
// (customization, plus the fallback for hosts that cannot create agents from a
// plugin transform); the sync assertions below keep template and code from
// drifting apart. The router template only carries identity (mode, description,
// hidden) and a one-line body: every behavioral rule lives in ROUTER_PROMPT,
// which the context hook injects each step.
const packageRoot = path.join(import.meta.dir, "..")
// Repository root, where a manual copy would shadow the registration.
const projectAgentDirectory = path.join(packageRoot, "..", "..", "..", ".opencode", "agent")

const MAX_BODY_LENGTH = 200
const FORBIDDEN_BODY_TERMS = ["dispatch", "ticket_", "工具", "工单"]

function splitFrontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) throw new Error("agent markdown is missing frontmatter")
  return { frontmatter: match[1]!, body: text.slice(match[0].length).trim() }
}

function frontmatterFields(frontmatter: string) {
  const fields: Record<string, string> = {}
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line)
    if (match) fields[match[1]!] = match[2]!.trim()
  }
  return fields
}

function templateOf(definition: AgentDefinition) {
  const text = readFileSync(path.join(packageRoot, "agent", `${definition.id}.md`), "utf8")
  const { frontmatter, body } = splitFrontmatter(text)
  return { text, fields: frontmatterFields(frontmatter), body }
}

type MutableAgent = Types.DeepMutable<Agent.Info>

interface KernelOptions {
  /** Older kernels ignore `editor.update` for an unknown id instead of materializing it. */
  readonly creates?: boolean
  /** Definitions a config file would have registered before (or after) this plugin. */
  readonly seed?: ReadonlyArray<Omit<Partial<MutableAgent>, "id"> & { readonly id: string }>
}

/**
 * A stand-in for the agent state: replaying a list, applying registrations in
 * order, exactly like `State.create` does, including the `Info.default`
 * materialization the plugin relies on.
 */
function makeKernel(options: KernelOptions = {}) {
  const registrations: Array<(editor: AgentEditor) => void> = []
  const editor = () => {
    const agents = new Map<string, MutableAgent>()
    for (const seed of options.seed ?? []) {
      agents.set(seed.id, { ...Agent.Info.default(Agent.ID.make(seed.id)), ...seed } as MutableAgent)
    }
    const target: AgentEditor = {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
      default: () => {},
      update: (id, update) => {
        const existing = agents.get(id)
        if (existing === undefined && options.creates === false) return
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
    editor,
    snapshot: () => editor().list(),
  }
}

function fakeContext(kernel: ReturnType<typeof makeKernel>) {
  return {
    agent: {
      transform: (callback: (editor: AgentEditor) => void) =>
        Effect.sync(() => {
          kernel.register(callback)
          return { dispose: Effect.void }
        }),
      list: () =>
        Effect.sync(() => ({
          location: { directory: AbsolutePath.make("/tmp/superagent-test") },
          data: kernel.snapshot(),
        })),
    },
  } as unknown as Plugin.Context
}

const byID = (agents: ReadonlyArray<MutableAgent>, id: string) => agents.find((agent) => agent.id === id)!
const ids = (agents: ReadonlyArray<MutableAgent>) => agents.map((agent) => String(agent.id)).sort()

describe("superagent agent definitions", () => {
  test("register the router identity and the worker subagent", () => {
    const kernel = makeKernel()
    kernel.register(applyAgentDefinitions)

    const agents = kernel.snapshot()
    expect(ids(agents)).toEqual([ROUTER_AGENT, WORKER_AGENT])
    expect(byID(agents, ROUTER_AGENT)).toMatchObject({
      id: ROUTER_AGENT,
      description: "Superagent router. Talks to the human, never executes work itself.",
      mode: "primary",
      hidden: true,
    })
    expect(byID(agents, WORKER_AGENT)).toMatchObject({
      id: WORKER_AGENT,
      description: "Superagent worker. Executes one task in its own session.",
      mode: "subagent",
      hidden: false,
    })
    expect(byID(agents, ROUTER_AGENT).system).toBe(AGENT_DEFINITIONS[0]!.system)
    expect(byID(agents, WORKER_AGENT).system).toBe(AGENT_DEFINITIONS[1]!.system)
  })

  test("setup registers both agents through ctx.agent.transform", async () => {
    const kernel = makeKernel()
    await Effect.runPromise(Effect.scoped(registerAgents(fakeContext(kernel))))
    expect(ids(kernel.snapshot())).toEqual([ROUTER_AGENT, WORKER_AGENT])
  })

  test("registration is idempotent across replays", () => {
    const kernel = makeKernel()
    kernel.register(applyAgentDefinitions)
    // Same callback registered twice, and a second pass over the same editor:
    // neither duplicates entries nor changes the registered values.
    kernel.register(applyAgentDefinitions)
    expect(kernel.snapshot()).toHaveLength(2)

    const editor = kernel.editor()
    expect(applyAgentDefinitions(editor)).toEqual([])
    expect(editor.list()).toHaveLength(2)
  })

  test("a definition registered before the plugin is kept", () => {
    const kernel = makeKernel({
      seed: [{ id: ROUTER_AGENT, description: "user file router", mode: "primary", hidden: false }],
    })
    kernel.register(applyAgentDefinitions)

    expect(byID(kernel.snapshot(), ROUTER_AGENT)).toMatchObject({
      description: "user file router",
      hidden: false,
    })
    expect(byID(kernel.snapshot(), ROUTER_AGENT).system).toBeUndefined()
  })

  test("a definition applied after the plugin wins the fields it sets", () => {
    // Real replay order: external plugins register before the built-in config
    // agent plugin, so `.opencode/agent/*.md` documents apply afterwards.
    const kernel = makeKernel()
    kernel.register(applyAgentDefinitions)
    kernel.register((editor) =>
      editor.update(ROUTER_AGENT, (agent) => {
        agent.description = "user file router"
        agent.system = "user file system"
        agent.hidden = false
      }),
    )

    expect(byID(kernel.snapshot(), ROUTER_AGENT)).toMatchObject({
      description: "user file router",
      system: "user file system",
      hidden: false,
    })
  })

  test("registration needs no .opencode/agent files", async () => {
    // Nothing seeds the kernel from disk: this is an install whose only agent
    // source is the plugin itself.
    const kernel = makeKernel()
    await Effect.runPromise(Effect.scoped(registerAgents(fakeContext(kernel))))
    const agents = kernel.snapshot()
    expect(ids(agents)).toEqual([ROUTER_AGENT, WORKER_AGENT])
    expect(byID(agents, WORKER_AGENT).system).toContain("独立的 Worker")
  })

  test("reports ids when an older kernel ignores updates for unknown ids", async () => {
    const kernel = makeKernel({ creates: false })
    // The transform still runs; it degrades to reporting instead of throwing,
    // which is what lets setup warn and fall back to the markdown templates.
    await Effect.runPromise(Effect.scoped(registerAgents(fakeContext(kernel))))
    expect(kernel.snapshot()).toEqual([])
    expect(applyAgentDefinitions(kernel.editor())).toEqual([ROUTER_AGENT, WORKER_AGENT])
  })
})

describe("superagent agent markdown templates", () => {
  test("templates mirror the programmatic definitions field by field", () => {
    for (const definition of AGENT_DEFINITIONS) {
      const { fields, body } = templateOf(definition)
      expect(fields.description).toBe(definition.description)
      expect(fields.mode).toBe(definition.mode)
      expect(fields.hidden === "true").toBe(definition.hidden)
      expect(body).toBe(definition.system)
    }
  })

  test("router template body is a short identity stub, not a rulebook", () => {
    const { body } = templateOf(AGENT_DEFINITIONS[0]!)
    expect(body.length).toBeGreaterThan(0)
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
    for (const term of FORBIDDEN_BODY_TERMS) expect(body).not.toContain(term)
  })

  test("router template body does not restate ROUTER_PROMPT sections", () => {
    const { body } = templateOf(AGENT_DEFINITIONS[0]!)
    const ruleLines = ROUTER_PROMPT.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
    expect(ruleLines.length).toBeGreaterThan(0)
    for (const line of ruleLines) expect(body).not.toContain(line)
  })

  test("ROUTER_PROMPT still carries the ticket-first contract", () => {
    expect(ROUTER_PROMPT).toContain("工单优先")
    expect(ROUTER_PROMPT).toContain("ticket_create")
    expect(ROUTER_PROMPT).toContain("ticket_close")
  })

  test("ROUTER_PROMPT carries the effort allocation policy", () => {
    // The router is the only place that picks an effort, so the judged criteria,
    // the retry escalation, the accounting line and the degradation rules must
    // live here rather than in the worker prompt.
    expect(ROUTER_PROMPT).toContain("推理档位分配")
    for (const level of ["low：", "medium（默认）", "high："]) expect(ROUTER_PROMPT).toContain(level)
    expect(ROUTER_PROMPT).toContain("禁止无理由用 high")
    expect(ROUTER_PROMPT).toContain("重试升档")
    expect(ROUTER_PROMPT).toContain("effort=<档位>：<理由>")
    expect(ROUTER_PROMPT).toContain("不能与显式 agent 覆盖同用")
    expect(ROUTER_PROMPT).toContain("unverified: inherited")
  })

  test("the worker prompt does not restate the effort policy", () => {
    // Keeping the rulebook out of the worker keeps its context small; the only
    // effort-related line there is the "you cannot change it" constraint.
    const { system } = AGENT_DEFINITIONS.find((definition) => definition.id === WORKER_AGENT)!
    expect(system).toContain("推理档位在会话创建时已固定")
    for (const term of ["推理档位分配", "medium（默认）", "重试升档", "effort=<档位>", "low：", "high："]) {
      expect(system).not.toContain(term)
    }
  })

  // Template sync for the repository's own copy. It is optional on purpose: a
  // fresh install has no `.opencode/agent` files at all, and this copy can be
  // deleted now that setup registers both agents.
  for (const definition of AGENT_DEFINITIONS) {
    const projectPath = path.join(projectAgentDirectory, `${definition.id}.md`)
    test.skipIf(!existsSync(projectPath))(`project copy of ${definition.id}.md matches the template`, () => {
      expect(readFileSync(projectPath, "utf8")).toBe(templateOf(definition).text)
    })
  }
})
