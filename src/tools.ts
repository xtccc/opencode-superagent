/**
 * The Router tool catalog: one entry per tool the Router session may call.
 *
 * It is the single source of truth for three consumers:
 * - `server.ts` registrations take their description from here (`specFor`),
 *   which throws when a tool has no entry, so a registration cannot ship
 *   undocumented;
 * - `context.ts` filters the Router's toolset by `ROUTER_TOOLS`, derived below;
 * - the TUI `/tools` command renders the same entries, so a new tool shows up
 *   without touching the command.
 *
 * Parameters are declared for display and checked against the registered input
 * schema in `test/tools.test.ts`, which fails when the two drift apart.
 */

export type ToolRisk = "read" | "write" | "terminate"
export type ToolGroup = "dispatch" | "query" | "control"

export interface ToolParam {
  readonly name: string
  readonly required: boolean
  readonly type: "string" | "number" | "boolean" | "string[]"
  /** Accepted values when only a fixed set is meaningful. */
  readonly values?: ReadonlyArray<string>
  /** Short note; keep it under one display line (see `describeTool`). */
  readonly note?: string
}

export interface ToolSpec {
  readonly name: string
  readonly group: ToolGroup
  /** Registered verbatim as the description the Router model sees. */
  readonly description: string
  /** One sentence for the `/tools` browser. */
  readonly summary: string
  readonly params: ReadonlyArray<ToolParam>
  readonly risk: ToolRisk
  /** How a call is gated: automatic, or through a permission action. */
  readonly confirmation: string
  /** Extra usage notes for the detail view. */
  readonly usage?: ReadonlyArray<string>
}

export const GROUP_LABELS: Record<ToolGroup, string> = {
  dispatch: "调度类",
  query: "查询类",
  control: "控制类",
}

export const RISK_LABELS: Record<ToolRisk, string> = {
  read: "只读",
  write: "可写",
  terminate: "终止",
}

