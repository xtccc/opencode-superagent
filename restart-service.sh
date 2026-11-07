#!/bin/sh
# 重启 OpenCode 后台服务（改完 superagent 插件代码后生效用）。
# 用法： sh packages/plugins/superagent/restart-service.sh
# 说明：插件 server.ts 改动需重启才生效；只改 gui bundle 才免重启。
set -eu

BIN="${OPENCODE_BIN:-$HOME/.opencode/bin/opencode}"

if [ ! -x "$BIN" ]; then
  echo "找不到 opencode 二进制：$BIN（可用 OPENCODE_BIN 覆盖）" >&2
  exit 1
fi

# Token 只判空、不打印。正式环境 Token 来自登录 shell 的 ~/.zshrc 导出。
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "WARN: 当前 shell 没有 TELEGRAM_BOT_TOKEN，重启后 Telegram 适配器会停用" >&2
  echo "      先执行：export TELEGRAM_BOT_TOKEN='<BotFather token>'（不要回显到聊天里）" >&2
fi

echo "restarting opencode background service..."
"$BIN" service restart
sleep 3
echo "--- service status ---"
"$BIN" service status
echo "--- 验证：应有一行 telegram polling enabled（token 正常）或 telegram disabled（无 token）---"
echo "tail -n 50 ~/.local/share/opencode/log/opencode.log | grep -i 'superagent telegram'"
