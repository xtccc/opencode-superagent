# Superagent（P0 原型）

一个运行在 OpenCode TUI 中的双角色 agent 原型：**Router** 负责与人对话和分派任务，**Worker** 在自己的会话里执行单一任务。事件按 thread 直通：同一 thread 的后续消息不再经过 Router，而是直接投递给已经负责该 thread 的 Worker；短时间内到达的多条事件会合并批处理。

## 当前能力

- 一个 Router 会话：和用户交互，用 `dispatch` 并行派活。
- 多个 Worker 会话：各自独立执行任务，结束时把结论作为 report 交回 Router。
- thread 亲和（粘性续聊）：首次出现的事件进入 Router 建 Worker，后续事件回到同一 Worker 继续（已结束会被唤起，不会每句话建新会话）。
- 批处理：相邻事件合批，减少重复唤醒。
- TUI 入口：`/superagent` 打开 Router，`/superagent-demo` 注入一组演示事件并显示每条事件的路由结果，`/abort` 终止或清理 Worker，`/tools` 查看 Router 可用工具与能力边界，`/tickets` 浏览工单、`/ticket <id>` 看单张工单详情。

## 明确不做

- 没有内置的 IM 信道（GitHub、邮件、即时通讯等）：事件由 RPC `trigger` 注入，TUI 演示事件用于本地联调。
- Worker 会话不做隐藏，仍然出现在普通会话列表中，方便观察和排障。
- 没有 watchdog / 超时回收；Worker 卡住时不会自动重启或升级给 Router。
- 没有 Worker 反向派活：Worker 不能创建子任务给其他 Worker；长期上下文靠链式召回带回 Router。
- 没有生产级的持久化、去重和投递保证；这是 P0 原型。

## 安装与启用

1. 在项目或全局 `opencode.jsonc` 中把插件目录加入 `plugins`。注意：相对路径是**相对于配置文件所在目录**解析的（见 `packages/core/src/config/plugin/source.ts` 的 `scan`：以 `path.dirname(entry.path)` 为基准 `resolve` 以 `./` 或 `../` 开头的目标），不是相对仓库根目录：

   项目级（配置文件是 `.opencode/opencode.jsonc`，需上一级再进 `packages/`）：

   ```jsonc
   {
     "plugins": ["../packages/plugins/superagent"],
   }
   ```

   写成 `"./packages/plugins/superagent"` 会被解析成 `.opencode/packages/plugins/superagent`，加载失败（日志 `failed to load plugin … ENOENT`）。

   全局（配置文件是 `~/.config/opencode/opencode.jsonc`）：不要用相对路径；插件路径不支持 `~` 展开（只处理 `file://`、`./`、`../` 开头和绝对路径），请写绝对路径：

   ```jsonc
   {
     "plugins": ["/abs/path/to/opencode/packages/plugins/superagent"],
   }
   ```

   如果已有 `plugins`，追加该项，不要覆盖其他插件。

2. 放置 agent 定义：
   - 项目级：把 `agent/superagent-router.md` 和 `agent/superagent-worker.md` 复制到 `.opencode/agent/`。
   - 全局：复制到 `~/.config/opencode/agents/`。

   两个文件的 frontmatter 都只有 `description` 和 `mode`：
   `superagent-router.md` 是 `mode: primary`，`superagent-worker.md` 是 `mode: subagent`。

3. 关闭 Location 空闲回收，避免后台 Worker 会话被当作空闲会话清理：

   ```jsonc
   {
     "experimental": {
       "location_idle_timeout": false,
     },
   }
   ```

   本仓库的 `.opencode/opencode.jsonc` 已经包含上述配置。

4. 重启 TUI，确认插件加载成功。

## 使用

- 输入 `/superagent`（或在命令面板执行 `Superagent`）：通过 RPC 创建/获取 Router 会话并跳转过去。
- 输入 `/abort`（或命令面板 `Superagent abort worker`）：选择要终止的 Worker，或首项“清理全部已结束 worker”（`stale`）批量清理；结果显示在 toast 里。
- 输入 `/tools`（别名 `/superagent-tools`，或命令面板 `Superagent tools`）：按调度类/查询类/控制类分组列出 Router 当前可用的全部工具，每行显示风险等级（只读/可写/终止）与必填参数；选中某个工具后弹窗给出参数表（名称、必填、类型、说明）、确认方式与用法，末行“能力边界”列出 Router 不能做什么。清单来自 `src/tools.ts` 的工具注册表，新增工具无需改动该命令。
- 输入 `/superagent-demo`（或命令面板 `Superagent demo triggers`）：按下面的顺序注入 6 条演示事件，以便看到直通效果：
  1. 先调用 `router` 确保 Router 会话存在。
  2. 注入 `T-1` 的第 1 条事件，期望返回 `router`。
  3. 轮询 `status`（每 500ms 一次，最多 20 秒），直到 `status.workers` 中出现 `threads` 包含 `T-1` 的 Worker；轮询期间不发送其他 `T-1` 事件。
  4. 找到负责 `T-1` 的 Worker 后，再注入 `T-1` 的第 2、3 条事件，期望返回 `worker`。
  5. 最后注入 `T-2` 的 2 条、`T-3` 的 1 条事件；这些 thread 首次出现，期望返回 `router`。
