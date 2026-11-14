# Changelog

All notable changes to `opencode-superagent` are documented here. The package
version is independent of the main OpenCode line (see README, "发布与构建").

## Unreleased

Nothing yet — see `0.5.1` below.

## 0.5.1 — 2026-11-14

### Changed

- **`sleep` ceiling raised from 60s to 3600s (one hour).** The default (30s) and
  the lower bound (1) are unchanged. `seconds` is still validated as an integer
  in `1..3600`; the tool description, tool spec, Router prompt and README now say
  `1..3600`. Only the Router-side tool definition changed, so no Worker behaviour
  is affected. A gateway restart is needed to pick this up (no hot reload).

## 0.5.0 — 2026-11-11

Breaking: the slash-command surface changed. The plain-text `/tickets` list was
removed and the two-level browser that used to be `/task` now owns `/tickets`.

Everything else is additive or behavioural: a `dispatch` reasoning `effort`,
short-id search, cross-platform directories, a release gate, and a batch of
concurrency/persistence fixes. The only config change is the new optional
`pendingTTLMs`. A gateway restart is needed to load the new code (`effort`), and
the TUI must be reopened for the `/tickets` panes.

### 🔥 Breaking

- **The plain-text `/tickets` list command is gone.** Its one-shot
  `dialog.alert` of the `tickets` RPC text was a narrower version of the
  browser's list pane, and its slash name is now owned by the browser. Browsing
  goes through `/tickets` (same rows plus a detail pane); the `tickets` RPC and
  the sidebar ticket panel are unchanged.
- **The two-level ticket browser is now `/tickets`; `/task` no longer exists.**
  The command keeps its panes, keys, size maths and short-id search; only the
  slash name changed (`/task` → `/tickets`), which is why the old `/tickets`
  text list could not stay (see above). `/ticket <id>` is unchanged and still
  opens a single ticket, so the pair now reads as: `/tickets` browses and
  searches, `/ticket <short id>` opens one. The command table moved to
  `src/commands.ts` and `tui.tsx` only binds each `run` key to its handler, so
  `test/commands.test.ts` can pin the registered slash names without loading the
  Solid renderer.

### Added

- **`dispatch` takes a reasoning `effort`.** `dispatch({ task, title?, threadID?, agent?, effort?, directory?, ticketID })`
  accepts `"low"`, `"medium"`, `"high"`, `"max"` and applies it as the worker's
  model *variant* (`sessions.create`'s `model.variant` — `sessions.prompt` has no
  effort field, so it cannot change per turn). The whitelist is the model's own
  `variants` from `ctx.model.list()`: the server stores an unknown variant
  instead of rejecting it, so the plugin validates and fails with
  `dispatch: effort <level> is not available for <provider>/<model>; available: …; omit effort to inherit the router's current effort`
  without creating a session. Omitted effort inherits the router's current
  level exactly as before; `effort` cannot be combined with an `agent` override
  (the agent keeps its own model) and says so; a missing/failing model catalog
  degrades to the inherited level, logs a warning and records
  `effort=<level> (unverified: inherited)` in the ticket history instead of
  blocking the dispatch. The dispatch entry and `/ticket <id>` show the level
  (`档位：`), per attempt. `src/effort.ts` is the single list shared by the tool
  catalog (`/tools`), the RPC schema (`dispatch` accepts an optional `effort`,
  so older clients keep working) and the dispatcher.
- **The `/tickets` browser is two-level: the list opens details, not sessions.**
  `⏎` on a row now shows that row's detail (ticket fields parsed from the
  `ticket` RPC text, or a worker summary), `/` searches, `q` closes. Ticket rows
  carry the tail of their **most recent** worker session as `p1 w=xxx123`
  (`w=` is absent until the ticket was dispatched), because a dispatch
  overwrites `ticket.workerSessionID`. The detail pane lists the ticket
  (short/full id, state, priority, title, objective, acceptance, directory,
  `档位` when the dispatch recorded one, latest worker, attempts, timestamps,
  report summary, history) and scrolls with `↑↓`/`PgUp`/`PgDn`. In the detail
  pane `⏎` enters the row's worker session — verified with `session.get` first,
  so a deleted session says `该工单的会话 … 不可用` instead of navigating
  nowhere — and a ticket without a worker says 「该工单暂无会话」 instead of
  failing silently. `q`/`esc` go back to the list with its query and cursor
  intact, and the footer hint follows the pane
  (`⏎ 详情 · q 退出 · / 搜索` vs `⏎ 进入会话 · q 返回`). The detail pane reuses
  `computeDialogSize`/`layoutPickerRow` from the existing picker, so there is
  one set of layout constants; `src/picker-nav.ts` holds the pure key map.
