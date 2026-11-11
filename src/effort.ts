/**
 * Reasoning efforts a dispatch may request for a worker.
 *
 * The level is a model *variant* (`model.variant`), not a per-prompt option:
 * `sessions.prompt` has no effort field, so it is fixed when the worker
 * session is created. A model advertises the levels it supports in its
 * `variants` list (`ctx.model.list()`), which is the whitelist — the server
 * stores an unknown variant instead of rejecting it.
 *
 * Kept in its own module so the tool catalog, the RPC contract and the
 * dispatcher share one list without importing each other (a `dispatch ↔ tools`
 * cycle would read the constant before it is initialized).
 */
export const DISPATCH_EFFORTS = ["low", "medium", "high", "max"] as const

export type DispatchEffort = (typeof DISPATCH_EFFORTS)[number]
