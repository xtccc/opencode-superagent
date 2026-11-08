import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "path"
import { ROUTER_PROMPT } from "../src/prompts.js"

// The router agent markdown only carries identity (mode, description, hidden) and a
// one-line body. Every behavioral rule lives in ROUTER_PROMPT, which the context hook
// injects each step. These assertions keep the markdown from growing back into a
// second, drifting copy of the rules.
const packageRoot = path.join(import.meta.dir, "..")
const packageAgentPath = path.join(packageRoot, "agent", "superagent-router.md")
// Repository root, where the runtime actually loads `.opencode/agent/*.md`.
const projectAgentPath = path.join(packageRoot, "..", "..", "..", ".opencode", "agent", "superagent-router.md")

const MAX_BODY_LENGTH = 200
const FORBIDDEN_BODY_TERMS = ["dispatch", "ticket_", "工具", "工单"]

function splitFrontmatter(text: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) throw new Error("agent markdown is missing frontmatter")
  return { frontmatter: match[1]!, body: text.slice(match[0].length).trim() }
}

const packageText = readFileSync(packageAgentPath, "utf8")
const { frontmatter, body } = splitFrontmatter(packageText)

describe("superagent router agent markdown", () => {
  test("frontmatter keeps identity fields and hides the fake router from agent pickers", () => {
    expect(frontmatter).toContain("description:")
    expect(frontmatter).toMatch(/^mode:\s*primary$/mu)
    expect(frontmatter).toMatch(/^hidden:\s*true$/mu)
  })

  test("body is a short identity stub, not a rulebook", () => {
    expect(body.length).toBeGreaterThan(0)
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH)
    for (const term of FORBIDDEN_BODY_TERMS) expect(body).not.toContain(term)
  })

  test("body does not restate ROUTER_PROMPT sections", () => {
    const ruleLines = ROUTER_PROMPT.split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
    expect(ruleLines.length).toBeGreaterThan(0)
    for (const line of ruleLines) expect(body).not.toContain(line)
  })

  test("ROUTER_PROMPT still carries the ticket-first contract", () => {
    expect(ROUTER_PROMPT).toContain("工单优先")
    expect(ROUTER_PROMPT).toContain("ticket_create")
    expect(ROUTER_PROMPT).toContain("ticket_close")
  })

  test.skipIf(!existsSync(projectAgentPath))("project .opencode/agent copy is identical", () => {
    expect(readFileSync(projectAgentPath, "utf8")).toBe(packageText)
  })
})
