#!/usr/bin/env bun
/**
 * Release gate: `npm publish` runs this through the `prepublishOnly` hook, so a
 * red typecheck, a failing test or a broken package layout stops the upload
 * before anything reaches the registry.
 *
 * Steps (fail fast, each one is fatal):
 *   1. `bun run typecheck` — the same command CI runs.
 *   2. `bun run test`      — the full unit suite.
 *   3. `bun run build` + `bun pm pack` into a temp dir, then validate the
 *      tarball: the entry points exist, the packed manifest is the version being
 *      released, and no sources/tests/CI files leaked into the package.
 *
 * The pack step uses `--ignore-scripts` because step 3 builds first; that keeps
 * the gate from building the same tree three times.
 */
import { $ } from "bun"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

process.chdir(path.resolve(import.meta.dir, ".."))

class ReleaseCheckError extends Error {
  override name = "ReleaseCheckError"
}

function fail(message: string): never {
  throw new ReleaseCheckError(message)
}

function ok(message: string): void {
  console.log(`release-check: ok  ${message}`)
}

async function run(command: string, args: string[]): Promise<void> {
  const label = [command, ...args].join(" ")
  console.log(`release-check: run ${label}`)
  const result = await $`${command} ${args}`.nothrow()
  if (result.exitCode !== 0) {
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim()
    fail(`\`${label}\` exited with ${result.exitCode}\n${output}`)
  }
  ok(label)
}

interface TarEntry {
  readonly name: string
  readonly type: string
  readonly data: Uint8Array
}

/**
 * Minimal ustar reader: enough to inspect `npm pack` output without shelling out
 * to `tar`, so the gate behaves the same on every platform. Handles the pax
 * extension bun/npm emit for long paths.
 */
function readTarball(bytes: Uint8Array<ArrayBuffer>): TarEntry[] {
  const archive = Bun.gunzipSync(bytes)
  const decoder = new TextDecoder()
  const entries: TarEntry[] = []
  let offset = 0
  let paxPath: string | undefined

  const field = (start: number, length: number): string => {
    const slice = archive.subarray(offset + start, offset + start + length)
    const end = slice.indexOf(0)
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end)).trim()
  }

  while (offset + 512 <= archive.length) {
    const name = field(0, 100)
    const prefix = field(345, 155)
    if (name === "" && prefix === "") break // end-of-archive marker
    const size = Number.parseInt(field(124, 12) || "0", 8)
    const type = field(156, 1) || "0"
    const dataOffset = offset + 512
    const data = archive.subarray(dataOffset, dataOffset + size)

    if (type === "x") {
      // pax extended header lines look like `NN path=<value>\n`
      for (const line of decoder.decode(data).split("\n")) {
        if (line.includes(" path=")) paxPath = line.slice(line.indexOf(" path=") + 6)
      }
    } else {
      const fullName = paxPath ?? (prefix === "" ? name : `${prefix}/${name}`)
      paxPath = undefined
      entries.push({ name: fullName.replace(/^\.\//, ""), type, data })
    }

    offset = dataOffset + Math.ceil(size / 512) * 512
  }

  if (entries.length === 0) fail("tarball is empty or not a valid gzip/tar archive")
  return entries
}

async function checkPack(): Promise<void> {
  const repoManifest = (await Bun.file("package.json").json()) as {
    name?: string
    version?: string
  }
  const name = repoManifest.name ?? fail("package.json has no name")
  const version = repoManifest.version ?? fail("package.json has no version")

  const dir = await mkdtemp(path.join(tmpdir(), "superagent-release-check-"))
  try {
    const packed = await $`${process.execPath} pm pack --destination ${dir} --ignore-scripts --quiet`.nothrow()
    if (packed.exitCode !== 0) {
      fail(`bun pm pack failed\n${packed.stdout.toString()}\n${packed.stderr.toString()}`)
    }
    const tarballs = (await readdir(dir)).filter((entry) => entry.endsWith(".tgz"))
    if (tarballs.length !== 1) fail(`expected exactly one tarball in ${dir}, got ${tarballs.join(", ")}`)
    const tarball = path.join(dir, tarballs[0] as string)
    const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer())
    const entries = readTarball(bytes)
    const names = new Set(entries.filter((entry) => entry.type !== "5").map((entry) => entry.name))

    const required = [
      "package/package.json",
      "package/dist/server.js",
      "package/dist/server.d.ts",
      "package/dist/tui.js",
      "package/dist/tui.d.ts",
      "package/README.md",
      "package/CHANGELOG.md",
      "package/LICENSE",
      "package/agent/superagent-router.md",
      "package/agent/superagent-worker.md",
    ]
    const missing = required.filter((entry) => !names.has(entry))
    if (missing.length > 0) fail(`tarball is missing ${missing.join(", ")} (did the build run?)`)

    const leaked = [...names].filter(
      (entry) =>
        !/\.d\.ts$/.test(entry) &&
        (/\.(ts|tsx|jsonc)$/.test(entry) ||
          /^package\/(src|test|e2e|script|\.github|node_modules|evidence)\//.test(entry)),
    )
    if (leaked.length > 0) fail(`tarball leaks non-published files: ${leaked.join(", ")}`)

    const packedEntry = entries.find((entry) => entry.name === "package/package.json")
    if (packedEntry === undefined) fail("tarball has no package/package.json")
    const packedManifest = JSON.parse(new TextDecoder().decode(packedEntry.data)) as {
      name?: string
      version?: string
    }
    if (packedManifest.name !== name) fail(`tarball name ${String(packedManifest.name)} != ${name}`)
    if (packedManifest.version !== version) {
      fail(`tarball version ${String(packedManifest.version)} != ${version} (stale pack?)`)
    }

    ok(
      `tarball ${path.basename(tarball)} carries ${names.size} files, ` +
        `${(bytes.byteLength / 1024).toFixed(1)} KiB, version ${version}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

await run("bun", ["run", "typecheck"])
await run("bun", ["run", "test"])
await run("bun", ["run", "build"])
await checkPack()
console.log("release-check: all gates passed; publishing may proceed")
