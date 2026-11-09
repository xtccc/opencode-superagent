# sleep wake-up "failure" — root cause and evidence

Ticket: `tk_mw91iq8q_4bd9` · branch `fix/sleep-wake-reliability`

## Verdict

**The first `sleep(60)` was not a missed wake-up: the worker had not finished
when the 60s deadline expired.** The `15s` in the report is a child shell /
subagent run *inside* the worker session; the worker session itself reached a
terminal state at **17:08:50.619**, i.e. **5.2s after** the sleep returned at
**17:08:45.405**.

No waiter/singleton state exists in the sleep implementation, so the
"invalid call residue" and "waiter leak" theories are ruled out. The 0.3.0 and
0.3.1 modules did coexist in the gateway process (config reconciled without a
restart), but the router's tool registry was 0.3.1 for both calls, so that did
not cause the difference either. Two *latent* reliability bugs were found and
fixed while auditing: counter-based baselines can miss a net-zero state change,
and the store was module-local so a duplicate plugin copy could silently watch
a different registry.

## Timeline (from `session_message`, local +08:00)

Router: `ses_e443d95a2ffeTwg1vTfliNh7Ts`. Worker 1: `ses_e406fc78bffeHNGFJ1mFOVVENp`.
Worker 2: `ses_e406e62a6ffes6li06aFEJvOqa`.

| time | event |
| --- | --- |
| 17:05:08 | `superagent 0.3.1 loaded` (in the already-running gateway process) |
| 17:06:30.892 | `sleep(120)` rejected: `sleep seconds must be between 1 and 60 (got 120)` |
| 17:07:42.358 | dispatch returns; worker 1 session starts, state `running` |
| **17:07:45.388** | **`sleep(60)` tool starts** (baseline: worker 1 = running, terminal = 0) |
| 17:08:13.624 | child subagent `ses_e406fa96…` completes (this is the "15s" run: `sleep 15` 17:07:52→17:08:09) |
| **17:08:45.405** | **`sleep(60)` deadline reached**, returns `slept 60s` (60.017s) |
| **17:08:50.619** | **worker 1 session goes `idle` / terminal** — 5.214s after the deadline |
| 17:09:13.717 | worker 2 session starts |
| **17:09:15.947** | **`sleep(30)` tool starts** |
| 17:09:28.967 | worker 2 terminal (13.020s into the sleep) |
| 17:09:29.123 | `sleep(30)` returns `slept 13s of 30s (woken: worker completed)` — 0.156s after terminal |

The sleep loop only samples every 250ms and compares against a baseline taken
when the tool starts (`src/sleep.ts:167-172`). At 17:08:45 the worker was still
`running`, so there was nothing to wake on; the deadline was reached first.

Why the report looked like a failure: the dispatched task itself ran a child
subagent whose `sleep 15` finished at 17:08:09, and the worker's own report
mentions that timestamp. The worker then kept working (reading files and running
the real-time evidence script) for another 41s. A later `worker_detail` call
(step window 17:08:45–17:08:58) already showed `done`, which made it look like
the completion had been visible during the sleep — it was not.

Reproduce the timeline:

```sh
sqlite3 -readonly ~/.local/share/opencode/opencode.db \
  "select seq,type,time_created,time_updated from session_message
     where session_id='ses_e443d95a2ffeTwg1vTfliNh7Ts' and seq in (4471,4480,4513,4521);
   select seq,type,time_created from session_message
     where session_id='ses_e406fc78bffeHNGFJ1mFOVVENp' order by seq;"
```

The tool part of message 4471 carries `time.ran=1794215265388`,
`time.completed=1794215325405`; the corresponding worker idle row is `132`,
`time_created=1794215330619`.

## Hypothesis elimination

1. **Rejected `sleep(120)` left state behind — ruled out.** Validation runs
   before the baseline and before any poll (`src/sleep.ts:141-165`). There is no
   waiter registration, Deferred or module-level Set; each call's baseline and
   loop are locals. New test asserts the rejected call performed zero polls and
   the next sleep still wakes.
