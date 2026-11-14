import { Agent, type Plugin } from "@opencode/plugin/effect"
import type { Model } from "@opencode/schema/model"
import { VariantID } from "@opencode/schema/model"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { WORKER_AGENT } from "./agents.js"
import { DEFAULT_DIR_KEY, directoryError, normalizeDirectory, rememberDirectory, resolveDirectory } from "./dirs.js"
import { DISPATCH_EFFORTS, type DispatchEffort } from "./effort.js"
import { requireRouter } from "./guard.js"
import { superagentMetadata, workerTitle } from "./session-meta.js"
import { partitioningEnabled, maxWorkersPerDirectorySetting, parseWorkerLimit } from "./settings.js"
import {
  detachWorkerThreads,
  dirKeyForRouter,
  dirKeyForWorker,
  dirScopedKey,
  dirState,
  effectiveDirKey,
  encodeThread,
  linkTriggerToWorker,
  routerPartitions,
  saveWorker,
  store,
  threadKey,
  toSessionID,
  totalPending,
  workerKey,
} from "./state.js"
import {
  activeTicketForWorker,
  activeTicketSummary,
  closeTicket,
  currentTrigger,
  linkTicketToWorker,
  requireDispatchTicket,
  ticketStats,
  type Ticket,
} from "./ticket.js"
import { specFor } from "./tools.js"
import { pluginVersion } from "./version.js"
import { isWorkerTerminal, type WorkerRecord } from "./worker-state.js"

/**
 * The effort levels are shared with the tool catalog and the RPC contract
 * (`./effort.ts`); a model advertises the subset it supports in `variants`
 * (`ctx.model.list()`), which is the only whitelist — the server stores an
 * unknown variant instead of rejecting it, so the check happens here.
 */
const DispatchEffortSchema = Schema.Literals(DISPATCH_EFFORTS)

export const DispatchInput = Schema.Struct({
  task: Schema.String,
  title: Schema.optionalKey(Schema.String),
  threadID: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(DispatchEffortSchema),
  directory: Schema.optionalKey(Schema.String),
  ticketID: Schema.String,
})

export const StatusInput = Schema.Struct({
  includeFinished: Schema.optionalKey(Schema.Boolean),
})

const StatusOutput = Schema.Struct({ text: Schema.String })
const DispatchOutput = Schema.Struct({ sessionID: Schema.String })

interface DispatchInput {
  readonly task: string
  readonly title?: string
  readonly threadID?: string
  readonly agent?: string
  readonly effort?: DispatchEffort
  readonly directory?: string
  readonly ticketID: string
}

interface StatusInput {
  readonly includeFinished?: boolean
}

/**
 * Bounds for the `status` tool text. The reply becomes a permanent tool result
 * in the Router history, so it must stay small no matter how many workers the
 * gateway has accumulated: list only live workers by default, cap the optional
 * finished tail, truncate reports, and finally clamp the whole text.
 */
const STATUS_TEXT_LIMIT = 2000
const STATUS_FINISHED_LIMIT = 20
const STATUS_REPORT_LIMIT = 120
const STATUS_LINE_LIMIT = 240
/** Finished rows keep the title short so the report snippet survives the row budget. */
const STATUS_TITLE_LIMIT = 24

export interface StatusOptions {
  /** Also list finished workers (max 20, newest first, reports shortened). */
  readonly includeFinished?: boolean
  /**
   * 调用方 Router 的分区：只统计/列出该目录的 worker 与工单。
   * `undefined`＝进程级视图（TUI/测试），输出与阶段 2a 逐字节一致。
   */
  readonly dirKey?: string
}

/**
 * Tickets with a dispatch currently in flight in this process. `runDispatch`
 * checks and inserts in one synchronous block, so two concurrent dispatches of
 * the same ticket cannot both pass: the loser fails with an explicit error
 * instead of creating a second worker session. The claim is released on
 * success, failure and interruption via `Effect.ensuring`.
 *
 * The set lives on `globalThis` for the same reason `store` does: the host may
 * load two copies of this plugin (two install paths for one version, or a
 * re-reconciliation), and a module-level set would let each copy claim the
 * same ticket, dispatching two workers for one work order. `Symbol.for` gives
 * both copies the same registry within a process.
 */
