import type { Plugin } from "@opencode/plugin/effect"
import type { Session } from "@opencode/schema/session"
import { Effect, Option, type Schema } from "effect"
import { HYDRATE_CONCURRENCY, store, toSessionID } from "./state.js"

/**
 * Session identity for the Super-agent prototype.
 *
 * A session's role lives in its durable `metadata.superagent` record, not in
 * its title: the title is user-editable and auto-generated titles are not a
 * contract. Every session this plugin creates writes the metadata at create
 * time, and `hydrateSessionMeta` backfills sessions created before that.
 */
export type SuperagentRole = "router" | "worker"

const WORKER_TITLE_PREFIX = "🔧 worker-"
export const ROUTER_TITLE = "🧭 router-main"

const TITLE_SLUG_MAX = 40
const THREAD_LABEL_MAX = 12

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/** The role recorded in a session's metadata, when the metadata is a Super-agent one. */
export function superagentRole(metadata: unknown): SuperagentRole | undefined {
  if (!isRecord(metadata)) return undefined
  const superagent = metadata["superagent"]
  if (!isRecord(superagent)) return undefined
  const role = superagent["role"]
  return role === "router" || role === "worker" ? role : undefined
}

export function isSuperagentSession(session: { readonly metadata?: unknown }): boolean {
  return superagentRole(session.metadata) !== undefined
}

export function isRouterSession(session: { readonly metadata?: unknown }): boolean {
  return superagentRole(session.metadata) === "router"
}

export function isWorkerSession(session: { readonly metadata?: unknown }): boolean {
  return superagentRole(session.metadata) === "worker"
}

/** The `superagent` metadata entry written at create time. */
export function superagentMetadata(role: SuperagentRole, threads?: ReadonlyArray<string>): Record<string, Schema.Json> {
  return {
    superagent: role === "worker" ? { role, threads: threads === undefined ? [] : [...threads] } : { role },
  } as Record<string, Schema.Json>
}

/**
 * Short label for a thread id: the last `:`-separated segment, so
 * `telegram:123456789` becomes `123456789` and long ids keep their tail.
 */
function threadLabel(threadID: string): string {
  const segment = (threadID.split(":").pop() ?? threadID).trim()
  if (segment === "") return "thread"
  return segment.length > THREAD_LABEL_MAX ? segment.slice(-THREAD_LABEL_MAX) : segment
}

function titleSlug(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim()
  if (clean === "") return "task"
  return clean.length > TITLE_SLUG_MAX ? `${clean.slice(0, TITLE_SLUG_MAX - 1).trimEnd()}…` : clean
}

/**
 * Worker session title. It is convenience only: the session stays
 * identifiable from metadata when a user renames it.
 */
export function workerTitle(input: {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
}): string {
  const subject = titleSlug(input.title ?? input.task.split("\n")[0] ?? "")
  const label = input.threadID === undefined ? subject : `${threadLabel(input.threadID)}-${subject}`
  return `${WORKER_TITLE_PREFIX}${label}`
}

/**
 * Backfill `metadata.superagent` on sessions this plugin already owns (the
 * router id plus every recorded worker) so role detection also covers
 * sessions created before the metadata existed. Idempotent: a session whose
 * role already matches is left untouched, and existing metadata is merged
 * rather than replaced.
 */
export const hydrateSessionMeta = Effect.fn("superagent.hydrateSessionMeta")(function* (ctx: Plugin.Context) {
  const targets: Array<{ sessionID: string; role: SuperagentRole }> = []
  if (store.routerID !== undefined) targets.push({ sessionID: store.routerID, role: "router" })
  for (const worker of store.workers.values()) targets.push({ sessionID: worker.sessionID, role: "worker" })
  // One `session.get` per owned session is unavoidable, but issuing them
  // back-to-back made startup O(n) round trips on top of `hydrate`'s own pass.
  // Read with the same bound, then apply the (rare) backfills in order.
  const current = yield* Effect.forEach(
    targets,
    (target) =>
      ctx.session.get({ sessionID: toSessionID(target.sessionID) }).pipe(
        Effect.option,
        Effect.map((info) => ({ target, info })),
      ),
    { concurrency: HYDRATE_CONCURRENCY },
  )
  for (const { target, info } of current) {
    if (Option.isNone(info)) continue
    const metadata = (info.value as Session.Info).metadata
    if (superagentRole(metadata) === target.role) continue
    const threads = target.role === "worker" ? store.workers.get(target.sessionID)?.threads : undefined
    yield* ctx.session
      .update({
        sessionID: toSessionID(target.sessionID),
        metadata: { ...(metadata ?? {}), ...superagentMetadata(target.role, threads) },
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("superagent failed to backfill session metadata", {
            sessionID: target.sessionID,
            cause,
          }),
        ),
      )
  }
})
