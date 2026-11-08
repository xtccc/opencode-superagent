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

### 从 npm 安装（发布形态）

发布包名是 `opencode-superagent`，与主仓版本线解耦（独立从 `0.1.0` 起步），`exports` 指向预构建产物，不需要在本地编译 TypeScript 或 TSX：

```sh
opencode plugin add opencode-superagent
```

或在 `opencode.jsonc` 里按包名声明（TUI 会把包装进 opencode 自己的插件缓存目录）：

```jsonc
{
  "plugins": ["opencode-superagent"],
}
```

- `dist/server.js` 由 `tsc` 产出，`dist/tui.js` 由 `bun build` + `@opentui/solid/bun-plugin` 预打包。必须预打包的原因：OpenCode 的运行时 Solid transform 会跳过 `node_modules` 里的文件，直接发 `tui.tsx` 会留下裸 JSX，加载时报 `Cannot find module 'react/jsx-dev-runtime'`。
- `agent/*.md` 随包内置（见下面第 2 条），agent 定义由插件在 setup 里程序化注册，**不需要复制任何 markdown 文件**。
- 安装后同样要关闭 Location 空闲回收（见下面本地安装的第 3 条），然后重启 TUI。

### 本地开发安装（本仓库源码）

本仓库根就是插件包本身。

1. 在项目或全局 `opencode.jsonc` 中把插件目录加入 `plugins`。注意：相对路径是**相对于配置文件所在目录**解析的（OpenCode 上游 `config/plugin/source.ts` 的 `scan` 以 `path.dirname(entry.path)` 为基准 `resolve` 以 `./` 或 `../` 开头的目标），不是相对仓库根目录：

   项目级（配置文件是本仓库的 `.opencode/opencode.jsonc`，插件目录即仓库根，所以上一级是 `..`）：

   ```jsonc
   {
     "plugins": [".."],
   }
   ```

   写成 `"."` 会被解析到 `.opencode` 自身，加载失败（日志 `failed to load plugin … ENOENT`）。

   全局（配置文件是 `~/.config/opencode/opencode.jsonc`）：不要用相对路径；插件路径不支持 `~` 展开（只处理 `file://`、`./`、`../` 开头和绝对路径），请写本仓库的绝对路径：

   ```jsonc
   {
     "plugins": ["/abs/path/to/opencode-superagent"],
   }
   ```

   如果已有 `plugins`，追加该项，不要覆盖其他插件。

2. agent 定义由插件在 setup 里程序化注册（`src/agents.ts` 的 `registerAgents`），**不需要手工复制任何 agent 文件**。项目里已有的 `.opencode/agent/superagent-*.md` 仍然优先（文件覆盖注册的同名字段），可用于定制；想回到纯插件定义就删掉这些副本。
   - `agent/*.md` 只是模板：随包发布，用于定制参考，以及在旧内核（`editor.update` 不会为未知 id 兜底创建）上手工兜底。注册失败时插件会打一条 warn 日志并列出没注册上的 id。
   - 模板与代码里的定义由 `test/agent-definition.test.ts` 逐字段比对，改一边会立刻报错。
   - `superagent-router` 是 `mode: primary` + `hidden: true`，`superagent-worker` 是 `mode: subagent`。

3. 关闭 Location 空闲回收，避免后台 Worker 会话被当作空闲会话清理：

   ```jsonc
   {
     "experimental": {
       "location_idle_timeout": false,
     },
   }
   ```

   开发时把上述配置写进仓库根的 `.opencode/opencode.jsonc` 即可（本仓库不提交该文件）。

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
- TUI 右侧栏（42 列）里有一块「工单」面板，常驻显示工单清单，见下节「侧栏工单面板」。

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
- 联动：派发成功即原子绑定——写入 `workerSessionID`、`attempts` 追加一条、`state → in_progress`；绑定失败会回滚新建的 Worker 会话（不会出现「Worker 起来了但单没绑上」）。Worker prompt 头部附「工单 + objective + acceptance」；Worker `done/failed` 由 watcher 结单，`abort_session` 关闭为 `failed`；watchdog 只告警，不改状态也不结单。

## 侧栏工单面板

`tui.tsx` 通过公开 slot API 往 OpenCode 会话侧栏注册了一块只读面板，不改 OpenCode 上游 `packages/tui` / `packages/plugin` 任何源码：

```tsx
context.ui.slot({ append: "sidebar.content", render: () => <SidebarTickets context={context} /> })
```