const IN_FLIGHT_KEY = Symbol.for("opencode-superagent.inflight-tickets.v1")

type GlobalWithInFlight = typeof globalThis & { [IN_FLIGHT_KEY]?: Set<string> }

const inflightGlobals = globalThis as GlobalWithInFlight

const inFlightTickets: Set<string> = inflightGlobals[IN_FLIGHT_KEY] ?? new Set<string>()

inflightGlobals[IN_FLIGHT_KEY] = inFlightTickets

/** Synchronous check-and-claim: only the first caller for a ticket gets `true`. */
function claimDispatch(ticketID: string): boolean {
  if (inFlightTickets.has(ticketID)) return false
  inFlightTickets.add(ticketID)
  return true
}

function releaseDispatch(ticketID: string): void {
  inFlightTickets.delete(ticketID)
}

/**
 * Per-directory worker slots (`maxWorkersPerDirectory`).
 *
 * The slot is taken in the same synchronous block as the ticket claim, before
 * any `Effect` step (agent lookup, `sessions.create`), so two concurrent
 * dispatches into one directory cannot both observe "one free slot" and
 * oversell it. The slot is released on success, failure and interruption via
 * `Effect.ensuring`, exactly like the claim. Default (`0`) is unlimited, so
 * the flag-off path behaves as before.
 */
const SLOTS_KEY = Symbol.for("opencode-superagent.dir-slots.v1")

type GlobalWithSlots = typeof globalThis & { [SLOTS_KEY]?: Map<string, number> }

const slotGlobals = globalThis as GlobalWithSlots

const reservedSlots: Map<string, number> = slotGlobals[SLOTS_KEY] ?? new Map<string, number>()

slotGlobals[SLOTS_KEY] = reservedSlots

/** Configured cap for one directory; non-positive/absent means unlimited. */
export function maxWorkersPerDirectory(ctx: Plugin.Context): number {
  // `options` is optional in every test/older host context: an absent cap means
  // "unlimited", never a crash. The process-wide mirror (set by `applySettings`)
  // is the fallback so a caller holding a context without options still sees the
  // configured limit.
  const options = (ctx as { options?: Readonly<Record<string, unknown>> }).options
  const fromContext = parseWorkerLimit(options?.["maxWorkersPerDirectory"])
  return fromContext > 0 ? fromContext : maxWorkersPerDirectorySetting()
}

/** Live (non-terminal) workers owned by one partition. */
function partitionWorkerCount(dirKey: string): number {
  let live = 0
  for (const worker of store.workers.values()) {
    if (isWorkerTerminal(worker.state)) continue
    if (dirKeyForWorker(worker) === dirKey) live += 1
  }
  return live
}

/** Synchronous check-and-reserve; only the caller that gets `true` may create a worker. */
function reserveWorkerSlot(dirKey: string, limit: number): boolean {
  const used = partitionWorkerCount(dirKey) + (reservedSlots.get(dirKey) ?? 0)
  if (used >= limit) return false
  reservedSlots.set(dirKey, (reservedSlots.get(dirKey) ?? 0) + 1)
  return true
}

function releaseWorkerSlot(dirKey: string): void {
  const next = (reservedSlots.get(dirKey) ?? 0) - 1
  if (next <= 0) reservedSlots.delete(dirKey)
  else reservedSlots.set(dirKey, next)
}

/** Test hook: slots currently reserved per partition. */
export function reservedSlotCount(dirKey: string): number {
  return reservedSlots.get(dirKey) ?? 0
}

/** The ticket header a worker sees first: objective and acceptance, verbatim. */
function ticketHeader(ticket: Ticket): string {
  const acceptance = ticket.acceptance.map((item, index) => `${index + 1}. ${item}`).join("\n")
  return `工单 ${ticket.id}: ${ticket.objective}\n验收:\n${acceptance}\n`
}

function workerPrompt(threadID: string, title: string | undefined, task: string, ticket: Ticket): string {
  const subject = title === undefined ? "" : `Title: ${title}\n`
  return `${ticketHeader(ticket)}Thread: ${threadID}\n${subject}Task:\n${task}\n\nEnd with a short report: what changed, how it was verified, remaining risks.`
}

