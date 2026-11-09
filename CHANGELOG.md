# Changelog

All notable changes to `opencode-superagent` are documented here. The package
version is independent of the main OpenCode line (see README, "发布与构建").

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