- **位置**：`append: "sidebar.content"`，排在内置 Todo / MCP / Limit 模块之后；侧栏只有 42 列（`SESSION_SIDEBAR_WIDTH`），`sidebar.content` 的 slot input 只有 `sessionID`、没有宽度，所以面板按固定 36 cell 布局（42 − 4 padding − 1 滚动条列，再留 1 cell 余量）。
- **渲染**：
  - 标题行：`工单 <总数>`，有未结单时追加 ` · <N> 未结`（`open`/`in_progress`/`blocked` 计为未结）。
  - 每行：状态符号 + 标题 + 4 位短 ID（`tk_mw7tqs9a_ximd` → `ximd`）。符号与颜色按语义取 theme token：`●` 进行中（info）、`◆` 阻塞（warning）、`○` 待办、`✓` 完成（success）、`✗` 失败（error）、`⊘`/`·` 取消/被取代（muted）。
  - 排序：`in_progress` → `blocked` → `open` → 终态；同一状态内保持服务端 `listTickets` 的 `updatedAt` 倒序（稳定排序）。
  - 终态最多显示 3 条，其余折成 `… 另有 N 条已结`。
  - 截断：标题按**终端显示宽度**截断（CJK 算 2 cell），宽度预算 `36 − 符号1 − 空格1 − 短ID4 − 空格1 = 29`，再保守封顶 26 cell，超出用 `…`；`<text wrapMode="none" truncate>` 再兜一层，保证任何一行都不超宽。
- **数据与刷新**：数据来自既有 RPC `tickets({ limit: 20 })`（`ticket_list` 的渲染版），启动即拉一次，之后每 4s 轮询（`TICKET_PANEL_REFRESH_MS`）。面板只在侧栏可见时挂载（侧栏 `Show` 控制），组件 `onMount`/`onCleanup` 起停定时器，切到终端面板或隐藏侧栏后不再轮询；同一时刻只有一个请求在飞。
- **空态**：没有任何工单时整块不渲染（与内置 sidebar 模块一致），不占侧栏空间、不留空标题。
- **失败降级**：RPC 抛错时显示 `工单 读取失败`（warning 色）；已有列表时降级为标题行追加 ` · 读取失败`，保留上一次的旧数据，不抛错、不影响其他 sidebar 模块。
- **交互**：点击任意一行等同 `/ticket <id>`，弹窗显示该工单详情。slot 只提供渲染，不接管键盘，所以没有回车跳转。
- **为什么解析文本**：`tickets` RPC 只返回 `{ text }`。服务端 `server.ts` 属于后台服务的代码，改动需 `opencode service restart` 才能生效，而本次改动要求不动服务、只重启 TUI，所以面板把 `renderTicketList` 的文本解析回行（`src/ticket-view.ts` 的 `parseTicketList`）。解析对未知行是忽略而非报错；`test/ticket-view.test.ts` 用真实的 `renderTicketList` 输出做往返断言，格式一改测试就会红。
- **已知限制**：`sidebar.content` 的 slot input 没有宽度，面板按固定 36 cell 排；RPC 只给 `{ text }`，所以行数据靠解析、标题在换行处拼接会丢掉断行处的空格（随后统一按 26 cell 截断，不影响观感）；`tickets` 一次最多 20 条，标题里的 `工单 N` 是**本次返回的条数**，工单超过 20 张时不会显示真实总数。
- **验证步骤**（宽终端效果最直观，需要 ≥121 列才会自动显示侧栏）：
  1. 只改 TUI：重启 TUI（`bun run dev:live` 或重开 `opencode`），**不需要**重启后台服务；服务端本次没有改动。
  2. 打开一个 **root 会话**（子会话/Worker 会话按上游逻辑不显示侧栏）。
  3. 宽度 ≥121 列时侧栏自动出现；更窄或之前手动隐藏过，用 `Ctrl-x b`（`session.sidebar.toggle`，默认 leader `<leader>b`）切换。
  4. 有工单时应看到 `工单 N · M 未结` 与若干行 `<符号> <标题> <短ID>`，终态超过 3 条时末行为 `… 另有 N 条已结`。
  5. 无工单时整块消失（空态）。
  6. 窄屏（≤120 列）注意：上游 `session-frame.tsx` 只在 `width - verticalTabsWidth > 120` 时渲染右侧栏，所以此时 `Ctrl-x b` 不会有可见效果——需要把终端调宽，这不是本面板的限制。
  7. RPC 失败降级：停掉后台服务后，面板下一轮（≤4s）显示 `工单 读取失败`；恢复服务后自动回到列表。

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
  "plugins": ["/abs/path/to/opencode-superagent"],
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
- 所有存在的 Worker：无条件先 `session.interrupt`（未运行视为无害 no-op，但会清掉排队中的 prompt，避免 abort 返回后它才开始）。
- 运行中的 Worker：再 `session.wait` 等终态，超时 `ABORT_TIMEOUT_MS = 10s`（超时也会标记 `aborted` 并在结果里注明 `settle-timeout`）。
- 已结束的 Worker（`done`/`failed`/`idle`，或 `time.busy` 不新于 `time.idle`）：不等待，返回 `already-ended`；若 interrupt 清掉了排队 prompt，`lastReport` 记 `interrupted queued prompt`。
- KV 变更（`worker:<sessionID>`）：`state` 置为 `aborted`，`lastReport` 前缀 `aborted (<reason>) [<detail>]`（保留旧 report），`updatedAt` 刷新；**记录保留**，不删除，便于追溯。
- thread 亲和：从 `thread:<threadID>` 的 `workers` 列表移除该会话（列表空则删除该键），后续消息不再投给它；该 thread 没有其它可用 Worker 时，下条消息回落 Router 重新 `dispatch`。Worker 记录里的 `threads` 保留用于追溯。
- 竞态保护：`state` 在中断**之前**就置为 `aborted`，`watcher.ts` 的 `handleEnded`/`session.idle` 会跳过 `aborted`，避免中断落地时被改回 `idle`/`done` 或重复向 Router 报“已完成”。
- 批量结果返回数量与逐条清单（`aborted N, already ended M, session missing K`）。
- 已知限制：`aborted` 记录不会自动回收，只在下次进程启动 `hydrate` 时按会话是否存在清理；`stale` 会解除 thread 亲和，等于放弃该 thread 的“追问回到原 Worker”。

