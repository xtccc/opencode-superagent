import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Plugin version, read from the package's own `package.json`.
 *
 * The version is the only thing this module exposes: it is deliberately not a
 * diagnostics dump, so logging it can never leak config, tokens, absolute
 * paths or session ids.
 */

/** Shown when no candidate `package.json` can be read or parsed. */
export const UNKNOWN_VERSION = "0.0.0-unknown"

/**
 * `package.json` locations relative to this module, most specific first:
 * - source (dev / tests): `src/version.ts` → `../package.json`
 * - build output: `dist/src/version.js` → `../../package.json`
 *
 * Both are tried so the same code works in the repo and in a packed tarball.
 */
const CANDIDATES = ["../package.json", "../../package.json"] as const

/** Extract `version` from raw `package.json` text; `undefined` when unusable. */
export function versionFromPackageJson(raw: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const value = (parsed as { version?: unknown }).version
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

export type ReadFile = (file: string) => string | undefined

function readRelative(file: string): string | undefined {
  try {
    return readFileSync(path.resolve(import.meta.dir, file), "utf8")
  } catch {
    return undefined
  }
}

/**
 * Read the first usable candidate, falling back to {@link UNKNOWN_VERSION}.
 *
 * `read` is injectable so the fallback path is testable without touching the
 * filesystem: pass `() => undefined` for a missing package, or a stub that
 * returns unparsable JSON.
 */
export function loadVersion(read: ReadFile = readRelative): string {
  for (const candidate of CANDIDATES) {
    const raw = read(candidate)
    if (raw === undefined) continue
    const version = versionFromPackageJson(raw)
    if (version !== undefined) return version
  }
  return UNKNOWN_VERSION
}

let cached: string | undefined

/** Cached plugin version; the process never changes version at runtime. */
export function pluginVersion(): string {
  cached ??= loadVersion()
  return cached
}

/**
 * One-line startup notice. Says what is loaded and that upgrading an already
 * running gateway is not enough — the plugin has no hot reload, so a service
 * restart is required before the new code is active.
 */
export function versionNotice(): string {
  return `superagent ${pluginVersion()} loaded; restart the OpenCode gateway after upgrading (no hot reload)`
}
