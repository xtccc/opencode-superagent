# Superagent（P0 原型）

一个运行在 OpenCode TUI 中的双角色 agent 原型：**Router** 负责与人对话和分派任务，**Worker** 在自己的会话里执行单一任务。事件按 thread 直通：同一 thread 的后续消息不再经过 Router，而是直接投递给已经负责该 thread 的 Worker；短时间内到达的多条事件会合并批处理。

## 当前能力

- 一个 Router 会话：和用户交互，用 `dispatch` 并行派活。
- 多个 Worker 会话：各自独立执行任务，结束时把结论作为 report 交回 Router。
- thread 亲和：首次出现的事件进入 Router，后续事件直投该 thread 的 Worker。
- 批处理：相邻事件合批，减少重复唤醒。
- TUI 入口：`/superagent` 打开 Router，`/superagent-demo` 注入一组演示事件并显示每条事件的路由结果。

## 明确不做

- 除 Telegram 外没有其他真实信道（GitHub、邮件等）；TUI 演示事件仍可用于本地联调。
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

| 工具                                      | 用途                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `dispatch`                                | 派活给后台 Worker，可并行多次调用                                                                         |
| `status`                                  | Router、pending、Worker 的紧凑摘要                                                                        |
| `thread_detail({ threadID, limit? })`     | 该 thread 的 trigger 列表（时间+作者+截断 300 字/条，默认 20 条）+ 订阅 workers 及其 state/lastReport     |
| `worker_detail({ sessionID, messages? })` | Worker 的标题/threads/state/lastReport + 最近 N 条（默认 5，上限 10）assistant 消息文本（截断 500 字/条） |

- 只有 Router 能调这四个工具（`thread_detail`/`worker_detail` 复用 `status` 的权限位，Router 会话已放行；其他会话直调会被拒绝）。
- 所有 Spill 输出都是紧凑文本，单次总长度控制在 4000 字内，超出截断并注明。
- trigger 历史持久化在 KV（`trigger:<id>`，含全文、route、sessionID）：排队事件入队即记（全文，内存同步+KV 异步），flush 后补 `route=router`；直投 Worker 的事件由 prompt 钩子补记（文本与 Worker 可见格式一致）。hydrate 只加载最近 200 条（按 createdAt 倒序），`triggerTotal` 记总数。

## Telegram 接入（MVP）

Bot API 长轮询接入：私聊/群消息映射为 `trigger({ source: "telegram", ... })`，
复用 `router`/`status`/`trigger`/`stop` 契约；Router 只做 `dispatch`/`status`，
Telegram 适配器是 Worker 侧的 ingress/egress，不新增 RPC 方法、不改 Router prompt。

### 配置

Token 读取顺序（永不落明文、不打日志）：

1. 插件选项 `telegramBotToken`（仅用于本地调试，不要提交到仓库），
2. 插件选项 `telegram.botToken`（同上），
3. 环境变量 `TELEGRAM_BOT_TOKEN`（推荐）。

私聊白名单（把 Bot 变私人）：插件选项 `telegramAllowedChatIDs`
（或 `telegram.allowlist` / `telegram.allowedChatIDs`），环境变量
`TELEGRAM_ALLOWED_CHAT_IDS`（逗号分隔）做后备。配置后白名单外的 chat
（私聊 chat id == user id，群是负数）直接丢弃、不回包；发送侧同样过滤。
不配置则保持开放（兼容旧行为）。

Router 接管对话：插件选项 `telegramViaRouter`（或 `telegram.viaRouter`，
环境变量 `TELEGRAM_VIA_ROUTER=1`）为 true 时，每条 Telegram 消息都进
Router 派发新 Worker；运行中的 Worker 结束后自动解绑 thread，下条消息
回到 Router。默认 false（粘性直投：同 thread 追问直达运行中的 Worker）。

`sources` allowlist 已有值时必须加上 `"telegram"`，否则新消息会被 `dropped`。
未配置（allowlist 缺失会打 `logWarning`，无 Token 则打 `logInfo` 并停用适配器，
其他功能不受影响）。

