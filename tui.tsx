import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { RpcCallOptions } from "@opencode/client/promise"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Definition } from "./src/protocol"
import { resolveTicketQuery, searchPickerOptions } from "./src/ticket-search"
import {
  computeDialogSize,
  layoutHelp,
  layoutPickerRow,
  layoutTitle,
  moveSelection,
  PICKER_MARKER,
  PICKER_MARKER_IDLE,
  windowStart,
} from "./src/tui-picker"
import {
  parseTicketList,
  shortTicketID,
  TICKET_PANEL_LIMIT,
  TICKET_PANEL_REFRESH_MS,
  TICKET_STATE_SYMBOL,
  ticketPanel,
  type TicketRow,
  type TicketState,
} from "./src/ticket-view"
import {
  describeLimits,
  describeTool,
  GROUP_LABELS,
  RISK_LABELS,
  ROUTER_LIMITS,
  ROUTER_TOOL_SPECS,
  specFor,
} from "./src/tools"

export default Plugin.define({
  id: "opencode.superagent",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "superagent.open",
          title: "Superagent",
          palette: true,
          slash: { name: "superagent" },
          run: () => open(context),
        },
        {
          id: "superagent.tasks",
          title: "Superagent tasks",
          description: "工单 / worker 选择器：支持标题、全 ID、4 位短 ID（如 dc8d）搜索",
          palette: true,
          slash: { name: "task" },
          run: () => tasks(context),
        },
        {
          id: "superagent.abort",
          title: "Superagent abort worker",
          palette: true,
          slash: { name: "abort" },
          run: () => abort(context),
        },
        {
          id: "superagent.tools",
          title: "Superagent tools",
          palette: true,
          slash: { name: "tools", aliases: ["superagent-tools"] },
          run: () => tools(context),
        },
        {
          id: "superagent.tickets",
          title: "Superagent tickets",
          palette: true,
          slash: { name: "tickets" },
          run: () => tickets(context),
        },
        {
          id: "superagent.ticket",
          title: "Superagent ticket detail",
          description: "查看工单详情：全 ID，或侧栏显示的 4 位短 ID（如 dc8d）",
          palette: true,
          slash: { name: "ticket", arguments: true },
          run: (input) => ticket(context, input),
        },
      ],
    }))

    // Append below the built-in sidebar modules (todo, mcp, limit). The claim
    // only mounts while the sidebar itself is on screen, so its polling stops
    // when the sidebar is hidden or the pane switches to a terminal.
    context.ui.slot({
      append: "sidebar.content",
      render: () => <SidebarTickets context={context} />,
    })
  },
})

type Theme = Plugin.Context["theme"]

function ticketStateColor(theme: Theme, state: TicketState) {
  switch (state) {
    case "in_progress":
      return theme.text.feedback.info.base
    case "blocked":
      return theme.text.feedback.warning.base
    case "done":
      return theme.text.feedback.success.base
    case "failed":
      return theme.text.feedback.error.base
    case "cancelled":
    case "superseded":
      return theme.text.muted
    case "open":
      return theme.text.base
  }
}

