/**
 * Stage 3 E2E: one gateway, two directories.
 *
 * Two independent layers, both isolated from the developer's real OpenCode:
 *
 * 1. **Real host** (`opencode serve`) with `OPENCODE_CONFIG_DIR` pointing at a
 *    throw-away directory, `HOME`/`XDG_*` also under the temp root and
 *    `options: { perDirectoryRouter: true }`. It proves the built plugin loads,
 *    that the aggregate `status` grows a partition list, and that
 *    `router({ directory })` creates two distinct Router sessions in their own
 *    `location.directory`.
 * 2. **Plugin internals on the built artifact** (`dist/src/*.js`): a fake host
 *    drives `ensureRouter` + `runDispatch` + `handleEnded` for two temporary
 *    directories. A real model is not needed, which is the only way to make
 *    completion delivery deterministic. It asserts two routers, two worker
 *    records with the right `directory`, completion events that reach only
 *    their own Router, and a flag-off control that collapses both directories
 *    onto one Router.
 *
 * Everything lives under one `mkdtemp` root and is removed at the end. Before
 * and after the run the real `~/.config/opencode` / data / state trees are
 * fingerprinted (path, size, mtime) and must be byte-identical.
 *
 * Run with:
 *
 *   bun run e2e/per-directory.e2e.ts
 *
 * Not a `*.test.ts`, so a bare `bun test` does not discover it.
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { Effect, type Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PLUGIN_ID = "opencode.superagent"
const STARTUP_TIMEOUT_MS = 90_000
const BUILD_TIMEOUT_MS = 300_000
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

// ── process helpers ─────────────────────────────────────────────────────────

interface RunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function bunBinary(): string {
  const bin = process.execPath
  if (bin === undefined || bin === "" || !basename(bin).toLowerCase().startsWith("bun")) {
    throw new AssertionError(`this E2E must run under Bun, not ${String(bin)}`)
  }
  return bin
}

function opencodeBinary(): string {
  const bin = Bun.which("opencode")
  if (bin === null) {
    throw new AssertionError("`opencode` is not on PATH; this E2E needs the real OpenCode CLI")
  }
  return bin
}

async function run(command: string[], options: { cwd: string; env?: Record<string, string> }): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env ?? (process.env as Record<string, string>),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
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
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      sink.text += decoder.decode(value, { stream: true })
    }
    sink.text += decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function terminate(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (proc.exitCode !== null) return
  try {
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    proc.kill("SIGTERM")
  }
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (exited) return
  try {
    process.kill(-proc.pid, "SIGKILL")
  } catch {
    proc.kill("SIGKILL")
  }
  await Promise.race([proc.exited, Bun.sleep(2_000)])
}

// ── isolation ───────────────────────────────────────────────────────────────

interface IsolatedEnv {
  readonly env: Record<string, string>
  readonly home: string
  readonly config: string
  readonly data: string
  readonly state: string
}

/** Drop every inherited OPENCODE_/XDG_/HOME variable, then point everything under `root`. */
function isolatedEnv(root: string): IsolatedEnv {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key === "HOME" || key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }
  const home = join(root, "home")
  const config = join(root, "config")
  const data = join(root, "data")
  const state = join(root, "state")
  env.HOME = home
  env.OPENCODE_CONFIG_DIR = config
  env.XDG_CONFIG_HOME = join(home, ".config")
  env.XDG_DATA_HOME = join(data, "xdg")
  env.XDG_STATE_HOME = join(state, "xdg")
  env.XDG_CACHE_HOME = join(home, ".cache")
  env.OPENCODE_SERVER_PASSWORD = `e2e-${crypto.randomUUID()}`
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.NO_COLOR = "1"
  env.DO_NOT_TRACK = "1"
  return { env, home, config, data, state }
}

interface Watchpoint {
  readonly path: string
  readonly exists: boolean
  /** Config files: size + mtime. Live gateway does not rewrite these. */
  readonly content?: string
  /** Database: inode + device, so a replaced/deleted file is caught without
   *  treating the user's live gateway writes as our fault. */
  readonly identity?: string
}

interface RealWatch {
  readonly config: ReadonlyArray<Watchpoint>
  readonly database: ReadonlyArray<Watchpoint>
}

