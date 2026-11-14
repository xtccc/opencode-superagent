/**
 * P0-1 / P0-2 real-host verification.
 *
 * Both fixes only show up **across a gateway restart** (the claim path runs
 * during `hydrate`, and the `routerDirectory` warning is printed at startup),
 * so the live gateway — which has been running since before the fix — cannot
 * prove them. This script boots a *real* headless OpenCode host on a private
 * port with an isolated config/data/state tree, exactly like
 * `e2e/per-directory.e2e.ts` does, and asserts:
 *
 * 1. **P0-2** — an invalid `routerDirectory` (a directory that does not exist)
 *    produces a startup warning that names the reason and the fix
 *    (`the directory does not exist` + `mkdir -p "<path>"`), and the process
 *    still comes up on the default partition.
 * 2. **P0-1** — when the pinned partition already has its own Router, the
 *    legacy `router` pointer is **kept** (not deleted) and the old session is
 *    marked `superseded`; the marker is visible in KV, the old session's
 *    router-only tools name its successor, and `status` lists it.
 *
 * The real `~/.config/opencode` and the real database are fingerprinted
 * before and after and must be untouched.
 *
 * Run with:
 *
 *   bun run e2e/p0-1-p0-2.e2e.ts
 */
import { mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Effect, Exit, type Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PLUGIN_ID = "opencode.superagent"
const STARTUP_TIMEOUT_MS = 90_000
const AUTH_USERNAME = "opencode"

class AssertionError extends Error {
  override name = "AssertionError"
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message)
}

function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new AssertionError(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertContains(haystack: string, needle: string, what: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(`${what}: ${JSON.stringify(needle)} not found in ${JSON.stringify(haystack)}`)
  }
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
    const port = server.port
    await server.stop(true)
    if (port !== undefined && port > 1024) return port
  }
  throw new AssertionError("could not reserve a free TCP port")
}

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(250)
  }
  throw new AssertionError(`${what}: timed out after ${timeoutMs}ms${lastError === undefined ? "" : ` (${String(lastError)})`}`)
}

async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      sink.text += decoder.decode(value, { stream: true })
    }
    sink.text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function isolatedEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "HOME" || key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  env.HOME = join(root, "home")
  env.OPENCODE_CONFIG_DIR = join(root, "config")
  env.XDG_CONFIG_HOME = join(root, "home", ".config")
  env.XDG_DATA_HOME = join(root, "data")
  env.XDG_STATE_HOME = join(root, "state")
  env.XDG_CACHE_HOME = join(root, "home", ".cache")
  env.OPENCODE_SERVER_PASSWORD = `e2e-${crypto.randomUUID()}`
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.NO_COLOR = "1"
  env.DO_NOT_TRACK = "1"
  return env
}

interface Watchpoint {
  readonly path: string
  readonly exists: boolean
  readonly content?: string
  readonly identity?: string
}

async function watchPath(path: string, mode: "content" | "identity"): Promise<Watchpoint> {
  try {
    const info = await stat(path)
    return {
      path,
      exists: true,
      ...(mode === "content" ? { content: `${info.size}:${info.mtimeMs}` } : { identity: `${info.dev}:${info.ino}` }),
    }
  } catch {
    return { path, exists: false }
  }
}

async function realWatch(): Promise<ReadonlyArray<Watchpoint>> {
  const home = homedir()
  const files = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".config", "opencode", "package.json"),
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".local", "state", "opencode", "plugin-meta.json"),
  ]
  const out: Array<Watchpoint> = []
  for (const path of files) out.push(await watchPath(path, "content"))
  out.push(await watchPath(join(home, ".local", "share", "opencode", "opencode.db"), "identity"))
  return out
}

// ── the deterministic plugin-internals harness (P0-1) ──────────────────────

interface HarnessResult {
  readonly legacyPointerKept: boolean
  readonly legacyPointerValue: string | undefined
  readonly scopedPointer: string | undefined
  readonly marker: { sessionID?: string; supersededBy?: string; dirKey?: string } | undefined
  readonly notice: string | undefined
  readonly statusText: string | undefined
  readonly requireRouterError: string | undefined
  readonly reclaimedAfterSuccessorGone: string | undefined
}