/** Fixed 36-cell layout: the sidebar publishes no width, and 42 columns are fixed upstream. */
function SidebarTickets(props: { context: Plugin.Context }) {
  const theme = props.context.theme
  const [rows, setRows] = createSignal<ReadonlyArray<TicketRow>>([])
  const [failed, setFailed] = createSignal(false)
  let disposed = false
  let running = false

  const refresh = async () => {
    if (running) return
    running = true
    try {
      const rpc = props.context.client.rpc(Definition)
      const { text } = await rpc.tickets({ limit: TICKET_PANEL_LIMIT }, options(props.context))
      if (disposed) return
      setRows(parseTicketList(text))
      setFailed(false)
    } catch {
      if (!disposed) setFailed(true)
    } finally {
      running = false
    }
  }

  // The slot content mounts with the sidebar, so mount/cleanup is the
  // visibility signal: no polling while the panel is not on screen.
  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), TICKET_PANEL_REFRESH_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  const panel = createMemo(() => ticketPanel(rows()))

  return (
    <Show when={panel().items.length > 0 || failed()}>
      <box>
        <Show
          when={panel().items.length > 0}
          fallback={<text fg={theme.text.feedback.warning.base}>工单 读取失败</text>}
        >
          <text fg={theme.text.base} wrapMode="none" truncate>
            <b>工单 {panel().total}</b>
            <Show when={panel().active > 0}>
              <span style={{ fg: theme.text.muted }}> · {panel().active} 未结</span>
            </Show>
            <Show when={failed()}>
              <span style={{ fg: theme.text.feedback.warning.base }}> · 读取失败</span>
            </Show>
          </text>
          <For each={panel().items}>
            {(item) => (
              <box flexDirection="row" minWidth={0} onMouseUp={() => void ticket(props.context, item.id)}>
                <text wrapMode="none" truncate>
                  <span style={{ fg: ticketStateColor(theme, item.state) }}>{TICKET_STATE_SYMBOL[item.state]}</span>
                  <span style={{ fg: theme.text.base }}> {item.title}</span>
                  <span style={{ fg: theme.text.muted }}> {item.shortID}</span>
                </text>
              </box>
            )}
          </For>
          <Show when={panel().hidden > 0}>
            <text fg={theme.text.muted}>… 另有 {panel().hidden} 条已结</text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

/** One picker row: the columns it draws plus the value it resolves to. */
interface PickerRow {
  readonly value: string
  /** Searchable label, the same text the built-in select put in `title`. */
  readonly title: string
  /** Searchable detail, the same text the built-in select put in `description`. */
  readonly description?: string
  readonly glyph?: string
  readonly code?: string
  readonly status?: string
  readonly trailing?: string
  readonly tone?: TicketState
}

interface PickerConfig {
  readonly title: string
  readonly placeholder: string
  readonly rows: ReadonlyArray<PickerRow>
  readonly search?: (query: string, rows: ReadonlyArray<PickerRow>) => ReadonlyArray<PickerRow>
  readonly emptyText?: string
}

/** Only a host that predates `useTerminalDimensions` falls back to this. */
const DEFAULT_TERMINAL = { width: 100, height: 40 }
const terminalDimensions: (() => () => { width: number; height: number }) | undefined =
  typeof useTerminalDimensions === "function" ? useTerminalDimensions : undefined

/**
 * The picker dialog. The host's `dialog.select` cannot be resized (its list
 * stops at `floor(rows / 2) - 6` entries inside a 60-column frame), so the
 * picker draws its own body and `computeDialogSize` sizes it for the terminal.
 * Keys match the built-in select: type to search, ↑↓ / PgUp PgDn / Home End to
 * move, ⏎ to pick, esc to cancel.
 */
export function PickerDialog(props: {
  readonly context: Plugin.Context
  readonly config: PickerConfig
  readonly onPick: (value: string) => void
}) {
  const theme = props.context.theme
  const dimensions = terminalDimensions ? terminalDimensions() : () => DEFAULT_TERMINAL
  const size = createMemo(() => computeDialogSize(dimensions().width, dimensions().height))
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [offset, setOffset] = createSignal(0)
  const rows = createMemo(() => {
    const search = props.config.search
    return search === undefined ? props.config.rows : search(query(), props.config.rows)
  })
  const help = createMemo(() => layoutHelp(size().width, rows().length, props.config.rows.length))
  const windowBegin = createMemo(() => Math.min(offset(), Math.max(0, rows().length - 1)))
  const window = createMemo(() => rows().slice(windowBegin(), windowBegin() + size().listRows))

  let field: InputRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    // Focus after the dialog mounts; the host does the same for its own prompts.
    focusTimer = setTimeout(() => field?.focus(), 1)
  })
  onCleanup(() => {
    if (focusTimer !== undefined) clearTimeout(focusTimer)
  })

  // Keep the cursor inside the current result set and the window on the cursor.
  createEffect(() => {
    const count = rows().length
    const next = moveSelection(selected(), 0, count)
    if (next !== selected()) setSelected(next)
  })
  createEffect(() => {
    const visible = size().listRows
    const start = windowStart(selected(), offset(), visible)
    if (start !== offset()) setOffset(start)
  })

  const pick = (row: PickerRow | undefined) => {
    if (row !== undefined) props.onPick(row.value)
  }

  useKeyboard((event) => {
    const count = rows().length
    if (count === 0) return
    const step = (delta: number) => {
      event.preventDefault()
      event.stopPropagation()
      setSelected((current) => moveSelection(current, delta, count))
    }
    switch (event.name) {
      case "up":
        step(-1)
        return
      case "down":
        step(1)
        return
      case "pageup":
        step(-size().listRows)
        return
      case "pagedown":
        step(size().listRows)
        return
      case "home":
        step(-count)
        return
      case "end":
        step(count)
        return
      case "return":
      case "kpenter":
      case "linefeed":
        // Submit here so the pick runs before the input consumes the key.
        event.preventDefault()
        event.stopPropagation()
        pick(rows()[selected()])
        return
    }
  })

  return (
    <box flexDirection="column" width={size().width} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text wrapMode="none" fg={theme.text.base}>
          <b>{layoutTitle(props.config.title, size().width)}</b>
        </text>
        <text wrapMode="none" fg={theme.text.muted}>
          esc
        </text>
      </box>
      <input
        ref={(element) => (field = element)}
        focused
        placeholder={props.config.placeholder}
        placeholderColor={theme.text.muted}
        focusedTextColor={theme.text.base}
        cursorColor={theme.text.formfield.focused}
        onInput={(value) => {
          setQuery(value)
          setSelected(0)
          setOffset(0)
        }}
        onSubmit={() => pick(rows()[Math.min(selected(), Math.max(0, rows().length - 1))])}
      />
      <box flexDirection="column" height={size().listRows}>
        <Show
          when={rows().length > 0}
          fallback={
            <text wrapMode="none" fg={theme.text.muted}>
              {props.config.emptyText ?? "无匹配项"}
            </text>
          }
        >
          <For each={window()}>
            {(row, index) => {
              const active = () => windowBegin() + index() === selected()
              const line = createMemo(() =>
                layoutPickerRow(
                  {
                    marker: active() ? PICKER_MARKER : PICKER_MARKER_IDLE,
                    glyph: row.glyph,
                    code: row.code,
                    status: row.status,
                    title: row.title,
                    trailing: row.trailing,
                  },
                  size().width,
                ),
              )
              const detailColor = () => (active() ? theme.text.action.primary.focused : theme.text.muted)
              const titleColor = () => (active() ? theme.text.action.primary.focused : theme.text.base)
              const glyphColor = () => (row.tone === undefined ? detailColor() : ticketStateColor(theme, row.tone))
              return (
                <box
                  flexDirection="row"
                  width="100%"
                  backgroundColor={active() ? theme.background.action.primary.focused : undefined}
                  onMouseUp={() => pick(row)}
                >
                  <text wrapMode="none">
                    <span style={{ fg: detailColor() }}>{line().marker}</span>
                    <span style={{ fg: glyphColor() }}>{line().glyph}</span>
                    <span style={{ fg: detailColor() }}>{line().detail}</span>
                    <span style={{ fg: titleColor() }}>{line().title}</span>
                    <span style={{ fg: detailColor() }}>{line().trailing}</span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text wrapMode="none" fg={theme.text.muted}>
          {help().hint}
        </text>
        <Show when={help().counter !== ""}>
          <text wrapMode="none" fg={theme.text.muted}>
            {help().counter}
          </text>
        </Show>
      </box>
    </box>
  )
}

/**
 * Show the picker and resolve the chosen value, or `undefined` when the user
 * backs out. The host resets every dialog to `medium` on open, so the size is
 * raised right after `show`; `xlarge` (116 columns) is the widest frame the
 * dialog publishes and `computeDialogSize` stays inside it.
 */
function pickList(context: Plugin.Context, config: PickerConfig): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      context.ui.dialog.clear()
      resolve(value)
    }
    context.ui.dialog.show(
      () => <PickerDialog context={context} config={config} onPick={finish} />,
      () => finish(undefined),
    )
    try {
      context.ui.dialog.set({ size: "xlarge", centered: true })
    } catch {
      // Older hosts have no presentation options; the picker still renders, it
      // just keeps the narrower default frame.
    }
  })
}

