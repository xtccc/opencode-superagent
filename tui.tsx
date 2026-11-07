import type { RpcCallOptions, RpcClient } from "@opencode/client/promise"
import { Plugin } from "@opencode/plugin/tui"
import { Definition } from "./src/protocol"

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
          id: "superagent.demo",
          title: "Superagent demo triggers",
          palette: true,
          slash: { name: "superagent-demo" },
          run: () => demo(context),
        },
      ],
    }))
  },
})

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
