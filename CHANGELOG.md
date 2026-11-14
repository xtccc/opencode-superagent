# Changelog

All notable changes to `opencode-superagent` are documented here. The package
version is independent of the main OpenCode line (see README, "发布与构建").

## Unreleased

### Fixed

- **Claiming a partition no longer silently takes the Router away.** When a
  `routerDirectory` partition already had its own Router, the startup claim
  **deleted** the legacy `router` KV pointer. The old session stopped being any
  partition's Router, and every router-only tool (`ticket_list`, `dispatch`,
  `sleep`, `status`, …) answered with a bare
  `only available to the router session` — the user had no idea why. Now:
  - the legacy pointer is **kept** (rolling back to the previous plugin version
    still finds a valid `router` pointer, so the rollback stays lossless) and
    the old session is marked `superseded` in a separate KV key
    (`superseded:router:<sessionID>`, global: a session id is globally unique,
    so the marker never enters the `dir:<dirKey>:` namespace);
  - the marked session says so in plain words: its router-only tool errors
    name the successor (`本会话已不再是 Router，已被 <会话> 取代`), the context
    hook injects the same notice into its system block, `status` lists the
    replaced session, and startup logs one readable WARN line per session;
  - `ensureRouter` never adopts a superseded pointer while its successor is
    alive (one session must not serve two partitions), and reclaims it once the
    successor is gone, so a deleted Router cannot strand a partition.
  - The default partition's KV key names are byte-identical (`router`,
    `superseded:router:<id>`); non-default partitions keep the `dir:<k>:`
    prefix.

