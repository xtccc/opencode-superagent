---
name: Superagent Release
description: Use when releasing opencode-superagent to npm and GitHub (version bump, CHANGELOG, release:check gate, tag, publish, registry verification, gh release, local plugin switch and rollback), or when a release step failed (EPUBLISHCONFLICT, 404 tarball, 401/2FA, gate failure, tag mismatch).
metadata:
  opencode/autoinvoke: true
---

# 发布 opencode-superagent

这份 skill 是仓库 `xtccc/opencode-superagent` 实际跑通过的发版路径（0.4.0 → 0.5.0，
2026-11-11）。照抄命令即可；每一步都写了「看到什么算成功」。

前置：在仓库根目录，`bun --version` ≥ 1.4，`gh auth status` 已登录，
`~/.npmrc` 里有 `//registry.npmjs.org/:_authToken=...`。
本机没有 Node/npm，用 `bun publish`；有 npm 时 `npm publish` 等价（两者都跑 `prepublishOnly`）。

---

## 1. 决定版本号

规则（0.x 阶段，semver 的 minor 承载破坏性变更）：

| 改动性质 | 版本 |
| --- | --- |
| 删/改公开面（slash 命令、RPC、dispatch 参数、配置字段类型） | **minor** |
| 纯新增 | minor |
| 只修 bug / 文档 / 内部重构 | patch |

0.4.0 → 0.5.0 的理由：删掉了纯文本 `/tickets` 列表，并把二级浏览器从 `/task` 改名为
`/tickets`，命令面破坏 → minor。

```sh
# 当前版本 = 上一个 tag，别用记忆里的版本
git describe --tags --abbrev=0        # 期望：v0.4.0
```

改版本只动这两处（README 里出现的版本号/体积数字顺手同步）：

```sh
# package.json "version"
# CHANGELOG.md
```

验证：`grep '"version"' package.json` 与 `git describe --tags --abbrev=0` 的差恰好是你打算发的这一步。

## 2. CHANGELOG

- 先把 `## Unreleased` 里的条目归位，再开新版本节：`## X.Y.Z — YYYY-MM-DD`。
- 四个固定分类：`### 🔥 Breaking` / `### Added` / `### Changed` / `### Fixed`。空的分类直接删掉。
- Breaking 必须写清「旧写法 → 新写法」，因为下面的 GitHub release notes 直接取自这里。
- 新 `## Unreleased` 留一句占位（本次是 `Nothing yet — see 0.5.0 below.`）。

验证：`sed -n '/## Unreleased/,/## 0\./p' CHANGELOG.md` 里没有遗留条目；
`grep -n '^## ' CHANGELOG.md | head -3` 第一行是 Unreleased、第二行是新版本。

## 3. 跑闸门 `bun run release:check`

四步，任一步非零直接退出（`script/release-check.ts`）：

```sh
bun run release:check
```

1. `bun run typecheck` 2. `bun run test` 3. `bun run build`
4. `bun pm pack --ignore-scripts` 到临时目录并用内置 ustar 解析器校验 tarball：

- 必须存在：`package/package.json`、`dist/server.js`、`dist/server.d.ts`、`dist/tui.js`、
  `dist/tui.d.ts`、`README.md`、`CHANGELOG.md`、`LICENSE`、
  `agent/superagent-router.md`、`agent/superagent-worker.md`
- 泄漏判定：非 `.d.ts` 的 `.ts/.tsx/.jsonc`，或 `package/{src,test,e2e,script,.github,node_modules,evidence}/`
- 打包内 `version` 必须等于 `package.json`（防止 stale pack）

成功标志（最后两行）：

```text
release-check: ok  tarball opencode-superagent-0.5.0.tgz carries 72 files, ... KiB, version 0.5.0
release-check: all gates passed; publishing may proceed
```

## 4. 提交 + annotated tag + push

```sh
git add package.json CHANGELOG.md README.md
git commit -m "chore(release): 0.5.0"   # body 写：为什么 bump、改了哪几处
git tag -a v0.5.0 -m "opencode-superagent 0.5.0"   # -m 里放 3~5 行摘要，和 CHANGELOG 一致
git push origin main
git push origin v0.5.0
```

验证：

```sh
git cat-file -t v0.5.0                    # 期望：tag（不是 commit）
git show -s --format=%B v0.5.0            # 有 tagger + 摘要
git ls-remote --tags origin v0.5.0        # 远端能看到
git status --short                        # 空
```

