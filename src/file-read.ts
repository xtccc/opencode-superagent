import type { Plugin } from "@opencode/plugin/effect"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import {
  aliasDirs,
  DEFAULT_DIR_KEY,
  directoryOfDirKey,
  normalizeDirectory,
  routerDirectoryForPartition,
  threadDirs,
} from "./dirs.js"
import { requireRouter } from "./guard.js"
import { dirKeyForRouter } from "./state.js"
import { specFor, toolPermission } from "./tools.js"

export const FileReadInput = Schema.Struct({
  path: Schema.String,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
})

const FileReadOutput = Schema.Struct({ text: Schema.String })

interface FileReadInput {
  readonly path: string
  readonly offset?: number
  readonly limit?: number
}

/** Character paging, mirroring `report_read` so the Router has one habit to learn. */
export const FILE_READ_DEFAULT_LIMIT = 8_000
export const FILE_READ_MAX_LIMIT = 20_000
/** Files larger than this are refused rather than loaded into the model's context. */
export const FILE_READ_MAX_BYTES = 2_000_000

/**
 * Sensitive path components. A segment is rejected when it matches an exact
 * secret name, a well-known secret prefix (e.g. `.env.local`, `credentials.json`)
 * or a private-key/certificate extension. Keeping this list explicit avoids
 * false positives on source files such as `tokenizer.ts` or `auth_service.ts`.
 */
const SENSITIVE_EXACT = new Set([
  ".env",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  ".netrc",
  ".htpasswd",
  ".git-credentials",
  "authorized_keys",
  "credentials",
  "secrets",
  "secret",
  "password",
  "passwd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
])
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".git", ".kube", ".docker"])
const SENSITIVE_PREFIXES = [
  ".env.",
  "credentials.",
  "credentials-",
  "secrets.",
  "secrets-",
  "secret.",
  "id_rsa.",
  "id_dsa.",
  "id_ecdsa.",
  "id_ed25519.",
]
const SENSITIVE_SUFFIXES = [".key", ".pem", ".p12", ".pfx", ".jks", ".keystore", ".kdbx"]

function sensitiveSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  if (SENSITIVE_DIRS.has(lower) || SENSITIVE_EXACT.has(lower)) return true
  if (SENSITIVE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

function segmentsOf(path: string): Array<string> {
  return path.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".")
}

function within(absolute: string, roots: ReadonlyArray<string>): string | undefined {
  for (const root of roots) {
    const base = resolve(root)
    const rel = relative(base, absolute)
    if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel
  }
  return undefined
}

/**
 * Pure, filesystem-free validation: a rejection reason, or `undefined` when the
 * path is allowed. Resolving `..` before comparing keeps traversal (`/root/../etc`)
 * from sneaking outside the allowed roots, and checking every relative segment
 * catches secrets both at the root and nested inside a project.
 */
export function readPathRejection(path: string, roots: ReadonlyArray<string>): string | undefined {
  const trimmed = path.trim()
  if (trimmed === "") return "path 不能为空"
  if (/\p{Cc}/u.test(trimmed)) return "path 含非法控制字符"
  const absolute = resolve(process.cwd(), trimmed)
  const rel = within(absolute, roots)
  if (rel === undefined) return "path 不在工作区或已知目录内"
  if (rel === "") return "不能读取目录本身"
  for (const segment of segmentsOf(rel)) {
    if (sensitiveSegment(segment)) return `拒绝读取敏感路径：${segment}`
  }
  return undefined
}

/**
 * Allowed read roots: the gateway workspace plus every directory the Router
 * already knows (its own partition, pinned directory, thread bindings and
 * basename aliases). Realpathing collapses symlinks so a link inside a root
 * cannot point at a secret outside it.
 */
