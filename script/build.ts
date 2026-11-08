#!/usr/bin/env bun
/**
 * Builds the published package: `dist/server.js` plus declarations from tsc,
 * and `dist/tui.js` from a Bun bundle that runs OpenTUI's Solid transform.
 *
 * The TUI half has to be bundled ahead of time. OpenCode's runtime Solid
 * transform skips every path inside `node_modules`, so a published `tui.tsx`
 * would keep raw JSX and fail with `Cannot find module 'react/jsx-dev-runtime'`.
 * Bundling also inlines the `src/` helpers the TUI reads, so the package does
 * not have to ship its TypeScript sources.
 *
 * `effect`, `@opencode/plugin` and the `@opentui/*` / `solid-js` runtime stay
 * bare imports in both outputs: the host resolves them to its own singletons
 * and refuses copies loaded from a plugin's `node_modules`.
 */
import { $ } from "bun"
import { rm } from "node:fs/promises"
import path from "node:path"
import solid from "@opentui/solid/bun-plugin"

process.chdir(path.resolve(import.meta.dir, ".."))

const external = [
  "effect",
  "effect/*",
  "@opencode/plugin",
  "@opencode/plugin/*",
  "@opencode/client",
  "@opencode/client/*",
  "@opentui/core",
  "@opentui/core/*",
  "@opentui/solid",
  "@opentui/solid/*",
  "solid-js",
  "solid-js/*",
]

await rm("dist", { recursive: true, force: true })

const server = await $`bun tsc -p tsconfig.build.json`.nothrow()
if (server.exitCode !== 0) process.exit(server.exitCode)

const types = await $`bun tsc -p tsconfig.build.tui.json`.nothrow()
if (types.exitCode !== 0) process.exit(types.exitCode)

const tui = await Bun.build({
  entrypoints: ["tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  plugins: [solid],
  external,
})
if (!tui.success) {
  for (const log of tui.logs) console.error(log)
  process.exit(1)
}

for (const entry of ["server.js", "server.d.ts", "tui.js", "tui.d.ts"]) {
  if (!(await Bun.file(path.join("dist", entry)).exists())) {
    console.error(`build: dist/${entry} is missing`)
    process.exit(1)
  }
}

const files = await Array.fromAsync(new Bun.Glob("dist/**/*.js").scan())
console.log(`build: dist/ has ${files.length} js files`)
