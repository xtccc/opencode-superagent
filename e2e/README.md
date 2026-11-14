# E2E: load the tarball packed from this tree in a real OpenCode host

`e2e/plugin-load.e2e.ts` proves the **publishable artifact of the current
working tree** loads. It:

1. runs `bun pm pack`, which triggers `prepack` → `bun run build`, so the tarball
   is built from the tree instead of being fetched from npm;
2. installs that tarball with `bun add <tarball>` into a scratch prefix
   (the only registry traffic is the tarball's own dependency,
   `@opencode/schema`);
3. compares the installed `dist/server.js` / `dist/tui.js` byte-for-byte with the
   files the build just wrote — a stale or foreign build cannot pass;
4. writes the installed directory into an isolated
   `$XDG_CONFIG_HOME/opencode/opencode.json` and boots a real
   `opencode serve` against a throw-away `HOME` and a private port;
5. asserts `/api/plugin` reports `opencode.superagent` as `active`, that
   `/api/agent` lists `superagent-router` + `superagent-worker`, and that the
   plugin's own RPC `status` answers with the version read from `package.json`.

Nothing in this file hardcodes a version: the expected version is read from the
repository's `package.json`, and the version the running host reports must match
it.

It is intentionally **not** part of `bun test` / `bun run test` /
`.github/workflows/ci.yml`:

- the file is not named `*.test.ts` and does not live under `test/`, so a bare
  `bun test` never discovers it;
- it needs the `opencode` CLI, network access to the npm registry (for the
  tarball's dependencies) and a real host process, so it runs only in
  `.github/workflows/e2e.yml`.

## How to run it

Locally (only if you really want a host process on your machine):

```sh
bun run test:e2e
```

In CI: the `E2E (real OpenCode host)` workflow runs on `workflow_dispatch` and on
pull requests that touch the surface the package is built from — `src/**`,
`server.ts`, `tui.tsx`, `agent/**`, `script/**`, `test/**`, `e2e/**`,
`tsconfig*.json`, `bun.lock`, `package.json` or the workflow itself. It installs
Bun, Node and the OpenCode v2 CLI (`npm install -g @opencode/cli`), then runs
`bun run typecheck` and `bun run test:e2e`.

Note: `opencode plugin add` only accepts npm-registry or Git specifiers, so a
local tarball cannot be registered through it. The E2E installs the tarball
itself and registers the extracted directory in `opencode.json`, which is the
same entry shape a global install ends up with.

## What the test proves

1. `bun pm pack` succeeds — `prepack`/`prepare` build `dist/` — and the tarball
   is named `<name>-<version>.tgz` from `package.json`.
2. The tarball installs and contains the expected entry points
   (`dist/server.js`, `dist/server.d.ts`, `dist/tui.js`, `dist/tui.d.ts`), with
   contents identical to the fresh build.
3. `opencode serve --port <ephemeral> --hostname 127.0.0.1` starts with an
   isolated `HOME`/`XDG_*` environment and never touches the user's gateway.
4. `GET /api/plugin` reports the package as loaded (`id=opencode.superagent`,
   the source path is the freshly packed directory, `state.status=active`); a
   plugin that throws during initialization shows up as `failed` instead.
5. The live host reports `superagent-router` and `superagent-worker` through
   `GET /api/agent`, and the plugin RPC answers
   `POST /api/rpc/opencode.superagent/status` with the `package.json` version, an
   empty pending queue and no workers.

The host requires authentication even on localhost: the E2E pins
`OPENCODE_SERVER_PASSWORD` and sends
`Authorization: Basic base64(opencode:<password>)`, so it never scrapes the
generated credential.

The test always kills the detached process group, verifies the port can be bound
again, and removes the temporary directory.

## `e2e/per-directory.e2e.ts` (stage 3)

Balanced on two independent layers, both under one `mkdtemp` root and one
`OPENCODE_CONFIG_DIR`:

1. **Real host.** Writes an isolated `opencode.json` with
   `options: { perDirectoryRouter: true }`, boots `opencode serve` against a
   throw-away `HOME`/`XDG_*`, creates two Routers through the public
   `router({ directory })` RPC for two temp directories, and asserts that
   `status({})` lists two partitions whose `router` ids differ and whose
   `directory` fields are the two real paths. When the host exposes session
   endpoints it also checks each Router session's `location.directory`.
2. **Built artifact internals.** Imports `dist/src/*.js` and drives
   `ensureRouter` + `runDispatch` + `handleEnded` with an in-memory host. This is
   the deterministic part a real host cannot provide without a model: two
   workers are dispatched, their records carry the right `directory`, each
   completion is delivered only to its own directory's Router, and with the flag
   off both directories collapse onto one Router.

Isolation is checked positively and negatively: the host's DB appears under the
temp root, while the user's real `opencode.json` / `package.json` / `auth.json`
(size+mtime) and `opencode.db` (device+inode) are unchanged. The DB is compared
by inode rather than mtime because the user's own gateway writes it continuously;
mtime would be noise, an inode change would mean our run replaced the file.

Run locally with:

```sh
bun run e2e/per-directory.e2e.ts
```

Like `plugin-load.e2e.ts` it is not a `*.test.ts`, so `bun test` does not pick it
up; it needs the `opencode` CLI and boots a real host.
