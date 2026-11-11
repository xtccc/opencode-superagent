/**
 * Programmatic agent definitions for the Router and the Worker.
 *
 * Shipping the definitions as code is what makes the plugin installable as a
 * standalone package: a fresh install no longer needs the user to copy
 * `.opencode/agent/superagent-*.md` by hand. `agent/*.md` stays in the package
 * as templates for customization and as the documented fallback for hosts
 * whose kernel cannot create agents from a plugin transform.
 *
 * Precedence is "user files first". External plugins register before the
 * built-in config agent plugin, so this transform replays *before*
 * `.opencode/agent/*.md` documents are applied; a file therefore updates the
 * same entry afterwards and keeps its own description, system, mode and
 * hidden. The `get` guard below covers hosts that replay config first (and
 * keeps repeated replays from re-applying the default).
 */

import type { Plugin } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { Effect } from "effect"

export const ROUTER_AGENT = "superagent-router"
export const WORKER_AGENT = "superagent-worker"

const ROUTER_SYSTEM = "你是 Super Agent Router 的会话身份；行为规则由运行时注入的 Router 提示提供。"

const WORKER_SYSTEM = `你是一个独立的 Worker，在自己的会话中完成被分派的单一任务。

- 专注任务本身，不主动联系用户。
- 按任务要求行事，不要越界调用无关工具；推理档位在会话创建时已固定，不要尝试切换。
- 结束时用简短结论说明改了什么、验证了什么、还有什么风险；这段文字会作为 report 交给 Router。
- 不要创建子任务给其他 worker。`

export interface AgentDefinition {
  readonly id: string
  readonly description: string
  readonly mode: "primary" | "subagent"
  readonly hidden: boolean
  readonly system: string
}

export const AGENT_DEFINITIONS = [
  {
    id: ROUTER_AGENT,
    description: "Superagent router. Talks to the human, never executes work itself.",
    mode: "primary",
    hidden: true,
    system: ROUTER_SYSTEM,
  },
  {
    id: WORKER_AGENT,
    description: "Superagent worker. Executes one task in its own session.",
    mode: "subagent",
    hidden: false,
    system: WORKER_SYSTEM,
  },
] as const satisfies ReadonlyArray<AgentDefinition>

/**
 * Registers the defaults on an agent editor, mutating it in place.
 *
 * Returns the ids the kernel refused to create. `Agent.Info.default` materializes
 * an unknown id, which is what newer kernels do inside `editor.update`; older
 * kernels silently ignore an unknown id, and there the returned ids are the
 * signal to fall back to the markdown templates.
 */
export function applyAgentDefinitions(editor: AgentEditor): string[] {
  return AGENT_DEFINITIONS.filter((definition) => !applyDefinition(editor, definition)).map(
    (definition) => definition.id,
  )
}

function applyDefinition(editor: AgentEditor, definition: AgentDefinition): boolean {
  try {
    if (editor.get(definition.id) !== undefined) return true
    editor.update(definition.id, (agent) => {
      agent.description = definition.description
      agent.mode = definition.mode
      agent.hidden = definition.hidden
      agent.system = definition.system
    })
    return editor.get(definition.id) !== undefined
  } catch {
    // A transform that throws breaks every agent read for the whole process, so a
    // kernel that rejects the edit degrades to "not registered" instead.
    return false
  }
}

export const registerAgents = Effect.fn("superagent.registerAgents")(function* (ctx: Pick<Plugin.Context, "agent">) {
  const unregistered = new Set<string>()
  yield* ctx.agent.transform((editor) => {
    for (const id of applyAgentDefinitions(editor)) unregistered.add(id)
  })
  // Force one replay so an unsupported kernel is detected during setup rather than
  // on the first agent read.
  yield* ctx.agent.list().pipe(Effect.ignore)
  if (unregistered.size === 0) return
  yield* Effect.logWarning(
    "superagent could not register its agents on this kernel; copy agent/*.md into .opencode/agent instead",
    { agents: [...unregistered] },
  )
})