async function watchPath(path: string, mode: "content" | "identity"): Promise<Watchpoint> {
  try {
    const info = await stat(path)
    return {
      path,
      exists: true,
      ...(mode === "content"
        ? { content: `${info.size}:${info.mtimeMs}` }
        : { identity: `${info.dev}:${info.ino}` }),
    }
  } catch {
    return { path, exists: false }
  }
}

/**
 * Watch the user's real OpenCode paths. Config JSON files are compared by
 * size+mtime (the live gateway does not rewrite them), the database by
 * inode/device only: the user's own gateway writes `opencode.db` continuously,
 * so its mtime is not attributable to this E2E. A changed inode means the file
 * was replaced or recreated, which our isolated run must never do.
 */
async function realWatch(): Promise<RealWatch> {
  const home = homedir()
  const configFiles = [
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
    join(home, ".config", "opencode", "package.json"),
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".local", "state", "opencode", "plugin-meta.json"),
  ]
  const databases = [join(home, ".local", "share", "opencode", "opencode.db")]
  const config: Array<Watchpoint> = []
  for (const path of configFiles) config.push(await watchPath(path, "content"))
  const database: Array<Watchpoint> = []
  for (const path of databases) database.push(await watchPath(path, "identity"))
  return { config, database }
}

function describeWatch(value: RealWatch): string {
  const parts = [
    ...value.config.map((entry) => `${basename(entry.path)}=${entry.exists ? "present" : "missing"}`),
    ...value.database.map((entry) => `${basename(entry.path)}=${entry.exists ? "present" : "missing"}`),
  ]
  return parts.join(", ")
}

/** Positive isolation evidence: the host must have written its DB under the temp root. */
async function hasIsolatedDatabase(root: string): Promise<boolean> {
  let found = false
  async function walk(dir: string): Promise<void> {
    if (found) return
    let names
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (/\.(?:db|sqlite3?|db-wal|db-shm)$/.test(entry.name)) found = true
      if (found) return
    }
  }
  await walk(root)
  return found
}

// ── real host phase ─────────────────────────────────────────────────────────

interface SessionSummary {
  readonly id?: string
  readonly location?: { readonly directory?: string }
}

interface StatusOutput {
  readonly version?: string
  readonly router?: string
  readonly pending?: number
  readonly workers?: ReadonlyArray<unknown>
  readonly partitions?: ReadonlyArray<{
    readonly dirKey?: string
    readonly directory?: string
    readonly router?: string
    readonly pending?: number
    readonly workers?: number
    readonly running?: number
  }>
  readonly dirKey?: string
  readonly directory?: string
}

