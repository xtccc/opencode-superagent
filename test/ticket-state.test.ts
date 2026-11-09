import { describe, expect, test } from "bun:test"
import {
  ACTIVE_STATES,
  allowedTransitions,
  canTransition,
  closeOutcomeForWorkerState,
  findActiveTicketForWorker,
  isTerminalState,
  TICKET_STATES,
  transitionError,
  workerCloseSummary,
  type TicketState,
} from "../src/ticket-state.js"
import {
  ACTIVE_STATES as STORE_ACTIVE_STATES,
  isTerminalState as storeIsTerminalState,
  TICKET_STATES as STORE_TICKET_STATES,
} from "../src/ticket.js"
import { isWorkerTerminal, TERMINAL_WORKER_STATES, type WorkerState } from "../src/worker-state.js"

// ── pure state machine ────────────────────────────────────────────────────────

describe("ticket-state: terminal states and transitions", () => {
  const allowed: Record<TicketState, ReadonlyArray<TicketState>> = {
    open: ["in_progress", "blocked", "done", "failed", "cancelled", "superseded"],
    in_progress: ["blocked", "done", "failed", "cancelled", "superseded"],
    blocked: ["in_progress", "done", "failed", "cancelled", "superseded"],
    done: [],
    failed: [],
    cancelled: [],
    superseded: [],
  }

  test("only closed states are terminal", () => {
    const terminal = TICKET_STATES.filter((state) => isTerminalState(state))
    expect(terminal).toEqual(["done", "failed", "cancelled", "superseded"])
    for (const state of ["open", "in_progress", "blocked"] as const) expect(isTerminalState(state)).toBe(false)
  })

  test("allowedTransitions exposes exactly the documented moves", () => {
    for (const state of TICKET_STATES) expect([...allowedTransitions(state)]).toEqual([...allowed[state]])
  })

  test("canTransition accepts no-op moves and rejects moves out of a closed state", () => {
    for (const state of TICKET_STATES) expect(canTransition(state, state)).toBe(true)
    for (const from of TICKET_STATES) {
      for (const to of TICKET_STATES) {
        const expected = from === to || allowed[from].includes(to)
        expect({ from, to, allowed: canTransition(from, to) }).toEqual({ from, to, allowed: expected })
      }
    }
  })

  test("transitionError explains a closed ticket and lists legal moves otherwise", () => {
    expect(transitionError("done", "in_progress")).toContain("already closed")
    expect(transitionError("done", "in_progress")).toContain("done")
    expect(transitionError("open", "in_progress")).toBeUndefined()
    expect(transitionError("open", "done")).toBeUndefined()
    expect(transitionError("open", "open")).toBeUndefined()
    const wrong = transitionError("blocked", "blocked") // same-state is a no-op
    expect(wrong).toBeUndefined()
    const illegal = transitionError("in_progress", "open")
    expect(illegal).toContain("illegal transition in_progress -> open")
    expect(illegal).toContain("blocked")
  })
})

// ── worker terminal states ────────────────────────────────────────────────────

describe("worker-state: terminal worker states", () => {
  const terminal = (state: WorkerState) => state === "done" || state === "failed" || state === "aborted"

  test("done/failed/aborted are terminal; running and idle are not", () => {
    expect([...TERMINAL_WORKER_STATES]).toEqual(["done", "failed", "aborted"])
    for (const state of ["running", "idle", "failed", "done", "aborted"] as const) {
      expect({ state, terminal: isWorkerTerminal(state) }).toEqual({ state, terminal: terminal(state) })
    }
    // `idle` stays non-terminal on purpose: a resumed session must not be re-dispatched onto.
    expect(isWorkerTerminal("idle")).toBe(false)
  })
})

// ── closed-outcome helpers ────────────────────────────────────────────────────

