# E2E: load `opencode-superagent` in a real OpenCode host

`e2e/plugin-load.e2e.ts` boots the real `opencode serve` process against a
throw-away `HOME` and a private port, then lets the host install and load the
published `opencode-superagent@0.2.1` package.

It is intentionally **not** part of `bun test` / `bun run test` /
`.github/workflows/ci.yml`:

- the file is not named `*.test.ts` and does not live under `test/`, so a bare
  `bun test` never discovers it;
- it needs the `opencode` CLI, network access to the npm registry and a real
  host process, so it runs only in `.github/workflows/e2e.yml`.

## How to run it

Locally (only if you really want a host process on your machine):

```sh
bun run test:e2e
```

In CI: the `E2E (real OpenCode host)` workflow runs on `workflow_dispatch` and
on pull requests that touch `e2e/**`, `.github/workflows/e2e.yml` or
`package.json`. It installs Bun, Node and the OpenCode v2 CLI
(`npm install -g @opencode/cli`), then runs `bun run typecheck` and
`bun run test:e2e`.

## What the test proves

1. `opencode plugin add opencode-superagent@0.2.1` writes the temporary
   `$XDG_CONFIG_HOME/opencode/opencode.json`.
2. `opencode serve --port <ephemeral> --hostname 127.0.0.1` starts with an
   isolated `HOME`/`XDG_*` environment and never touches the user's gateway.
3. `GET /api/plugin` reports the package as loaded (`id=opencode.superagent`,
   `source.version=0.2.1`, `state.status=active`); a plugin that throws during
   initialization shows up as `failed` instead.
4. The live host reports `superagent-router` and `superagent-worker` through
   `GET /api/agent`, and the plugin RPC answers
   `POST /api/rpc/opencode.superagent/status` with an empty pending queue and
   no workers.

The test always kills the detached process group, verifies the port can be
bound again, and removes the temporary directory.
