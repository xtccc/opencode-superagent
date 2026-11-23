import type { Plugin } from "@opencode/plugin/effect"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { filterSessionTools } from "../src/context.js"
import { aliasDirs } from "../src/dirs.js"
import {
  FILE_READ_MAX_LIMIT,
  knownRoots,
  readPathRejection,
  registerFileRead,
  runFileRead,
} from "../src/file-read.js"
import { store, type WorkerRecord } from "../src/state.js"
import { ROUTER_TOOLS, specFor, toolPermission } from "../src/tools.js"

const ROUTER = "ses_router"
const WORKER = "ses_worker"
const ALIAS = "file-read-test"

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

let sandbox: string

beforeEach(() => {
  store.routerID = ROUTER
  store.workers.clear()
  store.threads.clear()
  store.pending.length = 0
  // A temp dir under the gateway cwd is inside the default allowed root, so
  // both absolute and cwd-relative paths resolve without touching global aliases.
  sandbox = mkdtempSync(join(process.cwd(), ".tmp-file-read-"))
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  aliasDirs.delete(ALIAS)
  store.routerID = undefined
  store.workers.clear()
})

describe("file_read path boundaries", () => {
  test("accepts ordinary files inside a known root", () => {
    const roots = [process.cwd()]
    expect(readPathRejection(join(sandbox, "notes.md"), roots)).toBeUndefined()
    expect(readPathRejection("README.md", roots)).toBeUndefined()
  })

  test("rejects empty paths and paths outside the roots", () => {
    const roots = [process.cwd()]
    expect(readPathRejection("   ", roots)).toContain("不能为空")
    expect(readPathRejection("/etc/passwd", roots)).toContain("不在工作区")
    expect(readPathRejection(join(process.cwd(), "..", "etc", "passwd"), roots)).toContain("不在工作区")
    expect(readPathRejection(process.cwd(), roots)).toContain("不能读取目录本身")
  })

  test("rejects secrets, keys and sensitive directories anywhere in the path", () => {
    const roots = [process.cwd()]
    for (const file of [
      ".env",
      ".env.local",
      "credentials.json",
      "secrets.yml",
      "id_rsa",
      "id_ed25519",
      "server.key",
      "cert.pem",
      "store.p12",
      ".npmrc",
    ]) {
      expect({ file, reason: readPathRejection(join(sandbox, file), roots) }).toEqual({
        file,
        reason: `拒绝读取敏感路径：${file}`,
      })
    }
    for (const dir of [".ssh", ".aws", ".gnupg", ".git", ".kube", ".docker"]) {
      expect(readPathRejection(join(sandbox, dir, "config"), roots)).toContain("拒绝读取敏感路径")
    }
    // Source files whose names merely contain these words stay readable.
    expect(readPathRejection(join(sandbox, "tokenizer.ts"), roots)).toBeUndefined()
    expect(readPathRejection(join(sandbox, "auth_service.ts"), roots)).toBeUndefined()
  })

  test("knownRoots always includes the workspace", () => {
    expect(knownRoots().map((root) => root.replace(/\/$/, ""))).toContain(process.cwd().replace(/\/$/, ""))
  })
})

describe("file_read handler", () => {
  test("reads a file inside the workspace and reports the end", async () => {
    const path = join(sandbox, "hello.txt")
    writeFileSync(path, "Hello world")

    const result = await succeed(runFileRead({ path }, ROUTER))

    expect(result.content).toContain("Hello world")
    expect(result.content).toContain("已到末尾。")
    expect(result.output.text).toBe(result.content)
  })

  test("pages by character range with a capped limit", async () => {
    const path = join(sandbox, "digits.txt")
    writeFileSync(path, "0123456789abcdefghij")
    expect(FILE_READ_MAX_LIMIT).toBeGreaterThanOrEqual(20_000)

    const result = await succeed(runFileRead({ path, offset: 5, limit: 4 }, ROUTER))

    expect(result.content).toContain("5678")
    expect(result.content).toContain("offset: 9")
    expect(result.content).not.toContain("已到末尾。")
  })

  test("refuses secrets and out-of-root files before reading them", async () => {
    const env = join(sandbox, ".env")
    writeFileSync(env, "SECRET=do-not-leak")
    expect(await failure(runFileRead({ path: env }, ROUTER))).toContain("拒绝读取敏感路径")
    expect(await failure(runFileRead({ path: "/etc/passwd" }, ROUTER))).toContain("不在工作区")
  })

  test("refuses a symlink that escapes the allowed roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fr-secret-"))
    try {
      const target = join(outside, "secret.txt")
      writeFileSync(target, "outside secret")
      const link = join(sandbox, "link.txt")
      symlinkSync(target, link)

      const message = await failure(runFileRead({ path: link }, ROUTER))
      expect(message).toContain("符号链接指向受限路径")
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("a non-router caller is refused", async () => {
    const path = join(sandbox, "hello.txt")
    writeFileSync(path, "Hello world")
    const message = await failure(runFileRead({ path }, WORKER))
    expect(message).toContain("only available to the router session")
  })

  test("offset beyond the file length is refused", async () => {
    const path = join(sandbox, "short.txt")
    writeFileSync(path, "abc")
    expect(await failure(runFileRead({ path, offset: 99 }, ROUTER))).toContain("超出文件长度")
  })
})

describe("file_read registration and catalog", () => {
  test("file_read is a router-only catalog tool with an allowed permission", () => {
    expect(ROUTER_TOOLS.has("file_read")).toBe(true)
    expect(toolPermission(specFor("file_read"))).toBe("status")
    const worker: WorkerRecord = {
      sessionID: WORKER,
      threadID: "thread:1",
      threads: ["thread:1"],
      state: "running",
      createdAt: 1,
    }
    store.workers.set(WORKER, worker)
    const routerTools = { file_read: {}, status: {} }
    filterSessionTools(ROUTER, routerTools)
    expect(Object.keys(routerTools)).toEqual(["file_read", "status"])
    const workerTools = { file_read: {}, read: {} }
    filterSessionTools(WORKER, workerTools)
    expect(Object.keys(workerTools)).toEqual(["read"])
  })

  test("registration uses the catalog description and permission action", async () => {
    const registered: Array<{ name: string; description: string; options?: { permission?: string } }> = []
    const editor = { add: (tool: (typeof registered)[number]) => registered.push(tool) }
    const ctx = {
      tool: { transform: (fn: (target: typeof editor) => void) => Effect.sync(() => fn(editor)) },
    } as unknown as Plugin.Context
    await Effect.runPromise(Effect.scoped(registerFileRead(ctx)))
    expect(registered.map((tool) => tool.name)).toEqual(["file_read"])
    expect(registered[0]?.options?.permission).toBe("status")
    expect(registered[0]?.description).toBe(specFor("file_read").description)
  })
})
