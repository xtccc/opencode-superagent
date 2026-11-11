/**
 * End-to-end: build + `bun pm pack` *this working tree*, install the resulting
 * tarball into a throw-away HOME and let a real OpenCode host load it.
 *
 * The tarball is the artifact `npm publish` would upload, so this test can only
 * pass when HEAD builds and packs. Nothing is downloaded from the npm registry
 * as the plugin itself; the only registry traffic is the tarball's own
 * dependencies (`@opencode/schema`), which any real install needs too.
 *
 * The expected version is read from `package.json` (never hardcoded), and the
 * loaded artifact is compared byte-for-byte against the fresh build, so a stale
 * or foreign build cannot pass.
 *
 * This file is deliberately NOT a `*.test.ts` and does NOT live under `test/`,
 * so a bare `bun test` never discovers it. It boots a real host and needs the
 * `opencode` CLI on PATH, which makes it a poor fit for the default local/CI
 * test run. It is executed by `.github/workflows/e2e.yml` through:
 *
 *   bun run test:e2e
 *
 * It never talks to a model and never touches the user's real OpenCode config,
 * database, or a gateway that may already be listening on another port.
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const PLUGIN_ID = "opencode.superagent"
const STARTUP_TIMEOUT_MS = 90_000
const COMMAND_TIMEOUT_MS = 120_000
const PACK_TIMEOUT_MS = 600_000
const INSTALL_TIMEOUT_MS = 300_000
// OpenCode's server auth defaults to `Basic base64(<username>:<password>)` with
// the fixed username `opencode`; only the password is configurable (env
// `OPENCODE_SERVER_PASSWORD`). The E2E pins it, so it never scrapes the
// generated credential.
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
  readonly source?: { readonly type?: string; readonly path?: string; readonly target?: string }
  readonly state?: { readonly status?: string; readonly error?: string }
  readonly features?: { readonly server?: boolean; readonly rpc?: boolean; readonly tui?: boolean }
}

interface Manifest {
  readonly name: string
  readonly version: string
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

/** The Bun running this file: the same runtime the repo pins in `engines`. */
function bunBinary(): string {
  const bin = process.execPath
  if (bin === undefined || bin === "" || !basename(bin).toLowerCase().startsWith("bun")) {
    throw new AssertionError(`this E2E must run under Bun, not ${String(bin)}`)
  }
  return bin
}

async function readManifest(): Promise<Manifest> {
  const text = await readFile(join(REPO_ROOT, "package.json"), "utf8")
  const json = JSON.parse(text) as { name?: unknown; version?: unknown }
  assert(typeof json.name === "string" && json.name !== "", "package.json has no name")
  assert(typeof json.version === "string" && json.version !== "", "package.json has no version")
  return { name: json.name, version: json.version }
}

/** Run a short-lived command and collect its output. */
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

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
}

async function readableSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * Build + pack the working tree with Bun's own packer. `prepack` runs the
 * build, so the tarball always contains build output derived from HEAD.
 */
