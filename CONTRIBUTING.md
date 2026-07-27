# 贡献指南

感谢您对 monSQLize 项目的兴趣！我们欢迎各种形式的贡献。

## 📋 目录

- 开发环境设置
- 提交流程
- 代码规范
- 测试要求
- CI/CD 流程

---

## 开发环境设置

### 1. Fork 并克隆项目

```bash
git clone https://github.com/YOUR_USERNAME/monSQLize.git
cd monSQLize
```

### 2. 安装依赖

```bash
npm ci  # 推荐使用 ci 保证依赖一致性
```

- npm 包运行时合同：Node.js `>=18`；CI 持续验证 Node 18/20/22。
- 发布与文档浏览器验证工具链：Node.js 22+。这不会抬高最终用户安装 `monsqlize` 的运行时门槛。

### 3. 运行当前校验

```bash
# 日常快速回归
npm run verify:fast

# 完整默认测试与覆盖率
npm test
npm run test:coverage

# 自动修复 Lint 问题
npm run lint:fix
```

---

## 提交流程

### 1. 创建分支

```bash
git checkout -b feature/your-feature-name
# 或
git checkout -b fix/your-bug-fix
```

### 2. 编写代码

- 遵循现有代码风格
- `src/types/test/examples/scripts` 与工程配置中的注释、错误、日志和测试标题使用英文；`docs/en` 使用英文，`docs/zh` 使用简体中文
- 确保当前有效校验通过

### 3. 运行当前校验

```bash
# 快速 PR 基线
npm run verify:fast

# 行为与覆盖率
npm test
npm run test:coverage

# 发布包真实消费者与站点
npm run test:pack-install
npm --prefix website run verify
```

> `npm run verify` 是日常完整功能链的一部分，但不等于发布门禁。发布维护者必须在 Node.js 22+ 上执行 `npm run release:preflight`；该入口还包含 coverage、真实 examples/server matrix、DataTask/CLI、license/audit、pack consumer 与 website browser 验证。

### 4. 提交更改

提交消息格式遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```bash
git commit -m "feat: 添加新功能描述"
git commit -m "fix: 修复BUG描述"
git commit -m "docs: 更新文档"
git commit -m "test: 添加测试"
git commit -m "refactor: 重构代码"
git commit -m "perf: 性能优化"
git commit -m "ci: CI/CD 相关更新"
```

### 5. 推送并创建 Pull Request

```bash
git push origin feature/your-feature-name
```

然后在 GitHub 上创建 Pull Request。

---

## 代码规范

### ESLint

项目使用 ESLint 进行代码检查：

```bash
# 检查代码
npm run lint

# 自动修复
npm run lint:fix
```

### 命名规范

- **变量/函数**: camelCase（如 `findOne`, `maxTimeMS`）
- **类**: PascalCase（如 `MonSQLize`, `CacheManager`）
- **常量**: UPPER_SNAKE_CASE（如 `MAX_RETRY_COUNT`）
- **文件名**: kebab-case（如 `find-page.js`）

### 注释规范

- 公共 API 在需要解释契约、边界或非显然行为时添加英文 JSDoc；不要为显然代码机械补注释
- 复杂逻辑使用英文行内注释解释“为什么”和边界，不复述代码
- 示例：

```javascript
/**
 * Finds one document with an optional projection and timeout.
 * @param {Object} filter - MongoDB query filter.
 * @param {Object} [options] - Query options.
 * @returns {Promise<Object|null>} The matching document, or null.
 */
async function findOne(filter, options = {}) {
    // Keep driver return semantics unchanged.
}
```

---

## 测试要求

### 分层验证要求

- 快速贡献：`npm run verify:fast`，并补受影响模块的定向测试。
- PR 默认：`npm test`、`npm run test:coverage`；公开包/CLI 改动追加 `npm run test:pack-install`。
- 文档/站点：`npm run check:docs-examples` 与 `npm --prefix website run verify`。
- 发布维护者：在 Node.js 22+ 上执行 `npm run release:preflight`；不得用 `npm run verify` 代替。
- 若改动影响公开类型、README 入口、示例或能力映射，请同步检查：
  - `docs/**`
  - `examples/**`
  - `test/validation/DOCS-EXAMPLES-MAPPING.md`
  - `test/validation/VERIFICATION-PROGRESS.md`
- 覆盖率是发布强制门禁：全局 statements/branches/functions/lines 均不得低于 90%，高风险模块还受独立 floor 约束。
- 提交前至少保证受影响路线通过；无法执行的命令必须在 PR 中列出原因和风险，不得写成“已验证”。

---

## CI/CD 流程

### 自动化工作流

项目使用 GitHub Actions 实现 CI/CD：

#### 1. **静态、类型与文件规模**

**触发条件**:
- 所有 Push 和 Pull Request

**执行内容**:
- TypeScript/JavaScript ESLint、文档示例矩阵、TypeScript/tsd 与 source/types/test 分类规模门禁

#### 2. **运行时、覆盖率与消费者验证**

当前仓库已经恢复 TS 重写后的验证链，提交前建议至少关注：

- Node 18/20/22 默认测试矩阵
- 全局覆盖率与高风险模块 floor
- MongoDB 7/8 server matrix、DataTask/CLI、生产依赖 license/audit
- 临时目录中的 CJS/ESM/types/bin 裸包 consumer
- 双语站点 build/link/budget/axe/keyboard/focus

### Pull Request 检查清单

在合并前，请确保：

- [ ] `npm run verify:fast` 与受影响测试通过
- [ ] coverage / pack / website 等条件路线已执行或写明未执行原因
- [ ] 无未解决的 Code Review 意见
- [ ] 提交消息符合规范
- [ ] 文档、changelog 与 Profile 已按影响同步

### 查看 CI 状态

- 访问 [Actions 页面](https://github.com/devcodex-labs/monSQLize/actions) 查看所有工作流
- Pull Request 页面会显示所有检查状态
- README 中的入口说明应与当前仓库现状一致

---

## 📚 文档要求

如果您的更改涉及 API 变更或新功能：

1. **更新 README.md**: 添加功能描述和示例
2. **同步 Profile / 任务产物**: 若修改仓库入口、命令或发布契约，维护者需同步 workspace namespace 中 monSQLize 的 Profile 与相关任务产物；普通外部贡献者在 PR 中说明影响即可
3. **维护当前 TS 文档/示例入口**: 当前仓库的 `docs/**`、`examples/**` 已作为新的 TS 版正式入口建立；其中官方示例统一使用 TypeScript。更新相关能力时，需同步维护这些入口，而不是回滚复制 `monSQLize-v1` 的旧目录内容
4. **更新 CHANGELOG.md**: 记录变更（由维护者负责）

---

## 🐛 报告问题

在 [GitHub Issues](https://github.com/devcodex-labs/monSQLize/issues) 提交问题时，请包含：

- **环境信息**: Node.js 版本、MongoDB 版本、操作系统
- **复现步骤**: 清晰的步骤说明
- **预期行为**: 您期望发生什么
- **实际行为**: 实际发生了什么
- **代码示例**: 最小化复现代码

---

## 💬 讨论与交流

- **GitHub Discussions**: [讨论区](https://github.com/devcodex-labs/monSQLize/discussions)
- **GitHub Issues**: [问题跟踪](https://github.com/devcodex-labs/monSQLize/issues)

---

## 📄 许可

By contributing code, you agree that your contribution will be released under the Apache License 2.0.

---

**感谢您的贡献！** 🎉

