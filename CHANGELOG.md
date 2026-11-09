# Changelog

All notable changes to `opencode-superagent` are documented here. The package
version is independent of the main OpenCode line (see README, "发布与构建").

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