async function open(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const { sessionID } = await rpc.router({}, options(context))
    gotoSession(context, sessionID)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent", message: message(error), variant: "error" })
  }
}

/** Ticket rows in a picker carry a prefix so their value can never collide with a worker session id. */
const TICKET_CHOICE_PREFIX = "ticket:"
/** The `tickets` RPC clamps `limit` at 100, so this is every ticket a picker can see. */
const TICKET_PICKER_LIMIT = 100
/** Shared by `/task` and the `/ticket` candidate list. */
const TICKET_SEARCH_PLACEHOLDER = "搜索：标题 / 全 ID / 4 位短 ID（如 dc8d）"

/**
 * `/task`: tickets first, then workers. Ticket rows show the 4-character short
 * id the sidebar renders, and both kinds are searchable — a short id, any id
 * fragment, or a title/worker label picks the row.
 */
async function tasks(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const call = options(context)
    const status = await rpc.status({}, call)
    // A broken ticket list must not hide the worker list (and vice versa).
    const rows = await loadTickets(context).catch(() => [])
    if (status.workers.length === 0 && rows.length === 0) {
      context.ui.toast.show({ title: "Superagent tasks", message: "暂无 worker 与工单", variant: "info" })
      return
    }
    const selection = await pickList(context, {
      title: `Superagent tasks · 工单 ${rows.length} · worker ${status.workers.length}`,
      placeholder: TICKET_SEARCH_PLACEHOLDER,
      rows: [
        ...rows.map((row) => ({
          title: `${shortTicketID(row.id)} · ${row.title === "" ? row.id : row.title}`,
          description: `${TICKET_STATE_SYMBOL[row.state]} ${row.state} · ${row.priority} · ${row.id}`,
          value: `${TICKET_CHOICE_PREFIX}${row.id}`,
          glyph: TICKET_STATE_SYMBOL[row.state],
          tone: row.state,
          code: shortTicketID(row.id),
          status: row.state,
          trailing: row.priority,
        })),
        ...status.workers.map((worker) => ({
          title: worker.title ?? worker.sessionID.slice(0, 8),
          description: `${worker.state} · ${worker.threads.join(",") || "-"} · ${worker.sessionID.slice(0, 8)}`,
          value: worker.sessionID,
          status: worker.state,
          trailing: "worker",
        })),
      ],
      search: (query, visible) => searchPickerOptions(query, visible, rows, TICKET_CHOICE_PREFIX),
    })
    if (selection === undefined) return
    if (selection.startsWith(TICKET_CHOICE_PREFIX)) {
      await ticket(context, selection.slice(TICKET_CHOICE_PREFIX.length))
      return
    }
    gotoSession(context, selection)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent tasks", message: message(error), variant: "error" })
  }
}