```jsonc
{
  "plugins": ["../packages/plugins/superagent"],
  "sources": ["demo", "telegram"],
  // 私有 Bot：只允许自己的私聊 chat id（== user id），陌生人消息直接丢弃
  "telegramAllowedChatIDs": [708532537],
  // Router 接管对话：每条 Telegram 消息都经 Router 派发新 Worker，不粘旧会话
  "telegramViaRouter": true,
}
```

```sh
export TELEGRAM_BOT_TOKEN="<BotFather token>"
```

群组注意：Bot 需在 BotFather 关闭 privacy mode（或把 Bot 拉进群给管理员），
否则收不到群普通消息。论坛话题按 `message_thread_id` 区分（见映射表）。

### 按钮化状态管理（inline keyboard + commands）

只用文字也能干活，但状态都藏在服务端。Telegram 侧现在有两层可见入口，
共用同一份实时状态查询（`ctx.model.list()` 看模型、`sessions.get` 看
Router/Worker 的模型与目录、`store` 看 Router/pending/Workers）：

- 命令（客户端 `/` 菜单，启动时由 `setMyCommands` 注册）：`/menu` `/models`
  `/dir` `/workers` `/status` `/stop`（`/start`/`/help` 同 `/menu`）。
- 内联按钮（`callback_data` 形如 `sa:menu` / `sa:models:<page>` /
  `sa:mset:<page>:<idx>` / `sa:dir` / `sa:dset:<idx>` / `sa:workers` /
  `sa:wdetail:<sessionID>` / `sa:wstop:<sessionID>` / `sa:status`，64 字节内，
  下标每次按实时列表解析，服务端无缓存）：

| 入口 | 内容 | 动作 |
|------|------|------|
| `/menu` 主菜单 | 2×2 按钮 | 进模型/目录/Workers/状态视图 |
| `/models` | Router 当前模型 + 可用模型分页（8/页，✓ 标记当前） | 点按钮 `session.switchModel` 切 Router，新 Worker 跟随 Router 模型（`dispatch` 既有镜像逻辑） |
| `/dir` | Router 当前目录、服务默认目录、最近 Worker 目录候选；或 `/dir /绝对路径` | 点按钮/`/dir` 用 `session.move` 搬 Router，新 Worker 跟随 Router 目录（`dispatch` 新增镜像逻辑） |
| `/workers` | 运行中（🟢，每行详情+停止按钮）与历史（✅/❌/💤，最近 10 条） | 详情看标题/state/threads/结论；停止调 `session.interrupt` |
| `/status` | Router、模型、目录、pending/triggers/workers 计数 + 最近 12 个 Worker | 刷新按钮 |
| Worker 结论回执 | 结论正文 + 主菜单按钮行 | 一键回到各视图 |

回调走 `callback_query`（`allowed_updates` 已加），每个回调必回
`answerCallbackQuery`（消 loading，失败只告警）；按钮编辑原消息
（`editMessageText`，失败只打日志、不重发，避免刷屏）；白名单同样校验
回调来源 chat；token 永不打日志。轮询仍是单实例单 fiber，
`callback_query` 只是同循环里的新分支，不新增实例、不改偏移持久化。

### TelegramID ↔ threadID 映射
| Telegram 侧                  | threadID          | 回复目标                      |
| ---------------------------- | ----------------- | ----------------------------- |
| 私聊 `chat.id = 123`         | `telegram:123`    | `sendMessage(chat_id=123)`    |
| 群 `chat.id = -456`          | `telegram:-456`   | `sendMessage(chat_id=-456)`   |
| 话题 `topic = 7` 的群 `-456` | `telegram:-456:7` | 带 `message_thread_id=7` 回写 |

`author` 取 `@username`，没有用户名时取 `first_name`，都没有则省略。
去重键为 `telegram:<chat>:<message_id>`（Router 路径复用 pending 去重；
`update_id` 偏移持久化在 KV `telegram:offset`，崩溃重启后断点续拉）。