export function knownRoots(dirKey: string = DEFAULT_DIR_KEY, cwd: string = process.cwd()): Array<string> {
  const roots = new Map<string, string>()
  const add = (directory: string | undefined) => {
    if (directory === undefined) return
    const canonical = normalizeDirectory(directory)
    if (canonical === undefined) return
    let real = canonical
    try {
      real = realpathSync(canonical)
    } catch {
      // A configured directory may not exist on this host yet; keep the
      // canonical spelling so reads still resolve once it is created.
    }
    roots.set(resolve(real), real)
  }
  add(cwd)
  add(directoryOfDirKey(dirKey))
  add(routerDirectoryForPartition(dirKey))
  for (const directory of aliasDirs.values()) add(directory)
  for (const directory of threadDirs.values()) add(directory)
  return [...roots.values()]
}

/** Page through a text file that lives inside a known root. Router-only. */
export const runFileRead = Effect.fn("superagent.fileRead")(function* (input: FileReadInput, caller: string) {
  yield* requireRouter(caller, "file_read")
  const dirKey = dirKeyForRouter(caller) ?? DEFAULT_DIR_KEY
  const roots = knownRoots(dirKey)

  const reason = readPathRejection(input.path, roots)
  if (reason !== undefined) {
    return yield* new Tool.Error({ message: `file_read: ${reason}；可读范围仅工作区与已知目录，密钥文件一律拒绝。` })
  }

  const absolute = resolve(process.cwd(), input.path.trim())
  let real: string
  try {
    real = realpathSync(absolute)
  } catch {
    return yield* new Tool.Error({ message: `file_read: 文件不存在或不可读：${input.path}` })
  }
  // Symlink escape: the resolved target must itself be an allowed path.
  const realReason = readPathRejection(real, roots)
  if (realReason !== undefined) {
    return yield* new Tool.Error({ message: `file_read: 符号链接指向受限路径（${realReason}）：${input.path}` })
  }
  let size: number
  try {
    const info = statSync(real)
    if (!info.isFile()) {
      return yield* new Tool.Error({ message: `file_read: 只能读取普通文件：${input.path}` })
    }
    size = info.size
  } catch {
    return yield* new Tool.Error({ message: `file_read: 无法读取文件状态：${input.path}` })
  }
  if (size > FILE_READ_MAX_BYTES) {
    return yield* new Tool.Error({
      message: `file_read: 文件 ${size} 字节，超过 ${FILE_READ_MAX_BYTES} 上限；请派 Worker 分段处理。`,
    })
  }
  let text: string
  try {
    text = readFileSync(real, "utf8")
  } catch {
    return yield* new Tool.Error({ message: `file_read: 读取失败（非 UTF-8 文本？）：${input.path}` })
  }

  const rawOffset = input.offset ?? 0
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  if (offset >= text.length) {
    return yield* new Tool.Error({
      message: `file_read: offset ${offset} 超出文件长度 ${text.length}。`,
    })
  }
  const rawLimit = input.limit ?? FILE_READ_DEFAULT_LIMIT
  const limit = Number.isFinite(rawLimit)
    ? Math.min(FILE_READ_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : FILE_READ_DEFAULT_LIMIT
  const end = Math.min(text.length, offset + limit)
  const lines = [
    `file ${input.path.trim()} (${text.length} chars, ${size} bytes) [${offset}, ${end})`,
    "",
    text.slice(offset, end),
  ]
  if (end < text.length) {
    lines.push("", `还有后续：file_read(path: "${input.path.trim()}", offset: ${end})`)
  } else {
    lines.push("", "已到末尾。")
  }
  const output = lines.join("\n")
  return { output: { text: output }, content: output }
})

/** Router-only file reader, registered with the catalog's `status` permission. */
export const registerFileRead = Effect.fn("superagent.registerFileRead")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "file_read",
      description: specFor("file_read").description,
      input: FileReadInput,
      output: FileReadOutput,
      options: { permission: toolPermission(specFor("file_read")) },
      execute: (input, context) => runFileRead(input, context.sessionID),
    })
  })
})
