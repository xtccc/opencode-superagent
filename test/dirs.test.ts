import type { Plugin } from "@opencode/plugin/effect"
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Exit, type Schema } from "effect"
import {
  ALIAS_LIMIT,
  ALIAS_SUMMARY_LIMIT,
  DIRECTORY_ERROR,
  aliasConflicts,
  aliasDirs,
  basenameAlias,
  canonicalDirectory,
  directoryError,
  directorySummary,
  isValidDirectory,
  matchesAlias,
  normalizeDirectory,
  registerAlias,
  rememberAlias,
  resolveDirectory,
  threadDirs,
} from "../src/dirs.js"
import { runDispatch } from "../src/dispatch.js"
import { store } from "../src/state.js"
import { createTicket, resetTickets, validateCreateInput } from "../src/ticket.js"

const ROUTER = "ses_router"
const THREAD = "telegram:42"

beforeEach(() => {
  threadDirs.clear()
  aliasDirs.clear()
  aliasConflicts.clear()
  resetTickets()
  store.routerID = ROUTER
  store.routerBusy = false
  store.workers.clear()
  store.threads.clear()
})

// ── absolute path validation: POSIX ──────────────────────────────────────────

describe("isValidDirectory: POSIX absolute paths", () => {
  test("accepts POSIX absolute paths", () => {
    for (const dir of ["/opt/app", "/", "/home/me/project", "/srv/data-1"]) {
      expect(isValidDirectory(dir)).toBe(true)
    }
  })

  test("rejects relative paths and junk", () => {
    for (const dir of ["", "   ", ".", "..", "./app", "app", "relative/path", "~/app", "C:", "C:relative", "\\work"]) {
      expect(isValidDirectory(dir)).toBe(false)
      expect(normalizeDirectory(dir)).toBeUndefined()
    }
  })

  test("rejects over-long paths and control characters", () => {
    expect(isValidDirectory(`/${"a".repeat(600)}`)).toBe(false)
    expect(isValidDirectory("/opt/ap\u0000p")).toBe(false)
    expect(isValidDirectory("/opt/ap\np")).toBe(false)
  })

  test("strips trailing separators but keeps the root", () => {
    expect(normalizeDirectory("/opt/app/")).toBe("/opt/app")
    expect(normalizeDirectory("/opt/app//")).toBe("/opt/app")
    expect(normalizeDirectory("/")).toBe("/")
  })
})

// ── absolute path validation: Windows ────────────────────────────────────────

describe("isValidDirectory: Windows and MSYS paths", () => {
  test("accepts drive-letter paths with either separator", () => {
    for (const dir of ["C:\\work\\app", "C:/work/app", "C:\\", "C:/", "c:\\work\\app", "D:/data"]) {
      expect(isValidDirectory(dir)).toBe(true)
    }
  })

  test("accepts the MSYS /c/ form", () => {
    expect(isValidDirectory("/c/work/app")).toBe(true)
    expect(isValidDirectory("/c/")).toBe(true)
  })

  test("canonicalizes separators, trailing separators and drive-letter case", () => {
    const expected = "C:\\work\\app"
    for (const dir of ["C:\\work\\app", "C:/work/app", "c:\\work\\app", "C:/work/app/", "C:\\work\\app\\\\"]) {
      expect(canonicalDirectory(dir)).toBe(expected)
    }
    expect(canonicalDirectory("/c/work/app")).toBe(expected)
    expect(canonicalDirectory("/c/work/app/")).toBe(expected)
    expect(canonicalDirectory("C:\\")).toBe("C:\\")
    expect(canonicalDirectory("/c/")).toBe("C:\\")
  })

  test("a POSIX-style /c without the second slash is not treated as a drive root", () => {
    expect(canonicalDirectory("/c")).toBe("/c")
  })

  test("does not accept network or drive-relative forms", () => {
    expect(isValidDirectory("\\\\server\\share")).toBe(false)
    expect(isValidDirectory("C:app")).toBe(false)
    expect(isValidDirectory("1:\\app")).toBe(false)
  })

  test("basename alias works across separators and keeps Unicode", () => {
    expect(basenameAlias("/opt/ai-gw")).toBe("ai-gw")
    expect(basenameAlias("C:\\work\\App\\")).toBe("app")
    expect(basenameAlias("/c/work/订单")).toBe("订单")
    expect(basenameAlias("C:\\")).toBe("")
    expect(basenameAlias("relative/app")).toBe("")
  })
})