### 回复链路

- 新 thread：先回一条 `已收到，正在处理…` ack，消息进 Router → `dispatch` 建 Worker。
- 同 thread 后续消息：直投已订阅该 thread 的 Worker（`server.ts` 既有逻辑）。
- Worker 结束（`succeeded`/`failed`/`interrupted`）时，`watcher.ts` 在写回 Router
  的同时调 `reportWorkerToTelegram` 把 `lastReport`（截断 4000 字）发回对应聊天。
- `/start` 回帮助文本 + 主菜单按钮；命令（`/models` 等）只回对应视图，不进 trigger；非文本消息（贴纸/图片/系统消息）直接跳过。

### 本地验证（无 Token 也可做前两步）

1. 类型检查：`bun run --cwd packages/plugins/superagent typecheck` 通过。
2. 不设 Token 启动，日志应有 `superagent telegram disabled`，`/superagent-demo`
   仍可用（适配器停用不影响既有链路）。
3. 设 `TELEGRAM_BOT_TOKEN` + `sources` 含 `telegram` 后重启，日志应有
   `superagent telegram polling enabled`。
4. 给 Bot 发 `/start`，应收到帮助文本；发一句任务，应先收到 ack，
   Worker 完成后收到结论；`thread_detail({ threadID: "telegram:<chatID>" })`
   可看到该 thread 的 trigger 历史。
5. 群组验证：在群里发任务，确认同一群后续追问直达同一 Worker
   （`status` 里该 Worker 的 `threads` 包含对应 `telegram:` thread）。

### 已知限制

- 单进程轮询：多实例同时跑会抢 `getUpdates`（后启动的拿不到消息）；生产多副本
  需要换 webhook 或加分布式锁。
- 崩溃窗口内重放的消息只有 Router 路径去重，直投 Worker 的路径可能重复投递一次。
- 一个 Worker 订阅多个 thread 时，report 会发给其中所有 Telegram 聊天。
- 无鉴权：任何能和 Bot 说话的人都能派任务；私用给 Bot 设强随机 token，群用
  考虑后续加 allowlist（chat id 白名单）。

## 文件结构

```text
packages/plugins/superagent/
├── tui.tsx                      # TUI 入口：keymap、slash 命令、RPC 调用
├── src/protocol.ts              # 服务端 RPC 契约（由服务端实现提供）
├── src/telegram.ts              # Telegram 接入适配器（long polling ingress + worker report egress）
├── src/                          # 服务端 Router/Worker/批处理实现
├── agent/
│   ├── superagent-router.md     # Router agent 模板（mode: primary）
│   └── superagent-worker.md     # Worker agent 模板（mode: subagent）
└── README.md
```

TUI 侧只依赖 `src/protocol.ts` 导出的 `Definition`（`id: "opencode.superagent"`），当前使用三个方法：

- `router({}) -> { sessionID }`：创建或返回 Router 会话。
- `status({}) -> { router?, pending, workers }`：查看 Router 与各 Worker 的 thread 归属，演示命令用它等待 `T-1` 的 Worker 就绪。
- `trigger({ source, threadID, author?, text, title?, createdAt?, id? }) -> { route, sessionID? }`：注入一条事件，`route` 为 `router` / `worker` / `dropped`。

## 已知限制与下一步

- **反向派活与接管**：Worker 不能创建子任务，Router 也不能在多轮后重新接管 thread。
- **Watchdog**：检测长时间无进展的 Worker，超时后取消、重试或交还 Router。
- **真实信道**：把 TUI 演示事件换成 IM、GitHub issue/comment、Webhook 等来源，并补上签名与去重。
- **隐藏 Worker**：让 Worker 会话不出现在普通会话列表，只通过 Router 暴露进度。
- **持久化与并发**：事件去重、断线重放、跨进程 thread 租约，以及多 TUI 实例的一致性。

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