- **4-character short-id search for `/tickets` and `/ticket`.** The sidebar shows
  `dc8d` for `tk_mwbkve34_dc8d`; the picker and `/ticket` now accept that short
  id, a full id, a prefix, a suffix or any middle fragment (case and `tk`/`_`/`-`
  separators ignored). Ranking is exact > suffix > prefix > middle > title, and an
  ambiguous query lists candidates instead of guessing (`src/ticket-search.ts`).
- **A release gate.** `bun run release:check` (`script/release-check.ts`) runs
  typecheck → test → build → `bun pm pack` and validates the tarball (entry points
  present, packed version matches `package.json`, no `src/`/`test/`/`e2e/`/
  `script/`/`.github/` inside). `prepublishOnly` calls it, so a red gate blocks
  `npm publish`; CI runs the same command instead of three separate steps.

### Changed

- **The router prompt now carries an effort allocation policy.** `ROUTER_PROMPT`
  gained a 「推理档位分配」 section: concrete criteria for `low` / `medium`
  (default) / `high`, an explicit ban on "just use high to be safe", retry
  escalation (low→medium→high after a failed or interrupted worker, with a
  one-line reason), and a `effort=<level>：<reason>` accounting line required on
  the first line of every dispatch task. It also restates the boundaries the
  dispatcher enforces — no combination with an explicit `agent` override, the
  model's `variants` whitelist, and the `(unverified: inherited)` degradation —
  so the router stops guessing. The worker prompt keeps only a short
  "the level is fixed at session creation" constraint, never the policy itself.
- **Windows paths are accepted everywhere a `directory` is.** `normalizeDirectory`
  now recognises POSIX (`/opt/project`), Windows drive (`C:\project`, `C:/project`,
  `c:\project`) and MSYS (`/c/project`) forms and canonicalises all of them to one
  spelling (`C:\project`), so aliases, thread bindings and conflict detection
  treat the same directory as one directory. Rejected input now reports a single
  message listing the three accepted shapes instead of "must be an absolute path".
  UNC paths and `~` are still rejected (see README "已知限制").
- **Directory aliases match on word boundaries.** `app` no longer matches
  `appstore`/`myapp`, while `修复app的问题` and `app/web` still hit; longer aliases
  win. A basename that maps to two directories keeps the first registration and
  excludes the alias from automatic matching (the conflict is recorded and shown
  by `dirs:`), the alias table is capped at 24 entries (LRU eviction), and the
  status line lists only the newest 5 with `+N older` / `conflicts=N`.
- **An interrupted worker parks its ticket instead of freezing it.** The watcher
  moves the in-progress ticket to `blocked` with an `interrupted: <reason>`
  history entry, and the dispatch gate now lets that `idle` worker be replaced
  once the ticket was parked — `ticket_update({ status: "in_progress" })` is
  enough to re-dispatch, no `abort_session` + new ticket required.
- **Hydrate does bounded concurrent lookups.** `HYDRATE_CONCURRENCY = 8` for
  `hydrate` and `hydrateSessionMeta`, replacing one serial `session.get` per
  record, while state transitions and ticket reconciliation still apply in record
  order.
- **Pending replay expires.** `hydratePending` drops entries older than
  `pendingTTLMs` (default 24h, measured from `arrivedAt`) instead of injecting a
  day-old follow-up after a restart; the count is logged and kept in
  `store.pendingDropped` for `status`.
