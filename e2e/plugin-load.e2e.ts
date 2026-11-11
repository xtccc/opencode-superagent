/**
 * End-to-end: boot a real OpenCode host in an isolated HOME and let it load the
 * published `opencode-superagent@0.4.0` package.
 *
 * This file is deliberately NOT a `*.test.ts` and does NOT live under `test/`,
 * so a bare `bun test` never discovers it. It boots a real host, downloads a
 * package from npm and needs the `opencode` CLI on PATH, which makes it a poor
 * fit for the default local/CI test run. It is executed by
 * `.github/workflows/e2e.yml` through:
 *
 *   bun run test:e2e
 *
 * It never talks to a model and never touches the user's real OpenCode config,
 * database, or a gateway that may already be listening on another port.
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PLUGIN_SPEC = "opencode-superagent@0.4.0"
const PLUGIN_ID = "opencode.superagent"
const STARTUP_TIMEOUT_MS = 90_000
const COMMAND_TIMEOUT_MS = 120_000

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

interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

interface Host {
  readonly proc: ReturnType<typeof Bun.spawn>
  readonly stdout: { text: string }
  readonly stderr: { text: string }
  // Streams are drained in the background so a chatty server can never block
  // on a full pipe while the test is waiting for readiness.
  readonly drains: Array<Promise<void>>
}

interface PluginInfo {
  readonly id?: string
  readonly source?: { readonly type?: string; readonly target?: string; readonly version?: string }
  readonly state?: { readonly status?: string; readonly error?: string }
  readonly features?: { readonly server?: boolean; readonly rpc?: boolean; readonly tui?: boolean }
}

function opencodeBinary(): string {
  const bin = Bun.which("opencode")
  if (bin === null) {
    throw new AssertionError(
      "`opencode` is not on PATH. This E2E is meant to run in the dedicated GitHub Actions job, " +
        "which installs the OpenCode CLI (`npm install -g @opencode/cli`).",
    )
  }
  return bin
}

/** Run a short-lived CLI command and collect its output. */
async function run(
  command: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs?: number },
): Promise<RunResult> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => proc.kill("SIGKILL"), options.timeoutMs ?? COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    clearTimeout(timer)
  }
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

/** An isolated env: no OPENCODE_ or XDG_ variable from the caller can leak in. */
function isolatedEnv(root: string): {
  env: Record<string, string>
  home: string
  data: string
  config: string
} {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith("OPENCODE_") || key.startsWith("XDG_")) continue
    env[key] = value
  }

  const home = join(root, "home")
  env.HOME = home
  env.XDG_CONFIG_HOME = join(home, ".config")
  env.XDG_DATA_HOME = join(home, ".local", "share")
  env.XDG_CACHE_HOME = join(home, ".cache")
  env.XDG_STATE_HOME = join(home, ".local", "state")
  // Deterministic auth for the private server. `opencode api` reads this same
  // variable, so the test never has to scrape the generated password.
  env.OPENCODE_SERVER_PASSWORD = `e2e-${crypto.randomUUID()}`
  env.OPENCODE_DISABLE_AUTOUPDATE = "1"
  env.NO_COLOR = "1"
  env.DO_NOT_TRACK = "1"

  return {
    env,
    home,
    data: join(home, ".local", "share", "opencode"),
    config: join(home, ".config", "opencode"),
  }
}

/** Bind port 0 to let the kernel pick a free port, then release it for the host. */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
    const port = server.port
    await server.stop(true)
    if (port !== undefined && port > 1024) return port
  }
  throw new AssertionError("could not reserve a free TCP port")
}