## 会话区分（title 前缀 / metadata）

- **判定以 metadata 为准**：Router 建会话写 `metadata.superagent = { role: "router" }`，Worker 写
  `{ role: "worker", threads }`（`src/session-meta.ts` 的 `superagentMetadata`）。title 用户可改，
  不作为判定依据。
- **身份工具函数**（`src/session-meta.ts`，供过滤/统计/后续 UI 复用）：
  `superagentRole(metadata)`、`isSuperagentSession(session)`、`isRouterSession(session)`、`isWorkerSession(session)`。
- **幂等回填**：`hydrateSessionMeta` 在进程启动 `hydrate` 之后，对 Router id 与 KV 里已知的 Worker 记录补写
  `metadata.superagent`（role 已匹配则跳过，其余 metadata 合并而非覆盖）。老会话因此跨重启也能被识别。
- **title 前缀就是 TUI 里的区分手段**：Worker 标题为 `🔧 worker-<thread 简写>-<任务摘要>`（`workerTitle`），
  Router 为 `🧭 router-main`。TUI 不做插件专有的渲染/装饰，用户靠会话列表里的这两个前缀辨认：`🔧 worker-…`
  是后台 Worker，`🧭 router-main` 是 Router。
- **metadata 只做持久化判定**：`metadata.superagent` 是身份判定的**权威**来源（过滤、统计、`hydrate` 回填、
  `abort_session` 校验都读它），但**不在 TUI 展示**——它不进 title，也不派生角标/列。title 前缀纯粹给人看，
  用户改名不影响任何判定。

## 文件结构