- **E2E tests the local tarball.** `e2e/plugin-load.e2e.ts` now runs
  `bun pm pack` on the working tree, installs that tarball into a scratch prefix,
  compares the installed `dist/` with the fresh build, and boots a real host
  against it (version read from `package.json`, no hardcoded `0.4.0`). The
  workflow also triggers on `src/**`, `server.ts`, `tui.tsx`, `agent/**`,
  `script/**`, `test/**`, `tsconfig*.json` and `bun.lock`, so a code change can
  reach the E2E instead of silently rotting it.

### Fixed

- **Restart no longer leaves an interrupted ticket stuck in `in_progress`.**
  `hydrate` replayed a `running` record whose session ended as `interrupted` into
  `idle` but only closed tickets for `done`/`failed`, so the ticket stayed
  `in_progress` behind the idle gate forever. The hydrate path now calls
  `blockTicketsForWorker`, like the watcher does; `test/lifecycle-regressions.test.ts`
  covers the restart scenario and the follow-up re-dispatch.
- **Two concurrent dispatches of one ticket cannot both create a session.**
  `inFlightTickets` was a module-level `Set`, so when the host loaded two copies
  of the plugin (two install paths for one version, or a re-reconciliation) each
  copy had its own table and both could claim the same ticket. The set now lives
  on `globalThis` under a `Symbol.for` key, like `store`, so every in-process copy
  shares one claim table; the claim is still taken in one synchronous
  check-and-insert and released by `Effect.ensuring` on success, failure and
  interruption.
- **A trimmed ticket is no longer reported missing.** Memory keeps the newest 500
  tickets; `ticket`, `ticket_update`, `ticket_close`, `linkTicketToWorker`,
  `tickets` and the TUI now fall back to a single KV `get` (and a paged scan only
  when memory cannot fill a list page). Hydrate also counts the records in KV so
  "memory is complete" is answerable.
- **Failed KV writes are queued, not swallowed.** A ticket or index write that
  throws stays in a dirty queue and is retried by the next mutation or read, so a
  restart cannot resurrect the previous state.
- **Truncation is code-point safe.** Titles/objectives/acceptance are length
  checked in code points (`40` emoji is 40 characters, not 80) and every clip
  (`clipCodePoints`/`clipUtf16`) keeps surrogate pairs together, so stored text
  never ends in half an emoji.
- **Router creation is serialised.** `ensureRouter`'s check → create → persist ran
  concurrently, so two callers could each create a router and one KV write would
  orphan the other. A process-wide semaphore (on `globalThis`, shared like the
  store) guards it, and the winner's id is re-read under the lock.
- **The ticket picker is big enough to read.** The host's `dialog.select` cannot
  be resized (list capped at `floor(rows/2)-6` rows in a 60-column frame), so
  `/tickets` and `/ticket` draw their own `PickerDialog` (`src/tui-picker.ts`):
  75% of the terminal height, 12–30 visible rows, 40–112 columns, keys matching
  the built-in select. `test/tui-picker.test.ts` pins the layout maths.
- **Composition root is covered.** `server.ts` now renders tickets through the
  KV-fallback helpers, and `test/server-setup.test.ts` / `test/router-ensure.test.ts`
  pin the setup path and the router lock.

## 0.4.0

Removes the TUI demo slash command; no RPC or config changes.

- **`/superagent-demo` deleted.** The command injected six demo events to show
  router/worker routing. Use any RPC client that calls `trigger` for local
  debugging instead; `trigger`, `status`, and the rest of the RPC surface are
  unchanged.

## 0.3.3

Adds the router-only `worker_prompt` follow-up channel for existing workers; no
config changes, upgrade is a version bump plus a gateway restart.

- **`worker_prompt({ sessionID, text, delivery?, interrupt? })`.** Appends a
  `[router:follow-up]` prompt to a tracked worker with `queue` (default) or
  `steer` delivery. `interrupt: true` steers the text into the inbox first and
  then calls `interrupt({ resume: true })`, so the resumed execution always has
  the new instruction waiting for it.