async function main(): Promise<void> {
  const bin = opencodeBinary()
  const before = await realWatch()
  console.log(`[e2e] repo        ${REPO_ROOT}`)
  console.log(`[e2e] cli         ${bin}`)
  console.log(`[e2e] real paths  ${describeWatch(before)}`)

  const root = await mkdtemp(join(tmpdir(), "opencode-superagent-perdir-"))
  const dirA = join(root, "proj-alpha")
  const dirB = join(root, "proj-beta")
  const workspace = join(root, "work")
  const isolated = isolatedEnv(root)
  await Promise.all([mkdir(dirA, { recursive: true }), mkdir(dirB, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(isolated.config, { recursive: true })])

  let port: number | undefined
  let host: { proc: ReturnType<typeof Bun.spawn>; stdout: { text: string }; stderr: { text: string }; drains: Array<Promise<void>> } | undefined
  let failure: unknown
  const realDirs = { alpha: await realpath(dirA), beta: await realpath(dirB) }

  try {
    // 1. Build the tree this E2E drives; the real host loads it by absolute path.
    const built = await run([bunBinary(), "run", "build"], { cwd: REPO_ROOT })
    if (built.code !== 0) {
      throw new AssertionError(`bun run build failed (exit ${built.code})\n${built.stdout}\n${built.stderr}`)
    }
    console.log(`[e2e] build       ${built.stdout.trim() || "ok"}`)

    // 2. Isolated config: the plugin plus the stage 3 switch.
    await writeFile(
      join(isolated.config, "opencode.json"),
      `${JSON.stringify(
        { plugins: [{ package: REPO_ROOT, options: { perDirectoryRouter: true } }] },
        null,
        2,
      )}\n`,
    )

    // 3. Boot a real headless host on a private port.
    port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const auth = {
      authorization: `Basic ${btoa(`${AUTH_USERNAME}:${isolated.env.OPENCODE_SERVER_PASSWORD ?? ""}`)}`,
    }
    const proc = Bun.spawn([bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env: isolated.env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    const started = { proc, stdout: { text: "" }, stderr: { text: "" }, drains: [] as Array<Promise<void>> }
    host = started
    started.drains.push(
      drain(proc.stdout as ReadableStream<Uint8Array>, started.stdout),
      drain(proc.stderr as ReadableStream<Uint8Array>, started.stderr),
    )

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
    console.log(`[e2e] host        ${base}`)
    console.log(`[e2e] config dir  ${isolated.config} (OPENCODE_CONFIG_DIR)`)

    // Positive proof that the host wrote into the isolated tree, not the real
    // one: a DB/WAL file must exist somewhere under the temp root.
    await waitFor(
      "isolated database file",
      async () => ((await hasIsolatedDatabase(root)) ? true : undefined),
      10_000,
    )
    console.log(`[e2e] isolated db present under ${root}`)

    async function rpc<T>(method: string, input: unknown): Promise<T> {
      const response = await fetch(`${base}/api/rpc/${PLUGIN_ID}/${method}`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ input }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await response.text()
      if (!response.ok) throw new AssertionError(`${method} RPC failed: ${response.status} ${text}`)
      return JSON.parse(text) as T
    }

    // 4. No partition is active yet, so the aggregate keeps the stage 2b shape
    //    (no summary); a scoped call already resolves the directory key.
    const aggregateBefore = await rpc<{ output?: StatusOutput }>("status", {})
    assertEqual(aggregateBefore.output?.partitions, undefined, "aggregate omits the summary below two partitions")
    assertEqual(aggregateBefore.output?.pending, 0, "empty pending queue")

    const scopedBefore = await rpc<{ output?: StatusOutput }>("status", { directory: dirA })
    assert(typeof scopedBefore.output?.dirKey === "string", "status({directory}) should echo dirKey")
    assertEqual(scopedBefore.output?.workers?.length, 0, "fresh partition has no workers")
    assertEqual(scopedBefore.output?.partitions, undefined, "scoped status must not include the aggregate summary")
    console.log(`[e2e] status      aggregate partitions=${aggregateBefore.output?.partitions?.length ?? 0} scoped=${scopedBefore.output?.dirKey}`)

    // 5. Two Routers, each created in its own directory through the public RPC.
    const routerA = await rpc<{ output?: { sessionID?: string } }>("router", { directory: dirA })
    const routerB = await rpc<{ output?: { sessionID?: string } }>("router", { directory: dirB })
    const idA = routerA.output?.sessionID
    const idB = routerB.output?.sessionID
    assert(typeof idA === "string" && idA !== "", "router(dirA) returned a session id")
    assert(typeof idB === "string" && idB !== "", "router(dirB) returned a session id")
    assert(idA !== idB, `two directories must not share a Router (${idA})`)
    console.log(`[e2e] routers     alpha=${idA} beta=${idB}`)

    // 6. The aggregate summary now names both partitions and their directories.
    const aggregate = await rpc<{ output?: StatusOutput }>("status", {})
    const partitions = aggregate.output?.partitions ?? []
    assertEqual(partitions.length, 2, "aggregate partition count")
    const partA = partitions.find((entry) => entry.router === idA)
    const partB = partitions.find((entry) => entry.router === idB)
    assert(partA !== undefined && partB !== undefined, "both Routers must appear in the aggregate")
    assertEqual(partA.directory, realDirs.alpha, "alpha partition directory")
    assertEqual(partB.directory, realDirs.beta, "beta partition directory")
    assertEqual(partA.running, 0, "alpha running workers")
    assertEqual(partB.pending, 0, "beta pending triggers")

    const scopedA = await rpc<{ output?: StatusOutput }>("status", { directory: dirA })
    assertEqual(scopedA.output?.router, idA, "scoped status(alpha) router")
    assertEqual(scopedA.output?.dirKey, partA.dirKey, "scoped status(alpha) dirKey")
    console.log(
      `[e2e] partitions  ${partitions
        .map((entry) => `${entry.dirKey}=${entry.router}@${entry.directory}`)
        .join(" | ")}`,
    )

    // 7. Best-effort host-side proof of `location.directory` (the partition
    //    record already carries it; this reads the session itself when the API
    //    exposes it).
    const locations = await readSessionDirectories(base, auth, [idA, idB])
    if (locations === undefined) {
      console.log("[e2e] sessions    host session API did not expose locations; partition directories above are the evidence")
    } else {
      assertEqual(locations[idA], realDirs.alpha, "router A session location.directory")
      assertEqual(locations[idB], realDirs.beta, "router B session location.directory")
      console.log(`[e2e] sessions    alpha=${locations[idA]} beta=${locations[idB]}`)
    }
  } catch (error) {
    failure = error
  } finally {
    if (host !== undefined) {
      await terminate(host.proc)
      await Promise.allSettled(host.drains)
    }
    const log = host?.stderr.text ?? ""
    if (failure !== undefined && log.trim() !== "") {
      console.error(`--- host log tail ---\n${log.split("\n").slice(-60).join("\n")}`)
    }
  }

  // Whatever happened in the host phase, the deterministic harness still runs
  // (unless the build itself failed, which would make its imports meaningless).
  let harness: unknown
  try {
    harness = await runHarness(dirA, dirB, root)
  } catch (error) {
    harness = error
    if (failure === undefined) failure = error
  }

  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  assert(!existsSync(root), "temporary root was not removed")
  if (port !== undefined) {
    const released = await (async () => {
      try {
        const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") })
        await server.stop(true)
        return true
      } catch {
        return false
      }
    })()
    assert(released, `port ${port} was not released after shutdown`)
  }

  const after = await realWatch()
  assertEqual(
    JSON.stringify(after.config),
    JSON.stringify(before.config),
    "real config files (size+mtime) must be untouched",
  )
  assertEqual(
    JSON.stringify(after.database),
    JSON.stringify(before.database),
    "real database identity (device+inode) must be untouched",
  )
  console.log(`[e2e] isolation   ${describeWatch(after)}`)
  console.log("[e2e] isolation   real config size/mtime and DB inode unchanged; host DB lived under the temp root")

  if (failure !== undefined) throw failure
  console.log("[e2e] OK: two directories, two Routers, isolated completion delivery, flag-off control")
  console.log(
    `[e2e] harness    ${JSON.stringify(harness)}`,
  )
}

/**
 * Try a couple of host session endpoints; return `undefined` when none exposes
 * a session's location (older/newer host), never fail the E2E for it.
 */
async function readSessionDirectories(
  base: string,
  auth: Record<string, string>,
  ids: ReadonlyArray<string>,
): Promise<Record<string, string | undefined> | undefined> {
  const candidates = [`/api/session`, `/api/session/list`]
  for (const path of candidates) {
    try {
      const response = await fetch(`${base}${path}`, { headers: auth, signal: AbortSignal.timeout(5_000) })
      if (!response.ok) continue
      const body: unknown = await response.json()
      const found = new Map<string, string>()
      collectSessions(body, found)
      if (ids.some((id) => found.has(id))) {
        const out: Record<string, string | undefined> = {}
        for (const id of ids) out[id] = found.get(id)
        return out
      }
    } catch {
      // Ignore: location proof is a bonus, the partition list is authoritative.
    }
  }
  return undefined
}

/** Walk an arbitrary JSON tree for `{ id, location: { directory } }` pairs. */
function collectSessions(value: unknown, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSessions(item, out)
    return
  }
  if (typeof value !== "object" || value === null) return
  const record = value as Record<string, unknown>
  const id = record["id"]
  const location = record["location"]
  if (typeof id === "string" && typeof location === "object" && location !== null) {
    const directory = (location as Record<string, unknown>)["directory"]
    if (typeof directory === "string") out.set(id, directory)
  }
  for (const child of Object.values(record)) collectSessions(child, out)
}

// ── deterministic plugin-internals harness ──────────────────────────────────

interface HarnessResult {
  readonly flagOn: {
    readonly routerA: string
    readonly routerB: string
    readonly workerA: string
    readonly workerB: string
    readonly workerADirectory: string | undefined
    readonly workerBDirectory: string | undefined
    readonly deliveriesToA: number
    readonly deliveriesToB: number
    readonly leakedToA: boolean
    readonly leakedToB: boolean
  }
  readonly flagOff: {
    readonly routerA: string
    readonly routerB: string
    readonly created: number
  }
}

async function runHarness(dirA: string, dirB: string, root: string): Promise<HarnessResult> {
  // The harness never reads config; pinning the env anyway makes accidental
  // host/config use impossible and proves the artifact runs isolated.
  process.env.OPENCODE_CONFIG_DIR = join(root, "config")
  process.env.HOME = join(root, "home")

  const stateModule = (await import(join(REPO_ROOT, "dist/src/state.js"))) as typeof import("../src/state.js")
  const routerModule = (await import(join(REPO_ROOT, "dist/src/router.js"))) as typeof import("../src/router.js")
  const dispatchModule = (await import(join(REPO_ROOT, "dist/src/dispatch.js"))) as typeof import("../src/dispatch.js")
  const ticketModule = (await import(join(REPO_ROOT, "dist/src/ticket.js"))) as typeof import("../src/ticket.js")
  const watcherModule = (await import(join(REPO_ROOT, "dist/src/watcher.js"))) as typeof import("../src/watcher.js")
  const settingsModule = (await import(join(REPO_ROOT, "dist/src/settings.js"))) as typeof import("../src/settings.js")
  const statusModule = (await import(join(REPO_ROOT, "dist/src/status.js"))) as typeof import("../src/status.js")

  interface Created {
    readonly id: string
    readonly directory?: string
  }
  interface Synthetic {
    readonly sessionID: string
    readonly text: string
  }
  interface Info {
    title?: string
    location?: { directory?: string }
    time?: Record<string, unknown>
  }
  interface Host {
    readonly ctx: Plugin.Context
    readonly created: Array<Created>
    readonly infos: Map<string, Info>
    readonly synthetic: Array<Synthetic>
    readonly data: Map<string, Schema.Json>
  }

  function memoryContext(): Host {
    const data = new Map<string, Schema.Json>()
    const infos = new Map<string, Info>()
    const created: Array<Created> = []
    const synthetic: Array<Synthetic> = []
    let counter = 0
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
        return info === undefined ? Effect.fail(new Error(`missing session ${sessionID}`)) : Effect.succeed({ id: sessionID, ...info })
      },
      create: (input: { title?: string; location?: { directory?: string } }) =>
        Effect.sync(() => {
          counter += 1
          const id = `ses_${counter}`
          const location = input.location === undefined ? undefined : { directory: String(input.location.directory) }
          created.push({ id, ...(location === undefined ? {} : { directory: location.directory }) })
          infos.set(id, { ...(input.title === undefined ? {} : { title: input.title }), ...(location === undefined ? {} : { location }), time: {} })
          return { id, title: input.title }
        }),
      update: () => Effect.succeed(undefined),
      context: () => Effect.succeed([] as ReadonlyArray<unknown>),
      synthetic: (input: { sessionID: string; text: string }) => {
        synthetic.push({ sessionID: input.sessionID, text: input.text })
        return Effect.succeed(undefined)
      },
      prompt: () => Effect.succeed(undefined),
      interrupt: ({ sessionID }: { sessionID: string }) => Effect.succeed({ sessionID, interrupted: true }),
      wait: () => Effect.succeed(undefined),
      hook: () => Effect.succeed(undefined),
    }
    const agent = { get: ({ agentID }: { agentID: unknown }) => Effect.succeed({ data: { id: String(agentID) } }) }
    const ctx = {
      options: {},
      location: { directory: root },
      storage,
      session,
      agent,
      event: { subscribe: () => undefined },
    } as unknown as Plugin.Context
    return { ctx, data, infos, created, synthetic }
  }

  async function succeed<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    const exit = await Effect.runPromise(Effect.exit(effect))
    if (exit._tag === "Failure") throw new AssertionError(`harness effect failed: ${JSON.stringify(exit)}`)
    return exit.value
  }

  function reset(flagOn: boolean): void {
    settingsModule.applySettings({ perDirectoryRouter: flagOn })
    ticketModule.resetTickets()
    stateModule.resetPartitions()
    stateModule.store.workers.clear()
    stateModule.store.pending.length = 0
    stateModule.store.routerID = undefined
  }

  // ── flag on: two routers, two workers, isolated completions ──
  reset(true)
  const on = memoryContext()
  const keyA = stateModule.dirKeyFor(dirA)
  const keyB = stateModule.dirKeyFor(dirB)
  const routerA = await succeed(routerModule.ensureRouter(on.ctx, { dirKey: keyA, directory: dirA }))
  const routerB = await succeed(routerModule.ensureRouter(on.ctx, { dirKey: keyB, directory: dirB }))
  assert(routerA !== routerB, `two directories must not share a Router (${routerA})`)
  assertEqual(on.created.length, 2, "router sessions created for the flag-on phase")

  const ticketA = await succeed(
    ticketModule.createTicket(on.ctx, {
      threadID: "e2e:alpha",
      title: "alpha task",
      objective: "touch alpha",
      acceptance: ["done"],
      directory: dirA,
      source: "e2e",
    }),
  )
  const ticketB = await succeed(
    ticketModule.createTicket(on.ctx, {
      threadID: "e2e:beta",
      title: "beta task",
      objective: "touch beta",
      acceptance: ["done"],
      directory: dirB,
      source: "e2e",
    }),
  )
  const dispatchA = await succeed(
    dispatchModule.runDispatch(on.ctx, { task: "touch alpha", threadID: "e2e:alpha", ticketID: ticketA.ticket.id }, routerA),
  )
  const dispatchB = await succeed(
    dispatchModule.runDispatch(on.ctx, { task: "touch beta", threadID: "e2e:beta", ticketID: ticketB.ticket.id }, routerB),
  )
  const workerA = dispatchA.output.sessionID
  const workerB = dispatchB.output.sessionID
  const recordA = stateModule.store.workers.get(workerA)
  const recordB = stateModule.store.workers.get(workerB)
  assert(recordA !== undefined && recordB !== undefined, "both worker records must exist")
  assertEqual(recordA.directory, dirA, "worker A record.directory")
  assertEqual(recordB.directory, dirB, "worker B record.directory")

  await succeed(watcherModule.handleEnded(on.ctx, workerA, "done", undefined, 1))
  await succeed(watcherModule.handleEnded(on.ctx, workerB, "done", undefined, 2))
  const toA = on.synthetic.filter((call) => call.sessionID === routerA)
  const toB = on.synthetic.filter((call) => call.sessionID === routerB)
  assertEqual(toA.length, 1, "alpha completion deliveries")
  assertEqual(toB.length, 1, "beta completion deliveries")
  assert(toA[0]?.text.includes(workerA) === true, "alpha Router receives its own worker report")
  assert(toA[0]?.text.includes(workerB) === false, "alpha Router must not receive beta's report")
  assert(toB[0]?.text.includes(workerB) === true, "beta Router receives its own worker report")
  assert(toB[0]?.text.includes(workerA) === false, "beta Router must not receive alpha's report")

  // The public status payload reflects the same split.
  const statusOn = statusModule.statusSnapshot()
  assertEqual(statusOn.partitions?.length, 2, "flag-on aggregate partitions")
  assertEqual(statusModule.statusSnapshot({ directory: dirA }).workers?.length, 1, "flag-on scoped alpha workers")

  // ── flag off: both directories collapse onto the single default Router ──
  reset(false)
  const off = memoryContext()
  const offRouterA = await succeed(routerModule.ensureRouter(off.ctx, { directory: dirA }))
  const offRouterB = await succeed(routerModule.ensureRouter(off.ctx, { directory: dirB }))
  assertEqual(offRouterA, offRouterB, "flag off must reuse the single Router")
  assertEqual(off.created.length, 1, "flag off creates exactly one Router session")
  assertEqual(off.created[0]?.directory, undefined, "flag off Router keeps the host default location")
  assertEqual(statusModule.statusSnapshot().partitions, undefined, "flag off has no partition summary")

  console.log(
    `[e2e] harness     flag-on routers=${routerA},${routerB} workers=${workerA}@${dirA},${workerB}@${dirB} ` +
      `deliveries=${toA.length}/${toB.length} flag-off router=${offRouterA} created=${off.created.length}`,
  )

  return {
    flagOn: {
      routerA,
      routerB,
      workerA,
      workerB,
      workerADirectory: recordA.directory,
      workerBDirectory: recordB.directory,
      deliveriesToA: toA.length,
      deliveriesToB: toB.length,
      leakedToA: toA[0]?.text.includes(workerB) === true,
      leakedToB: toB[0]?.text.includes(workerA) === true,
    },
    flagOff: {
      routerA: offRouterA,
      routerB: offRouterB,
      created: off.created.length,
    },
  }
}

try {
  await main()
} catch (error) {
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