/**
 * Compact status text for the `status` tool and its diagnostics readers.
 * Starts with the plugin version so a stale gateway (code upgraded but not
 * restarted) is visible from the first line instead of guessed from behavior.
 *
 * Only live workers are listed by default: finished records keep their
 * `lastReport`, and emitting all of them used to produce >12k characters that
 * stayed in the Router history forever. `includeFinished` opts into a bounded
 * tail of finished workers with shortened reports.
 */
export function statusText(options: StatusOptions = {}): string {
  // A partitioned status shows its own directory only; `undefined` keeps the
  // process-wide view (byte-identical to stage 2a with the flag off).
  const scope = options.dirKey === undefined ? undefined : effectiveDirKey(options.dirKey)
  const stats = ticketStats(scope)
  const activeTickets = activeTicketSummary(undefined, 5, scope)
  const all = [...store.workers.values()]
  const workers = scope === undefined ? all : all.filter((worker) => dirKeyForWorker(worker) === scope)
  const live = workers.filter((worker) => !isWorkerTerminal(worker.state))
  const finished = workers.filter((worker) => isWorkerTerminal(worker.state))
  // A partitioned status reports its own queue depth; the process-wide view
  // (TUI/tests) keeps summing every partition, which is the pre-2b number.
  const pending = scope === undefined ? totalPending() : dirState(store, scope).pending.length
  const lines = [
    `superagent ${pluginVersion()} — restart the gateway after upgrading (no hot reload)`,
    `router: ${routerSummary()} pending: ${pending} workers=${workers.length} active=${live.length} tickets: open=${stats.open} in_progress=${stats.inProgress} blocked=${stats.blocked} closed=${stats.closed}`,
  ]
  // Only when directory partitioning is switched on: with the default `false`
  // this reply stays byte-identical to the pre-partition format.
  if (partitioningEnabled()) {
    const partitions = routerPartitions()
    const detail =
      partitions.length > 0 && store.dirs.size > 1
        ? ` [${partitions.map((entry) => `${entry.dirKey}=${entry.routerID}`).join(", ")}]`
        : ""
    lines.push(`directories: ${store.dirs.size} partition(s) active=${store.dirKey}${detail}`)
  }
  if (activeTickets !== "") lines.push(`active tickets: ${activeTickets}`)
  // Only shown when startup actually dropped something: a replayed trigger that
  // outlived its TTL is invisible otherwise, and the Router would wonder why the
  // thread it remembers never got an answer.
  const dropped = store.pendingDropped ?? 0
  if (dropped > 0) lines.push(`dropped ${dropped} expired pending trigger(s) at startup`)
  if (live.length === 0) lines.push("- (no active workers)")
  for (const worker of live) lines.push(liveWorkerLine(worker))
  if (options.includeFinished === true) {
    const recent = [...finished].sort((a, b) => lastSeen(b) - lastSeen(a))
    const shown = recent.slice(0, STATUS_FINISHED_LIMIT)
    const hidden = recent.length - shown.length
    // Share what the header leaves over between the rows that will be shown, so
    // the 20-row window survives the overall char cap instead of being cut by it.
    const reserved = hidden > 0 ? 40 : 0
    const available = STATUS_TEXT_LIMIT - lines.join("\n").length - reserved
    const perRow = Math.max(
      40,
      Math.min(STATUS_LINE_LIMIT, Math.floor(available / Math.max(1, shown.length)) - 1),
    )
    for (const worker of shown) lines.push(finishedWorkerLine(worker, perRow))
    if (hidden > 0) lines.push(`... ${hidden} more finished worker(s)`)
  } else if (finished.length > 0) {
    lines.push(`... ${finished.length} finished worker(s) hidden (pass includeFinished=true to list up to ${STATUS_FINISHED_LIMIT})`)
  }
  return clampStatus(lines)
}

/** Router column of the status line: one id with the switch off, per-partition ids with it on. */
function routerSummary(): string {
  if (!partitioningEnabled()) return store.routerID ?? "none"
  const entries = routerPartitions().map((entry) => `${entry.dirKey}=${entry.routerID}`)
  return entries.length === 0 ? "none" : entries.join(",")
}

/** Live worker row: where it runs and which threads it serves; never its report. */
function liveWorkerLine(worker: WorkerRecord): string {
  const id = worker.sessionID
  const title = worker.title ?? "-"
  const threads = worker.threads.length === 0 ? "-" : worker.threads.join(",")
  const dir = worker.directory ?? "-"
  return clip(`- ${id} ${title} [${threads}] ${worker.state} dir=${dir}`, STATUS_LINE_LIMIT)
}

