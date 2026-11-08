import type { RpcCallOptions, RpcClient } from "@opencode/client/promise"
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Definition } from "./src/protocol"
import {
  parseTicketList,
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

type SuperagentRpc = RpcClient<typeof Definition>

type DemoEvent = {
  readonly thread: string
  readonly text: string
}

// T-1 exercises Router dispatch followed by direct-to-Worker delivery, T-2 exercises a second worker
// thread, and T-3 is a single first touch.
const events: readonly DemoEvent[] = [
  { thread: "T-1", text: "Review src/index.ts and report one improvement" },
  { thread: "T-1", text: "Check the README for one missing setup step" },
  { thread: "T-1", text: "Summarize the test failures in src/index.ts" },
  { thread: "T-2", text: "Find one unused export in src/index.ts" },
  { thread: "T-2", text: "Summarize the latest commit in one sentence" },
  { thread: "T-3", text: "List the files changed in the last 24 hours" },
]

const pollInterval = 500
// Router has to finish a model call and dispatch before T-1 can reach a Worker.
const pollAttempts = 40

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
          palette: true,
          slash: { name: "ticket", arguments: true },
          run: (input) => ticket(context, input),
        },
        {
          id: "superagent.demo",
          title: "Superagent demo triggers",
          palette: true,
          slash: { name: "superagent-demo" },
          run: () => demo(context),
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

async function open(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const { sessionID } = await rpc.router({}, options(context))
    gotoSession(context, sessionID)
  } catch (error) {
    context.ui.toast.show({ title: "Superagent", message: message(error), variant: "error" })
  }
}

async function tasks(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const status = await rpc.status({}, options(context))
    if (status.workers.length === 0) {
      context.ui.toast.show({ title: "Superagent tasks", message: "暂无 worker", variant: "info" })
      return
    }
    const sessionID = await context.ui.dialog.select({
      title: "Superagent workers",
      options: status.workers.map((worker) => ({
        title: worker.title ?? worker.sessionID.slice(0, 8),
        description: `${worker.state} · ${worker.threads.join(",")} · ${worker.sessionID.slice(0, 8)}`,
        value: worker.sessionID,
      })),
    })
    if (sessionID === undefined) return
    gotoSession(context, sessionID)
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

/** `/ticket <id>`: full detail for one ticket; prompts for the id when omitted. */
async function ticket(context: Plugin.Context, input?: string) {
  try {
    const ticketID =
      input?.trim() || (await context.ui.dialog.prompt({ title: "/ticket", placeholder: "tk_…" }))?.trim()
    if (ticketID === undefined || ticketID === "") return
    const rpc = context.client.rpc(Definition)
    const { text } = await rpc.ticket({ ticketID }, options(context))
    await context.ui.dialog.alert({ title: `Superagent ${ticketID}`, message: text })
  } catch (error) {
    context.ui.toast.show({ title: "Superagent ticket", message: message(error), variant: "error" })
  }
}

function gotoSession(context: Plugin.Context, sessionID: string) {
  context.ui.router.navigate({ type: "session", sessionID })
  if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID)
}

async function demo(context: Plugin.Context) {
  try {
    const rpc = context.client.rpc(Definition)
    const call = options(context)
    await rpc.router({}, call)

    // The first T-1 event enters the Router; the Router dispatches a Worker and subscribes the thread.
    const routes = [await trigger(rpc, events[0], call)]
    const ready = await waitForWorker(rpc, "T-1", call)

    // Only after the Worker owns T-1 can the remaining T-1 events skip the Router.
    for (const event of events.slice(1)) {
      routes.push(await trigger(rpc, event, call))
      await sleep(150)
    }

    const summary = events.map((event, index) => `${event.thread}=${routes[index]?.route ?? "unknown"}`).join(" ")
    context.ui.toast.show({
      title: "Superagent demo",
      message: ready ? summary : `${summary} (T-1 wait timed out)`,
      variant: ready ? "info" : "warning",
    })
  } catch (error) {
    context.ui.toast.show({ title: "Superagent demo", message: message(error), variant: "error" })
  }
}

async function trigger(rpc: SuperagentRpc, event: DemoEvent, options: RpcCallOptions) {
  return rpc.trigger({ source: "demo", threadID: event.thread, author: "demo-user", text: event.text }, options)
}

async function waitForWorker(rpc: SuperagentRpc, thread: string, options: RpcCallOptions) {
  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    await sleep(pollInterval)
    const status = await rpc.status({}, options)
    if (status.workers.some((worker) => worker.threads.includes(thread))) return true
  }
  return false
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
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
