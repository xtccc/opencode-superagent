/**
 * One process, one copy of every mutable singleton.
 *
 * The OpenCode host may load the same plugin once **per location**
 * (`perDirectoryRouter` deployments see one instance per directory, all inside
 * the same `server` run). Every load re-evaluates this package's modules, so a
 * module-level `Map` / `Set` / counter is *not* process state: each instance
 * gets its own copy. That is how a ticket created by one instance's Router
 * became invisible to the instance that owned the watcher, and why a finished
 * worker's ticket stayed `in_progress` (the close landed in another instance's
 * map).
 *
 * `sharedSingleton` resolves this the same way `state.ts` / `worker-state.ts`
 * already do: a `Symbol.for` key on `globalThis`, which every module instance
 * in the process resolves to the same value. The key is versioned (`…​.v1`) so
 * an older copy of the plugin that happens to share the process keeps its own
 * symbol and its own data instead of reading a shape it does not understand.
 *
 * Rules for callers:
 * - keep the object **stable**: never replace a shared Map/Set, only clear or
 *   mutate it (another instance still holds the old reference);
 * - `init` must be cheap and side-effect free, because it only runs for the
 *   first instance (or after a test reset dropped the symbol).
 */

type SharedGlobals = typeof globalThis & Record<symbol, unknown>

const globals = globalThis as SharedGlobals

/** Symbol key for one shared singleton; exported for tests/diagnostics. */
export function sharedKey(name: string): symbol {
  return Symbol.for(`opencode.superagent.${name}.v1`)
}

/**
 * Return the process-wide singleton registered under `name`, creating it with
 * `init` on first use. Two module instances that ask for the same name get the
 * *same* object, not a copy.
 */
export function sharedSingleton<T>(name: string, init: () => T): T {
  const key = sharedKey(name)
  const existing = globals[key]
  if (existing !== undefined) return existing as T
  const created = init()
  globals[key] = created
  return created
}

/** Whether the singleton under `name` already exists (diagnostics/tests). */
export function hasSharedSingleton(name: string): boolean {
  return globals[sharedKey(name)] !== undefined
}