- **Router-only, tracked workers only.** The tool goes through
  `requireRouter`, so worker sessions neither see nor may call it. Only tracked
  workers in `running`/`idle` are eligible: unknown sessions, the router
  itself, and failed/aborted/done records are refused.
- **Closed work orders are never woken.** A worker whose ticket is `done`,
  `failed`, `cancelled`, `superseded` (or any other terminal state) is rejected
  with `worker <id> ticket <id> is closed (<state>); start a new worker
  instead`. A tracked worker with no ticket is rejected too (fail-closed), and
  no prompt or interrupt call is made in either case.

## 0.3.2

`sleep` no longer silently sleeps the full duration when work changes in a way
that keeps the old counters net-zero. No config or API changes; upgrade is a
version bump plus a gateway restart.

- **`sleep` baseline compares identities, not counters.** The wake check now
  snapshots terminal-worker identities (`sessionID` plus state/`updatedAt`) and
  pending-trigger ids instead of plain counts and queue length. A terminal
  worker that is resumed while another worker completes (terminal count
  unchanged), or a pending queue drained by the idle hook while a new trigger
  arrives (length unchanged), no longer swallows the wake-up. Wake reasons and
  the result shape are unchanged.
- **The store is process-wide.** `store` and the worker registry live on stable
  `globalThis` symbols (`opencode-superagent.store.v1`,
  `opencode-superagent.workers.v1`), so a duplicate in-process plugin copy
  (same version, a second install path, or a re-reconciliation) shares the
  registry the watcher writes instead of silently polling a private copy.
  Different plugin versions still require a gateway restart to share state.
- **7 new reliability regression tests.** `test/sleep-wake-reliability.test.ts`
  covers rejected/interrupted/concurrent sleeps leaving no residue, a resumed
  terminal worker alongside a completion at the same count, a drain-and-refill
  queue at the same length, and the `globalThis` store/worker registry being
  shared across a second module evaluation.

## 0.3.1

The `sleep` tool becomes interruptible and its ceiling drops from 600s to 60s;
no config changes, upgrade is a version bump plus a gateway restart.

- **Interruptible `sleep` (plan A).** While waiting, the router checks plugin
  memory every 250ms for a terminal worker or a newly queued trigger and
  returns early instead of sleeping the full time. The baseline is taken
  before the first wait, so state that existed when `sleep` started never
  causes a false wake-up.
- **Early return is explicit.** The text becomes
  `slept Ns of Ms (woken: worker completed)` (or `Ns` new events); the output
  gains an optional `woken` field and `slept` is the real elapsed time, never
  the requested value. A full wait keeps the original `slept Ns` shape.
- **New-trigger wakes steer the queue.** A pending-trigger wake calls
  `flushPending(ctx, { delivery: "steer" })`, so the event is visible at the
  next step boundary. Worker completions are not re-delivered: the watcher
  already steers that notification.
- **Ceiling is 60s.** `seconds` is validated as an integer in `1..60`
  (default stays 30); tool description, Router prompt and README are synced.
- Tests cover worker wake, trigger wake with a single steer delivery, full
  sleeps, pre-existing state (no false wake), the 60s ceiling and the
  non-busy poll cadence.

## 0.3.0

Fixes from the 0.2.1 field reports; no API or config changes, upgrade is a
plain version bump plus a gateway restart.

- **Router system prefix is cache-stable.** The router's system prompt is now
  built so the prefix stays byte-identical across turns, so the provider prompt
  cache keeps hitting instead of being invalidated on every dispatch.
- **`status` tool output is compact.** The tool result is trimmed to the
  decision-relevant fields (version, router, pending, workers), which keeps it
  cheap to read and well under output limits.
- **Worker completion notifications are deduped.** Terminal announcements are
  keyed by worker session id + execution epoch + terminal state and the marker
  is persisted in the worker record before the synthetic is sent, so hydrate,
  watcher wobble and host re-delivery can no longer inject a duplicate router
  notification. A newer `started` event opens a new execution, so a resumed
  worker still reports again.

## 0.2.1

- Runtime plugin version notice: startup log and `status` expose the loaded
  plugin version.
- CI workflow running typecheck, tests and build; real-host E2E workflow.