## 5. 发布

```sh
bun publish --access public
# 有 npm 的机器上等价： npm publish --access public
```

`prepublishOnly = bun run release:check` 会再跑一遍闸门，**不要**加 `--ignore-scripts` 绕过。

成功标志：输出里出现 `+ opencode-superagent@0.5.0`，文件数 72，
退出码 0，并提示已发布到 https://registry.npmjs.org/。

## 6. registry 核验（发布后必做）

```sh
V=0.5.0
# 6.1 dist-tags 指向新版本
curl -s https://registry.npmjs.org/opencode-superagent | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"
# 期望 {'latest': '0.5.0'}

# 6.2 tarball integrity：registry 的 sha512 必须等于本地 pack 产物的 sha512(base64)
rm -rf /tmp/relcheck && mkdir -p /tmp/relcheck
bun pm pack --destination /tmp/relcheck --ignore-scripts --quiet
openssl dgst -sha512 -binary /tmp/relcheck/opencode-superagent-$V.tgz | openssl base64 -A; echo
curl -s https://registry.npmjs.org/opencode-superagent/$V | python3 -c "import json,sys;print(json.load(sys.stdin)['dist']['integrity'])"
# 两行必须逐字符一致（前缀 sha512-）

# 6.3 包内文件表：命令表/agent 存在，禁止泄漏目录不存在
curl -s https://registry.npmjs.org/opencode-superagent/-/opencode-superagent-$V.tgz | tar tz \
  | grep -E '^(package/(dist|agent)/|package/(src|test|e2e|script)/)' | head -20
# 期望：只有 dist/ agent/ README CHANGELOG LICENSE package.json；不出现 src/ test/ e2e/ script/

# 6.4 与本地产物 diff 文件清单
diff <(tar tzf /tmp/relcheck/opencode-superagent-$V.tgz | sort) \
     <(curl -s https://registry.npmjs.org/opencode-superagent/-/opencode-superagent-$V.tgz | tar tz | sort)
# 期望：无输出
```

另外确认 `fileCount` 与 6.4 的文件数一致，且 `dist.tarball` 指向 `.../-/opencode-superagent-$V.tgz`。

## 7. GitHub release

notes 从 CHANGELOG 的新版本节生成（去掉标题行），非 prerelease，tag 已存在用 `--verify-tag`：

```sh
awk '/^## 0\.5\.0/{f=1;next}/^## /{f=0}f' CHANGELOG.md > /tmp/notes-0.5.0.md
gh release create v0.5.0 --title 0.5.0 --notes-file /tmp/notes-0.5.0.md --verify-tag
```

验证：

```sh
gh release view v0.5.0 --json tagName,isPrerelease,name
# 期望 {"isPrerelease":false,"name":"0.5.0","tagName":"v0.5.0"}
```

## 8. 本地插件从 local spec 切到 npm 正式版

我们的 local 形态是绝对路径 spec，指向
`C:/Users/tmzy/.cache/opencode-superagent-local/plugin/node_modules/opencode-superagent`
（版本形如 `0.5.0-local.20261111`）。切换：

```sh
CFG=/c/Users/tmzy/.config/opencode/opencode.json
cp "$CFG" "$CFG.bak-npmswitch-$(date +%Y%m%d-%H%M%S)"      # 先备份，回滚靠它
# 把 "plugins": ["C:/Users/.../opencode-superagent"] 改成 "plugins": ["opencode-superagent"]
opencode plugin update          # 拉 npm 正式版进缓存
```

验证（三者都要对）：

```sh
# a) 配置里只剩包名
grep -A2 '"plugins"' "$CFG"
# b) 缓存里的版本是 0.5.0，且 dist 字节与 registry tarball 一致
CACHE=$(ls -d /c/Users/tmzy/.cache/opencode/npm/opencode-superagent@latest/*/node_modules/opencode-superagent | tail -1)
grep '"version"' "$CACHE/package.json"                 # 期望 "0.5.0"
mkdir -p /tmp/npmtgz && cd /tmp/npmtgz && rm -rf package
curl -s https://registry.npmjs.org/opencode-superagent/-/opencode-superagent-0.5.0.tgz | tar xz
sha256sum package/dist/server.js "$CACHE/dist/server.js"   # 两行哈希相同
# c) 重启后日志只有新版本、无 local 标识
sh restart-service.sh
tail -n 50 ~/.local/share/opencode/log/opencode.log | grep -i superagent
# 期望：加载路径是 ~/.cache/opencode/npm/...，没有 superagent-local / local.
```