async function pack(destination: string, env: Record<string, string>): Promise<string> {
  await mkdir(destination, { recursive: true })
  const result = await run([bunBinary(), "pm", "pack", "--destination", destination], {
    cwd: REPO_ROOT,
    env,
    timeoutMs: PACK_TIMEOUT_MS,
  })
  if (result.code !== 0) {
    throw new AssertionError(
      `bun pm pack failed (exit ${result.code}); the tree does not build\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
  const tarballs = (await readdir(destination)).filter((name) => name.endsWith(".tgz"))
  assertEqual(tarballs.length, 1, `tarballs in ${destination}`)
  return join(destination, tarballs[0] as string)
}

/** `bun add <tarball>` into a scratch prefix: exactly what an install does. */
async function installTarball(
  tarball: string,
  prefix: string,
  env: Record<string, string>,
): Promise<string> {
  await mkdir(prefix, { recursive: true })
  await writeFile(
    join(prefix, "package.json"),
    `${JSON.stringify({ name: "superagent-e2e-install", private: true, version: "0.0.0" }, null, 2)}\n`,
  )
  const result = await run([bunBinary(), "add", tarball], {
    cwd: prefix,
    env,
    timeoutMs: INSTALL_TIMEOUT_MS,
  })
  if (result.code !== 0) {
    throw new AssertionError(
      `bun add <tarball> failed (exit ${result.code})\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
  return join(prefix, "node_modules")
}

/** Native path -> the POSIX-ish form OpenCode stores in `opencode.json`. */
function configPath(path: string): string {
  return path.replace(/\\/g, "/")
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
  // Deterministic auth for the private server. The host accepts
  // `Basic base64(opencode:<password>)`, so the test never has to scrape the
  // generated credential.
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
  const manifest = await readManifest()
  const version = await run([bin, "--version"], {
    cwd: REPO_ROOT,
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 30_000,
  })
  console.log(`[e2e] repo        ${REPO_ROOT}`)
  console.log(`[e2e] package     ${manifest.name}@${manifest.version} (read from package.json)`)
  console.log(`[e2e] cli         ${bin} (${version.stdout.trim() || version.stderr.trim() || "unknown"})`)

  const root = await mkdtemp(join(tmpdir(), "opencode-superagent-e2e-"))
  const workspace = join(root, "work")
  const { env, home, data, config } = isolatedEnv(root)
  await mkdir(workspace, { recursive: true })
  await mkdir(config, { recursive: true })

  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const auth = { authorization: `Basic ${btoa(`${AUTH_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`)}` }
  let host: Host | undefined
  let cleanupResult: { portReleased: boolean; rootRemoved: boolean } | undefined
  let failure: unknown

  try {
    // 1. Build + pack HEAD. `prepack` runs `bun run build`, so a broken tree
    //    fails here instead of publishing a stale `dist/`.
    const tarball = await pack(join(root, "pack"), env)
    const tarballSize = await readableSize(tarball)
    assert(tarballSize > 0, `tarball ${basename(tarball)} is empty`)
    assertEqual(
      basename(tarball),
      `${manifest.name}-${manifest.version}.tgz`,
      "packed tarball name (must follow package.json)",
    )
    console.log(`[e2e] tarball     ${basename(tarball)} (${tarballSize} bytes, built from this tree)`)

    // 2. Install the tarball into a scratch prefix, like a real user install.
    //    `opencode plugin add` only accepts npm/git specs, so the extracted
    //    directory is registered in `opencode.json` instead (the same shape as
    //    a global install, minus the CLI-managed cache copy).
    const modules = await installTarball(tarball, join(root, "install"), env)
    const packageDir = join(modules, manifest.name)
    assert(existsSync(packageDir), `tarball did not install ${manifest.name}: ${packageDir}`)

    // 3. The installed artifact must be the tarball built from this tree: same
    //    version, same bytes. This is what stops a stale/foreign build passing.
    const installed = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Manifest
    assertEqual(installed.name, manifest.name, "installed package name")
    assertEqual(installed.version, manifest.version, "installed package version")
    for (const entry of ["dist/server.js", "dist/server.d.ts", "dist/tui.js", "dist/tui.d.ts"]) {
      assert(existsSync(join(packageDir, entry)), `tarball is missing ${entry} (did prepack run?)`)
    }
    for (const entry of ["dist/server.js", "dist/tui.js"]) {
      assertEqual(
        await sha256(join(packageDir, entry)),
        await sha256(join(REPO_ROOT, entry)),
        `installed ${entry} must be the build of this tree`,
      )
    }

    // 4. Register the installed package by absolute path, exactly like a
    //    global `plugins` entry.
    const pluginPath = configPath(packageDir)
    await writeFile(
      join(config, "opencode.json"),
      `${JSON.stringify({ plugins: [pluginPath] }, null, 2)}\n`,
    )

    // 5. Boot a real headless host on a private port.
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

    // 6. `/api/plugin` is the host's own inventory: it names the loaded
    //    package and whether the plugin's init effect completed
    //    (`state.status === "active"`; a throwing plugin shows up as `failed`
    //    with the error attached).
    const entry = await waitFor<PluginInfo>(
      "plugin list to report an active opencode-superagent",
      async () => {
        const response = await fetch(`${base}/api/plugin`, { headers: auth, signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error(`GET /api/plugin -> ${response.status} ${await response.text()}`)
        const body = (await response.json()) as { data?: PluginInfo[] }
        const found = (body.data ?? []).find(
          (item) =>
            item.id === PLUGIN_ID ||
            (item.source?.path ?? item.source?.target ?? "").includes(manifest.name),
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
    const resolved = configPath(entry.source?.path ?? entry.source?.target ?? "")
    assertEqual(resolved, pluginPath, "loaded plugin must be the freshly packed directory")
    assertEqual(entry.features?.server, true, "server feature")

    // 7. Ask the running host: the plugin's agents and RPC surface must be
    //    live, and it must report the version from package.json (the version is
    //    never hardcoded in this file). This is stronger than a log line alone
    //    and does not call a model.
    const agentsResponse = await fetch(`${base}/api/agent`, { headers: auth, signal: AbortSignal.timeout(30_000) })
    assertEqual(agentsResponse.status, 200, "GET /api/agent")
    const agents = (await agentsResponse.json()) as { data?: Array<{ id?: string }> }
    const agentIDs = (agents.data ?? []).map((agent) => agent.id)
    assert(agentIDs.includes("superagent-router"), `missing superagent-router agent: ${agentIDs.join(", ")}`)
    assert(agentIDs.includes("superagent-worker"), `missing superagent-worker agent: ${agentIDs.join(", ")}`)

    const statusResponse = await fetch(`${base}/api/rpc/${PLUGIN_ID}/status`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
      signal: AbortSignal.timeout(30_000),
    })
    assertEqual(statusResponse.status, 200, "POST /api/rpc status")
    const status = (await statusResponse.json()) as {
      output?: { version?: string; pending?: number; workers?: unknown[] }
    }
    assertEqual(status.output?.version, manifest.version, "version reported by the loaded plugin")
    assertEqual(status.output?.pending, 0, "hydrated pending triggers")
    assert(Array.isArray(status.output?.workers), "RPC status should return a worker list")
    assertEqual(status.output?.workers?.length, 0, "hydrated workers")

    // 8. Real evidence for the report / CI log.
    const log = `${await readHostLog(data)}\n${started.stderr.text}`
    const superagentLines = log
      .split("\n")
      .filter((line) => line.includes("superagent"))
      .slice(-5)
    console.log(`[e2e] host        ${base} (isolated HOME ${home})`)
    console.log(`[e2e] plugin      ${PLUGIN_ID} ${manifest.version} (${resolved})`)
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
  console.log("[e2e] OK: real OpenCode host loaded the plugin packed from this tree and shut down cleanly")
} catch (error) {
  console.error(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