async function canBind(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("probe") })
    await server.stop(true)
    return true
  } catch {
    return false
  }
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  host: () => Host | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    const current = host()
    if (current !== undefined && current.proc.exitCode !== null) {
      throw new AssertionError(
        `${what}: opencode exited with code ${current.proc.exitCode}\n` +
          `--- stdout ---\n${current.stdout.text}\n--- stderr ---\n${current.stderr.text}`,
      )
    }
    try {
      const value = await probe()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(250)
  }
  const current = host()
  throw new AssertionError(
    `${what}: timed out after ${timeoutMs}ms${lastError === undefined ? "" : ` (${String(lastError)})`}\n` +
      `--- stdout ---\n${current?.stdout.text ?? ""}\n--- stderr ---\n${current?.stderr.text ?? ""}`,
  )
}

async function readLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

/** Best-effort host log text (v2 keeps one file per boot under `<data>/log`). */
async function readHostLog(dataDir: string): Promise<string> {
  try {
    const dir = join(dataDir, "log")
    const entries = await readdir(dir)
    const files = entries.filter((name) => name.endsWith(".log")).sort()
    const chunks: string[] = []
    for (const name of files) chunks.push(await readLog(join(dir, name)))
    return chunks.join("\n")
  } catch {
    return ""
  }
}

/** Stop the detached process group; `opencode serve` may have children. */
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

