# 验证入口分层说明

> 目标：把“平时改代码该跑什么、发版前该跑什么、哪些检查依赖私有环境”说清楚。

## 三层验证入口

| 入口 | 命令 | 默认环境 | 用途 |
|------|------|----------|------|
| Fast | `npm run verify:fast` | 本地 / CI | 日常改动、热点重构、PR 前快速守卫 |
| Full | `npm run verify:full` | 本地 / CI | 完整功能回归、示例回归、memory-server 矩阵；不串联 coverage 治理门禁 |
| Release | `npm run verify:release` | 本地私有发布前 | 在 `full` 基础上追加 opt-in 真实环境检查 |

## 补充入口

| 命令 | 说明 |
|------|------|
| `npm test` | 默认统一门禁：smoke + compatibility + unit + integration；不再隐式跑 legacy compat runner 或迁移专用 runner |
| `npm run check:docs-examples` | 文档 / 示例一致性门禁：校验当前双语 slug 矩阵、runner 覆盖、共享示例目标、doc-check 目标和用户可见路径文本 |
| `npm run check:lint-contract` | 证明 ESLint flat config 对代表性 JavaScript、TypeScript、声明、测试、示例与 TSX 文件真实解析和检查 |
| `npm run check:doc-claims` / `check:error-contract` / `check:current-version` | 分别守卫数字性能证据、Data Task 错误码文档和当前 v3 / MongoDB 7.x-8.x 术语 |
| `npm run test:coverage` | 独立 `c8 --all` 覆盖率门禁：全局四项不低于 90%，六个风险模块满足局部 floor，并清理每轮唯一临时目录 |
| `npm run test:refactor-guard` | 热点重构三联回归：exports + runtime/model + sync |
| `npm run test:server-matrix` | Node 20/22 × Driver 6/7 × MongoDB 7/8 严格 memory-server 矩阵；复用当前 Node，Volta 只补齐缺失的 Node 20/22，数据库集成文件串行启动以避免自动端口竞争 |
| `npm run test:real-env:private` | 私有真实环境检查；默认不进入常规 verify / CI |
| `npm run release:preflight` | Node 22 严格单一真相源发布门禁：干净且已推送候选 + 发布元数据 + `verify:fast` + 默认测试 + coverage + examples + server matrix + dataTasks/CLI integration + license/audit + 临时安装 + Chromium 网站 verify + 最终 pack 边界 |
| `npm run test:pack-install` | 构建并打包候选版本，在临时消费者中安装 tarball，验证 CJS、ESM、dataTasks、schema-dsl、TypeScript、MIGRATION/SECURITY、bin、help 与 version |
| `npm --prefix website run verify` | 使用网站锁文件验证类型、Rspress 构建、站内链接、资产预算、必要搜索索引及大小统计、Chromium 键盘/移动/语言行为、axe WCAG A/AA 和依赖 audit |

memory-server 相关入口统一使用 `.cache/mongodb-memory-server/binaries` 作为二进制缓存，`.cache/mongodb-memory-server/db` 作为项目内临时数据目录；项目自动创建的 dbPath 会在脚本退出或 runtime close 时清理，避免默认系统临时目录堆积。

发布矩阵固定验证 MongoDB `7.0.37` / `8.0.26`。任一必需服务端、拓扑、Driver 或测试组合 unavailable/failed 时，`probe:server-matrix` / `test:server-matrix` 都会非零退出。Volta 可用时，`test:server-matrix` 只补齐当前环境缺失的 Node 20/22，不重复当前 major。

## 运行策略

### 1. 日常开发 / 小范围重构

```bash
npm run verify:fast
```

说明：当前 `verify:fast` 不再串联迁移专用 runner；它覆盖 lint、type-check、size strict、runtime smoke、compatibility、runtime/model/sync refactor guard 与 cache refactor guard。完整 unit / integration 默认门禁由 `npm test` 覆盖，发布预检会在 `verify:fast` 后继续执行 `npm test`。

`verify:fast` 已包含 `npm run check:docs-examples`，因此文档 / 示例漂移会在常规类型与运行时检查前被发现。

适合：

- 热点文件拆分
- 内部 helper 重构
- 类型和导出面调整

### 2. 完整交付 / 大范围改动

```bash
npm run verify:full
```

适合：

- 文档和示例联动更新
- 行为变更或跨模块重构
- 发版前的完整仓库回归

`verify:full` 同时包含 `npm run test:examples`，会在矩阵门禁确认当前双语文档覆盖后编译并执行全部 runnable examples。

### 3. 私有真实环境验证

```bash
npm run test:real-env:private
```

说明：

- 仅在具备私有 Mongo / SSH 等条件时执行
- 不作为默认 CI 阶段
- 主要用于验证 memory-server 无法覆盖的真实部署路径

需要的环境变量：

- `MONSQLIZE_REAL_SSH_HOST`
- `MONSQLIZE_REAL_SSH_PORT`
- `MONSQLIZE_REAL_SSH_USERNAME`
- `MONSQLIZE_REAL_SSH_PASSWORD`
- `MONSQLIZE_REAL_MONGO_URI`

## 默认边界

- **默认验证链**：`npm test` / `check:docs-examples` / `verify:fast` / `verify:full` / `test:server-matrix`
- **覆盖率门禁**：`npm run test:coverage` 仍可独立执行；`verify:full` 不串联它，但公开 CI 的 release-gate 与 `release:preflight` 强制执行
- **显式 opt-in**：`test:real-env:private`
- **公开发布前门禁**：`release:preflight`，仅接受工作树干净、依赖树有效且 `HEAD` 已存在于 `origin` 的候选
- **本地私有发布前补充**：`verify:release`

## 为什么 CI 不直接跑 `verify:release`

- `verify:release` 依赖私有 SSH / Mongo 环境变量，适合操作者在本地或私有 runner 明确触发。
- 公开 CI 与仓库默认验证链只承诺 memory-server + 仓库内可复现资产。
- 因此 GitHub Actions 的 `Release Preflight` workflow 故意只运行 `release:preflight`，不假设私有环境存在。

> 仓库同时提供 GitHub Actions `Release Preflight` workflow，支持手动触发和 `v*` tag 推送时复用同一套发布前门禁。

> 说明：`test:server-matrix` 只保留**跨 Driver / Server 组合下稳定可重复的兼容面**。像 sync target fan-out 统计这类更依赖 change-stream 时序的深度断言，继续由常规 integration、`test:refactor-guard` 和 `release:preflight` 覆盖。
