import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber } from "effect"
import { filterSessionTools, registerContext } from "../src/context.js"
import { registerSleep, runSleep, SLEEP_DEFAULT_SECONDS } from "../src/sleep.js"
import { store } from "../src/state.js"
import { ROUTER_PERMISSIONS, ROUTER_TOOLS, specFor, toolPermission } from "../src/tools.js"

const ROUTER = "ses_router"
const WORKER = "ses_worker"

/** Records the seconds each call would have slept; no timer ever runs. */
function recorder() {
  const calls: Array<number> = []
  const sleeper = (seconds: number) => Effect.sync(() => void calls.push(seconds))
  return { calls, sleeper }
}

async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isFailure(exit)) throw new Error(`expected success, got ${JSON.stringify(exit)}`)
  return exit.value
}

async function failure<A, E>(effect: Effect.Effect<A, E>): Promise<string> {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error(`expected failure, got ${JSON.stringify(exit.value)}`)
  return String(exit.cause)
}

beforeEach(() => {
  store.routerID = ROUTER
  store.workers.clear()
  store.threads.clear()
})

describe("sleep tool validation", () => {
  test("defaults to 30 seconds without really sleeping", async () => {
    const { calls, sleeper } = recorder()
    const started = performance.now()
    const result = await succeed(runSleep({}, ROUTER, sleeper))
    expect(result.content).toBe("slept 30s")
    expect(result.output).toEqual({ slept: 30, text: "slept 30s" })
    expect(SLEEP_DEFAULT_SECONDS).toBe(30)
    expect(calls).toEqual([30])
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("custom seconds are passed through unchanged", async () => {
    const { calls, sleeper } = recorder()
    const result = await succeed(runSleep({ seconds: 45 }, ROUTER, sleeper))
    expect(result.content).toBe("slept 45s")
    expect(result.output).toEqual({ slept: 45, text: "slept 45s" })
    expect(calls).toEqual([45])
  })

  test("the 1 and 600 boundaries are accepted", async () => {
    const { calls, sleeper } = recorder()
    expect((await succeed(runSleep({ seconds: 1 }, ROUTER, sleeper))).content).toBe("slept 1s")
    expect((await succeed(runSleep({ seconds: 600 }, ROUTER, sleeper))).content).toBe("slept 600s")
    expect(calls).toEqual([1, 600])
  })

  test("zero, negative, above 600 and non-numbers are rejected", async () => {
    const { calls, sleeper } = recorder()
    const outOfRange = [0, -1, 601, Number.NaN, Number.POSITIVE_INFINITY]
    for (const seconds of outOfRange) {
      const message = await failure(runSleep({ seconds } as never, ROUTER, sleeper))
      expect(message).toContain("between 1 and 600")
    }
    const notNumber = await failure(runSleep({ seconds: "abc" } as never, ROUTER, sleeper))
    expect(notNumber).toContain("must be a number")
    const fractional = await failure(runSleep({ seconds: 1.5 } as never, ROUTER, sleeper))
    expect(fractional).toContain("must be an integer")
    // No invalid input ever reaches the sleeper.
    expect(calls).toEqual([])
  })
})

describe("sleep is router-only", () => {
  test("the router's toolset keeps sleep while a tracked worker's drops it", () => {
    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: "thread:1",
      threads: ["thread:1"],
      state: "running",
      createdAt: 1,
    })

    const routerTools: Record<string, unknown> = { sleep: {}, dispatch: {}, read: {}, edit: {} }
    filterSessionTools(ROUTER, routerTools)
    expect(Object.keys(routerTools)).toEqual(["sleep", "dispatch"])

    const workerTools: Record<string, unknown> = { sleep: {}, dispatch: {}, read: {}, edit: {} }
    filterSessionTools(WORKER, workerTools)
    expect(Object.keys(workerTools)).toEqual(["read", "edit"])

    // A user session is not part of the plugin and keeps its own toolset.
    const userTools: Record<string, unknown> = { sleep: {}, read: {} }
    filterSessionTools("ses_user", userTools)
    expect(Object.keys(userTools)).toEqual(["sleep", "read"])
  })

  test("the real context hook keeps sleep for the router and strips it from a worker", async () => {
    type ContextHandler = (event: {
      sessionID: string
      tools: Record<string, unknown>
      system: Array<{ type: string; text: string }>
    }) => Effect.Effect<void>
    const handlers = new Map<string, ContextHandler>()
    const editor = { add: () => {} }
    const ctx = {
      session: {
        hook: (name: string, callback: ContextHandler) =>
          Effect.sync(() => {
            handlers.set(name, callback)
            return { dispose: Effect.void }
          }),
      },
      tool: {
        transform: (fn: (target: typeof editor) => void) =>
          Effect.sync(() => {
            fn(editor)
            return { dispose: Effect.void }
          }),
      },
    } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerContext(ctx)))
    const handler = handlers.get("context")
    expect(handler).toBeDefined()

    store.workers.set(WORKER, {
      sessionID: WORKER,
      threadID: "thread:1",
      threads: ["thread:1"],
      state: "running",
      createdAt: 1,
    })
    const workerEvent = { sessionID: WORKER, tools: { sleep: {}, dispatch: {}, read: {} }, system: [] }
    await Effect.runPromise(handler!(workerEvent))
    expect(Object.keys(workerEvent.tools)).toEqual(["read"])
    expect(workerEvent.system).toEqual([])

    const routerEvent = { sessionID: ROUTER, tools: { sleep: {}, dispatch: {}, read: {} }, system: [] }
    await Effect.runPromise(handler!(routerEvent))
    expect(Object.keys(routerEvent.tools)).toEqual(["sleep", "dispatch"])
    expect(routerEvent.system).toHaveLength(1)
  })

  test("sleep is catalog-visible and its permission action is allowed for the router", () => {
    expect(ROUTER_TOOLS.has("sleep")).toBe(true)
    const action = toolPermission(specFor("sleep"))
    expect(action).toBe("status")
    const deciding = ROUTER_PERMISSIONS.filter((rule) => rule.action === "*" || rule.action === action).at(-1)
    expect(deciding?.effect).toBe("allow")
  })

  test("a worker calling sleep directly is refused", async () => {
    const { calls, sleeper } = recorder()
    const message = await failure(runSleep({ seconds: 1 }, WORKER, sleeper))
    expect(message).toContain("sleep is only available to the router session")
    expect(calls).toEqual([])
  })

  test("registration uses the catalog permission action", async () => {
    const registered: Array<{ name: string; description: string; options?: { permission?: string } }> = []
    const editor = { add: (tool: (typeof registered)[number]) => registered.push(tool) }
    const ctx = {
      tool: { transform: (fn: (target: typeof editor) => void) => Effect.sync(() => fn(editor)) },
    } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerSleep(ctx)))
    expect(registered.map((tool) => tool.name)).toEqual(["sleep"])
    expect(registered[0]?.options?.permission).toBe("status")
    expect(registered[0]?.description).toBe(specFor("sleep").description)
  })
})

describe("sleep does not block other work", () => {
  test("a concurrent task completes while a real sleep is still pending", async () => {
    const order: Array<string> = []
    const started = performance.now()
    const fiber = await Effect.runPromise(Effect.forkDetach(runSleep({ seconds: 1 }, ROUTER)))
    // The quick task must finish long before the 1s sleep does; a busy wait
    // would hold the runtime and push this past the deadline.
    await Effect.runPromise(
      Effect.sleep(Duration.millis(50)).pipe(Effect.andThen(Effect.sync(() => void order.push("quick task")))),
    )
    const quickDoneAt = performance.now()
    expect(order).toEqual(["quick task"])
    expect(quickDoneAt - started).toBeLessThan(900)

    const result = await Effect.runPromise(Fiber.join(fiber))
    order.push(result.content)
    expect(order).toEqual(["quick task", "slept 1s"])
    expect(performance.now() - started).toBeGreaterThanOrEqual(900)
  })
})