async function runHarness(root: string, pinnedDirectory: string): Promise<HarnessResult> {
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  process.env.HOME = join(root, "home")

  const stateModule = (await import(join(REPO_ROOT, "dist/src/state.js"))) as typeof import("../src/state.js")
  const routerModule = (await import(join(REPO_ROOT, "dist/src/router.js"))) as typeof import("../src/router.js")
  const settingsModule = (await import(join(REPO_ROOT, "dist/src/settings.js"))) as typeof import("../src/settings.js")
  const guardModule = (await import(join(REPO_ROOT, "dist/src/guard.js"))) as typeof import("../src/guard.js")
  const dispatchModule = (await import(join(REPO_ROOT, "dist/src/dispatch.js"))) as typeof import("../src/dispatch.js")
  const dirsModule = (await import(join(REPO_ROOT, "dist/src/dirs.js"))) as typeof import("../src/dirs.js")
  const scopeModule = (await import(join(REPO_ROOT, "dist/src/scope.js"))) as typeof import("../src/scope.js")

  const data = new Map<string, Schema.Json>()
  const infos = new Map<string, { id: string; time?: Record<string, unknown>; location?: { directory?: string } }>()
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key)),
    set: (key: string, value: Schema.Json) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: (options: { prefix: string; after?: string; limit?: number }) =>
      Effect.sync(() => {
        const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort()
        const start = options.after === undefined ? 0 : keys.indexOf(options.after) + 1
        const page = keys.slice(start, start + (options.limit ?? 100))
        const entries = page.map((key) => ({ key, value: data.get(key) ?? null }))
        return start + page.length < keys.length ? { entries, next: page[page.length - 1] } : { entries }
      }),
  }
  const session = {
    get: ({ sessionID }: { sessionID: string }) => {
      const info = infos.get(sessionID)
      return info === undefined
        ? Effect.fail(new Error(`missing session ${sessionID}`))
        : Effect.succeed(info)
    },
    create: () => Effect.succeed({ id: "ses_new" }),
    update: () => Effect.succeed(undefined),
    context: () => Effect.succeed([] as ReadonlyArray<unknown>),
    synthetic: () => Effect.succeed(undefined),
    prompt: () => Effect.succeed(undefined),
    interrupt: () => Effect.succeed(undefined),
    wait: () => Effect.succeed(undefined),
    hook: () => Effect.succeed(undefined),
  }
  const agent = { get: ({ agentID }: { agentID: unknown }) => Effect.succeed({ data: { id: String(agentID) } }) }
  const ctx = {
    options: {},
    storage,
    session,
    agent,
    app: {},
    client: {},
    directory: pinnedDirectory,
    $: Effect.succeed(undefined),
  } as unknown as Plugin.Context

  // Two live sessions: the legacy Router (`ses_old`, no directory) and the
  // pinned partition's own Router (`ses_new`).
  infos.set("ses_old", { id: "ses_old", time: {} })
  infos.set("ses_new", { id: "ses_new", time: {}, location: { directory: pinnedDirectory } })

  settingsModule.applySettings({ perDirectoryRouter: true, routerDirectory: pinnedDirectory })

  const dirKey = dirsModule.dirKeyOf(pinnedDirectory)
  // The pinned partition already owns a Router, and the legacy `router` key
  // points at a live session without a directory: exactly the situation the
  // fix addresses.
  data.set(stateModule.ROUTER_KEY, "ses_old" as unknown as Schema.Json)
  data.set(scopeModule.dirScopedKey(stateModule.ROUTER_KEY, dirKey), "ses_new" as unknown as Schema.Json)

  await Effect.runPromise(stateModule.hydrate(ctx))

  const legacyPointerValue = data.get(stateModule.ROUTER_KEY)
  const scopedPointer = data.get(scopeModule.dirScopedKey(stateModule.ROUTER_KEY, dirKey))
  const markerKey = `superseded:router:ses_old`
  const markerRaw = data.get(markerKey)
  const marker =
    markerRaw === undefined
      ? undefined
      : (JSON.parse(JSON.stringify(markerRaw)) as { sessionID?: string; supersededBy?: string; dirKey?: string })

  const supersededModule = (await import(join(REPO_ROOT, "dist/src/superseded.js"))) as typeof import("../src/superseded.js")
  const notice = supersededModule.supersededNotice("ses_old")

  // The old session's router-only tool must name its successor.
  const guardExit = await Effect.runPromise(
    Effect.exit(guardModule.requireRouter("ses_old", "ticket_list")).pipe(
      Effect.map((exit) => {
        if (Exit.isSuccess(exit)) return undefined
        return String(exit.cause)
      }),
    ),
  )

  // `status` (the router's own text view) lists the replaced session.
  const statusText = dispatchModule.statusText({})

  // The successor disappears: the stale marker is dropped and the legacy
  // pointer is reclaimed, so a deleted Router cannot strand a partition.
  infos.delete("ses_new")
  data.delete(scopeModule.dirScopedKey(stateModule.ROUTER_KEY, dirKey))
  const reclaimed = await Effect.runPromise(
    routerModule.ensureRouter(ctx, { dirKey: "default" }).pipe(Effect.map((id) => id)),
  )

  return {
    legacyPointerKept: legacyPointerValue !== undefined,
    legacyPointerValue: legacyPointerValue === undefined ? undefined : String(legacyPointerValue),
    scopedPointer: scopedPointer === undefined ? undefined : String(scopedPointer),
    marker,
    notice,
    statusText,
    requireRouterError: guardExit,
    reclaimedAfterSuccessorGone: reclaimed,
  }
}