## 9. 回滚

```sh
CFG=/c/Users/tmzy/.config/opencode/opencode.json
cp "$CFG.bak-npmswitch-<时间戳>" "$CFG"    # 恢复成 local 绝对路径 spec
sh restart-service.sh
tail -n 50 ~/.local/share/opencode/log/opencode.log | grep -i superagent
# 期望：路径回到 .cache/opencode-superagent-local/...，版本是 0.5.0-local.*
```

代码层面的回滚就是 `git revert`/`git checkout v0.4.0` 后重新 build；不要手改 `dist/`（它被 tag 固化过）。

---

## 失败处置

### `EPUBLISHCONFLICT` / "cannot publish over the previously published versions"
已经发上去了（或别人先发了）。**不要改版本号重试**，直接进第 6 步核验：

```sh
curl -s https://registry.npmjs.org/opencode-superagent | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['dist-tags'], '0.5.0' in d['versions'])"
```
`latest` 已是目标版本 → 当作成功，继续 6/7/8。只有 `versions` 里没有、确实被占用才 bump patch。

### 刚发布后 tarball 404（Cloudflare 负缓存）
`curl` metadata 有版本但 `.../-/opencode-superagent-X.tgz` 404，是 CDN 负缓存，不是发布失败：

```sh
for i in 1 2 3 4 5; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/opencode-superagent/-/opencode-superagent-$V.tgz?cb=$(date +%s)")
  echo "try $i -> $code"; [ "$code" = 200 ] && break; sleep $((i*10))
done
```
加 `?cb=` 绕缓存；等 1~5 分钟再核验。期间不要重复 publish。

### 401 / 403 / 2FA
先诊断，别动版本号：

```sh
grep -o '^//registry.npmjs.org/:_authToken=.\{0,6\}' ~/.npmrc   # 确认 token 存在（别打印全文）
curl -s -H "Authorization: Bearer $(sed -n 's|^//registry.npmjs.org/:_authToken=||p' ~/.npmrc)" \
  https://registry.npmjs.org/-/whoami                          # 期望 {"username":"xtccc"}
```
- 401：token 过期/无 publish 权限 → `npm login` 或换 token。
- 403 + `one-time password`：账号开了 2FA → 加 `--otp=<6位>` 重发（`bun publish --otp=...`），
  先确认前一次没有实际成功（见 EPUBLISHCONFLICT）。
- 403 且 `cannot publish over` → 同 EPUBLISHCONFLICT。
- 确认 registry 没被 `~/.npmrc` 的 `registry=` 指到镜像：`npm config get registry`（无 npm 时看 ~/.npmrc）。

### `prepublishOnly` 闸门失败
输出里 `release-check: run ...` 之后紧跟着失败的那一步，就是唯一原因，原样修，**不要**用
`--ignore-scripts` / `--no-verify` 跳过。常见：类型错误（typecheck）、测试 flaky（重跑确认）、
tarball 缺入口（`dist/*.d.ts` 没产出，检查 `bun run build`）、tarball 版本不一致（先 pack 过旧产物，
清 `dist/` 重来）。修完先单独 `bun run release:check` 绿了再 publish。

### tag 与版本不一致
```sh
grep '"version"' package.json
git describe --tags --exact-match HEAD    # 期望 vX.Y.Z，且与 package.json 一致
git ls-remote --tags origin | grep "v$V"
```
- 本地 tag 错：`git tag -d vX.Y.Z` 后重打（只在未 push 时）。
- 已 push 且指向错提交：`git push origin :refs/tags/vX.Y.Z && git tag -a ... && git push origin vX.Y.Z`
  （GitHub 已有 release 时先 `gh release delete`）。
- 版本号本身错了但已发布：不发第二遍，直接发下一个 patch/minor，并在 CHANGELOG 说明。

## 收尾清单
- [ ] `git status` 干净，`v$V` 是 annotated tag 且已 push
- [ ] registry `latest == $V`，integrity 与本地 pack 一致，无禁止目录
- [ ] `gh release view` 非 prerelease
- [ ] 本地插件已切 npm 版，日志版本正确无 `local`
- [ ] 备份文件 `opencode.json.bak-npmswitch-*` 保留到下次发版
