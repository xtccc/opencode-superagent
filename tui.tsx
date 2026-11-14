import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { RpcCallOptions } from "@opencode/client/promise"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { COMMANDS, type CommandRun } from "./src/commands"
import { Definition } from "./src/protocol"
import {
  missingSessionMessage,
  ticketHint,
  ticketStep,
  workerBySuffix,
  type TicketKey,
  type TicketNavRow,
  type TicketPane,
} from "./src/picker-nav"
import { detailRows, parseTicketDetail, type TicketDetail } from "./src/ticket-detail"
import { resolveTicketQuery, searchPickerOptions } from "./src/ticket-search"
import type { StatusPartitionView } from "./src/status"
import {
  computeDialogSize,
  layoutHelp,
  layoutHint,
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
  truncateCells,
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

/** Handler behind each `run` key of `COMMANDS` (`browse` is the `/tickets` two-pane browser). */
const RUNNERS: Record<CommandRun, (context: Plugin.Context, input?: string) => Promise<void> | void> = {
  open: (context) => open(context),
  browse: (context) => tickets(context),
  abort: (context) => abort(context),
  tools: (context) => tools(context),
  detail: (context, input) => ticket(context, input),
}

export default Plugin.define({
  id: "opencode.superagent",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      // The slash names live in `src/commands.ts`; this file only binds each
      // `run` key to its handler.
      commands: COMMANDS.map((command) => ({
        ...command,
        run: (input?: string) => RUNNERS[command.run](context, input),
      })),
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
  const [partitions, setPartitions] = createSignal<ReadonlyArray<StatusPartitionView>>([])
  const [currentDirKey, setCurrentDirKey] = createSignal<string | undefined>(undefined)
  const [failed, setFailed] = createSignal(false)
  let disposed = false
  let running = false

  const refresh = async () => {
    if (running) return
    running = true
    try {
      const rpc = props.context.client.rpc(Definition)
      const call = options(props.context)
      const directory = directoryOf(props.context)
      // Aggregate status drives the partition list; the scoped call tells us
      // which row is the session's own directory (so it can be highlighted).
      // Scoping the ticket list keeps another directory's work orders out of
      // this panel under `perDirectoryRouter`.
      const [status, scoped, tickets] = await Promise.all([
        rpc.status({}, call),
        directory === undefined ? Promise.resolve(undefined) : rpc.status({ directory }, call).catch(() => undefined),
        rpc.tickets(
          { limit: TICKET_PANEL_LIMIT, ...(directory === undefined ? {} : { directory }) },
          call,
        ),
      ])
      if (disposed) return
      setPartitions(status.partitions ?? [])
      setCurrentDirKey(scoped?.dirKey)
      setRows(parseTicketList(tickets.text))
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
  // One partition = the pre-2b view; hide the summary entirely so the sidebar
  // looks exactly as it did before this stage.
  const showPartitions = createMemo(() => partitions().length > 1)

  return (
    <Show when={panel().items.length > 0 || failed() || showPartitions()}>
      <box>
        <Show when={showPartitions()}>
          <box>
            <text fg={theme.text.base} wrapMode="none" truncate>
              <b>目录 {partitions().length}</b>
              <span style={{ fg: theme.text.muted }}> · 每区 router/pending/run</span>
            </text>
            <For each={partitions()}>
              {(partition) => (
                <text wrapMode="none" truncate>
                  <span
                    style={{
                      fg:
                        partition.router === undefined
                          ? theme.text.muted
                          : theme.text.feedback.success.base,
                    }}
                  >
                    {partition.router === undefined ? "○" : "●"}
                  </span>
                  <span
                    style={{
                      fg: partition.dirKey === currentDirKey() ? theme.text.base : theme.text.muted,
                    }}
                  >
                    {" "}
                    {partitionLabel(partition)}
                  </span>
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show
          when={panel().items.length > 0}
          fallback={
            <Show when={failed()}>
              <text fg={theme.text.feedback.warning.base}>工单 读取失败</text>
            </Show>
          }
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

/** Show the directory's basename; fall back to the partition key when unknown. */
function partitionLabel(partition: StatusPartitionView): string {
  const name = partition.directory === undefined ? partition.dirKey : basenameOf(partition.directory)
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name
  return `${label} p${partition.pending} ${partition.running}/${partition.workers}`
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "")
  const last = parts[parts.length - 1]
  return last === undefined || last === "" ? path : last
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
  /** `/tickets` rows only: what the detail pane shows and what `⏎` enters there. */
  readonly nav?: TicketNavRow
}

interface PickerConfig {
  readonly title: string
  readonly placeholder: string
  readonly rows: ReadonlyArray<PickerRow>
  readonly search?: (query: string, rows: ReadonlyArray<PickerRow>) => ReadonlyArray<PickerRow>
  readonly emptyText?: string
  /** Footer hint; the shared help line when absent. */
  readonly hint?: string
}

/** Only a host that predates `useTerminalDimensions` falls back to this. */
const DEFAULT_TERMINAL = { width: 100, height: 40 }
const terminalDimensions: (() => () => { width: number; height: number }) | undefined =
  typeof useTerminalDimensions === "function" ? useTerminalDimensions : undefined

/**
 * The rows of a picker, laid out by `layoutPickerRow` and windowed to the
 * dialog height. Shared by the plain picker (`/ticket`) and the `/tickets` list
 * pane, so both draw the same columns with the same width budget.
 */
function PickerRows(props: {
  context: Plugin.Context
  rows: ReadonlyArray<PickerRow>
  selected: number
  offset: number
  width: number
  listRows: number
  emptyText?: string
  onActivate: (row: PickerRow) => void
}) {
  const theme = props.context.theme
  const windowBegin = () => Math.min(props.offset, Math.max(0, props.rows.length - 1))
  const window = () => props.rows.slice(windowBegin(), windowBegin() + props.listRows)
  return (
    <box flexDirection="column" height={props.listRows}>
      <Show
        when={props.rows.length > 0}
        fallback={
          <text wrapMode="none" fg={theme.text.muted}>
            {props.emptyText ?? "无匹配项"}
          </text>
        }
      >
        <For each={window()}>
          {(row, index) => {
            const active = () => windowBegin() + index() === props.selected
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
                props.width,
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
                onMouseUp={() => props.onActivate(row)}
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
  )
}

/** Header row shared by both panes: the title on the left, the width-sized frame. */
function PickerHeader(props: { context: Plugin.Context; title: string; width: number; right: string }) {
  const theme = props.context.theme
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text wrapMode="none" fg={theme.text.base}>
        <b>{layoutTitle(props.title, props.width)}</b>
      </text>
      <text wrapMode="none" fg={theme.text.muted}>
        {props.right}
      </text>
    </box>
  )
}

/**
 * The picker dialog. The host's `dialog.select` cannot be resized (its list
 * stops at `floor(rows / 2) - 6` entries inside a 60-column frame), so the
 * picker draws its own body and `computeDialogSize` sizes it for the terminal.
 * Keys match the built-in select: type to search, ↑↓ / PgUp PgDn / Home End to
 * move, ⏎ to pick, esc to cancel. `/tickets` uses `TicketBrowser`, which shares the
 * same frame, size maths and row layout.
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
  /** Row under the cursor, clamped: `selected` can briefly outrun a shrinking list. */
  const activeRow = createMemo(() => rows()[Math.min(selected(), Math.max(0, rows().length - 1))])
  const help = createMemo(() =>
    layoutHelp(size().width, rows().length, props.config.rows.length, props.config.hint),
  )

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
        pick(activeRow())
        return
    }
  })

  return (
    <box flexDirection="column" width={size().width} gap={1}>
      <PickerHeader context={props.context} title={props.config.title} width={size().width} right="esc" />
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
        onSubmit={() => pick(activeRow())}
      />
      <PickerRows
        context={props.context}
        rows={rows()}
        selected={selected()}
        offset={offset()}
        width={size().width}
        listRows={size().listRows}
        emptyText={props.config.emptyText}
        onActivate={pick}
      />
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

/** What the `/tickets` browser resolves to: a session to enter, or nothing (closed). */
export type TicketResult = { readonly action: "jump"; readonly sessionID: string } | undefined

/** The detail pane content: already wrapped rows, plus the session `⏎` enters. */
export interface TicketDetailContent {
  readonly lines: ReadonlyArray<string>
  /** Session the detail pane's `⏎` enters; absent when the row has none. */
  readonly sessionID?: string
}

/** Props of the two-pane browser; `browseTickets` fills in the context and the resolver. */
export interface TicketBrowserProps {
  readonly context: Plugin.Context
  readonly title: string
  readonly placeholder: string
  readonly rows: ReadonlyArray<PickerRow>
  readonly total: number
  readonly search: (query: string, rows: ReadonlyArray<PickerRow>) => ReadonlyArray<PickerRow>
  readonly loadDetail: (row: PickerRow, width: number) => Promise<TicketDetailContent | undefined>
  readonly onDone: (result: TicketResult) => void
}

/**
 * `/tickets` in two panes, sharing `PickerDialog`'s frame, size maths and row
 * layout:
 *
 * - **list**: `/tickets` rows (tickets, then workers). `⏎` opens the row's detail,
 *   `/` focuses the search field (the query survives a round trip), `q` closes.
 * - **detail**: the ticket fields (`src/ticket-detail.ts`) or a worker summary,
 *   scrollable with ↑↓ / PgUp / PgDn. `⏎` enters the worker session of the row,
 *   `q` / `esc` go back to the list with its query and cursor intact.
 *
 * `ticketStep` (pure) decides every transition; this component only applies it and
 * awaits the RPCs.
 */
export function TicketBrowser(props: TicketBrowserProps) {
  const theme = props.context.theme
  const dimensions = terminalDimensions ? terminalDimensions() : () => DEFAULT_TERMINAL
  const size = createMemo(() => computeDialogSize(dimensions().width, dimensions().height))
  const [pane, setPane] = createSignal<TicketPane>("list")
  const [searching, setSearching] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal(0)
  const [offset, setOffset] = createSignal(0)
  const [lines, setLines] = createSignal<ReadonlyArray<string>>([])
  const [detailSession, setDetailSession] = createSignal<string | undefined>(undefined)
  const [detailOffset, setDetailOffset] = createSignal(0)
  const [notice, setNotice] = createSignal("")
  const [loading, setLoading] = createSignal(false)

  const rows = createMemo(() => props.search(query(), props.rows))
  const activeRow = createMemo(() => rows()[Math.min(selected(), Math.max(0, rows().length - 1))])
  const help = createMemo(() => ticketHint(pane(), searching()))

  let field: InputRenderable | undefined
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  onMount(() => {
    // The list opens in navigate mode so `q` / `⏎` work without a click; `/`
    // moves the keyboard into the search field.
    focusTimer = setTimeout(() => field?.blur(), 1)
  })
  onCleanup(() => {
    if (focusTimer !== undefined) clearTimeout(focusTimer)
  })

  // The cursor and the window stay inside the current result set.
  createEffect(() => {
    const count = rows().length
    const next = moveSelection(selected(), 0, count)
    if (next !== selected()) setSelected(next)
  })
  createEffect(() => {
    if (pane() !== "list") return
    const start = windowStart(selected(), offset(), size().listRows)
    if (start !== offset()) setOffset(start)
  })
  createEffect(() => {
    const max = Math.max(0, lines().length - size().listRows)
    if (detailOffset() > max) setDetailOffset(max)
  })

  // The search field only exists inside the list pane, so returning from a
  // detail remounts it empty. The query lives in a signal; put it back into the
  // field so the visible filter always matches the list.
  createEffect(() => {
    if (pane() !== "list") return
    const text = query()
    setTimeout(() => {
      if (field !== undefined && field.value !== text) field.value = text
    }, 0)
  })

  const detailWindow = createMemo(() =>
    lines().slice(detailOffset(), detailOffset() + size().listRows),
  )

  const close = () => props.onDone(undefined)

  const openDetail = async () => {
    // `⏎` can arrive twice (keyboard hook + input submit); the second is a no-op.
    if (loading()) return
    const row = activeRow()
    if (row === undefined) return
    setNotice("")
    setPane("detail")
    setDetailOffset(0)
    setLoading(true)
    setLines([])
    setDetailSession(undefined)
    try {
      const loaded = await props.loadDetail(row, size().width)
      setLines(loaded?.lines ?? ["（该行没有可显示的详情）"])
      setDetailSession(loaded?.sessionID)
    } catch (error) {
      setLines([`读取详情失败：${message(error)}`])
    } finally {
      setLoading(false)
    }
  }

  /**
   * Enter the session of the row on screen. The session is verified first: a
   * ticket whose worker was deleted must say so instead of navigating nowhere.
   */
  const enterSession = async (sessionID: string) => {
    try {
      await props.context.client.session.get({ sessionID })
    } catch {
      setNotice(missingSessionMessage(sessionID))
      return
    }
    props.onDone({ action: "jump", sessionID })
  }

  const apply = (key: TicketKey) => {
    const base = activeRow()?.nav
    // The detail pane knows the session the list row could not: a ticket's
    // full worker id only appears in its detail text.
    const row =
      base === undefined ? undefined : { kind: base.kind, sessionID: detailSession() ?? base.sessionID }
    const step = ticketStep(pane(), key, row)
    switch (step.kind) {
      case "close":
        close()
        return
      case "back-to-list":
        setPane("list")
        setNotice("")
        // No blur here: the search field is unmounted while the detail pane is
        // up, and the one that comes back mounts unfocused.
        return
      case "open-detail":
        void openDetail()
        return
      case "jump":
        void enterSession(step.sessionID)
        return
      case "notice":
        setNotice(step.message)
        return
    }
  }

  useKeyboard((event) => {
    const key = event.name
    if (pane() === "detail") {
      const step = size().listRows
      const scroll = (delta: number) => {
        event.preventDefault()
        event.stopPropagation()
        setDetailOffset((current) =>
          Math.min(Math.max(0, current + delta), Math.max(0, lines().length - step)),
        )
      }
      switch (key) {
        case "up":
          return scroll(-1)
        case "down":
          return scroll(1)
        case "pageup":
          return scroll(-step)
        case "pagedown":
          return scroll(step)
        case "return":
        case "kpenter":
        case "linefeed":
        case "q":
        case "escape":
          event.preventDefault()
          event.stopPropagation()
          apply(key === "return" || key === "kpenter" || key === "linefeed" ? "enter" : "quit")
          return
      }
      return
    }

    // List pane: the search field owns printable keys while it is focused.
    if (searching()) {
      switch (key) {
        case "up":
          event.preventDefault()
          setSelected((current) => moveSelection(current, -1, rows().length))
          return
        case "down":
          event.preventDefault()
          setSelected((current) => moveSelection(current, 1, rows().length))
          return
        case "return":
        case "kpenter":
        case "linefeed":
          event.preventDefault()
          event.stopPropagation()
          setSearching(false)
          field?.blur()
          void openDetail()
          return
        case "escape":
          event.preventDefault()
          event.stopPropagation()
          setSearching(false)
          field?.blur()
          return
      }
      return
    }

    const count = rows().length
    switch (key) {
      case "up":
        event.preventDefault()
        setSelected((current) => moveSelection(current, -1, count))
        return
      case "down":
        event.preventDefault()
        setSelected((current) => moveSelection(current, 1, count))
        return
      case "pageup":
        event.preventDefault()
        setSelected((current) => moveSelection(current, -size().listRows, count))
        return
      case "pagedown":
        event.preventDefault()
        setSelected((current) => moveSelection(current, size().listRows, count))
        return
      case "home":
        event.preventDefault()
        setSelected(0)
        return
      case "end":
        event.preventDefault()
        setSelected(Math.max(0, count - 1))
        return
      case "return":
      case "kpenter":
      case "linefeed":
        event.preventDefault()
        event.stopPropagation()
        apply("enter")
        return
      case "q":
      case "escape":
        event.preventDefault()
        event.stopPropagation()
        apply("quit")
        return
      case "/":
        event.preventDefault()
        event.stopPropagation()
        setSearching(true)
        field?.focus()
        return
    }
  })

  return (
    <box flexDirection="column" width={size().width} gap={1}>
      <PickerHeader
        context={props.context}
        title={props.title}
        width={size().width}
        right={pane() === "detail" ? "q 返回 · esc" : "esc"}
      />
      <Show
        when={pane() === "list"}
        fallback={
          <box flexDirection="column" height={size().listRows}>
            <Show
              when={!loading()}
              fallback={
                <text wrapMode="none" fg={theme.text.muted}>
                  读取中…
                </text>
              }
            >
              <For each={detailWindow()}>
                {(line) => (
                  <text wrapMode="none" fg={line.startsWith("·") ? theme.text.muted : theme.text.base}>
                    {line === "" ? " " : line}
                  </text>
                )}
              </For>
            </Show>
          </box>
        }
      >
        <input
          ref={(element) => (field = element)}
          placeholder={props.placeholder}
          placeholderColor={theme.text.muted}
          focusedTextColor={theme.text.base}
          cursorColor={theme.text.formfield.focused}
          onInput={(value) => {
            setQuery(value)
            setSelected(0)
            setOffset(0)
          }}
          onSubmit={() => {
            setSearching(false)
            field?.blur()
            void openDetail()
          }}
        />
        <PickerRows
          context={props.context}
          rows={rows()}
          selected={selected()}
          offset={offset()}
          width={size().width}
          listRows={size().listRows}
          onActivate={(row) => {
            const index = rows().indexOf(row)
            if (index >= 0) setSelected(index)
            void openDetail()
          }}
        />
      </Show>
      <box flexDirection="row" justifyContent="space-between">
        <text
          wrapMode="none"
          fg={notice() !== "" ? theme.text.feedback.warning.base : theme.text.muted}
        >
          {pane() === "detail"
            ? layoutHint(size().width, notice() !== "" ? notice() : help())
            : layoutHelp(size().width, rows().length, props.total, help()).hint}
        </text>
        <Show when={pane() === "list"}>
          <text wrapMode="none" fg={theme.text.muted}>
            {layoutHelp(size().width, rows().length, props.total, help()).counter}
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

/**
 * Show the two-pane `/tickets` browser and resolve what the user chose. Same frame
 * contract as `pickList`: the host resets dialogs to `medium`, so the size is
 * raised right after `show`.
 */
function browseTickets(
  context: Plugin.Context,
  props: Omit<TicketBrowserProps, "context" | "onDone">,
): Promise<TicketResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: TicketResult) => {
      if (settled) return
      settled = true
      context.ui.dialog.clear()
      resolve(result)
    }
    context.ui.dialog.show(
      () => <TicketBrowser context={context} {...props} onDone={finish} />,
      () => finish(undefined),
    )
    try {
      context.ui.dialog.set({ size: "xlarge", centered: true })
    } catch {
      // Older hosts have no presentation options; the pane still renders.
    }
  })
}

async function open(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const { sessionID } = await rpc.router(directoryInput(context), options(context))
    gotoSession(context, sessionID)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent", message: message(error), variant: "error" })
  }
}

/** Ticket rows in a picker carry a prefix so their value can never collide with a worker session id. */
const TICKET_CHOICE_PREFIX = "ticket:"
/** The `tickets` RPC clamps `limit` at 100, so this is every ticket a picker can see. */
const TICKET_PICKER_LIMIT = 100
/** Shared by `/tickets` and the `/ticket` candidate list. */
const TICKET_SEARCH_PLACEHOLDER = "搜索：标题 / 全 ID / 4 位短 ID（如 dc8d）"

/**
 * `/tickets`: a two-pane browser. The list mixes tickets and worker sessions;
 * `⏎` always opens the row's detail first (a mis-jump is expensive to undo),
 * and the detail pane is where `⏎` enters the worker session of that row.
 *
 * A ticket's session is its **most recent** worker: every dispatch overwrites
 * `ticket.workerSessionID`, the list trailer prints that session's last six
 * characters (`w=abc123`), and the detail text prints the full id. The load
 * below prefers the exact id from the detail and only falls back to a unique
 * suffix match.
 */
async function tickets(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const call = options(context)
    const status = await rpc.status(directoryInput(context), call)
    // A broken ticket list must not hide the worker list (and vice versa).
    const rows = await loadTickets(context).catch(() => [])
    if (status.workers.length === 0 && rows.length === 0) {
      context.ui.toast.show({ title: "Superagent tickets", message: "暂无 worker 与工单", variant: "info" })
      return
    }
    const ticketByID = new Map(rows.map((row) => [row.id, row]))
    const workerIDs = status.workers.map((worker) => worker.sessionID)
    const result = await browseTickets(context, {
      title: `Superagent tickets · 工单 ${rows.length} · worker ${status.workers.length}`,
      placeholder: TICKET_SEARCH_PLACEHOLDER,
      rows: [
        ...rows.map((row) => ({
          // The short id is already the `code` column, so the title carries none.
          title: row.title === "" ? row.id : row.title,
          description: `${TICKET_STATE_SYMBOL[row.state]} ${row.state} · ${row.priority} · ${row.id}`,
          value: `${TICKET_CHOICE_PREFIX}${row.id}`,
          glyph: TICKET_STATE_SYMBOL[row.state],
          tone: row.state,
          code: shortTicketID(row.id),
          status: row.state,
          // The trailer's six-character tail names the latest worker, so a row
          // that would jump says so without opening anything.
          trailing: row.workerSuffix === undefined ? row.priority : `${row.priority} w=${row.workerSuffix}`,
          nav: { kind: "ticket" as const },
        })),
        ...status.workers.map((worker) => ({
          title: worker.title ?? worker.sessionID.slice(0, 8),
          description: `${worker.state} · ${worker.threads.join(",") || "-"} · ${worker.sessionID.slice(0, 8)}`,
          value: worker.sessionID,
          status: worker.state,
          trailing: "worker",
          nav: { kind: "worker" as const, sessionID: worker.sessionID },
        })),
      ],
      total: rows.length + status.workers.length,
      search: (query, visible) => searchPickerOptions(query, visible, rows, TICKET_CHOICE_PREFIX),
      loadDetail: async (row, width) => {
        const ticketID = row.value.startsWith(TICKET_CHOICE_PREFIX)
          ? row.value.slice(TICKET_CHOICE_PREFIX.length)
          : undefined
        if (ticketID === undefined) {
          const worker = status.workers.find((item) => item.sessionID === row.value)
          return worker === undefined ? undefined : { lines: workerDetailRows(worker, width) }
        }
        const listRow = ticketByID.get(ticketID)
        const detail = await loadTicketDetail(context, ticketID)
        // The full id from the detail is authoritative; the six-character tail
        // is only a hint, so it is the fallback when the detail is unavailable.
        const sessionID = detail?.workerSessionID ?? workerBySuffix(workerIDs, listRow?.workerSuffix)
        if (detail === undefined) {
          return {
            lines: [
              `工单 ${ticketID}`,
              "",
              listRow === undefined ? "读取详情失败。" : `${listRow.state} · ${listRow.priority}`,
              "（详情读取失败，仍可尝试 ⏎ 进入会话）",
            ],
            ...(sessionID === undefined ? {} : { sessionID }),
          }
        }
        return { lines: detailRows(detail, width), ...(sessionID === undefined ? {} : { sessionID }) }
      },
    })
    if (result === undefined) return
    gotoSession(context, result.sessionID)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent tickets", message: message(error), variant: "error" })
  }
}

/** One worker session as the detail pane shows it. */
function workerDetailRows(
  worker: {
    readonly sessionID: string
    readonly title?: string
    readonly threads: ReadonlyArray<string>
    readonly state: string
  },
  width: number,
): ReadonlyArray<string> {
  return [
    `worker · ${worker.state}`,
    worker.title ?? worker.sessionID,
    "",
    `会话：${worker.sessionID}`,
    `thread：${worker.threads.join(",") || "-"}`,
    "",
    "⏎ 进入该会话",
  ].map((line) => truncateCells(line, width))
}

/**
 * Fetch and parse one ticket's detail. `undefined` means the RPC failed or the
 * gateway no longer knows the ticket; the pane then shows a short explanation
 * instead of an empty frame.
 */
async function loadTicketDetail(context: Plugin.Context, ticketID: string): Promise<TicketDetail | undefined> {
  try {
    const rpc = context.client.rpc(Definition)
    const { text } = await rpc.ticket({ ticketID }, options(context))
    return parseTicketDetail(text)
  } catch {
    return undefined
  }
}

/** Stale cleanup entry in the abort picker; any other value is a worker session id. */
const STALE_CHOICE = "__stale__"

async function abort(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const call = options(context)
    const status = await rpc.status(directoryInput(context), call)
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

/**
 * `/ticket [id]`: full detail for one ticket. The argument accepts a full id or
 * the 4-character short id (or any id fragment); without one the command opens
 * a searchable ticket list. An ambiguous fragment lists every candidate.
 */
async function ticket(context: Plugin.Context, input?: string) {
  try {
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
    await showTicketDetail(context, ticketID)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent ticket", message: message(error), variant: "error" })
  }
}

/** The full detail of one ticket in a dialog, used by `/ticket` and the sidebar rows. */
async function showTicketDetail(context: Plugin.Context, ticketID: string) {
  const rpc = context.client.rpc(Definition)
  const { text } = await rpc.ticket({ ticketID }, options(context))
  await context.ui.dialog.alert({ title: `Superagent ${ticketID}`, message: text })
}

/** Every ticket the `tickets` RPC can return (the server clamps `limit` at 100). */
async function loadTickets(context: Plugin.Context): Promise<Array<TicketRow>> {
  const rpc = context.client.rpc(Definition)
  const { text } = await rpc.tickets({ limit: TICKET_PICKER_LIMIT, ...directoryInput(context) }, options(context))
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
    // Every row is a ticket and this picker has one level: the search field is
    // focused from the start, and `⏎` opens the detail right away.
    hint: "输入即搜 · ↑↓ 移动 · ⏎ 详情 · esc 取消",
    rows: rows.map((row) => ({
      title: row.title === "" ? row.id : row.title,
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

/** The session location's directory, when the host knows it. */
function directoryOf(context: Plugin.Context): string | undefined {
  return context.location?.directory
}

/**
 * Stage 3: the `status` / `tickets` / `router` inputs carry the session's
 * directory, so a `perDirectoryRouter` gateway shows and opens that partition.
 * With the flag off the server collapses it onto the default partition, so the
 * request is byte-identical to the pre-3 one.
 */
function directoryInput(context: Plugin.Context): { readonly directory?: string } {
  const directory = directoryOf(context)
  return directory === undefined ? {} : { directory }
}

function message(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