async function cleanup(
  root: string,
  port: number,
  host: Host | undefined,
): Promise<{ portReleased: boolean; rootRemoved: boolean }> {
  if (host !== undefined) {
    await terminate(host.proc)
    await Promise.allSettled(host.drains)
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  return { portReleased: await canBind(port), rootRemoved: !existsSync(root) }
}

function logTail(text: string, lines = 80): string {
  const parts = text.split("\n")
  return parts.slice(Math.max(0, parts.length - lines)).join("\n")
}

async function main(): Promise<void> {
  const bin = opencodeBinary()
  const version = await run([bin, "--version"], { cwd: process.cwd(), env: { ...process.env } as Record<string, string>, timeoutMs: 30_000 })
  console.log(`[e2e] cli         ${bin} (${version.stdout.trim() || version.stderr.trim() || "unknown"})`)

  const root = await mkdtemp(join(tmpdir(), "opencode-superagent-e2e-"))
  const workspace = join(root, "work")
  const { env, home, data, config } = isolatedEnv(root)
  await mkdir(workspace, { recursive: true })
  await mkdir(config, { recursive: true })

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let host: Host | undefined
  let cleanupResult: { portReleased: boolean; rootRemoved: boolean } | undefined
  let failure: unknown

  try {
    // 1. Install through the real CLI so the temporary config is produced
    //    by OpenCode itself, not by the test guessing the file format.
    const added = await run([bin, "plugin", "add", PLUGIN_SPEC], { cwd: workspace, env })
    assertEqual(added.code, 0, `opencode plugin add failed\n${added.stderr}`)

    const configText = await readFile(join(config, "opencode.json"), "utf8")
    const configured = JSON.parse(configText) as { plugins?: unknown[] }
    assert(
      Array.isArray(configured.plugins) && configured.plugins.includes(PLUGIN_SPEC),
      `global config does not list ${PLUGIN_SPEC}: ${configText}`,
    )

    // 2. Boot a real headless host on a private port.
    const proc = Bun.spawn([bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    })
    host = { proc, stdout: { text: "" }, stderr: { text: "" }, drains: [] }
    const started = host
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
      () => host,
    )

    // 3. `/api/plugin` is the host's own inventory: it names the published
    //    package, its resolved version and whether the plugin's init effect
    //    completed (`state.status === "active"`; a throwing plugin shows up as
    //    `failed` with the error attached).
    const entry = await waitFor<PluginInfo>(
      "plugin list to report an active opencode-superagent",
      async () => {
        const result = await run([bin, "api", "--server", base, "GET", "/api/plugin"], {
          cwd: workspace,
          env,
          timeoutMs: 30_000,
        })
        if (result.code !== 0) {
          throw new Error(`GET /api/plugin failed (exit ${result.code}): ${result.stderr.trim()}`)
        }
        const body = JSON.parse(result.stdout) as { data?: PluginInfo[] }
        const list = body.data ?? []
        const found = list.find(
          (item) => item.id === PLUGIN_ID || item.source?.target === "opencode-superagent",
        )
        if (found === undefined) return undefined
        if (found.state?.status === "failed") {
          throw new AssertionError(`plugin failed to initialize: ${found.state.error ?? "unknown error"}`)
        }
        return found.state?.status === "active" ? found : undefined
      },
      STARTUP_TIMEOUT_MS,
      () => host,
    )

    assertEqual(entry.id, PLUGIN_ID, "loaded plugin id")
    assertEqual(entry.source?.type, "package", "plugin source type")
    assert(
      entry.source?.target?.startsWith("opencode-superagent") === true,
      `plugin package spec: ${String(entry.source?.target)}`,
    )
    assertEqual(entry.source?.version, "0.4.0", "resolved plugin version")

    // 4. Ask the running host through its own CLI: the plugin's agents and
    //    RPC surface must be live. This is stronger than a log line alone and
    //    does not call a model.
    const agentsResult = await run([bin, "api", "--server", base, "GET", "/api/agent"], {
      cwd: workspace,
      env,
      timeoutMs: 30_000,
    })
    assertEqual(agentsResult.code, 0, `GET /api/agent failed\n${agentsResult.stderr}`)
    const agents = JSON.parse(agentsResult.stdout) as { data?: Array<{ id?: string }> }
    const agentIDs = (agents.data ?? []).map((agent) => agent.id)
    assert(agentIDs.includes("superagent-router"), `missing superagent-router agent: ${agentIDs.join(", ")}`)
    assert(agentIDs.includes("superagent-worker"), `missing superagent-worker agent: ${agentIDs.join(", ")}`)

    const statusResult = await run(
      [bin, "api", "--server", base, "POST", "/api/rpc/opencode.superagent/status", "-d", '{"input":{}}'],
      { cwd: workspace, env, timeoutMs: 30_000 },
    )
    assertEqual(statusResult.code, 0, `superagent RPC status failed\n${statusResult.stderr}`)
    const status = JSON.parse(statusResult.stdout) as {
      output?: { pending?: number; workers?: unknown[] }
    }
    assertEqual(status.output?.pending, 0, "hydrated pending triggers")
    assert(Array.isArray(status.output?.workers), "RPC status should return a worker list")
    assertEqual(status.output?.workers?.length, 0, "hydrated workers")

    // 5. Real evidence for the report / CI log.
    const log = `${await readHostLog(data)}\n${started.stderr.text}`
    const superagentLines = log
      .split("\n")
      .filter((line) => line.includes("superagent"))
      .slice(-5)
    console.log(`[e2e] host        ${base} (isolated HOME ${home})`)
    console.log(`[e2e] plugin      ${PLUGIN_ID} ${entry.source?.version} (${entry.source?.target})`)
    console.log(`[e2e] plugin state ${entry.state?.status ?? "unknown"} features=${JSON.stringify(entry.features ?? {})}`)
    for (const line of superagentLines) console.log(`[e2e] log         ${line.trim().slice(0, 300)}`)
    console.log(`[e2e] agents      ${agentIDs.filter((id) => id?.startsWith("superagent")).join(", ")}`)
    console.log(`[e2e] rpc status  ${JSON.stringify(status.output)}`)
  } catch (error) {
    failure = error
  } finally {
    cleanupResult = await cleanup(root, port, host)
  }

  if (failure !== undefined) {
    const log = `${await readHostLog(data)}\n${host?.stderr.text ?? ""}`
    if (log.trim() !== "") console.error(`--- host log tail ---\n${logTail(log)}`)
  }

  assert(cleanupResult?.rootRemoved === true, "temporary HOME was not removed")
  assert(cleanupResult?.portReleased === true, `port ${port} was not released after shutdown`)

  if (failure !== undefined) throw failure
}

try {
  await main()
  console.log("[e2e] OK: real OpenCode host loaded the published plugin and shut down cleanly")
} catch (error) {
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