describe("ticket-state: worker close helpers", () => {
  test("only done/failed ends close a ticket", () => {
    expect(closeOutcomeForWorkerState("done")).toBe("done")
    expect(closeOutcomeForWorkerState("failed")).toBe("failed")
    expect(closeOutcomeForWorkerState("idle")).toBeUndefined()
    expect(closeOutcomeForWorkerState("aborted")).toBeUndefined()
    expect(closeOutcomeForWorkerState("running")).toBeUndefined()
  })

  test("close summary prefers summary, then note, then the generated line", () => {
    expect(workerCloseSummary({ sessionID: "ses_1", outcome: "done", summary: "SUMMARY", note: "NOTE" })).toBe(
      "SUMMARY",
    )
    expect(workerCloseSummary({ sessionID: "ses_1", outcome: "failed", note: "NOTE" })).toBe("NOTE")
    expect(workerCloseSummary({ sessionID: "ses_1", outcome: "done" })).toBe("done (worker ses_1)")
    expect(workerCloseSummary({ sessionID: "ses_1", outcome: "failed" })).toBe("failed (worker ses_1)")
    // An empty explicit summary is still honoured (only the store compacts it).
    expect(workerCloseSummary({ sessionID: "ses_1", outcome: "done", summary: "" })).toBe("")
  })
})

// ── active ticket selector ────────────────────────────────────────────────────

describe("ticket-state: findActiveTicketForWorker", () => {
  const ticket = (workerSessionID: string | undefined, state: TicketState) => ({ workerSessionID, state })

  test("returns the in-progress ticket bound to the worker", () => {
    const candidates = [ticket("ses_a", "open"), ticket("ses_b", "in_progress")]
    expect(findActiveTicketForWorker(candidates, "ses_b")).toBe(candidates[1]!)
  })

  test("ignores tickets bound to another worker or in a non-active state", () => {
    expect(findActiveTicketForWorker([ticket("ses_b", "done")], "ses_b")).toBeUndefined()
    expect(findActiveTicketForWorker([ticket("ses_b", "open")], "ses_b")).toBeUndefined()
    expect(findActiveTicketForWorker([ticket("ses_b", "blocked")], "ses_b")).toBeUndefined()
    expect(findActiveTicketForWorker([ticket("ses_b", "in_progress")], "ses_c")).toBeUndefined()
    expect(findActiveTicketForWorker([], "ses_b")).toBeUndefined()
    expect(findActiveTicketForWorker([ticket(undefined, "in_progress")], "ses_b")).toBeUndefined()
  })

  test("keeps insertion order when a session is on several tickets", () => {
    const first = ticket("ses_b", "in_progress")
    const second = ticket("ses_b", "in_progress")
    expect(findActiveTicketForWorker([first, second], "ses_b")).toBe(first)
    expect(findActiveTicketForWorker([second, first], "ses_b")).toBe(second)
  })

  test("works on the real ticket map iterator shape", () => {
    const map = new Map<string, ReturnType<typeof ticket>>([
      ["tk_1", ticket("ses_b", "in_progress")],
      ["tk_2", ticket("ses_b", "in_progress")],
    ])
    expect(findActiveTicketForWorker(map.values(), "ses_b")).toBe(map.get("tk_1")!)
  })
})

// ── public API compatibility ──────────────────────────────────────────────────

describe("ticket.ts re-exports the extracted state model", () => {
  test("the store still exposes the same constants and predicates", () => {
    expect([...STORE_TICKET_STATES]).toEqual([...TICKET_STATES])
    expect([...STORE_ACTIVE_STATES]).toEqual([...ACTIVE_STATES])
    expect(storeIsTerminalState("done")).toBe(true)
    expect(storeIsTerminalState("blocked")).toBe(false)
  })
})

// ── cycle guard ───────────────────────────────────────────────────────────────

describe("module layering", () => {
  const read = (name: string) => Bun.file(new URL(`../src/${name}`, import.meta.url)).text()

  test("the ticket layer no longer imports state.ts", async () => {
    const ticket = await read("ticket.ts")
    expect(ticket).not.toMatch(/from\s+["']\.\/state(?:\.js)?["']/)
    // Nor does it reach the store through another path.
    expect(ticket).not.toMatch(/from\s+["']\.\/state\.[jt]s["']/)
  })

  test("the shared pure modules import neither side of the old cycle", async () => {
    for (const name of ["ticket-state.ts", "worker-state.ts"]) {
      const source = await read(name)
      expect({ name, state: /from\s+["']\.\/state(?:\.js)?["']/.test(source) }).toEqual({ name, state: false })
      expect({ name, ticket: /from\s+["']\.\/ticket(?:\.js)?["']/.test(source) }).toEqual({ name, ticket: false })
    }
  })
})