/**
 * Finished worker row: no threads/directory, so the report snippet gets the
 * space instead. Reports sit at the end, so a tight per-row budget cuts the
 * report, never the identity of the row.
 */
function finishedWorkerLine(worker: WorkerRecord, limit: number): string {
  const id = worker.sessionID
  const title = clip(worker.title ?? "-", STATUS_TITLE_LIMIT)
  const report = clip((worker.lastReport ?? "-").replace(/\s+/g, " "), STATUS_REPORT_LIMIT)
  return clip(`- ${id} ${worker.state} ${title} report=${report}`, limit)
}

/** Slice by code point, so a tightened budget never splits an emoji or surrogate pair. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : [...text].slice(0, limit).join("")
}

/** Timestamp used to show the newest finished workers first. */
function lastSeen(worker: WorkerRecord): number {
  return worker.updatedAt ?? worker.createdAt
}

/** Hard cap on the whole reply; the marker line is reserved before it is needed. */
function clampStatus(lines: ReadonlyArray<string>): string {
  const text = lines.join("\n")
  if (text.length <= STATUS_TEXT_LIMIT) return text
  const marker = "... truncated"
  const kept: Array<string> = []
  let used = 0
  for (const line of lines) {
    const cost = (kept.length === 0 ? 0 : 1) + line.length
    if (used + cost + 1 + marker.length > STATUS_TEXT_LIMIT) break
    kept.push(line)
    used += cost
  }
  kept.push(marker)
  return kept.join("\n")
}

/**
 * Undo a half-created dispatch: fail the ticket bound to the worker, detach
 * the worker from its thread affinity lists, forget the worker record and stop
 * its session. Every step is best-effort after the first failure, so one
 * storage problem cannot leave the whole dispatch half-rolled-back.
 */
const rollbackDispatch = Effect.fn("superagent.rollbackDispatch")(function* (
  ctx: Plugin.Context,
  sessionID: string,
  reason: string,
) {
  // Fail the ticket while the worker → ticket edge still exists, so the
  // Router sees why the dispatch never started instead of a stuck in_progress.
  // The worker record is the only thing that knows the partition here; a
  // rollback must never close another directory's ticket.
  const worker = store.workers.get(sessionID)
  const rollbackDirKey = worker === undefined ? undefined : dirKeyForWorker(worker)
  const ticket = activeTicketForWorker(sessionID)
  if (ticket !== undefined) {
    yield* closeTicket(ctx, {
      ticketID: ticket.id,
      outcome: "failed",
      summary: `dispatch rollback: ${reason}`,
      ...(rollbackDirKey === undefined ? {} : { dirKey: rollbackDirKey }),
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to fail ticket for rolled-back worker", {
          sessionID,
          ticketID: ticket.id,
          cause,
        }),
      ),
    )
  }
  // Thread affinity is written before the prompt; drop the worker from every
  // list it was added to so the thread falls back to the Router. The list lives
  // in the worker's own partition, so a rollback never edits another directory.
  if (worker !== undefined) {
    yield* detachWorkerThreads(ctx, sessionID, worker.threads, dirKeyForWorker(worker))
  }
  store.workers.delete(sessionID)
  yield* ctx.storage
    .remove(workerKey(sessionID))
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to remove rolled-back worker", { sessionID, cause }),
      ),
    )
  yield* ctx.session
    .interrupt({ sessionID: toSessionID(sessionID) })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning("superagent failed to interrupt rolled-back worker", { sessionID, cause }),
      ),
    )
})

/**
 * Structural model reference, taken from the published schema type so the
 * branded ids of `sessions.get` narrow into it and `sessions.create` accepts it.
 */
type ModelRef = Model.Ref

/**
 * The catalog subset used for effort resolution. Both entry points are
 * optional on purpose: tests and older hosts may not expose `ctx.model`, and a
 * missing catalog must degrade, never block a dispatch.
 */
interface ModelCatalog {
  readonly list?: (input?: {
    readonly location?: { readonly directory?: string }
  }) => Effect.Effect<{ readonly data: ReadonlyArray<Model.Info> }, unknown>
  readonly default?: (input?: {
    readonly location?: { readonly directory?: string }
  }) => Effect.Effect<{ readonly data: Model.Info | undefined }, unknown>
}