2. **Waiter leak / cross-talk — ruled out by construction.** There is no
   waiter: the loop is `for (;;) { poll; compare local baseline }`
   (`src/sleep.ts:167-179`). Interruption only kills that fiber; concurrent
   calls have independent locals. Tests cover abort→sleep and two concurrent
   sleeps.
3. **Baseline data source — two real edge cases fixed.** `snapshotWork()` used
   terminal *counts* and queue *length*. A terminal worker that is resumed while
   another completes leaves the count unchanged (1→1) and the completion is
   missed; an idle-hook flush that drains one trigger while another arrives
   leaves the length unchanged and the new trigger is missed. The snapshot now
   compares terminal worker identities (`sessionID → state@updatedAt`) and
   pending trigger identities.
4. **Two plugin instances — real, but not the cause here.** The log shows the
   same live process (`run=7c6a3e27`, PID 1270514 started 16:37) loading
   `opencode-superagent@0.3.0` and then `@0.3.1` without a restart, e.g.
   `~/.local/share/opencode/log/opencode.log:13382-13415` (17:05:02Z) and
   `:13490-13534` (17:05:08Z): five `loading plugin ...@0.3.0` lines followed by
   `@0.3.1`, then six `superagent 0.3.1 loaded` notices. However:
   - the host loads a plugin with `await import(await Bun.resolve(entry, bunfig_folder))`
     (no cache-busting), so every repeated load of the **same 0.3.1 path** is
     the same module instance and shares its store;
   - `sleep(120)` was rejected with the 0.3.1 ceiling at 17:06:30 (0.3.0's
     `SLEEP_MAX_SECONDS` is 600 and accepts 120), and the log has no plugin load
     between 17:06:30 and 17:09:29 — both later sleeps were served by the same
     0.3.1 tool instance;
   - the actual timing (worker terminal 5.2s after the deadline) fully explains
     the first result without a store desync.

   Still, a duplicate copy of the *same* version from another install path
   would have had a private store. `store` and the `workers` map now live on
   `globalThis` under `Symbol.for("opencode-superagent.store.v1")` /
   `…workers.v1`, so every in-process copy shares one registry. Cross-version
   copies cannot share (old code has no symbol), so a gateway restart after an
   upgrade remains mandatory; the startup notice already says so.
5. **Poll vs. state-update race — ruled out.** The watcher writes the terminal
   state before sending the completion synthetic (`src/watcher.ts:165-174`), and
   the second test woke 156ms after the terminal transition, within one poll
   interval.

## Changes

- `src/sleep.ts`: identity-based `WorkSnapshot` (terminal workers + pending
  triggers) so net-zero count/length changes still wake; wake reasons unchanged.
- `src/worker-state.ts`: `workers` registry stored on a process-wide
  `globalThis` symbol.
- `src/state.ts`: `store` object stored on a process-wide `globalThis` symbol,
  reusing an existing store from a duplicate module evaluation.
- `test/sleep-wake-reliability.test.ts`: rejected call → valid sleep → wake;
  interrupt → sleep → wake; two concurrent sleeps; net-zero terminal count;
  net-zero queue length; global store assertions including a cache-busted second
  module evaluation.

## Test output

```sh
$ bun test
176 pass, 2 skip, 0 fail  (178 tests / 24 files)

$ bun run typecheck
✓ No type errors in 52 files

$ bun run build
build: dist/ has 26 js files
```

The new tests fail 4/7 against the pre-fix sources (`git stash` of the three
source files), confirming they cover the new behaviour rather than restating it.

## Remaining risk

- A gateway restart is still required after upgrading; the plugin cannot merge
  state across two *different versions* loaded in one process.
- `sleep` still compares an in-memory snapshot. If the host ever runs the
  watcher in a different OS process from the tools, no in-process singleton can
  bridge that; today both live in the gateway process.
- The `updatedAt` component of the terminal signature can produce a
  `worker state changed` wake if a terminal record is rewritten for unrelated
  bookkeeping during a sleep. That is a benign early return, not a lost wake.
