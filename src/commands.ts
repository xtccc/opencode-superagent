/**
 * The TUI slash commands as data, so the command set can be pinned by
 * `test/commands.test.ts` without loading the Solid renderer.
 *
 * `tui.tsx` maps each `run` key to the handler of the same name; the table
 * itself carries only ids, titles and slash names. Exactly one command owns a
 * slash name: `/tickets` is the two-level browser, `/ticket` opens a single
 * ticket, and there is no plain-text ticket list command.
 */

/** Handler key: `tui.tsx` binds each one to a function in this file's sibling module. */
export type CommandRun = "open" | "browse" | "abort" | "tools" | "detail"

/** One command, minus the handler the renderer adds. */
export interface CommandSpec {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly palette: true
  readonly slash: {
    readonly name: string
    readonly aliases?: string[]
    /** Keeps the slash command in the prompt and passes its raw input to `run`. */
    readonly arguments?: true
  }
  readonly run: CommandRun
}

/** The registered commands, in palette order. */
export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: "superagent.open",
    title: "Superagent",
    palette: true,
    slash: { name: "superagent" },
    run: "open",
  },
  {
    id: "superagent.tickets",
    title: "Superagent tickets",
    description:
      "浏览工单 / worker 两级列表：⏎ 看详情、/ 搜索、q 退出；详情里 ⏎ 进入该 worker 会话、q 返回。支持标题、全 ID、4 位短 ID（如 dc8d）搜索；只看一张用 /ticket <短ID>",
    palette: true,
    slash: { name: "tickets" },
    run: "browse",
  },
  {
    id: "superagent.abort",
    title: "Superagent abort worker",
    palette: true,
    slash: { name: "abort" },
    run: "abort",
  },
  {
    id: "superagent.tools",
    title: "Superagent tools",
    palette: true,
    slash: { name: "tools", aliases: ["superagent-tools"] },
    run: "tools",
  },
  {
    id: "superagent.ticket",
    title: "Superagent ticket detail",
    description:
      "看单张工单详情：/ticket <4 位短 ID 或全 ID>（如 /ticket dc8d）；要浏览并搜索全部工单用 /tickets",
    palette: true,
    slash: { name: "ticket", arguments: true },
    run: "detail",
  },
]
