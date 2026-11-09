import { beforeEach, describe, expect, test } from "bun:test"
import { statusText } from "../src/dispatch.js"
import { Definition } from "../src/protocol.js"
import { store } from "../src/state.js"
import { resetTickets } from "../src/ticket.js"
import {
  loadVersion,
  pluginVersion,
  UNKNOWN_VERSION,
  versionFromPackageJson,
  versionNotice,
} from "../src/version.js"

/**
 * The plugin version is part of the observable surface: it shows up in the
 * startup log, in the `status` tool text and in the `status` RPC reply, so an
 * operator can tell a stale gateway (code upgraded but not restarted) from a
 * current one. These tests pin that surface and the package.json fallback.
 */

const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string }

beforeEach(() => {
  resetTickets()
  store.routerID = undefined
  store.workers.clear()
})

describe("version source", () => {
  test("reads the real package.json version", () => {
    expect(pluginVersion()).toBe(pkg.version)
    expect(pluginVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("parses a version and rejects unusable package.json text", () => {
    expect(versionFromPackageJson('{"name":"x","version":"1.2.3"}')).toBe("1.2.3")
    expect(versionFromPackageJson('{"version":" 2.0.0 "}')).toBe("2.0.0")
    expect(versionFromPackageJson('{"version":""}')).toBeUndefined()
    expect(versionFromPackageJson('{"version":42}')).toBeUndefined()
    expect(versionFromPackageJson("{}")).toBeUndefined()
    expect(versionFromPackageJson("not json")).toBeUndefined()
    expect(versionFromPackageJson("null")).toBeUndefined()
  })

  test("falls back when no candidate can be read", () => {
    expect(loadVersion(() => undefined)).toBe(UNKNOWN_VERSION)
  })

  test("falls back when candidates read but cannot be parsed", () => {
    expect(loadVersion(() => "{ broken")).toBe(UNKNOWN_VERSION)
    expect(loadVersion(() => '{"version":""}')).toBe(UNKNOWN_VERSION)
  })

  test("skips an unusable candidate and uses the next readable one", () => {
    const reads: Array<string> = []
    const version = loadVersion((file) => {
      reads.push(file)
      // First candidate exists but has no version; the second is the real one.
      return reads.length === 1 ? '{"name":"x"}' : '{"version":"9.9.9"}'
    })
    expect(version).toBe("9.9.9")
    expect(reads.length).toBe(2)
  })
})

describe("version notices", () => {
  test("startup notice names the version and the restart requirement", () => {
    const notice = versionNotice()
    expect(notice).toContain(pkg.version)
    expect(notice).toContain("restart the OpenCode gateway")
    expect(notice).toContain("no hot reload")
  })

  test("status tool text includes the plugin version", () => {
    const text = statusText()
    expect(text.split("\n")[0]).toContain(pkg.version)
    expect(text).toContain("restart the gateway")
    expect(text).toContain("router: none")
  })

  test("status RPC output declares and accepts the version", async () => {
    const validate = Definition.methods.status.output["~standard"].validate
    const parsed = (await Promise.resolve(validate({ version: pkg.version, pending: 0, workers: [] }))) as
      | { value: { version?: string } }
      | { issues: ReadonlyArray<{ message: string }> }
    expect("issues" in parsed).toBe(false)
    if ("issues" in parsed) return
    expect(parsed.value.version).toBe(pkg.version)
  })
})