/** Stale cleanup entry in the abort picker; any other value is a worker session id. */
const STALE_CHOICE = "__stale__"

async function abort(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const call = options(context)
    const status = await rpc.status({}, call)
    const selection = await context.ui.dialog.select({
      title: "Superagent abort",
      options: [
        {
          title: "清理全部已结束 worker",
          description: "stale：只清理 done/failed/idle/aborted，不中断运行中的 worker",
          value: STALE_CHOICE,
        },
        ...status.workers.map((worker) => ({
          title: worker.title ?? worker.sessionID.slice(0, 8),
          description: `${worker.state} · ${worker.threads.join(",") || "-"} · ${worker.sessionID.slice(0, 8)}`,
          value: worker.sessionID,
        })),
      ],
    })
    if (selection === undefined) return
    const result =
      selection === STALE_CHOICE
        ? await rpc.abort({ stale: true }, call)
        : await rpc.abort({ sessionID: selection }, call)
    context.ui.toast.show({ title: "Superagent abort", message: result.text, variant: "info" })
  } catch (error) {
    context.ui.toast.show({ title: "Superagent abort", message: message(error), variant: "error" })
  }
}

/** Doc row in the tool browser; every other value is a tool name. */
const LIMITS_CHOICE = "__limits__"

/**
 * Browse the Router toolset. The list comes from `src/tools.ts`, so a newly
 * registered tool appears here without changing this command; each row opens
 * its parameter table, and the last row documents what the Router cannot do.
 */
async function tools(context: Plugin.Context) {
  try {
    // Stay in the browser until the user closes the list, so reading several
    // tools does not mean retyping the command.
    for (;;) {
      const selection = await context.ui.dialog.select({
        title: `Superagent 工具 · ${ROUTER_TOOL_SPECS.length}`,
        placeholder: "搜索工具：dispatch / abort / status …",
        options: [
          ...ROUTER_TOOL_SPECS.map((spec) => {
            const required = spec.params.flatMap((param) => (param.required ? [param.name] : []))
            return {
              title: spec.name,
              description: `${RISK_LABELS[spec.risk]} · ${spec.summary}`,
              footer: required.length === 0 ? (spec.params.length === 0 ? "无参数" : "无必填") : required.join(","),
              category: GROUP_LABELS[spec.group],
              value: spec.name,
            }
          }),
          {
            title: "能力边界",
            description: `Router 不能做什么（${ROUTER_LIMITS.length} 条）`,
            footer: "不含工具",
            category: "说明",
            value: LIMITS_CHOICE,
          },
        ],
      })
      if (selection === undefined) return
      if (selection === LIMITS_CHOICE) {
        await context.ui.dialog.alert({ title: "Superagent 能力边界", message: describeLimits() })
        continue
      }
      await context.ui.dialog.alert({ title: `Superagent ${selection}`, message: describeTool(specFor(selection)) })
    }
  } catch (error) {
    context.ui.toast.show({ title: "Superagent tools", message: message(error), variant: "error" })
  }
}