// ── alias matching ───────────────────────────────────────────────────────────

describe("alias matching", () => {
  test("matches on word boundaries, not substrings", () => {
    expect(matchesAlias("修复 app 的问题", "app")).toBe(true)
    expect(matchesAlias("修复app的问题", "app")).toBe(true)
    expect(matchesAlias("跑一下 app/web 的测试", "app")).toBe(true)
    expect(matchesAlias("Fix the appstore bug", "app")).toBe(false)
    expect(matchesAlias("myapp 崩了", "app")).toBe(false)
    expect(matchesAlias("app_v2 崩了", "app")).toBe(false)
    expect(matchesAlias("app2 崩了", "app")).toBe(false)
  })

  test("resolveDirectory only returns a word-boundary alias hit", () => {
    registerAlias("app", "/opt/app")
    expect(resolveDirectory({ task: "修复 app 的登录" })).toBe("/opt/app")
    expect(resolveDirectory({ task: "fix appstore bug" })).toBeUndefined()
    expect(resolveDirectory({ task: "myapp crashed" })).toBeUndefined()
  })

  test("longer aliases win over their prefixes", () => {
    registerAlias("app", "/opt/app")
    registerAlias("app-web", "/opt/app-web")
    expect(resolveDirectory({ task: "跑 app-web 测试" })).toBe("/opt/app-web")
    expect(resolveDirectory({ task: "跑 app 测试" })).toBe("/opt/app")
  })

  test("Unicode basenames match inside Chinese sentences", () => {
    registerAlias("订单", "C:\\work\\订单")
    expect(resolveDirectory({ task: "修一下订单服务的分页" })).toBe("C:\\work\\订单")
    expect(resolveDirectory({ task: "修一下库存服务的分页" })).toBeUndefined()
  })

  test("explicit and thread-bound directories beat alias matching", () => {
    registerAlias("app", "/opt/app")
    threadDirs.set(THREAD, "/opt/thread")
    expect(resolveDirectory({ task: "fix app", threadID: THREAD })).toBe("/opt/thread")
    expect(resolveDirectory({ task: "fix app", threadID: THREAD, requested: "/opt/explicit" })).toBe("/opt/explicit")
    expect(resolveDirectory({ task: "fix app", requested: "relative" })).toBe("/opt/app")
  })
})

// ── alias conflicts, limits, summary ─────────────────────────────────────────

