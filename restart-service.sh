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

echo "restarting opencode background service..."
"$BIN" service restart
sleep 3
echo "--- service status ---"
"$BIN" service status
echo "--- 验证：日志应只有 superagent 的 router/worker 行 ---"
echo "tail -n 50 ~/.local/share/opencode/log/opencode.log | grep -i 'superagent'"