export const ROUTER_TOOL_SPECS: ReadonlyArray<ToolSpec> = [
  {
    name: "dispatch",
    group: "dispatch",
    description:
      "Dispatch one independent task to a background worker session in the given directory (absolute path). Only the router may call it.",
    summary: "把独立任务派给后台 Worker 会话，不阻塞 Router。",
    params: [
      { name: "task", required: true, type: "string", note: "任务内容" },
      { name: "title", required: false, type: "string", note: "会话标题" },
      { name: "threadID", required: false, type: "string", note: "thread 绑定" },
      { name: "agent", required: false, type: "string", note: "覆盖默认 agent" },
      { name: "directory", required: false, type: "string", note: "绝对路径" },
      { name: "ticketID", required: false, type: "string", note: "关联工单 ID" },
    ],
    risk: "write",
    confirmation: "自动执行，不逐次确认：创建 Worker 会话后以队列 prompt 投递任务。",
    usage: [
      "每次派发都要带 directory（绝对路径）；Router 会复用 thread 绑定与目录别名。",
      "同一 thread 的后续消息直投该 Worker，不要重复 dispatch。",
      "先 ticket_create 建单，再带 ticketID 派发：工单记录 workerSessionID 与 attempts，Worker 结束自动结单。",
    ],
  },
  {
    name: "ticket_create",
    group: "dispatch",
    description:
      "Create a work ticket before dispatching: title, objective, acceptance criteria (1-10) and an absolute directory are required. Returns the ticket id and reuses an open ticket with the same dedupe key in the same thread. Only the router may call it.",
    summary: "建工单：写清目标、验收标准与目录，重复任务自动复用。",
    params: [
      { name: "threadID", required: true, type: "string", note: "thread 标识" },
      { name: "title", required: true, type: "string", note: `≤80 字` },
      { name: "objective", required: true, type: "string", note: "要做什么" },
      { name: "acceptance", required: true, type: "string[]", note: "1-10 条验收标准" },
      { name: "directory", required: true, type: "string", note: "绝对路径" },
      { name: "priority", required: false, type: "string", values: ["p0", "p1", "p2"], note: "默认 p1" },
      { name: "parentTicketID", required: false, type: "string", note: "拆单时指向父单" },
      { name: "dedupeKey", required: false, type: "string", note: "默认按来源+thread+目标生成" },
    ],
    risk: "write",
    confirmation: "自动执行：仅建单，不派活；authorization 自动取当前触发器的 id 与原话摘要。",
    usage: [
      "acceptance 为空直接拒绝建单：想不出验收标准就先问用户。",
      "同 thread 已有 open/in_progress 同 dedupeKey 的工单会直接复用（reused=true）。",
    ],
  },
  {
    name: "ticket_list",
    group: "query",
    description:
      "List tickets, optionally filtered by thread, state, update time and limit. Returns id/state/title/priority/worker per ticket. Only the router may call it.",
    summary: "按 thread/状态/时间列出工单（默认 20 条）。",
    params: [
      { name: "threadID", required: false, type: "string", note: "只看该 thread" },
      {
        name: "status",
        required: false,
        type: "string",
        values: ["open", "in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
        note: "状态过滤",
      },
      { name: "since", required: false, type: "number", note: "updatedAt 起始毫秒" },
      { name: "limit", required: false, type: "number", note: "默认 20，上限 100" },
    ],
    risk: "read",
    confirmation: "只读，自动执行（permission: status）。",
    usage: ["按 updatedAt 倒序；需要某张单的完整验收标准用 /ticket <id>。"],
  },
  {
    name: "ticket_update",
    group: "control",
    description:
      "Move a ticket along its state machine (open → in_progress → blocked/done/failed/cancelled/superseded) and optionally append a note. Illegal transitions are rejected. Only the router may call it.",
    summary: "推进工单状态或追加备注，非法迁移直接报错。",
    params: [
      { name: "ticketID", required: true, type: "string", note: "工单 ID" },
      {
        name: "status",
        required: false,
        type: "string",
        values: ["open", "in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
        note: "目标状态",
      },
      { name: "note", required: false, type: "string", note: "备注，写入 history" },
    ],
    risk: "write",
    confirmation: "自动执行：状态迁移按状态机校验。",
    usage: ["结束任务优先用 ticket_close（带 outcome 与 summary），不要手动跳到 done。"],
  },
  {
    name: "ticket_close",
    group: "control",
    description:
      "Close a ticket with an outcome (done, failed or cancelled) and a summary; records closedAt, closeReason and a history entry. Only the router may call it.",
    summary: "结单：写入结论、关闭时间与历史。",
    params: [
      { name: "ticketID", required: true, type: "string", note: "工单 ID" },
      { name: "outcome", required: true, type: "string", values: ["done", "failed", "cancelled"], note: "结果" },
      { name: "summary", required: true, type: "string", note: "结论，≤500 字" },
    ],
    risk: "write",
    confirmation: "自动执行：已结单的工单保持原状态，改结论需新建工单。",
    usage: ["Worker 结束会自动结单；只有在 Router 主动放弃/改判时才手动调用。"],
  },
  {
    name: "status",
    group: "query",
    description: "Show a compact summary of the router, pending triggers and worker sessions.",
    summary: "查看 Router、pending 触发器数量与全部 Worker 的 thread/状态/最近报告。",
    params: [],
    risk: "read",
    confirmation: "只读，自动执行（permission: status）。",
    usage: ["system 状态行只给计数，细节用 status / thread_detail。"],
  },
  {
    name: "thread_detail",
    group: "query",
    description: "Show a thread's trigger history plus its subscribed workers. Only the router may call it.",
    summary: "查看某个 thread 的触发器历史（谁在何时说了什么）与订阅它的 Worker。",
    params: [
      { name: "threadID", required: true, type: "string", note: "thread 标识" },
      { name: "limit", required: false, type: "number", note: "默认 20 条" },
    ],
    risk: "read",
    confirmation: "只读，自动执行（permission: status）。",
    usage: ["详细信息不在 system 里：需要原文时用它，不要猜。"],
  },
  {
    name: "worker_detail",
    group: "query",
    description: "Show a worker's state plus its recent assistant messages. Only the router may call it.",
    summary: "查看某个 Worker 的状态与最近几条 assistant 文本。",
    params: [
      { name: "sessionID", required: true, type: "string", note: "Worker 会话 ID" },
      { name: "messages", required: false, type: "number", note: "默认 5，上限 10" },
    ],
    risk: "read",
    confirmation: "只读，自动执行（permission: status）。",
    usage: ["用于验收 Worker 的中间结论，不必等它结束。", "单条消息默认截断 1500 字；要看完整报告用 report_read。"],
  },
  {
    name: "report_read",
    group: "query",
    description:
      "Read the full report text a worker produced when it finished, by character range (offset, limit). Returns the slice plus the total length, truncation state and the next offset. Only the router may call it.",
    summary: "分页读取 Worker 结束报告的完整全文（默认 4000 字/页）。",
    params: [
      { name: "sessionID", required: true, type: "string", note: "Worker 会话 ID" },
      { name: "offset", required: false, type: "number", note: "起始字符偏移，默认 0" },
      { name: "limit", required: false, type: "number", note: "默认 4000，上限 20000" },
    ],
    risk: "read",
    confirmation: "只读，自动执行（permission: status）。",
    usage: [
      "只存 Worker 结束时捕获的全文；没有全文记录会直接报错，此时用 worker_detail。",
      "按返回的 nextOffset 翻页，到末尾时提示「已到末尾」。",
    ],
  },
  {
    name: "abort_session",
    group: "control",
    description:
      "Terminate a tracked worker session: interrupt it, wait for it to settle, mark it aborted and detach it from its thread so later messages fall back to the router. Pass sessionID, or all/stale for batch cleanup. Only the router may call it.",
    summary: "终止/清理 Worker：中断执行、等待收敛、标记 aborted 并从 thread 摘除。",
    params: [
      { name: "sessionID", required: false, type: "string", note: "单个 Worker" },
      { name: "reason", required: false, type: "string", note: "终止原因" },
      { name: "all", required: false, type: "boolean", values: ["true"], note: "终止全部" },
      { name: "stale", required: false, type: "boolean", values: ["true"], note: "只清理已结束" },
    ],
    risk: "terminate",
    confirmation: "自动执行（permission: status）：只接受插件跟踪的 Worker，Router 自身与用户会话一律拒绝。",
    usage: [
      "sessionID 与 all/stale 二选一；stale 不会中断运行中的 Worker。",
      "终止后该 thread 的下一条消息回落到 Router 重新 dispatch。",
    ],
  },
]

const specsByName = new Map(ROUTER_TOOL_SPECS.map((spec) => [spec.name, spec]))

/** Tools the Router may see; `context.ts` strips everything else from its toolset. */
export const ROUTER_TOOLS: ReadonlySet<string> = new Set(specsByName.keys())

/** Catalog entry for a registered tool. Throws so a registration can never ship undocumented. */
export function specFor(name: string): ToolSpec {
  const spec = specsByName.get(name)
  if (spec === undefined) throw new Error(`superagent tool ${name} has no entry in src/tools.ts`)
  return spec
}

/** What the Router cannot do, independent of which tools it currently has. */
export const ROUTER_LIMITS: ReadonlyArray<string> = [
  "不能读写文件或执行命令：没有 Read/Write/Edit/Bash，只能派 Worker 去做。",
  "不能操作非 superagent 会话：abort_session 只接受插件自己创建的 Worker，用户会话、Router 自身和未知 sessionID 一律拒绝。",
  "不能修改自身：改不了自己的 prompt、工具集或配置，也不能终止自己所在的 Router 会话。",
  "不能直接和 Worker 的模型对话：只能 dispatch 任务，或读它的状态、最近 assistant 消息与报告全文（report_read）。",
  "不能跨网关或跨进程：状态存在网关进程内存与 KV，重启后按 KV 恢复，不跨机器同步。",
]

/** Detail views render inside the medium dialog, so keep lines inside its text column. */
const DETAIL_WIDTH = 52

/** Terminal cells a string occupies: CJK and fullwidth forms take two. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += fullWidth(char.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

function fullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

/** CJK punctuation that must not start a line, so it stays attached to the previous unit. */
const NO_BREAK_BEFORE = "，。、；：！？）》」』】…"

/** Atomic wrap units: Latin words stay whole, CJK breaks between characters. */
function tokens(text: string): Array<string> {
  const result: Array<string> = []
  let word = ""
  for (const char of text) {
    if (char === " " || fullWidth(char.codePointAt(0) ?? 0)) {
      if (word !== "") result.push(word)
      word = ""
      const previous = result.at(-1)
      if (NO_BREAK_BEFORE.includes(char) && previous !== undefined) {
        result[result.length - 1] = `${previous}${char}`
        continue
      }
      result.push(char)
      continue
    }
    word += char
  }
  if (word !== "") result.push(word)
  return result
}

/**
 * Wrap by cell width: Latin words stay whole, CJK text has no spaces so it
 * breaks between characters, and a word wider than the line is split.
 */
export function wrapText(text: string, width: number): Array<string> {
  const lines: Array<string> = []
  let line = ""
  let cells = 0
  const push = (unit: string) => {
    const unitWidth = displayWidth(unit)
    if (cells + unitWidth > width && line !== "") {
      lines.push(line.trimEnd())
      line = ""
      cells = 0
    }
    line += unit
    cells += unitWidth
  }
  for (const token of tokens(text)) {
    if (token === " ") {
      if (line !== "") push(token)
      continue
    }
    if (displayWidth(token) > width) for (const char of token) push(char)
    else push(token)
  }
  if (line !== "") lines.push(line.trimEnd())
  return lines
}

/** One bulleted item, with continuation lines indented under the text. */
function bullet(text: string, width: number): Array<string> {
  return wrapText(`· ${text}`, width).map((line, index) => (index === 0 ? line : `  ${line}`))
}

/** A labelled paragraph whose continuation lines line up under the text. */
function labelled(label: string, text: string, width: number): Array<string> {
  const indent = " ".repeat(displayWidth(label))
  return wrapText(`${label}${text}`, width).map((line, index) => (index === 0 ? line : `${indent}${line}`))
}

function pad(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`
}

function paramLine(param: ToolParam, nameWidth: number): string {
  const required = param.required ? "必填" : "可选"
  const type = param.values === undefined ? param.type : `${param.type} ${param.values.join("|")}`
  const note = param.note === undefined ? "" : `  ${param.note}`
  return `${pad(param.name, nameWidth)}${required} ${type}${note}`
}

/** Full description of one tool: summary, parameter table, risk and usage notes. */
export function describeTool(spec: ToolSpec, width = DETAIL_WIDTH): string {
  const lines = [`${spec.name} · ${GROUP_LABELS[spec.group]} · ${RISK_LABELS[spec.risk]}`]
  lines.push(...wrapText(spec.summary, width))
  if (spec.params.length === 0) {
    lines.push("", "参数：无")
  } else {
    const nameWidth = Math.max(...spec.params.map((param) => displayWidth(param.name))) + 2
    const indent = " ".repeat(nameWidth + 7)
    lines.push("", "参数")
    for (const param of spec.params) {
      const [head, ...rest] = wrapText(paramLine(param, nameWidth), width - 2)
      if (head !== undefined) lines.push(`  ${head}`)
      // Continuation lines sit under the type column, so re-wrap them at the
      // remaining width or a long token would overflow the dialog.
      for (const line of rest.length === 0 ? [] : wrapText(rest.join(" "), width - indent.length)) {
        lines.push(`${indent}${line}`)
      }
    }
  }
  lines.push("", ...labelled("确认：", spec.confirmation, width))
  for (const note of spec.usage ?? []) lines.push(...bullet(note, width))
  return lines.join("\n")
}

/** The capability-boundary section shared by `/tools`. */
export function describeLimits(width = DETAIL_WIDTH): string {
  const lines = ["Router 只能调度，不能自己动手。以下是明确的边界：", ""]
  for (const limit of ROUTER_LIMITS) lines.push(...bullet(limit, width))
  return lines.join("\n")
}