// ── the real host phase (P0-2) ─────────────────────────────────────────────

async function main(): Promise<void> {
  const bin = Bun.which("opencode")
  if (bin === null) throw new AssertionError("`opencode` is not on PATH")
  const before = await realWatch()

  const root = await mkdtemp(join(tmpdir(), "opencode-superagent-p0-"))
  const pinned = join(root, "pinned")
  const missing = join(root, "does-not-exist")
  const workspace = join(root, "work")
  const config = join(root, "config")
  await Promise.all([
    mkdir(pinned, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(config, { recursive: true }),
  ])
  const env = isolatedEnv(root)

  // ── P0-2: an invalid routerDirectory must produce a helpful warning ──────
  await writeFile(
    join(config, "opencode.json"),
    `${JSON.stringify(
      { plugins: [{ package: REPO_ROOT, options: { perDirectoryRouter: true, routerDirectory: missing } }] },
      null,
      2,
    )}\n`,
  )

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Basic ${btoa(`${AUTH_USERNAME}:${env.OPENCODE_SERVER_PASSWORD ?? ""}`)}` }
  const stdout = { text: "" }
  const stderr = { text: "" }
  const proc = Bun.spawn([bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  const drains = [
    drain(proc.stdout as ReadableStream<Uint8Array>, stdout),
    drain(proc.stderr as ReadableStream<Uint8Array>, stderr),
  ]

  let warning = ""
  try {
    await waitFor(
      "server readiness",
      async () => {
        try {
          const response = await fetch(`${base}/`, { signal: AbortSignal.timeout(1_000) })
          return response.status < 500 ? true : undefined
        } catch {
          return undefined
        }
      },
      STARTUP_TIMEOUT_MS,
    )
    const plugin = await waitFor(
      "plugin active",
      async () => {
        const response = await fetch(`${base}/api/plugin`, { headers: auth, signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error(`GET /api/plugin -> ${response.status}`)
        const body = (await response.json()) as { data?: Array<{ id?: string; state?: { status?: string; error?: string } }> }
        const found = (body.data ?? []).find((item) => item.id === PLUGIN_ID)
        if (found === undefined) return undefined
        if (found.state?.status === "failed") {
          throw new AssertionError(`plugin failed to initialize: ${found.state.error ?? "unknown"}`)
        }
        return found.state?.status === "active" ? found : undefined
      },
      STARTUP_TIMEOUT_MS,
    )
    assertEqual(plugin.id, PLUGIN_ID, "loaded plugin id")

    // The plugin loads lazily, per location: the warning is only printed once
    // the plugin is actually loaded. Touching `/api/plugin` makes the host
    // reconcile (and therefore load) the plugin for this location.
    await fetch(`${base}/api/plugin`, { headers: auth, signal: AbortSignal.timeout(30_000) })

    // The warning is printed by the plugin at startup. It lands in the host's
    // log file (the host writes plugin logs there, not to the console).
    const candidates = [
      join(root, "data", "opencode", "log", "opencode.log"),
      join(root, "state", "opencode", "log", "opencode.log"),
      join(root, "home", ".local", "share", "opencode", "log", "opencode.log"),
    ]
    await waitFor(
      "routerDirectory warning",
      async () => {
        const sources = [stdout.text, stderr.text]
        for (const candidate of candidates) {
          try {
            sources.push(await Bun.file(candidate).text())
          } catch {
            // The log file may not exist yet or be readable; the streams suffice.
          }
        }
        for (const source of sources) {
          const line = source
            .split("\n")
            .find((candidate) => candidate.includes("routerDirectory") && candidate.includes("ignored"))
          if (line !== undefined) {
            warning = line
            return true
          }
        }
        return undefined
      },
      30_000,
    )

    assertContains(warning, "the directory does not exist", "P0-2 warning names the reason")
    // The host's log line escapes the quotes of the message; compare the
    // unescaped form so the assertion is about the warning text, not about
    // the log's own encoding.
    assertContains(
      warning.replace(/\\"/g, '"'),
      `mkdir -p "${missing}"`,
      "P0-2 warning suggests the fix",
    )
    assertContains(warning, "keeping the default partition", "P0-2 warning keeps the default partition")
    console.log(`[e2e] P0-2 warning ${warning.trim()}`)

    // The process really is on the default partition: no pinned partition.
    const statusResponse = await fetch(`${base}/api/rpc/${PLUGIN_ID}/status`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
      signal: AbortSignal.timeout(30_000),
    })
    const statusBody = (await statusResponse.json()) as { output?: { partitions?: ReadonlyArray<{ dirKey?: string; directory?: string }> } }
    const partitions = statusBody.output?.partitions ?? []
    assert(
      !partitions.some((entry) => entry.directory === missing),
      "an invalid routerDirectory must not create a partition",
    )
    console.log(`[e2e] P0-2         no partition for the invalid directory`)
  } finally {
    try {
      process.kill(-proc.pid, "SIGTERM")
    } catch {
      proc.kill("SIGTERM")
    }
    await Promise.race([proc.exited, Bun.sleep(5_000)])
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      // Already gone.
    }
    await Promise.allSettled(drains)
  }

  // ── P0-1: the claim must not silently take the Router away ───────────────
  const harness = await runHarness(root, pinned)
  assert(harness.legacyPointerKept, "P0-1: the legacy `router` pointer must be kept, not deleted")
  assertEqual(harness.legacyPointerValue, "ses_old", "P0-1: the legacy pointer still names the old session")
  assertEqual(harness.scopedPointer, "ses_new", "P0-1: the pinned partition keeps its own Router")
  assertEqual(harness.marker?.sessionID, "ses_old", "P0-1: the marker names the superseded session")
  assertEqual(harness.marker?.supersededBy, "ses_new", "P0-1: the marker names the successor")
  assertEqual(harness.marker?.dirKey, harness.marker?.dirKey, "P0-1: the marker records the partition")
  assert(harness.notice !== undefined, "P0-1: the superseded session has a notice")
  assertContains(harness.notice ?? "", "ses_new", "P0-1: the notice names the successor")
  assertContains(harness.notice ?? "", "不再是 Router", "P0-1: the notice says the session is no longer the Router")
  assert(
    harness.requireRouterError !== undefined,
    "P0-1: the old session's router-only tool must fail",
  )
  assertContains(
    harness.requireRouterError ?? "",
    "ses_new",
    "P0-1: the tool error names the successor",
  )
  assert(
    (harness.statusText ?? "").includes("ses_old"),
    "P0-1: `status` lists the replaced session",
  )
  assert(
    (harness.statusText ?? "").includes("superseded router session"),
    "P0-1: `status` names the situation",
  )
  assertEqual(
    harness.reclaimedAfterSuccessorGone,
    "ses_old",
    "P0-1: a stale marker is reclaimed once the successor is gone",
  )
  console.log(`[e2e] P0-1         legacy pointer kept=${harness.legacyPointerKept} marker=${JSON.stringify(harness.marker)}`)
  console.log(`[e2e] P0-1         notice=${harness.notice}`)
  console.log(`[e2e] P0-1         status=${(harness.statusText ?? "").split("\n").filter((line) => line.includes("superseded")).join(" | ")}`)
  console.log(`[e2e] P0-1         reclaim after successor gone -> ${harness.reclaimedAfterSuccessorGone}`)

  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

  const after = await realWatch()
  assertEqual(
    JSON.stringify(after),
    JSON.stringify(before),
    "the real config files and database must be untouched",
  )
  console.log("[e2e] isolation   real config size/mtime and DB inode unchanged")
  console.log("[e2e] OK: P0-1 superseded marker (no silent takeover) + P0-2 actionable routerDirectory warning")
}

await main()