describe("alias registry", () => {
  test("same basename in a different directory is a conflict, not an overwrite", () => {
    registerAlias("app", "/opt/app")
    registerAlias("app", "/srv/app")
    expect(aliasDirs.get("app")).toBe("/opt/app")
    expect(aliasConflicts.get("app")).toEqual(["/srv/app"])
    // Ambiguous aliases are never resolved automatically.
    expect(resolveDirectory({ task: "fix app" })).toBeUndefined()
  })

  test("the same directory written differently is not a conflict", () => {
    registerAlias("app", "C:\\work\\app")
    registerAlias("app", "c:/work/app/")
    expect(aliasDirs.get("app")).toBe("C:\\work\\app")
    expect(aliasConflicts.size).toBe(0)
    expect(resolveDirectory({ task: "fix app" })).toBe("C:\\work\\app")
  })

  test("a non-conflicting re-registration keeps the alias listed as recent", () => {
    registerAlias("one", "/a/one")
    registerAlias("two", "/a/two")
    registerAlias("one", "/a/one")
    expect([...aliasDirs.keys()]).toEqual(["two", "one"])
  })

  test("the alias table is capped and drops the oldest entry with its conflict record", () => {
    registerAlias("dup", "/first/dup")
    registerAlias("dup", "/second/dup")
    for (let index = 0; index < ALIAS_LIMIT + 3; index += 1) {
      registerAlias(`alias${index}`, `/work/alias${index}`)
    }
    expect(aliasDirs.size).toBe(ALIAS_LIMIT)
    expect(aliasDirs.has("dup")).toBe(false)
    expect(aliasConflicts.has("dup")).toBe(false)
    expect(aliasDirs.has(`alias${ALIAS_LIMIT + 2}`)).toBe(true)
    expect(aliasDirs.has("alias0")).toBe(false)
  })

  test("the status summary shows only the newest aliases plus the folded count", () => {
    for (let index = 0; index < ALIAS_SUMMARY_LIMIT + 4; index += 1) {
      registerAlias(`alias${index}`, `/work/alias${index}`)
    }
    const summary = directorySummary()
    expect(summary).toContain("+4 older")
    expect(summary).toContain(`alias${ALIAS_SUMMARY_LIMIT + 3}=/work/alias${ALIAS_SUMMARY_LIMIT + 3}`)
    expect(summary).not.toContain("alias0=")
  })

  test("a conflicting alias persists the directory memory kept", async () => {
    const ctx = memoryContext()
    await Effect.runPromise(rememberAlias(ctx, "/opt/app"))
    await Effect.runPromise(rememberAlias(ctx, "/srv/app"))
    expect(aliasDirs.get("app")).toBe("/opt/app")
    expect(await Effect.runPromise(ctx.storage.get("dir:alias:app"))).toBe("/opt/app")
  })

  test("the status summary marks conflicts", () => {
    registerAlias("app", "/opt/app")
    registerAlias("app", "/srv/app")
    const summary = directorySummary()
    expect(summary).toContain("conflict:/srv/app")
    expect(summary).toContain("conflicts=1")
  })
})

// ── one rule set for ticket_create and dispatch ─────────────────────────────

const base = {
  threadID: THREAD,
  title: "修复登录日志",
  objective: "登录失败时把用户 id 写进日志",
  acceptance: ["日志含 user id"],
  directory: "/opt/app",
  source: "telegram",
} as const

function memoryContext() {
  const data = new Map<string, Schema.Json>()
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
    get: ({ sessionID }: { sessionID: string }) =>
      Effect.succeed({ id: sessionID, model: undefined, location: { directory: "/opt/app" } }),
    create: (input: { title?: string }) => Effect.succeed({ id: "ses_worker_new", title: input.title }),
    prompt: () => Effect.succeed(undefined),
    interrupt: () => Effect.succeed({ interrupted: true }),
  }
  const agent = { get: () => Effect.succeed({ data: { id: "superagent-worker" } }) }
  return { storage, session, agent, data } as unknown as Plugin.Context
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

describe("ticket_create and dispatch share one directory rule", () => {
  test("both accept a Windows path and both reject a relative one", async () => {
    expect(
      validateCreateInput({ ...base, directory: "C:\\work\\app" }),
    ).toBeUndefined()
    expect(validateCreateInput({ ...base, directory: "work/app" })).toBe(DIRECTORY_ERROR)

    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, { ...base, directory: "C:\\work\\app" }))
    expect(created.ticket.directory).toBe("C:\\work\\app")

    const message = await failure(
      runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id, directory: "work/app" }, ROUTER),
    )
    expect(message).toContain(DIRECTORY_ERROR)
    expect(message).not.toContain("/opt/ai-gw")
  })

  test("dispatch accepts C:/ and /c/ forms of the same directory", async () => {
    const ctx = memoryContext()
    const created = await succeed(createTicket(ctx, base))
    const result = await succeed(
      runDispatch(ctx, { task: "修日志", ticketID: created.ticket.id, directory: "C:/work/app" }, ROUTER),
    )
    expect(String(result.output.sessionID)).toBe("ses_worker_new")
    expect(store.workers.get("ses_worker_new")?.directory).toBe("C:\\work\\app")
    expect(directoryError("/c/work/app")).toBeUndefined()
    expect(directoryError("../work")).toBe(DIRECTORY_ERROR)
  })
})