```text
.                              # 仓库根即本包
├── tui.tsx                      # TUI 入口：keymap、slash 命令、RPC 调用、侧栏工单面板
├── src/protocol.ts              # 服务端 RPC 契约（由服务端实现提供）
├── src/ticket-view.ts           # 侧栏面板的纯视图模型：解析 tickets 文本、排序、按 cell 截断
├── src/agents.ts                # Router/Worker agent 的程序化注册（插件 setup 调用）
├── src/                          # 服务端 Router/Worker/批处理实现
├── agent/
│   ├── superagent-router.md     # Router agent 模板（mode: primary，可按需定制，非运行必需）
│   └── superagent-worker.md     # Worker agent 模板（mode: subagent，可按需定制，非运行必需）
├── script/build.ts              # 构建：tsc（server + d.ts）→ bun build（tui.js）
├── tsconfig.json                # 类型检查（noEmit，含 test/script）
├── tsconfig.build.json          # 构建：server.ts + src → dist/*.js + *.d.ts
├── tsconfig.build.tui.json      # 构建：只为 tui.tsx 产出 dist/tui.d.ts
├── LICENSE                      # MIT（版权人占位，见「发布与构建」）
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
- **隐藏 Worker**：让 Worker 会话不出现在普通会话列表，只通过 Router 暴露进度（当前只做 title 前缀，未做过滤/分组）。
- **持久化与并发**：事件去重、断线重放、跨进程 thread 租约，以及多 TUI 实例的一致性。
- **工单 P1**：内存只保留最近 500 张单（更早的仍在 KV，重启后回到内存），跨进程/多实例的工单索引尚未同步；被中断但未 `abort_session` 的 Worker 会让工单停在 `in_progress`，需要 Router 手动推进。
- **工单 P2**：工单与验收标准的自动核验、按工单聚合的用量/成本统计、工单看板与通知推送。

## 开发

在插件包（本仓库根）内做类型检查：

```sh
bun run typecheck      # bun check（bun 1.4.0 没有该子命令，会报 Script not found）
bun run typecheck:tsc  # tsc --noEmit，CI 口径，推荐
```

测试用 `bun test`，在仓库根直接运行即可（本仓库不含上游的 `do-not-run-tests-from-root` 保护）。

## 发布与构建

```sh
bun run build          # 清空 dist/，tsc 产出 server + d.ts，bun build 产出 tui.js
npm pack --dry-run     # 预览 tarball（prepack/prepare 会各跑一次 build）
```

- **构建产物**：`dist/server.js` + `dist/server.d.ts` + `dist/src/*.js|.d.ts`（`tsc -p tsconfig.build.json`）；`dist/tui.js`（`Bun.build`，插件 `@opentui/solid/bun-plugin`，内联 `src/` 里 TUI 用到的纯函数）；`dist/tui.d.ts`（`tsc -p tsconfig.build.tui.json`，`emitDeclarationOnly`）。`dist/` 里没有任何 `.ts`/`.tsx` 入口，也没有指向源码的导入。
- **外置模块**：两份产物都把 `effect`、`@opencode/plugin`、`@opencode/client`、`@opentui/*`、`solid-js` 保持为裸导入。OpenCode 宿主提供这些单例，并会拒绝从插件 `node_modules` 加载 `effect`/`@opencode/plugin` 的副本。
- **依赖划分**：`@opencode/schema`（`Tool`、`AbsolutePath` 等运行时用的 schema 助手）是真正的 `dependencies`，宿主不提供它；`@opencode/plugin`、`effect`、`@opentui/solid`、`solid-js` 挂在 `peerDependencies` 且标 `optional`，因为它们只由宿主提供、npm 不该再装一份（`optional` 是为了避免裸 `npm install` 时的噪声告警）。
- **包字段**：`exports` 指向 `./dist/server.js` 与 `./dist/tui.js`（类型由同名 `.d.ts` 解析）；`files` 为 `dist`、`agent`、`README.md`、`LICENSE`；`publishConfig.access: public`。
- **包元数据**：`repository`/`homepage`/`bugs` 均指向 `xtccc/opencode-superagent`，`LICENSE` 版权人为 `xtccc`；这两处只影响元数据，不影响加载。
- **已知限制**：
  - `tui.d.ts` 只声明默认导出的 `Plugin.Definition`，不描述 `setup` 内部类型；TUI 插件是动态加载的，消费方通常只需要包名。
  - `dist/tui.js` 约 41 KB（未压缩，Solid JSX 编译结果 + 内联的 `src/` 纯函数），不包含 `solid-js`/`@opentui/solid`，那部分由宿主提供。
  - `@opencode/schema` 会带上自己的一份 `effect`（其 manifest 的 dependency）。运行时所有 `effect` 导入都被宿主接管，这份副本不会被求值，只是多占几 MB 磁盘。
  - 包版本 `0.1.0` 与主仓 `2.2.5` 解耦，发版需要单独 bump。

## Watchdog

后台 Worker 停滞检测与 pending 队列崩溃恢复（P0 只告警、不自动杀）。

- **检查间隔**：插件 scope 内 `Stream.tick` 每 60 秒跑一次（`src/watchdog.ts` 的 `WATCHDOG_INTERVAL_MS`），可用插件选项 `watchdogIntervalMs`（毫秒）覆盖。
- **停滞定义**：`state` 为 `running` 的 Worker，若其会话 `time.busy` 比当前早超过 30 分钟（`STALL_TIMEOUT_MS`，可用 `stallTimeoutMs` 覆盖），且 `time.idle` 没有新于 `busy` 的更新（执行期间 `idle` 只保留上一次执行的结束时间），视为停滞。
- **只告警不自动杀**：停滞后向 Router 注入一条 delivery `queue` 的提示（`Worker <sid>（<title>）已停滞 <N> 分钟，建议：stop 后重派或人工介入`）。不修改 Worker 的 `state`/`lastReport`，不结单，也不 interrupt；同一繁忙窗口只告警一次，避免误杀长任务和重复刷屏。
- **单轮错误隔离**：单个 Worker 检查失败只 `logWarning` 并继续下一个；整轮失败也只告警，循环永不退出。
- **pending 队列崩溃恢复**：入队时同步写 KV（键前缀 `pending:`，纯 JSON），flush 成功后删除该键；setup 时从 KV 读回未 flush 的 trigger 重新入内存队列（不自动建 Router，等下一次 `router` RPC 或新 trigger 时再 flush）。同一 id 重复入队会被去重。
- **status 无 Router**：Router 尚未创建时 `status` 返回 `{pending, workers}` 且不含 `router` 字段（显式 `undefined` 会导致输出校验失败，故直接省略该键）。
