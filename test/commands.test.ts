/**
 * `src/commands.ts` pins the registered slash names. `/tickets` is the
 * two-level browser (list → detail → session) scoped to the session's own
 * directory, `/alltickets` is the aggregate view over every partition,
 * `/ticket <id>` opens one ticket, and the deleted plain-text `/tickets` list
 * must not come back under any name. `tui.tsx` only maps each `run` key to its
 * handler, so these assertions cover what the prompt actually offers.
 */

import { describe, expect, test } from "bun:test"
import { COMMANDS } from "../src/commands.js"

const names = COMMANDS.map((command) => command.slash.name)

describe("registered slash commands", () => {
  test("the command set has no `/task` and no second ticket list", () => {
    // open, tickets, alltickets, abort, tools, ticket
    expect(names).toEqual(["superagent", "tickets", "alltickets", "abort", "tools", "ticket"])
    expect(names).not.toContain("task")
  })

  test("`/tickets` is the two-pane browser", () => {
    const tickets = COMMANDS.filter((command) => command.slash.name === "tickets")
    expect(tickets).toHaveLength(1)
    // `browse` is the only run key bound to the TicketBrowser flow.
    expect(tickets[0]!.run).toBe("browse")
    // A browser takes no argument: `/` inside the dialog is the search field.
    expect(tickets[0]!.slash.arguments).toBeUndefined()
    expect(tickets[0]!.id).toBe("superagent.tickets")
    expect(tickets[0]!.title).toBe("Superagent tickets")
  })

  test("`/alltickets` is the aggregate browser over every partition", () => {
    const all = COMMANDS.filter((command) => command.slash.name === "alltickets")
    expect(all).toHaveLength(1)
    // A separate run key: the aggregate view is not the directory-scoped one.
    expect(all[0]!.run).toBe("browseAll")
    expect(all[0]!.slash.arguments).toBeUndefined()
    expect(all[0]!.id).toBe("superagent.alltickets")
    expect(all[0]!.title).toBe("Superagent all tickets")
    // The help text points at the directory-scoped command.
    expect(all[0]!.description).toContain("/tickets")
    // The two browser commands are distinct, not a rename of one another.
    expect(all[0]!.run).not.toBe(
      COMMANDS.find((command) => command.slash.name === "tickets")!.run,
    )
  })

  test("`/ticket` keeps opening a single ticket and does not collide with `/tickets`", () => {
    const ticket = COMMANDS.find((command) => command.slash.name === "ticket")
    expect(ticket?.run).toBe("detail")
    expect(ticket?.slash.arguments).toBe(true)
    expect(ticket?.description).toContain("/tickets")
    // Exactly three ticket commands: the two browsers and the single-ticket opener.
    expect(names.filter((name) => name.includes("ticket"))).toEqual([
      "tickets",
      "alltickets",
      "ticket",
    ])
  })

  test("no slash name or alias is registered twice", () => {
    expect(new Set(names).size).toBe(names.length)
    const aliases = COMMANDS.flatMap((command) => command.slash.aliases ?? [])
    expect(new Set([...names, ...aliases]).size).toBe(names.length + aliases.length)
    expect(COMMANDS.filter((command) => command.slash.name === "tools")[0]!.slash.aliases).toEqual([
      "superagent-tools",
    ])
  })

  test("every command is palette-visible with a unique title and a run key", () => {
    const titles = COMMANDS.map((command) => command.title)
    expect(new Set(titles).size).toBe(titles.length)
    for (const command of COMMANDS) {
      expect(command.palette).toBe(true)
      expect(command.run.length).toBeGreaterThan(0)
    }
  })
})