- **Partition ownership follows the calling Router, not the working directory
  (`perDirectoryRouter`).** The previous stage-2b rule derived a ticket's (and a
  worker's) partition from `directory`, which conflated "where the work runs"
  with "who owns the work order". With the flag on this locked the default
  partition's Router — the one a pre-flag gateway session ends up in — out of
  every directory it tried to operate on
  (`this router (partition default) cannot operate on /home/x/tmp (partition …)`),
  routed completion reports of a cross-directory dispatch to the wrong Router,
  and scattered legacy tickets across partitions so a Router saw
  `closed=0` instead of its own history. Now:
  - `ticket_create` / `ticket_list` / `ticket_update` / `ticket_close` /
    `dispatch` / `abort_session` / `worker_prompt` take their partition from the
    caller (`requireRouter` → `dirKey`, `default` when unset). `directory` is
    still validated as an absolute working directory, but only decides where the
    worker session is created. `Ticket` gained a `dirKey` ownership field next to
    `directory`. `requireRouterFor` (which refused a foreign directory) is gone.
  - `dispatch` may now send a worker into any directory; the gate is
    "caller partition == ticket partition". The dispatch no longer rewrites its
    own target directory into the caller's partition.
  - `WorkerRecord` gained `ownerDirKey` (the dispatching Router's partition,
    set by `dispatch`). `watcher` terminal delivery, `watchdog` stall alerts,
    `sleep` wake-ups and the `recall` / `session-meta` / `status` / ticket
    lookups all resolve a worker's partition through
    `workerOwnerDirKey()` (`ownerDirKey` first, `directory` for old records,
    `default` + one-shot warning when neither is present). A partition's Router
    is never created in the worker's working directory unless that directory
    really is the partition's own.
  - `hydrateTickets` reads the legacy `ticket:<id>` prefix **into the default
    partition** and writes no scoped copy; records already under
    `dir:<dirKey>:` keep their partition, and when both copies of one id exist
    (the old migration's leftover) the ownership returns to `default` while the
    content comes from the newer `updatedAt`, so state updated after the
    migration is not rolled back. Legacy `router` / `thread:` / `trigger:` /
    `pending:` keys already landed in `default` and still do. Hydration stays
    write-free and idempotent.
  - New regression suite `test/partition-ownership.test.ts` (cross-directory
    dispatch stays in the dispatcher's partition and reports only to it; the
    creator can list/update/close its own ticket; two Routers stay isolated;
    legacy hydration visibility and idempotency; legacy worker fallback;
    `sleep` not woken by another partition; flag-off byte-identical
    `statusText`/`buildStatusInjection`) plus updated
    `test/ticket-partition.test.ts`, `test/per-directory-router.test.ts`,
    `test/rpc-directory.test.ts`, and a cross-directory case in
    `e2e/per-directory.e2e.ts`. The README's "单网关多目录" section documents the
    new ownership rule.

### Added

- **`/alltickets`: one aggregate view over every partition.** `/tickets` lists
  the session's own directory (and its workers); the new `/alltickets` lists
  **every** partition's work orders and groups them by directory, so a gateway
  serving several directories can be surveyed in one place.
  - **RPC**: `tickets` gained an optional `all?: boolean`. Omitted, the
    behaviour is exactly as before (the caller's partition, or the
    process-wide list when no `directory` is given). With `all: true` the
    response is the aggregate list; `all` wins over `directory` (asking for
    "all" and "one directory" at once is not an error, the aggregate simply
    answers).
  - **Output**: the total comes first (`共 N 条，K 个目录`), then one block per
    directory with its own header (`目录 <path> · <dirKey> · <n> 条`) and the
    **same** body the single-partition view prints (`renderTicketList`), so the
    two commands differ only in the headers. With a single partition the
    aggregate output is byte-identical to the default output — the aggregate
    view adds no noise to a gateway that only ever has one directory. The
    `limit` applies to **each** group (the N newest tickets of every
    directory), and the KV fallback fills the groups when memory was trimmed,
    so a ticket that only lives in KV still shows up in its own directory's
    block.
  - **TUI**: `/alltickets` is registered next to `/tickets` (same palette
    entry style, same two-pane browser, same keys: `⏎` detail, `/` search,
    `q`/`esc` quit). Each group is introduced by a `目录 <path>` header row;
    `⏎` in the detail still enters the ticket's most recent worker session.
    The worker list stays out of the aggregate view: workers belong to a
    partition, and the aggregate view is about the work orders.
  - New suite `test/ticket-all.test.ts` (two partitions aggregate with group
    headers and the total line; the default call still returns one partition;
    a single partition degrades byte-for-byte to the default output; the empty
    case agrees; the layout and the aggregate text parser), an updated
    `test/commands.test.ts` (the command set now contains `alltickets`), and an
    aggregate case in `e2e/per-directory.e2e.ts`. README's command table, RPC
    section and "单网关多目录" section document the new command.
- **The sidebar ticket panel is the aggregate view too.** The panel used to
  list only the session's own directory's work orders; it now lists **every**
  partition's, the same data `/alltickets` shows. 36 cells cannot hold every
  partition's tickets, so the panel expands the session's own directory and
  gives every other partition **one summary line** (`目录 <basename> · <N> 条`)
  — the user still sees that work is waiting elsewhere and how much of it
  there is, without the panel outgrowing the terminal. A count that may be a
  lower bound is printed as `N+ 条` (the partition hit the 20-per-partition
  fetch limit), so the number is never a wrong claim. With a single partition
  the panel is structurally identical to the old one: same rows, same order,
  same counts, no group label and no summary line.
  - Both surfaces read the **same** aggregate text and share one model:
    `src/ticket-aggregate.ts` renders the groups on the server and parses them
    on the TUI side, and `src/ticket-sidebar.ts` turns the parsed groups into
    the panel's layout. The group count the panel prints is the count the
    **server** wrote into the group header, so the sidebar and the command can
    never disagree.
  - New suite `test/ticket-sidebar.test.ts` (the panel holds every partition's
    tickets; the session's own directory is expanded and comes first; the
    other partitions are collapsed into one summary line with their count; the
    single-partition panel equals the old one row for row; the aggregate fetch
    of one partition is byte-identical to the old directory-scoped fetch).
    README's "侧栏工单面板" section documents the new layout.

- **Fixed Router working directory (`routerDirectory` option).** The gateway
  Router can now be pinned to one directory so its work orders land in that
  directory's partition and show up in the `/tickets` panel / sidebar of a TUI
  session opened there. The option must be an existing absolute path; a
  relative, missing or non-directory value is ignored with a single startup
  warning and the old `default` behaviour is kept. When set:
  - the Router's partition is `dirKeyOf(routerDirectory)` and a newly created
    Router session carries `location: { directory: routerDirectory }`;
    `ensureRouter` uses the fixed directory even when a caller names the
    partition without a directory (and, with `perDirectoryRouter` off, pins the
    single Router there — configuring the option is enough to enable the
    partition machinery with exactly one partition);
  - a legacy Router stored under `router` (created before the flag, no
    `location.directory`, parked in `default`) is claimed into that partition on
    hydrate: `dir:<dirKey>:router` is written, the legacy `router` pointer is
    removed, and an already-scoped Router wins over the stale pointer, so one
    session is never served by two partitions;
  - legacy `ticket:<id>` records without a `dirKey` are re-owned by the fixed
    partition and written back to the **same** legacy key (key name kept for
    rollback); records that already name an owner are untouched, so repeated
    hydration is idempotent. Without the option nothing changes (`default`
    partition, no `dir:` keys, byte-identical snapshots).
  - TUI visibility needs no new aggregate view: `/tickets`, the sidebar and the
    ticket picker already resolve the session directory to a partition, which
    equals the Router's partition when the session runs in `routerDirectory`.
  New suite `test/router-directory.test.ts` covers creation pinning, ticket
  visibility from that directory vs `default`, legacy ticket re-owning
  (idempotent, old key kept), legacy Router claiming (no-location, matching,
  superseded and foreign-location shapes), flag-off standalone pinning and
  invalid-value warnings. README's "单网关多目录" section and the options table
  document the option; the config change needs a gateway restart.
- **Groundwork for one-instance-per-directory (stage 1, no behaviour change).**
  `dirKeyOf()` turns a directory into a KV-safe partition key (`<slug>-<sha1[0:8]>`,
  canonicalized, symlink-resolved), `DEFAULT_DIR_KEY` names the no-directory
  partition, `store.dirs` holds one `DirState` per partition with the flat
  `routerID`/`routerBusy`/`threads`/`pending` fields as views on the active one,
  and the new `perDirectoryRouter` option (default `false`, strict `true` only)
  gates the `dir:<dirKey>:` KV namespace. With the option off there is exactly one
  partition, every KV key keeps its old shape, legacy state hydrates into the
  default partition, and `status` output is byte-identical to before. A gateway
  restart is needed to load the new code (no hot reload).
- **One Router per directory behind `perDirectoryRouter` (stage 2a).** With the
  option on, each directory partition owns its Router session (created *in* that
  directory, so its model/cwd resolution matches the workers it dispatches), its
  undelivered-trigger queue, its `flush`/`router` semaphores and its thread
  affinity. Worker terminal events, watchdog stalls and `sleep` wake-ups are
  routed by the worker's `directory` → `dirKey` → that partition's Router, so one
  directory's reports never reach another directory's Router; the idle hook
  drains only the queue of the Router that went idle. Router identity checks
  (`requireRouter`, `dispatch`, `abort_session`, `worker_prompt`, the context
  tool filter, `session-meta` backfill, the RPC `status` view) now accept every
  partition's Router, and `dispatch` refuses a ticket whose directory belongs to
  another partition. Non-default partitions keep their Router, thread affinity
  and pending triggers under `dir:<dirKey>:` (the default partition keeps the
  legacy keys), and startup replays them back into their own partition. A worker
  record without a `directory` degrades to the default partition with a
  one-shot warning instead of losing its completion. New optional
  `maxWorkersPerDirectory` caps live workers per directory (default: unlimited;
  the slot is taken in the same synchronous block as the ticket claim). Still
  process-wide and left for 2b: worker records, trigger history and tickets
  (including `ticket_create`/`ticket_list` partitioning), and one threadID bound
  to two directories. With the option off the behaviour and KV keys are
  byte-identical to the previous release (`test/store-partition.test.ts`,
  `test/per-directory-router.test.ts`).
- **Tickets, trigger history and thread affinity partitioned by directory (stage
  2b).** With `perDirectoryRouter` on, a ticket now belongs to the partition of
  its own `directory` — the same rule `requireRouterFor` uses — and its KV keys
  follow: the default partition keeps `ticket:<id>` / `ticketidx:*`, every other
  partition uses `dir:<dirKey>:ticket:<id>` / `dir:<dirKey>:ticketidx:*`.
  `ticket_create`/`ticket_list`/`ticket_update`/`ticket_close`, the `dispatch`
  gate (`requireDispatchTicket`), `status`, the recall/status injection and
  `thread_detail` are all scoped to the caller's Router, so a work order of
  another directory is neither listed nor operable (the refusal names both
  partitions). Startup scans both layouts: a legacy `ticket:<id>` whose directory
  belongs to another partition gets a scoped copy, the legacy key is **kept** so
  a rollback still reads its own data, and a re-run changes nothing (memory is
  keyed by ticket id, and the scoped copy is adopted before the legacy scan, so
  no duplicate record and no repeat write; `dirtyTicketIDs()` stays empty).
  Trigger history (`trigger:` → per-partition `DirState.triggers`) and the
  "newest trigger delivered to the Router" note are per partition too, so one
  directory's `trigger_detail`/ticket authorization can never quote another's
  conversation, and the same `threadID` used in two directories keeps two
  independent affinity lists (dispatch writes, `runTrigger` reads and
  `detachWorkerThreads` all take the partition explicitly). `status` reports the
  caller's partition only. `maxWorkersPerDirectory` is documented in `settings`
  and covered by tests: with `1`, a second dispatch of the same directory is
  refused while another directory is unaffected, and two dispatches gated inside
  `sessions.create` cannot oversell the last slot. With the option off nothing
  is partitioned: same KV keys, same `status`/injection bytes
  (`test/ticket-partition.test.ts`).
- **Directory visibility for RPC and the TUI (stage 3).** `status`, `tickets`
  and `router` accept an optional `directory`. `status` without it keeps the
  pre-3 payload byte-for-byte and, when `perDirectoryRouter` is on, adds a
  `partitions` summary (`dirKey`, `directory`, `router`, `pending`, `workers`,
  `running`); with it, `status` answers for that partition only and echoes
  `dirKey`/`directory`, never another partition's workers. `tickets` scopes the
  rendered list to that directory (omitted = process-wide, as before) and
  `router` opens/reuses that directory's Router. The TUI sends the session
  directory on every call, and the sidebar renders a compact per-partition
  router/pending/running summary once more than one partition exists; with a
  single partition the panel is visually unchanged. The pure view model lives in
  `src/status.ts` so the payload and the protocol schemas are tested together
  (`test/rpc-directory.test.ts`), and a standalone `e2e/per-directory.e2e.ts`
  drives two isolated directories end to end (two routers, two workers, isolated
  completion delivery, flag-off control) without touching the user's real
  config, data or gateway.

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
