# 发布前检查与故障恢复

## 命令

```bash
# 发布与文档工具链要求 Node.js 22；包消费者运行时仍为 Node.js >=18。
npm run release:preflight
```

也可以通过 GitHub Actions 手动触发 **Release Preflight** workflow。`v*` tag 与 npm 发布 workflow 必须经过同一门禁。preflight 不会创建 tag、发布 npm 包或部署文档。

## 它会做什么

1. 拒绝存在未提交文件、无效安装依赖树或当前提交尚未推送到 `origin` 的候选版本。
2. 检查 `package-lock.json` 是否与当前 `package.json` 版本一致，且不包含 `file:` / `workspace:` / sibling 本地路径残留。
3. 检查当前 `package.json` 版本对应的 changelog 文件，以及包内 `MIGRATION.md` / `SECURITY.md` 是否存在。
4. 检查工程治理必需文档是否存在：
   - `docs/en/support-matrix.md`
   - `docs/en/file-dependency-governance.md`
   - `docs/en/verification-entrypoints.md`
   - `docs/zh/support-matrix.md`
   - `docs/zh/file-dependency-governance.md`
   - `docs/zh/verification-entrypoints.md`
5. 执行快速静态/运行时门禁和完整公开验证链。
6. 强制执行源码 coverage、可运行示例、MongoDB server matrix、真实 dataTasks integration、CLI matrix 与 package-install smoke。
7. 使用干净安装与 Chromium 验证文档站类型、构建、站内链接、资产/搜索预算、键盘与移动导航、语言切换、axe WCAG A/AA 和依赖审计。
8. 执行 `npm pack --dry-run` 并核对打包边界。
9. `prepublishOnly` 与仓库发布路径共用同一个 `release:preflight` 真相源，直接 publish 也不能绕过门禁。
10. `verify:release` 仍是显式执行的私有真实环境补充检查，不能代替公开门禁；未配置私有环境时必须记录 `skipReason`，不能伪报通过。

## 为什么不是直接 publish

这个脚本的目标是把**版本信息、公开验证链、依赖发布边界、打包可消费性**先收口，再进入人工确认的 release / tag / publish 阶段。

## 推荐顺序

```bash
git status
git commit
git push origin HEAD
# 等待当前提交的远端 CI 通过，然后在同一干净提交上执行：
npm run release:preflight
# 手动运行 Release Authentication Check workflow，验证 GitHub OIDC 就绪。
# 确认 npm 包已信任 devcodex-labs/monSQLize 的 publish.yml，且允许 npm publish。
# 可选的私有真实环境复核：npm run verify:release
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

`release:preflight` 会校验当前 `HEAD` 已存在于 `origin`，因此不能在未提交或仅本地存在的候选上运行。创建 tag 前必须确认当前提交的远端 CI、preflight 证据、**Release Authentication Check** 成功，以及 npm 侧可信发布者配置。在 `monsqlize` 包设置中选择 GitHub Actions，填写组织 `devcodex-labs`、仓库 `monSQLize`、工作流文件名 `publish.yml`，环境留空，并允许 `npm publish`。探针只验证 runner 能请求 OIDC 凭据；npm 在实际 `npm publish` 时才验证可信发布者。探针和 preflight 都不会创建或推送 tag，也不会发布。

tag 会启动仓库 preflight 与 publish workflow，此时不要部署 Pages。registry 验收通过后，手动运行 **Deploy Docs to GitHub Pages**，传入 `release_tag=vX.Y.Z`；该 workflow 会检出指定 tag，并在 tag、`package.json` 与 npm registry 版本不一致时拒绝部署。

如果 tag 触发的 publish 因认证或 registry 可用性等可恢复原因失败，可以用同一个已存在的 `release_tag` 手动重跑 publish workflow。workflow 会检出并校验该 tag 的 commit，不能把默认分支上的未打 tag 提交直接发布。

## 发布后验收

创建或确认 GitHub Release 前，对准确版本执行：

```bash
VERSION=$(node -p "require('./package.json').version")
npm view "monsqlize@${VERSION}" version dist.integrity dist.tarball --registry=https://registry.npmjs.org/
npm view monsqlize dist-tags --json --registry=https://registry.npmjs.org/

TEMP_DIR=$(mktemp -d)
npm --prefix "${TEMP_DIR}" init -y
npm --prefix "${TEMP_DIR}" install "monsqlize@${VERSION}" --registry=https://registry.npmjs.org/
node -e "const M=require('${TEMP_DIR}/node_modules/monsqlize'); if (!M) process.exit(1)"
node --input-type=module -e "import M from '${TEMP_DIR}/node_modules/monsqlize/dist/esm/index.mjs'; if (!M) process.exit(1)"
"${TEMP_DIR}/node_modules/.bin/monsqlize" --version
```

验收要求：目标版本、integrity 与 tarball 元数据存在；`latest` 指向预期稳定版；CJS、ESM 与 CLI 均可加载；Git tag 指向发布提交；GitHub Release 与 Pages 也引用同一个 tag。

## 半发布故障恢复

任何修正前先记录 `VERSION`、上一稳定版、发布提交与 registry 证据：

```bash
VERSION=$(node -p "require('./package.json').version")
PREVIOUS_STABLE=2.0.6
RELEASE_COMMIT=$(git rev-parse HEAD)
npm view "monsqlize@${VERSION}" version dist.integrity --json --registry=https://registry.npmjs.org/ || true
npm view monsqlize dist-tags --json --registry=https://registry.npmjs.org/
git ls-remote --tags origin "refs/tags/v${VERSION}"
```

- **tag 已存在、npm 版本不存在：** 保持不可变 tag 指向已复核提交，修复认证或 workflow 后重跑 preflight，再对同一 tag 重跑 publish；不要部署文档。
- **npm 版本已存在、tag 或 GitHub Release 缺失：** 先核对 registry integrity，再在 `RELEASE_COMMIT` 创建并推送 `v${VERSION}`，GitHub Release 必须基于该 tag。不得移动消费者可能已经获取的 tag。
- **缺陷版本已经成为 `latest`：** 先把 `latest` 恢复到上一稳定版；保留缺陷版本供审计并标记 deprecated；发布新的修正版后再前移 `latest`。

```bash
npm dist-tag add "monsqlize@${PREVIOUS_STABLE}" latest
npm dist-tag add "monsqlize@${VERSION}" next
npm deprecate "monsqlize@${VERSION}" "已被取代；修正版发布前请使用 ${PREVIOUS_STABLE}"
```

- **Pages 与 npm 不一致：** 用最后一个通过 npm 校验的稳定 tag 运行 Pages workflow；未发布或版本不一致会被 workflow 拒绝。
- **registry integrity 与复核包不一致：** 立即停止。npm 版本不可覆盖；不得重新指向 tag 或在同一版本上重发，应保留证据并调查后发布新版本。
