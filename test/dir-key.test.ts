import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_DIR_KEY, dirKeyOf } from "../src/dirs.js"

/**
 * `dirKeyOf` 是「一目录一实例」的分区 key：同一个目录必须永远得到同一个 key
 * （重启、写法差异、符号链接都不能分家），不同目录必须得到不同 key（不能因为
 * basename 相同或只差大小写而共用一个分区），并且结果必须是 KV 安全字符串。
 */

const ROOT = mkdtempSync(join(tmpdir(), "superagent-dirkey-"))

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** 所有分区 key 的共同形状：只含 `[a-z0-9-]`，即 KV key 里没有 `/`、`:`、空白。 */
const KEY_SHAPE = /^[a-z0-9-]+$/

function expectSafeKey(key: string): void {
  expect(key).toMatch(KEY_SHAPE)
  expect(key).not.toContain("/")
  expect(key).not.toContain("\\")
  expect(key).not.toContain(":")
  expect(key).not.toContain(" ")
}

describe("dirKeyOf: normalization", () => {
  test("trailing separators do not create a second partition", () => {
    const base = dirKeyOf("/opt/app")
    expect(dirKeyOf("/opt/app/")).toBe(base)
    expect(dirKeyOf("/opt/app//")).toBe(base)
    expect(dirKeyOf("  /opt/app  ")).toBe(base)
    expectSafeKey(base)
  })

  test("default key for empty, undefined and non-absolute input", () => {
    expect(dirKeyOf(undefined)).toBe(DEFAULT_DIR_KEY)
    expect(dirKeyOf("")).toBe(DEFAULT_DIR_KEY)
    expect(dirKeyOf("   ")).toBe(DEFAULT_DIR_KEY)
    // 相对路径无法定位唯一目录，一律归默认分区，调用方不需要自己判断。
    expect(dirKeyOf("app")).toBe(DEFAULT_DIR_KEY)
    expect(dirKeyOf("./app")).toBe(DEFAULT_DIR_KEY)
    expect(dirKeyOf("../app")).toBe(DEFAULT_DIR_KEY)
    expect(dirKeyOf("C:relative")).toBe(DEFAULT_DIR_KEY)
  })

  test("case differences stay distinct (case-sensitive filesystems)", () => {
    const upper = dirKeyOf("/opt/App")
    const lower = dirKeyOf("/opt/app")
    expect(upper).not.toBe(lower)
    // slug 只做可读性，大小写不影响它；唯一性由 hash 负责。
    expect(upper.split("-").slice(0, -1).join("-")).toBe(lower.split("-").slice(0, -1).join("-"))
    expectSafeKey(upper)
    expectSafeKey(lower)
  })

  test("Windows drive forms and the MSYS form collapse to one key", () => {
    const expected = dirKeyOf("C:\\work\\app")
    expect(dirKeyOf("C:/work/app")).toBe(expected)
    expect(dirKeyOf("c:/work/app/")).toBe(expected)
    expect(dirKeyOf("/c/work/app")).toBe(expected)
    expectSafeKey(expected)
  })

  test("Windows paths do not collide with POSIX paths of the same basename", () => {
    expect(dirKeyOf("C:\\work\\app")).not.toBe(dirKeyOf("/work/app"))
    expect(dirKeyOf("C:\\work\\app")).not.toBe(dirKeyOf("D:\\work\\app"))
  })

  test("same basename on different parents never collides", () => {
    const keys = ["/opt/app", "/srv/app", "/opt/app/v2", "C:\\app", "/订单/app"].map((dir) => dirKeyOf(dir))
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expectSafeKey(key)
  })

  test("a symlink shares the partition of its target", () => {
    mkdirSync(join(ROOT, "target"), { recursive: true })
    symlinkSync(join(ROOT, "target"), join(ROOT, "link"), "dir")
    const target = dirKeyOf(join(ROOT, "target"))
    expect(dirKeyOf(join(ROOT, "link"))).toBe(target)
    expect(dirKeyOf(`${join(ROOT, "link")}/`)).toBe(target)
    expectSafeKey(target)
  })

  test("a directory that does not exist still gets a stable key", () => {
    const missing = join(ROOT, "not-created", "deeper")
    expect(dirKeyOf(missing)).toBe(dirKeyOf(missing))
    expectSafeKey(dirKeyOf(missing))
  })

  test("the root directory and very long paths stay KV-safe", () => {
    const root = dirKeyOf("/")
    expect(root).toStartWith("dir-")
    const long = `/${"segment/".repeat(60)}end`
    const key = dirKeyOf(long)
    expect(key.length).toBeLessThanOrEqual(40 + 1 + 8)
    expectSafeKey(key)
  })
})