/** `/tickets`: one compact list grouped by state, safe on a narrow terminal. */
async function tickets(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const { text } = await rpc.tickets({}, options(context))
    await context.ui.dialog.alert({ title: "Superagent 工单", message: text })
  } catch (error) {
    context.ui.toast.show({ title: "Superagent tickets", message: message(error), variant: "error" })
  }
}

/**
 * `/ticket [id]`: full detail for one ticket. The argument accepts a full id or
 * the 4-character short id (or any id fragment); without one the command opens
 * a searchable ticket list. An ambiguous fragment lists every candidate.
 */
async function ticket(context: Plugin.Context, input?: string) {
  try {
    const rpc = context.client.rpc(Definition)
    const query = input?.trim() ?? ""
    let rows: Array<TicketRow> | undefined
    try {
      rows = await loadTickets(context)
    } catch {
      // Old service or a transient RPC failure: fall back to the plain prompt.
      rows = undefined
    }
    const ticketID = await chooseTicket(context, rows, query)
    if (ticketID === undefined || ticketID === "") return
    const { text } = await rpc.ticket({ ticketID }, options(context))
    await context.ui.dialog.alert({ title: `Superagent ${ticketID}`, message: text })
  } catch (error) {
    context.ui.toast.show({ title: "Superagent ticket", message: message(error), variant: "error" })
  }
}

/** Every ticket the `tickets` RPC can return (the server clamps `limit` at 100). */
async function loadTickets(context: Plugin.Context): Promise<Array<TicketRow>> {
  const rpc = context.client.rpc(Definition)
  const { text } = await rpc.tickets({ limit: TICKET_PICKER_LIMIT }, options(context))
  return parseTicketList(text)
}

/** Turn a query, or an empty one, into a ticket id; ambiguity opens the candidate list. */
async function chooseTicket(
  context: Plugin.Context,
  rows: Array<TicketRow> | undefined,
  query: string,
): Promise<string | undefined> {
  if (rows === undefined) {
    return query !== ""
      ? query
      : (await context.ui.dialog.prompt({ title: "/ticket", placeholder: "tk_… 或 4 位短 ID（如 dc8d）" }))?.trim()
  }
  if (query === "") return pickTicket(context, rows)
  const resolution = resolveTicketQuery(rows, query)
  if (resolution.kind === "one") return resolution.ticket.id
  if (resolution.kind === "many") {
    return pickTicket(context, [...resolution.tickets], `「${query}」匹配 ${resolution.tickets.length} 张工单`)
  }
  // No local match: a full id outside the 100-row window may still exist.
  if (query.toLowerCase().startsWith("tk_")) return query
  context.ui.toast.show({ title: "Superagent ticket", message: `没有匹配「${query}」的工单`, variant: "warning" })
  return undefined
}

/** Searchable ticket list: the short id leads each row so it can be read off the sidebar. */
async function pickTicket(
  context: Plugin.Context,
  rows: ReadonlyArray<TicketRow>,
  title = "Superagent 工单",
): Promise<string | undefined> {
  if (rows.length === 0) {
    context.ui.toast.show({ title: "Superagent ticket", message: "暂无工单", variant: "info" })
    return undefined
  }
  return pickList(context, {
    title: `${title} · ${rows.length}`,
    placeholder: TICKET_SEARCH_PLACEHOLDER,
    rows: rows.map((row) => ({
      title: `${shortTicketID(row.id)} · ${row.title === "" ? row.id : row.title}`,
      description: `${TICKET_STATE_SYMBOL[row.state]} ${row.state} · ${row.priority} · ${row.id}`,
      value: row.id,
      glyph: TICKET_STATE_SYMBOL[row.state],
      tone: row.state,
      code: shortTicketID(row.id),
      status: row.state,
      trailing: row.priority,
    })),
    search: (query, visible) => searchPickerOptions(query, visible, rows, ""),
  })
}

function gotoSession(context: Plugin.Context, sessionID: string) {
  context.ui.router.navigate({ type: "session", sessionID })
  if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID)
}

function options(context: Plugin.Context): RpcCallOptions {
  return context.location ? { location: { directory: context.location.directory } } : {}
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