- 相邻事件间隔 150ms，最后用 toast 汇总每条事件的返回路由：`thread=router`、`thread=worker` 或 `thread=dropped`；20 秒内没等到 `T-1` 的 Worker 时，toast 会附带 `T-1 wait timed out`。
- 演示命令先创建 Router 再注入事件，因此不需要靠“先失败再创建 Router”的兜底逻辑。

## 数据流

```text
用户输入 /superagent
        │
        ▼
TUI command ── rpc.router ──▶ 服务端创建/返回 Router 会话
        │
        ▼
trigger(threadID, source, author, text)
        │
        ├── thread 首次出现 ──▶ Router 会话
        │                          │ dispatch（可并行多次）
        │                          ▼
        │                        Worker 会话
        │                          │ report
        │                          ▼
        │                        Router 汇总 ──▶ 用户
        │
        └── thread 已知 ──▶ 直接投递该 thread 的 Worker
                             （相邻事件合批）
```

## 链式召回（Inline / Spill）

Router 的 system prompt 里只有短摘要（Inline）：worker 数量、pending 数量、trigger 总数，以及 `status` 的紧凑列表。完整信息按需取（Spill），不要猜：

| 工具                                                                                                           | 用途                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dispatch`                                                                                                     | 派活给后台 Worker，可并行多次调用                                                                              |
| `ticket_create({ threadID, title, objective, acceptance, directory, priority?, parentTicketID?, dedupeKey? })` | 建工单：`objective`/`acceptance`(1-10 条)/`directory` 必填，同 thread 同 dedupeKey 自动复用（reused=true）     |
| `ticket_list({ threadID?, status?, since?, limit? })`                                                          | 按 thread/状态/更新时间列工单（默认 20 条，上限 100），含 id/state/title/priority/更新时间/worker              |
| `ticket_update({ ticketID, status?, note? })`                                                                  | 按状态机推进工单（open→in_progress→blocked/done/failed/cancelled/superseded），非法迁移报错                    |
| `ticket_close({ ticketID, outcome, summary })`                                                                 | 结单：写 `closeReason`/`closedAt` 与 history                                                                   |
| `status`                                                                                                       | Router、pending、Worker、工单计数的紧凑摘要                                                                    |
| `thread_detail({ threadID, limit? })`                                                                          | 该 thread 的 trigger 列表（时间+作者+截断 300 字/条，默认 20 条）+ 订阅 workers 及其 state/lastReport          |
| `worker_detail({ sessionID, messages? })`                                                                      | Worker 的标题/threads/state/lastReport + 最近 N 条（默认 5，上限 10）assistant 消息文本（默认截断 1500 字/条） |
| `report_read({ sessionID, offset?, limit? })`                                                                  | 按字符区间读取 Worker 结束报告的**完整全文**（默认 4000 字/页，上限 20000），返回总长度与 nextOffset           |
| `abort_session({ sessionID?, reason?, all?, stale? })`                                                         | 终止/清理 Worker：中断、等待终态、标记 `aborted`、解除 thread 亲和（见下）                                     |

- 只有 Router 能调这些工具（`ticket_*`、`thread_detail`/`worker_detail`/`report_read`/`abort_session` 复用 `status` 的权限位，Router 会话已放行；其他会话直调会被拒绝）。
- Router 会话的权限位由 `src/tools.ts` 的目录派生（`ROUTER_PERMISSIONS`）：新增工具必须在 spec 里声明 `permission`，`Tool.snapshot` 会按该权限位过滤，漏声明会让工具从模型可见列表里消失。
- 所有 Spill 输出都是紧凑文本，`thread_detail`/`worker_detail` 单次总长度控制在 6000 字内，超出截断并注明；`report_read` 按页返回（默认 4000 字/页）。
- trigger 历史持久化在 KV（`trigger:<id>`，含全文、route、sessionID）：排队事件入队即记（全文，内存同步+KV 异步），flush 后补 `route=router`；直投 Worker 的事件由 prompt 钩子补记（文本与 Worker 可见格式一致）。hydrate 只加载最近 200 条（按 createdAt 倒序），`triggerTotal` 记总数。

## 工单（Ticket）

工单是「用户要什么 + 怎么算完成」的持久记录。Router 先建单再派活，Worker 的终态自动回写。核心原则：**先建单登记意图，再决定并行或串行；工单是账本，不是派发的副产品**——拆子任务先建全部子单（`parentTicketID`），完成后逐张结单。

- 状态机：`open → in_progress → blocked/done/failed/cancelled/superseded`；`blocked → in_progress` 可回；`done/failed/cancelled/superseded` 为终态，任何非法迁移都报错。`open` 也可直接 `done/failed/cancelled`（派活前就完成/放弃的情况）。
- 必填：`objective`、`acceptance`（1-10 条）、`directory`（绝对路径）；`acceptance` 为空直接拒绝建单，避免占位单。
- 去重：`dedupeKey` 缺省为 `sha1(source + threadID + 归一化 objective)`，建单前在同 thread 找 `open/in_progress` 的同键单，命中则返回原单并标 `reused=true`。
- authorization：自动取 Router 最近一次被投递的 trigger（`triggerID` + 原文摘要 ≤300 字），所以每张单都能追溯「用户当时怎么说的」。
- 存储：`ticket:<id>` 存全量记录；`ticketidx:status:<state>`、`ticketidx:thread:<threadID>`、`ticketidx:all` 是按 createdAt 倒序的派生索引（各截断 200 项）。hydrate 扫 `ticket:` 前缀重建内存与索引，索引丢失不会丢单；历史 Worker 不回填工单。
- 强制：`dispatch` 的 `ticketID` 必填（工具与 RPC 同一实现）。缺失、单据不存在、单据已关闭（非 `open/in_progress`）、`threadID` 与单据不符、或单据已绑定运行中的 Worker，一律拒绝并给出可操作提示；RPC 直达同样被拦。
- 联动：派发成功即原子绑定——写入 `workerSessionID`、`attempts` 追加一条、`state → in_progress`；绑定失败会回滚新建的 Worker 会话（不会出现「Worker 起来了但单没绑上」）。Worker prompt 头部附「工单 + objective + acceptance」；Worker `done/failed` 由 watcher 结单，`abort_session` 与 watchdog 置 `failed`（note=aborted / stalled）。

## 单网关多目录（Router 自管，用户无需暴露映射表）

所有目录共用一个网关进程，Router 自主管理目录映射，用户只说自然语言
（如“去 ai-gw 修登录”），Router 解析并记住：

- `dispatch` 支持 `directory`（绝对路径），透传给 `sessions.create location`，
  Worker 落到目标目录干活；网关进程本身的目录只是缺省值，不重要。
- 目录推断优先级：消息中的绝对路径 > 历史 thread 绑定（事件文本标注“已知目录”）
  > 已知别名映射（状态行 `dirs:`）> 网关默认目录。
- KV 持久化：`dir:thread:<threadID>` 与 `dir:alias:<小写别名>`；`dispatch` 带目录时
  自动记住 thread 绑定与目录 basename 别名（如 `/opt/ai-gw` 记住 `ai-gw`），
  重启后 `hydrateDirs` 读回。
- 缺失映射时用网关默认目录派发，并在回复中向用户确认正确路径，待用户告知后记住；
  绝不编造不存在的路径。

全局注册（多目录可用）：在 `~/.config/opencode/opencode.jsonc` 注册一次插件即可，
所有目录共用同一网关，无需每个目录单独配置：

```jsonc
{
  "plugins": ["/abs/path/to/opencode/packages/plugins/superagent"],
}
```

## 粘性续聊（thread 亲和）

- 同一 thread 的追问默认**回到上一个 Worker 继续**：运行中直接收，已结束（done/idle）会被唤起继续，不会每句话建新会话。
- 只有全新 thread（该 thread 没有 Worker 记录）或上一个 Worker 失败了，消息才进 Router → `dispatch` 建新 Worker。
- 事件入口通过 RPC 注入（TUI 的 `/superagent-demo`，或任何调用 `trigger` 的客户端）；
  `trigger` 的 `source` 可用插件选项 `sources` 过滤，未配置则全部放行。
- 插件选项 `worker_detail_message_limit` 控制 `worker_detail` 单条消息截断字数（默认 1500，夹在 200–4000 之间）。
- Worker 结束（`succeeded`/`failed`/`interrupted`）时，`watcher.ts` 把结论写回 Router：
  完整报告先写入 `report:<sessionID>`（KV，全文，上限 20 万字），Worker 记录只留 2000 字摘要
  `lastReport` 供 `status`/`worker_detail` 使用；注入 Router 的事件带上
  「全文长度 N，可用 report_read 读取」句柄，用 `report_read({ sessionID, offset?, limit? })` 翻页读全文。

## 终止会话（abort_session）

用户明确要求“终止/清理 Worker”时用 `abort_session`（`src/abort.ts`）：

- 参数：`sessionID`（单个）或 `all: true` / `stale: true`（批量），可选 `reason`；两者不可同时给。
  - `stale: true`：只清理 `done`/`failed`/`idle`/`aborted` 的记录，不中断运行中的 Worker。
  - `all: true`：全部 Worker 都终止，运行中的先中断。
- 单个终止的校验顺序：调用者自身 → Router 会话 → 必须是 superagent 记录的 Worker；用户手动会话、未知 sessionID 一律拒绝（不会误删用户会话）。
- 运行中的 Worker：先 `session.interrupt`（优雅中断，`resume: false`，不重放队列），再 `session.wait` 等终态，超时 `ABORT_TIMEOUT_MS = 10s`（超时也会标记 `aborted` 并在结果里注明 `settle-timeout`）。
- 已结束的 Worker（`done`/`failed`/`idle`，或 `time.busy` 不新于 `time.idle`）：不发中断信号，只做清理语义，返回 `already-ended`。
- KV 变更（`worker:<sessionID>`）：`state` 置为 `aborted`，`lastReport` 前缀 `aborted (<reason>) [<detail>]`（保留旧 report），`updatedAt` 刷新；**记录保留**，不删除，便于追溯。
- thread 亲和：从 `thread:<threadID>` 的 `workers` 列表移除该会话（列表空则删除该键），后续消息不再投给它；该 thread 没有其它可用 Worker 时，下条消息回落 Router 重新 `dispatch`。Worker 记录里的 `threads` 保留用于追溯。
- 竞态保护：`state` 在中断**之前**就置为 `aborted`，`watcher.ts` 的 `handleEnded`/`session.idle` 会跳过 `aborted`，避免中断落地时被改回 `idle`/`done` 或重复向 Router 报“已完成”。
- 批量结果返回数量与逐条清单（`aborted N, already ended M, session missing K`）。
- 已知限制：`aborted` 记录不会自动回收，只在下次进程启动 `hydrate` 时按会话是否存在清理；`stale` 会解除 thread 亲和，等于放弃该 thread 的“追问回到原 Worker”。

## 会话区分（title 前缀 / metadata / 列表角标）

- **判定以 metadata 为准**：Router 建会话写 `metadata.superagent = { role: "router" }`，Worker 写
  `{ role: "worker", threads }`（`src/session-meta.ts` 的 `superagentMetadata`）。title 用户可改，
  不作为判定依据。
- **身份工具函数**（`src/session-meta.ts`，供过滤/统计/后续 UI 复用）：
  `superagentRole(metadata)`、`isSuperagentSession(session)`、`isRouterSession(session)`、`isWorkerSession(session)`。
- **幂等回填**：`hydrateSessionMeta` 在进程启动 `hydrate` 之后，对 Router id 与 KV 里已知的 Worker 记录补写
  `metadata.superagent`（role 已匹配则跳过，其余 metadata 合并而非覆盖）。老会话因此跨重启也能被识别。
- **title 前缀**：Worker 标题为 `🔧 worker-<thread 简写>-<任务摘要>`（`workerTitle`），Router 为
  `🧭 router-main`。前缀只用于列表里肉眼可辨；用户改名不影响识别。
- **TUI 角标**：Sessions 列表（`packages/tui/src/component/dialog-session-list.tsx`）用
  `sessionRoleBadge`（`packages/tui/src/util/session.ts`）在行右侧显示 `[worker]` / `[router]`：
  metadata 优先，绑定 agent（`superagent-worker` / `superagent-router`）兜底，手动会话无角标。

## 文件结构

```text
packages/plugins/superagent/
├── tui.tsx                      # TUI 入口：keymap、slash 命令、RPC 调用
├── src/protocol.ts              # 服务端 RPC 契约（由服务端实现提供）
├── src/                          # 服务端 Router/Worker/批处理实现
├── agent/
│   ├── superagent-router.md     # Router agent 模板（mode: primary）
│   └── superagent-worker.md     # Worker agent 模板（mode: subagent）
└── README.md
```

TUI 侧只依赖 `src/protocol.ts` 导出的 `Definition`（`id: "opencode.superagent"`）与 `src/tools.ts` 的工具目录（`/tools` 直接渲染它，不发 RPC），当前使用六个方法：

- `router({}) -> { sessionID }`：创建或返回 Router 会话。
- `status({}) -> { router?, pending, workers }`：查看 Router 与各 Worker 的 thread 归属，演示命令用它等待 `T-1` 的 Worker 就绪。
- `trigger({ source, threadID, author?, text, title?, createdAt?, id? }) -> { route, sessionID? }`：注入一条事件，`route` 为 `router` / `worker` / `dropped`。
- `abort({ sessionID?, reason?, all?, stale? }) -> { text }`：终止/清理 Worker，被拒绝时抛 `abort.rejected`（带可读 message）。TUI 的 `/abort`（或命令面板 “Superagent abort worker”）会列出 Worker 供选择，首项是“清理全部已结束 worker”。
- `tickets({ threadID?, status?, limit? }) -> { text }` / `ticket({ ticketID }) -> { text }`：渲染工单列表（按状态分组，窄终端友好）与单张工单的详情；对应 `/tickets` 与 `/ticket <id>`。

## 已知限制与下一步

- **反向派活与接管**：Worker 不能创建子任务，Router 也不能在多轮后重新接管 thread。
- **Watchdog**：检测长时间无进展的 Worker，超时后取消、重试或交还 Router。
- **真实信道**：把 TUI 演示事件换成 IM、GitHub issue/comment、Webhook 等来源，并补上签名与去重。
- **隐藏 Worker**：让 Worker 会话不出现在普通会话列表，只通过 Router 暴露进度（当前只做 title 前缀 + `[worker]` 角标，未做过滤/分组）。
- **持久化与并发**：事件去重、断线重放、跨进程 thread 租约，以及多 TUI 实例的一致性。
- **工单 P1**：内存只保留最近 500 张单（更早的仍在 KV，重启后回到内存），跨进程/多实例的工单索引尚未同步；被中断但未 `abort_session` 的 Worker 会让工单停在 `in_progress`，需要 Router 手动推进。
- **工单 P2**：工单与验收标准的自动核验、按工单聚合的用量/成本统计、工单看板与通知推送。

## 开发

在插件包目录内做类型检查：

```sh
bun run --cwd packages/plugins/superagent typecheck
```

不要在仓库根目录直接运行测试（仓库有 `do-not-run-tests-from-root` 保护）；需要跑测试时进入对应包目录。

## Watchdog

后台 Worker 停滞检测与 pending 队列崩溃恢复（P0 只告警、不自动杀）。

- **检查间隔**：插件 scope 内 `Stream.tick` 每 60 秒跑一次（`src/watchdog.ts` 的 `WATCHDOG_INTERVAL_MS`），可用插件选项 `watchdogIntervalMs`（毫秒）覆盖。
- **停滞定义**：`state` 为 `running` 的 Worker，若其会话 `time.busy` 比当前早超过 30 分钟（`STALL_TIMEOUT_MS`，可用 `stallTimeoutMs` 覆盖），且 `time.idle` 没有新于 `busy` 的更新（执行期间 `idle` 只保留上一次执行的结束时间），视为停滞。
- **只告警不自动杀**：停滞后向 Router 注入一条 delivery `queue` 的提示（`Worker <sid>（<title>）已停滞 <N> 分钟，建议：stop 后重派或人工介入`），并把该 Worker 记为 `failed`（`lastReport` 前缀 `watchdog: stalled <N>m`）。不 interrupt，避免误杀长任务。
- **单轮错误隔离**：单个 Worker 检查失败只 `logWarning` 并继续下一个；整轮失败也只告警，循环永不退出。
- **pending 队列崩溃恢复**：入队时同步写 KV（键前缀 `pending:`，纯 JSON），flush 成功后删除该键；setup 时从 KV 读回未 flush 的 trigger 重新入内存队列（不自动建 Router，等下一次 `router` RPC 或新 trigger 时再 flush）。同一 id 重复入队会被去重。
- **status 无 Router**：Router 尚未创建时 `status` 返回 `{pending, workers}` 且不含 `router` 字段（显式 `undefined` 会导致输出校验失败，故直接省略该键）。