function catalogOf(ctx: Plugin.Context): ModelCatalog | undefined {
  return (ctx as unknown as { readonly model?: ModelCatalog }).model
}

const locationInput = (directory: string | undefined) =>
  directory === undefined ? undefined : { location: { directory } }

/** Variants the catalog advertises for one model, or `undefined` when it cannot tell. */
function modelVariants(
  ctx: Plugin.Context,
  model: ModelRef,
  directory: string | undefined,
): Effect.Effect<ReadonlyArray<string> | undefined> {
  return Effect.suspend(() => {
    const list = catalogOf(ctx)?.list
    if (list === undefined) return Effect.succeed(undefined)
    return list(locationInput(directory)).pipe(
      Effect.map((output) =>
        output.data
          .find((entry) => entry.providerID === model.providerID && entry.id === model.id)
          ?.variants.map((variant) => String(variant.id)),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("superagent model catalog unavailable; keeping the inherited effort", {
          model: `${model.providerID}/${model.id}`,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("superagent model catalog threw; keeping the inherited effort", {
          model: `${model.providerID}/${model.id}`,
          defect,
        }).pipe(Effect.as(undefined)),
      ),
    )
  })
}

/** The catalog's default model for a directory, used when the router has no explicit one. */
const defaultModelRef = (
  ctx: Plugin.Context,
  directory: string | undefined,
): Effect.Effect<ModelRef | undefined> =>
  Effect.suspend(() => {
    const fallback = catalogOf(ctx)?.default
    if (fallback === undefined) return Effect.succeed(undefined)
    return fallback(locationInput(directory)).pipe(
      Effect.map((output) =>
        output.data === undefined
          ? undefined
          : { providerID: output.data.providerID, id: output.data.id },
      ),
      Effect.catch((cause) =>
        Effect.logWarning("superagent default model unavailable; keeping the inherited effort", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("superagent default model threw; keeping the inherited effort", { defect }).pipe(
          Effect.as(undefined),
        ),
      ),
    )
  })

interface EffortResolution {
  /** Model to create the worker with; `undefined` keeps the inherited resolution. */
  readonly model: ModelRef | undefined
  /** What the ticket records for this dispatch: the applied effort, or why it was not. */
  readonly note: string | undefined
}

/**
 * Turn the requested effort into the worker's `model.variant`.
 *
 * `ctx.model.list()` is the whitelist: every model advertises its `variants`,
 * and the server silently stores an unknown variant, so a value that is not in
 * the list is rejected here instead of becoming a broken session model.
 *
 * A catalog failure degrades to the inherited model (logged, not fatal): a
 * dispatch must not be blocked because model discovery hiccuped. The ticket
 * note keeps that visible as `<effort> (unverified)`, so the history never
 * claims an effort that was not applied.
 */
const resolveEffortModel = Effect.fn("superagent.resolveEffortModel")(function* (
  ctx: Plugin.Context,
  input: {
    readonly effort: DispatchEffort
    readonly base: ModelRef | undefined
    readonly directory: string | undefined
  },
) {
  const effort = input.effort
  const target = input.base ?? (yield* defaultModelRef(ctx, input.directory))
  if (target === undefined) {
    yield* Effect.logWarning("superagent cannot resolve a model for the requested effort; inheriting", {
      effort,
    })
    return { model: undefined, note: `${effort} (unresolved: inherited)` }
  }
  const variants = yield* modelVariants(ctx, target, input.directory)
  if (variants === undefined) {
    // Catalog failure degrades to the inherited model: keep whatever the worker
    // would have inherited rather than downgrading it to the default resolution.
    return { model: input.base, note: `${effort} (unverified: inherited)` }
  }
  if (!variants.includes(effort)) {
    const available = variants.length === 0 ? "none (this model has no reasoning variants)" : variants.join(", ")
    return yield* new Tool.Error({
      message: `dispatch: effort ${effort} is not available for ${target.providerID}/${target.id}; available: ${available}; omit effort to inherit the router's current effort`,
    })
  }
  return { model: { providerID: target.providerID, id: target.id, variant: VariantID.make(effort) }, note: effort }
})

/**
 * The one dispatch implementation, shared by the `dispatch` tool and the
 * `dispatch` RPC. Both paths pass the same ticket gate: `ticketID` is required
 * by the schema and re-checked here, so a direct RPC call cannot skip the
 * work order either.
 *
 * There is deliberately no `internal` bypass: no watchdog/resume path calls
 * dispatch today (the watchdog reports to the Router and resume prompts an
 * existing worker session), so every caller of this function is a real task
 * dispatch and must be backed by a ticket.
 */
export const runDispatch = Effect.fn("superagent.dispatch")(function* (
  ctx: Plugin.Context,
  input: DispatchInput,
  caller: string,
) {
  // The caller must be a router; `callerDirKey` is the partition it owns.
  const callerDirKey = yield* requireRouter(caller, "dispatch")
  const routerID = caller
  // Every dispatch is backed by a ticket: the gate refuses a missing ticket,
  // an unknown/closed one, a thread mismatch and a ticket whose worker is
  // still running, so no dispatch can bypass the work-order record.
  // `callerDirKey` also scopes the gate: a Router only dispatches work orders
  // of its own partition. The **directory** is irrelevant here — a worker may
  // be dispatched into any directory, and the ticket keeps its owner.
  const ticket = yield* requireDispatchTicket(input.ticketID, input.threadID, callerDirKey)
  // Claim the ticket synchronously before any further dispatch step. Check
  // and insert happen in one uninterrupted block, so two concurrent calls can
  // never both see the ticket as free and race into `sessions.create`; the
  // loser gets an explicit error instead of a second worker.
  if (!claimDispatch(ticket.id)) {
    return yield* new Tool.Error({ message: `dispatch already in progress for ticket ${ticket.id}` })
  }
  // Per-directory cap, taken in the same synchronous block as the claim so two
  // dispatches cannot both pass the last free slot.
  const limit = maxWorkersPerDirectory(ctx)
  if (limit > 0 && !reserveWorkerSlot(callerDirKey, limit)) {
    // Report both numbers: the configured cap and what is actually occupying
    // the partition (live workers + dispatches already holding a slot).
    const running = partitionWorkerCount(callerDirKey) + reservedSlotCount(callerDirKey)
    releaseDispatch(ticket.id)
    return yield* new Tool.Error({
      message: `dispatch: directory partition ${callerDirKey} already has ${running} live worker(s) (maxWorkersPerDirectory=${limit}); wait for one to finish, abort_session it, or raise the option`,
    })
  }
  return yield* completeDispatch(ctx, input, routerID, ticket, callerDirKey).pipe(
    // Success, failure and interruption all release the claim and the slot.
    Effect.ensuring(
      Effect.sync(() => {
        releaseDispatch(ticket.id)
        if (limit > 0) releaseWorkerSlot(callerDirKey)
      }),
    ),
  )
})

/**
 * Body of a dispatch that already owns the ticket claim. `runDispatch` is the
 * only caller and releases the claim on every exit path.
 */
const completeDispatch = Effect.fn("superagent.dispatchClaimed")(function* (
  ctx: Plugin.Context,
  input: DispatchInput,
  routerID: string,
  ticket: Ticket,
  dirKey: string = DEFAULT_DIR_KEY,
) {
  const agents = ctx.agent
  const sessions = ctx.session
  const requested = input.agent ?? WORKER_AGENT
  // Same validation as ticket_create: one rule set, one message, no example
  // directory that only exists on some machines.
  const directoryFailure = input.directory === undefined ? undefined : directoryError(input.directory)
  if (directoryFailure !== undefined) {
    return yield* new Tool.Error({ message: `dispatch: ${directoryFailure}` })
  }
  // The ticket carries its thread; the dispatch must agree with it and
  // inherits it when the call omits one.
  const threadID = input.threadID ?? ticket.threadID
  const agentResolved = yield* agents.get({ agentID: Agent.ID.make(requested) }).pipe(
    Effect.map((result) => result.data.id),
    Effect.catch((cause) =>
      Effect.logWarning("superagent worker agent missing, creating session without it", {
        agent: requested,
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  )
  // Mirror the router session's explicit model so the worker resolves the
  // same model. When the router has no explicit model (default resolution),
  // pass nothing so the worker follows the same default resolution.
  // An explicitly requested agent keeps its own model priority: no override.
  const routerInherit = yield* sessions.get({ sessionID: toSessionID(routerID) }).pipe(
    Effect.map((info) => ({ model: info.model, directory: info.location.directory })),
    Effect.catch((cause) =>
      Effect.logWarning("superagent router model unavailable, creating worker without it", {
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  )
  const routerModel = routerInherit?.model
  const routerDirectory = routerInherit?.directory
  // Single gateway, Router-managed directories: explicit directory wins,
  // otherwise the ticket's working directory, then thread binding / alias
  // match, otherwise follow Router. The gateway process directory itself is
  // irrelevant. Any of these may name a directory outside the caller's own
  // partition: the worker runs there, but it is owned by the dispatching
  // Router (`ownerDirKey`), so its report comes back here.
  const requestedDir = input.directory === undefined ? undefined : normalizeDirectory(input.directory)
  const ticketDir = ticket.directory === undefined ? undefined : normalizeDirectory(ticket.directory)
  const rememberedDir = resolveDirectory({
    threadID,
    task: input.task,
    requested: requestedDir ?? ticketDir,
  })
  const targetDirectory = rememberedDir ?? routerDirectory
  // An explicit agent keeps its own model priority, so there is no model to
  // attach a variant to: refuse instead of silently dropping the effort.
  if (input.effort !== undefined && input.agent !== undefined) {
    return yield* new Tool.Error({
      message:
        "dispatch: effort cannot be combined with an explicit agent override — the agent keeps its own model. Omit agent to set effort, or omit effort to run the agent's own effort.",
    })
  }
  const inheritedModel = input.agent === undefined ? routerModel : undefined
  // No effort: the worker inherits the router model exactly as before. With an
  // effort: the model reference gains `variant`, after the catalog whitelist
  // check in `resolveEffortModel`.
  const resolved: EffortResolution =
    input.effort === undefined
      ? { model: inheritedModel, note: undefined }
      : yield* resolveEffortModel(ctx, {
          effort: input.effort,
          base: inheritedModel,
          directory: targetDirectory,
        })
  const threads = [threadID]
  const current = currentTrigger(dirKey)
  const authorizing =
    current !== undefined && current.threadID === threadID ? current.id : ticket.authorization.triggerID
  const triggerID = authorizing === "" || authorizing === "unknown" ? undefined : authorizing
  const created = yield* sessions
    .create({
      // The prefix keeps workers recognizable in session lists; metadata, not
      // this title, is what identifies the session after a user rename.
      title: workerTitle({
        task: input.task,
        ...(input.title === undefined ? {} : { title: input.title }),
        threadID,
      }),
      ...(agentResolved === undefined ? {} : { agent: agentResolved }),
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      ...(targetDirectory === undefined ? {} : { location: { directory: AbsolutePath.make(targetDirectory) } }),
      metadata: superagentMetadata("worker", threads),
    })
    .pipe(Effect.mapError((cause) => new Tool.Error({ message: `failed to create worker session: ${String(cause)}` })))
  const record = {
    sessionID: created.id,
    title: created.title ?? input.title,
    // Forward edges: worker → primary thread and worker → authorizing trigger.
    // The ticket's authorization is the trigger that created the work order;
    // a newer router trigger on the same thread wins because it is the one
    // that actually asked for this dispatch.
    threadID,
    ...(triggerID === undefined ? {} : { triggerID }),
    threads,
    state: "running" as const,
    createdAt: Date.now(),
    ...(targetDirectory === undefined ? {} : { directory: targetDirectory }),
    // Ownership: the dispatching Router's partition. `directory` above is only
    // where the session runs; completion/stall/wake notices follow this key.
    ownerDirKey: dirKey,
  }
  store.workers.set(created.id, record)
  yield* saveWorker(ctx, record)
  // Complete the reverse edge (trigger → worker) so the dispatch can be traced
  // from the message that caused it. A missing trigger is not an error: the
  // ticket remains the durable record in that case. The trigger lives in the
  // caller's partition, so the edge must be written there.
  if (triggerID !== undefined) {
    yield* linkTriggerToWorker(ctx, triggerID, created.id, dirKey).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent failed to link trigger to worker", { cause })),
    )
  }
  if (targetDirectory !== undefined) {
    yield* rememberDirectory(ctx, { threadID, directory: targetDirectory }).pipe(
      Effect.catch((cause) => Effect.logWarning("superagent failed to remember directory", { cause })),
    )
  }
  // Record the worker on its ticket (open → in_progress) before the prompt
  // lands, so the watcher can close it even if the worker fails immediately.
  // The binding is part of the dispatch: if it fails, the half-created worker
  // is rolled back instead of running outside the ticket it was dispatched for.
  const linkFailure = yield* linkTicketToWorker(ctx, {
    ticketID: ticket.id,
    sessionID: created.id,
    dirKey,
    ...(targetDirectory === undefined ? {} : { note: targetDirectory }),
    ...(resolved.note === undefined ? {} : { effort: resolved.note }),
  }).pipe(
    Effect.as(undefined),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed(error.message)),
  )
  if (linkFailure !== undefined) {
    yield* rollbackDispatch(ctx, created.id, `could not bind ticket ${ticket.id} to the new worker (${linkFailure})`)
    return yield* new Tool.Error({
      message: `dispatch aborted: could not bind ticket ${ticket.id} to the new worker (${linkFailure})`,
    })
  }
  const partitionThreads = dirState(store, dirKey).threads
  const existing = partitionThreads.get(threadID) ?? []
  if (!existing.includes(created.id)) existing.push(created.id)
  // Affinity lists persist after workers end; cap them so long-lived
  // threads don't grow unbounded in memory and KV.
  if (existing.length > 20) existing.splice(0, existing.length - 20)
  partitionThreads.set(threadID, existing)
  yield* ctx.storage
    .set(
      dirScopedKey(threadKey(threadID), dirKey),
      encodeThread({ threadID, workers: [...existing], updatedAt: Date.now() }),
    )
    .pipe(Effect.catch((cause) => Effect.logWarning("superagent failed to persist thread", { cause })))
  // Prompt delivery is part of the dispatch: if the worker never receives its
  // task, the ticket, thread affinity and worker record must not stay behind.
  const promptFailure = yield* sessions
    .prompt({
      sessionID: created.id,
      text: workerPrompt(threadID, input.title, input.task, ticket),
      delivery: "queue",
    })
    .pipe(
      Effect.as(undefined),
      Effect.catch((cause) => Effect.succeed(String(cause))),
    )
  if (promptFailure !== undefined) {
    yield* rollbackDispatch(ctx, created.id, `failed to prompt worker session: ${promptFailure}`)
    return yield* new Tool.Error({
      message: `dispatch aborted: failed to prompt worker session: ${promptFailure}`,
    })
  }
  const where = targetDirectory === undefined ? "gateway default directory" : targetDirectory
  // A degraded resolution must reach the Router, not just the ticket history: the
  // dispatch still succeeds, so without this line the model would report the
  // requested effort as applied while the worker actually inherited the Router's.
  const degraded =
    resolved.note !== undefined && /\((?:unverified|unresolved)/.test(resolved.note)
      ? ` WARNING: effort ${input.effort} was NOT applied (${resolved.note}); the worker inherits the router's current level. Do not report this dispatch as effort=${input.effort}.`
      : ""
  return {
    output: { sessionID: created.id },
    content: `Worker ${created.id} started in ${where} in the background and will report back. Do not poll; wait for its report. Ticket ${ticket.id} is now in_progress.${degraded}`,
  }
})

export const registerTools = Effect.fn("superagent.registerTools")(function* (ctx: Plugin.Context) {
  yield* ctx.tool.transform((editor) => {
    editor.add({
      name: "dispatch",
      description: specFor("dispatch").description,
      input: DispatchInput,
      output: DispatchOutput,
      execute: (input, context) => runDispatch(ctx, input, context.sessionID),
    })
    editor.add({
      name: "status",
      description: specFor("status").description,
      input: StatusInput,
      output: StatusOutput,
      execute: (input, context) => {
        // The status tool is router-only; scoping it to the caller's partition
        // keeps one directory's counters out of another's reply.
        const dirKey = dirKeyForRouter(context.sessionID)
        const text = statusText({
          includeFinished: input.includeFinished === true,
          ...(dirKey === undefined ? {} : { dirKey }),
        })
        return Effect.succeed({ output: { text }, content: text })
      },
    })
  })
})
