# CHANGELOG

> Summary index — the latest stable release details are in [changelogs/v3.2.0.md](./changelogs/v3.2.0.md); the earlier RC note remains an unpublished rehearsal archive.
> **Last updated**: 2026-08-07

---

## Version Overview

| Version | Date | Summary | Details |
|---------|------|---------|---------|
| [v3.2.0](./changelogs/v3.2.0.md) | 2026-08-07 | Minor: Vector Search APIs, relation-safe Model deletion, and relation projection improvements | [View](./changelogs/v3.2.0.md) |
| [v3.1.0](./changelogs/v3.1.0.md) | 2026-07-15 | Minor: schema-dsl v3 GA consumption, canonical validation errors, and normalized full-document persistence | [View](./changelogs/v3.1.0.md) |
| [v3.0.0](./changelogs/v3.0.0.md) | 2026-07-14 | Major: two-instance preview/apply/restore data tasks, write-path policy, runtime-scoped schema DSL, stricter OCC/sync/query contracts, and release recovery controls | [View](./changelogs/v3.0.0.md) |
| [v2.0.7](./changelogs/v2.0.7.md) | Unpublished | Withdrawn patch candidate; never published and superseded by v3.0.0 | [Archive](./changelogs/v2.0.7.md) |
| [v2.0.6](./changelogs/v2.0.6.md) | 2026-06-15 | Patch: dependency alignment to `schema-dsl@2.0.11` so downstream frameworks inherit the ESM/CJS shared custom type registry fix | [View](./changelogs/v2.0.6.md) |
| [v2.0.5](./changelogs/v2.0.5.md) | 2026-06-13 | Patch: Model schema adapter delegates DSL type authority to `schema-dsl@2.0.10`, removing the duplicated monSQLize allowlist while preserving legacy aliases and business literals | [View](./changelogs/v2.0.5.md) |
| [v2.0.4](./changelogs/v2.0.4.md) | 2026-06-12 | Patch: production-safe Model index rollout controls, `schema-dsl@2.0.9`, capability-index wording cleanup, and documentation home refinements | [View](./changelogs/v2.0.4.md) |
| [v2.0.3](./changelogs/v2.0.3.md) | 2026-06-11 | Patch: v1 compatibility fixes, public stats APIs, standalone docs-site link safety, bilingual docs consistency, and release preflight alignment | [View](./changelogs/v2.0.3.md) |
| [v2.0.2](./changelogs/v2.0.2.md) | 2026-06-09 | Patch: direct runtime, optional and development dependencies pinned to exact versions for deterministic consumer installs | [View](./changelogs/v2.0.2.md) |
| [v2.0.1](./changelogs/v2.0.1.md) | 2026-06-03 | Patch: model collection/pool compatibility, automatic-index task dedupe, runtime cache/pool v1 smooth-upgrade fixes, and current docs/types alignment | [View](./changelogs/v2.0.1.md) |
| [v2.0.0](./changelogs/v2.0.0.md) | 2026-06-01 | 🎉 **v2.0.0 — TypeScript rewrite**: full TypeScript source, cache-hub integration, schema-dsl `^2.0.3` TS dependency, Apache-2.0 licensing, English README, MultiLevel cache support, v1 API compat preserved, optimized npm artifact boundary without default sourcemaps, JSDoc coverage complete, `getPoolStats/getPoolHealth` keyed by pool name, v1 compat fixes included, workspace smooth-upgrade bridge validated for downstream consumers | [View](./changelogs/v2.0.0.md) |
| [v1.3.0](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.3.0.md) | 2026-04-27 | 🆕 **新功能**：链式池访问 API — `pool(name)` / `use(dbName)` / `scopedCollection()` / `scopedModel()` 四个公开方法，支持多连接池多数据库路由，connection 合并语义，TypeScript 类型签名完整覆盖 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.3.0.md) |
| [v1.2.3](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.3.md) | 2026-04-26 | 🐛 **Bug Fix**：`model()` 方法修复注册 key 直接作为 MongoDB 集合名的问题，优先读 `definition.collection > definition.name`，注册 key 仅作 fallback，向后兼容 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.3.md) |
| [v1.2.2](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.2.md) | 2026-04-24 | 🆕 **新功能**：Model 数据源绑定 — `connection: { pool?, database? }` 支持 Model 绑定指定连接池和/或数据库，四种组合路由，向后兼容；🐛 **Bug Fix**：修复 `Model._clear()` 导致 `msq.model()` 实例缓存失效失效，populate 关系丢失问题 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.2.md) |
| [v1.2.1](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.1.md) | 2026-04-13 | 🐛 **Bug 修复**：`msq.model()` 实例缓存 + 索引去重 + 死代码清理 + `types/monsqlize.ts` 补全 `model()` / `collection()` 类型 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.1.md) |
| [v1.2.0](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.0.md) | 2026-04-13 | 🐛 **Bug 修复 + 新功能**：`findPage` 正式支持 `projection` 投影参数（修复静默忽略问题）+ 有效投影策略自动保护游标排序字段 + 8 个测试用例 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.2.0.md) |
| [v1.1.9](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.9.md) | 2026-04-02 | 🚨 **P1 Bug 修复**：MultiLevelCache L2→L1 回填 TTL 缺失（null 永久驻留 L1）+ 新增 `backfillLocalTTL` 配置 + Redis `getWithTTL` 方法 + 14 个回归测试 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.9.md) |
| [v1.1.8](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.8.md) | 2026-03-16 | 🆕 **新功能**：Model 热重载支持（`undefine()` + `redefine()` + `_loadModels` reload 模式）+ 22个测试 (100%通过) | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.8.md) |
| [v1.1.6](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.6.md) | 2026-02-11 | 🎉 **重大功能**：精准缓存失效机制 + 🚨 upsert 缓存失效 Bug 修复 + 36个测试 (100%通过) | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.6.md) |
| [v1.1.4](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.4.md) | 2026-02-09 | 🎉 重大功能：通用函数缓存 - 52个测试 (100%通过) + 多层缓存 delPattern 修复 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.4.md) |
| [v1.1.3](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.3.md) | 2026-02-03 | 📚 文档完善：多连接池文档优化 + 健康检查详解 + 验证体系规范 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.3.md) |
| [v1.1.2](#v112---日志优化) | 2026-01-27 | 🔧 优化：ObjectId 转换日志默认静默 + Saga 日志修复 | [查看](#v112---日志优化) |
| [v1.1.1](#v111---objectid-跨版本兼容) | 2026-01-27 | 🔧 Bug修复：新增跨版本 ObjectId 兼容性（支持 mongoose bson@4.x/5.x）| [查看](#v111---objectid-跨版本兼容) |
| [v1.1.0](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.0.md) | 2026-01-21 | 🎉 重大更新：新增49个操作符，实现100% MongoDB操作符支持（122/122）| [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.0.md) |
| [v1.0.9](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.9.md) | 2026-01-19 | 🎉 重大功能：统一表达式系统 - 67个操作符 + 107个测试 (100%通过) | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.9.md) |
| [v1.0.8](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.8.md) | 2026-01-17 | 🎉 重大功能：多连接池 + Update 聚合管道 + Saga 事务 + Change Stream 同步 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.8.md) |
| [v1.0.7](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.7.md) | 2026-01-09 | 🔧 依赖更新：schema-dsl@1.1.3 修复类型错误消息 + 测试用例 Schema 语法修复 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.7.md) |
| [v1.0.6](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.6.md) | 2026-01-08 | 文档完善：新增 ObjectId 自动转换文档 + 验证所有 v1.3.0+ 功能文档 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.6.md) |
| [v1.0.5](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.5.md) | 2026-01-08 | Schema 验证默认启用 + Model 自动加载机制 + 类型定义完善 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.5.md) |
| [v1.0.4](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.4.md) | 2026-01-07 | 新功能：虚拟字段、默认值 + Bug 修复：嵌套 Populate + 测试改进 | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.4.md) |
| v1.0.3 | 2025-12-31 | 新增 Model 层（Schema 验证、自定义方法、生命周期钩子、自动时间戳） | 早期状态归档未随当前仓库保留 |
| v1.0.2 | 2025-12-30 | 新增批量操作方法（deleteBatch/updateBatch） | 早期状态归档未随当前仓库保留 |
| v1.0.1 | 2025-12-29 | 稳定版本，生产就绪 | 早期状态归档未随当前仓库保留 |
| [v1.0.0](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.0.md) | 2025-12-03 | 正式发布，生产就绪，已发布到 npm | [查看](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.0.md) |

---

## 🚨 重要更新

### v1.1.6 - 精准缓存失效 + 严重 Bug 修复 🎉🔴

**发布日期**: 2026-02-11  
**版本类型**: Feature + Critical Bug Fix  
**重要性**: ⭐⭐⭐⭐⭐ **强烈推荐立即升级**

#### 🎉 新功能：精准缓存失效机制

**核心特性**:
- ✅ **精准失效**: 只清除受影响查询的缓存（vs 集合级别失效）
- ✅ **配置灵活**: 实例级别 + 查询级别配置，查询级别优先
- ✅ **智能跳过**: 自动跳过复杂查询（$or、$expr、$regex等）
- ✅ **性能优化**: 批量删除、命名空间过滤、零拷贝

**性能提升**:
| 指标 | 旧方式 | 新方式 | 提升 |
|------|--------|--------|------|
| 缓存失效数量 | 100个 | ~1个 | ↓ 99% |
| 缓存命中率 | 随机 | 95%+ | ↑ 显著 |
| 数据库查询 | 100次 | 5次 | ↓ 95% |

**配置示例**:
```javascript
// 实例配置（默认 false）
const msq = new MonSQLize({
  cache: { autoInvalidate: false }
});

// 查询配置（优先）
await collection('users').find(
  { status: 'active' },
  { cache: 60000, autoInvalidate: true }
);
```

**支持的操作符**: 等值、$in、$gt/$gte/$lt/$lte、$ne、$exists  
**自动跳过**: $or、$nor、$expr、$where、$text、$regex

**已集成**: insertOne/Many, updateOne/Many, deleteOne/Many, upsertOne (7个写操作)

**ObjectId 完全支持** 🆕:
- ✅ 自动规范化 ObjectId 为字符串（缓存键层面）
- ✅ 缓存键 100% 一致性保证
- ✅ 支持 `_id` 和所有 ObjectId 字段
- ✅ 递归处理嵌套结构和数组
- ✅ 精准失效对 ObjectId 字段 100% 可靠

**测试覆盖**: 36个单元测试，100%通过，≥95%覆盖率

#### 🚨 修复的严重问题

**问题描述**:
- `updateOne({ upsert: true })`、`updateMany({ upsert: true })`、`replaceOne({ upsert: true })` 在**插入新文档时不会失效缓存**
- 导致后续查询返回**过时数据**（缓存中是空数组，但数据库中已有新数据）
- **影响**: 严重的数据一致性问题

**影响场景**:
- ❌ 用户注册后看不到新用户
- ❌ 订单创建后看不到新订单
- ❌ count/distinct 查询返回错误的数量
- ❌ 统计数据不准确

**修复的方法**:
1. ✅ **updateOne** - 修复缓存失效条件 (第 146 行)
2. ✅ **updateMany** - 修复缓存失效条件 (第 146 行)
3. ✅ **replaceOne** - 修复缓存失效条件 (第 113 行，新发现)

**测试验证**:
- ✅ 新增 11 个测试用例，100% 通过
- ✅ 三轮彻底验证，所有场景覆盖

**升级建议**:
```bash
# 如果你使用了 upsert，请立即升级
npm update monsqlize
```

📖 **详细分析**: 历史验证报告未作为当前 npm 包资产发布；如需追溯，请以仓库归档或项目内部报告为准。

#### 其他改进

- ✅ function-cache 性能优化 (23-45% 提升)
- ✅ 新增 17 个复杂数据类型测试
- ✅ 代码质量提升 (A → A+)
- ✅ 全局 Map 监控机制
- ✅ 错误日志记录增强

---

## 变更统计

| 版本系列 | 版本数 | 主要改进方向 |
|---------|-------|------------|
| v1.1.x | 5 | **数据一致性修复** 🆕、通用函数缓存、文档完善、日志优化、100% MongoDB 操作符 |
| v1.0.x | 10 | 企业级功能、分布式支持、Model 层完善、Schema 验证、统一表达式系统 |

---

## 文档与验证改进

### v1.1.3 - 文档完善与验证体系 📚

**发布日期**: 2026-02-03  
**版本类型**: 文档优化 + 验证体系完善  
**重要性**: ⭐⭐⭐⭐

#### 核心改进

**多连接池文档优化**:
- ✅ 修复代码实现（ConnectionPoolManager 导出、selectPool 返回值完整）
- ✅ 验证 100% 通过（76 项功能验证）
- ✅ 文档精简（2082 行 → 1970 行，-5%）
- ✅ 目录格式统一、删除重复内容

**健康检查机制详解**:
- ✅ 新增文档 `docs/multi-pool-health-check.md`
- ✅ 详细说明工作原理、问题发现、问题处理
- ✅ 提供 3 种运维通知方式（日志、监控、事件）
- ✅ 集成方案（Prometheus、企业微信/钉钉、邮件）
- ✅ 完整的生产环境告警系统代码

**验证体系规范**:
- ✅ 文档规范说明（目录格式、内容规范、禁止内容）
- ✅ 文档更新流程（4 步）
- ✅ 引用关系规范（建立原则、禁止情况、判断流程）
- ✅ 验证通过标准（6 项）

#### 影响范围

- **文档文件**: 3 个（multi-pool.md、multi-pool-health-check.md、README.md）
- **代码文件**: 2 个（lib/index.js、ConnectionPoolManager.js）
- **验证文件**: 5 个（清单、脚本、报告）
- **规范文件**: 1 个（validation/README.md）

#### 升级说明

**无破坏性变更**，现有代码无需修改：
```bash
npm update monsqlize
```

📖 **详细变更**: [查看完整变更日志](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.1.3.md)

---

## 里程碑版本

### v1.1.2 - 日志优化 🔧

**发布日期**: 2026-01-27  
**重要性**: ⭐⭐⭐

**优化内容**:

1. **ObjectId 转换日志默认静默**
   - ✅ **默认完全静默**: 不输出任何 ObjectId 转换日志
   - ✅ **用户反馈驱动**: 根据用户反馈，转换日志无实际作用
   - ✅ **可选启用**: 支持按需启用摘要或详细日志
   - ✅ **生产友好**: 减少日志量，避免日志污染

2. **Saga 日志修复**
   - ✅ **修复误导性日志**: 正确区分内存缓存和 Redis 缓存
   - ✅ **准确识别**: 通过检测 `cache.keys` 和 `cache.publish` 方法识别 Redis
   - ✅ **日志准确**: 内存缓存显示"使用内存缓存"，Redis 显示"使用 Redis 存储"

**配置选项**:

```javascript
// 默认配置（完全静默）
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' }
});
// ✅ 无任何 ObjectId 转换日志

// 启用摘要日志（调试用）
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' },
  autoConvertObjectId: {
    silent: false  // 关闭静默
  }
});
// 输出：[DEBUG] Converted 15 cross-version ObjectIds

// 启用详细日志（深度调试）
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' },
  autoConvertObjectId: {
    silent: false,
    verbose: true
  }
});
// 输出：每个 ObjectId 都有一条日志
```

**效果对比**:

| 模式 | silent | verbose | 日志输出 | 适用场景 |
|------|--------|---------|---------|---------|
| **静默模式**（默认）✅ | `true` | - | 无 | 生产环境、日常开发 |
| **摘要模式** | `false` | `false` | 1条摘要 | 需要了解转换情况时 |
| **详细模式** | `false` | `true` | N条详情 | 深度调试、排查问题 |

**修改的文件**:
- `lib/utils/objectid-converter.js`: 添加 `silent` 配置，默认 `true`
- `lib/saga/SagaOrchestrator.js`: 修复 Redis 识别逻辑

**详细文档**: 
- [ObjectId 日志配置](https://github.com/vextjs/monSQLize/blob/main/docs/objectid-logging-optimization.md)
- [FAQ - Q3: 如何关闭日志](https://github.com/vextjs/monSQLize/blob/main/docs/objectid-cross-version-faq.md#q3)

---

### v1.1.1 - ObjectId 跨版本兼容 🔧

**发布日期**: 2026-01-27  
**重要性**: ⭐⭐⭐⭐

**问题背景**:
- 混用 mongoose (bson@4.x/5.x) 和 monSQLize (bson@6.x) 时出现版本冲突
- 错误信息：`Unsupported BSON version, bson types must be from bson 6.x.x`
- 跨服务数据传递时 ObjectId 实例无法被 mongodb@6.x 驱动识别

**解决方案**:
- ✅ **自动跨版本转换**: 检测并转换来自其他 BSON 版本的 ObjectId
- ✅ **递归处理**: 自动处理嵌套对象和数组中的 ObjectId
- ✅ **性能优化**: 无需转换时返回原对象（零拷贝）
- ✅ **错误降级**: 转换失败时返回原值，不影响其他字段
- ✅ **调试支持**: 提供详细的转换日志

**兼容性**:
| BSON 版本 | mongoose 版本 | 支持状态 |
|-----------|--------------|---------|
| bson@4.x  | mongoose@5.x | ✅ 完全支持 |
| bson@5.x  | mongoose@6.x | ✅ 完全支持 |
| bson@6.x  | mongoose@7.x | ✅ 原生支持 |

**测试覆盖**:
- 🏆 **测试数量**: 17个测试用例
- 🏆 **通过率**: 100% (17/17通过)
- 🏆 **覆盖场景**: 基础转换、嵌套对象、数组、边界情况、错误处理

**使用示例**:
```javascript
// 从 mongoose 获取数据（包含 bson@4.x/5.x 的 ObjectId）
const dataFromMongoose = await MongooseModel.findOne({ ... }).lean();

// 直接插入，monSQLize 自动转换 ObjectId
const result = await msq.collection('orders').insertOne(dataFromMongoose);
// ✅ 成功：自动将旧版本 ObjectId 转换为 bson@6.x 版本
```

**详细文档**: [查看 docs/objectid-cross-version.md](https://github.com/vextjs/monSQLize/blob/main/docs/objectid-cross-version.md)

---

### v1.0.9 - 统一表达式系统 🎉

**发布日期**: 2026-01-19  
**重要性**: ⭐⭐⭐⭐⭐

**核心功能**:
- ✅ **67个统一表达式操作符**: 完整实现阶段1 (43个) + 阶段2 (24个)
- ✅ **上下文感知编译**: 自动检测 $match/$project/$group 上下文
- ✅ **递归函数调用**: 支持任意深度的函数嵌套
- ✅ **Lambda表达式**: FILTER/MAP 完整支持
- ✅ **高性能缓存**: LRU缓存，>90%命中率
- ✅ **100%向后兼容**: 无破坏性变更

**测试覆盖**:
- 🏆 **测试数量**: 107个测试用例 (新增19个边界测试)
- 🏆 **通过率**: 100% (107/107通过)
- 🏆 **边界覆盖**: 95%+ 边界情况覆盖
- 🏆 **质量评级**: A+ (98.8%完成度)

**文档更新**:
- 📚 **聚合文档更新**: aggregate.md 新增统一表达式章节
- 📚 **完整实施报告**: 15+份详细报告
- 📚 **质量分析**: 全面质量检查和验证

### v1.0.8 - 企业级功能升级 🎉

**发布日期**: 2026-01-16  
**重要性**: ⭐⭐⭐⭐⭐

**核心功能**:
- ✅ **企业级多连接池管理**: 支持 primary、secondary、analytics、custom 角色
- ✅ **智能选择策略**: auto、roundRobin、weighted、leastConnections、manual
- ✅ **健康检查机制**: 自动故障检测和恢复，支持自定义检查间隔和重试次数
- ✅ **Update 聚合管道**: updateOne/updateMany 支持聚合管道语法
- ✅ **Saga 分布式事务**: 完整的补偿机制，支持跨服务事务

**质量提升**:
- 🏆 **测试覆盖率**: 90.77% (从 37.8% 提升，+53%)
- 🏆 **测试数量**: 400+个测试用例 (增长 4000%)
- 🏆 **函数覆盖率**: 95.23%
- 🏆 **核心功能**: 100% 测试覆盖
- 🏆 **行业领先**: 超过 85% 的开源项目

**重大改进**:
1. **多连接池架构**:
   - ConnectionPoolManager: 统一管理多个连接池
   - HealthChecker: 实时健康监控
   - PoolSelector: 5种智能选择策略
   - PoolStats: 完整的统计收集

2. **Update 聚合管道**:
   - 支持字段间计算 (`$add`、`$multiply`、`$subtract`)
   - 条件赋值 (`$cond`、`$ifNull`)
   - 多阶段转换 (`$concat`、`$toLower`、`$toUpper`)
   - 完全兼容 MongoDB 4.2+ 语法

3. **Saga 分布式事务**:
   - 自动补偿机制
   - 事务状态跟踪
   - 支持超时和重试
   - 完整的错误处理

**详细信息**: [查看 changelogs/v1.0.8.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.8.md)

---

### v1.0.7 - 依赖更新与测试修复 🔧

**发布日期**: 2026-01-09  
**重要性**: ⭐⭐⭐

**核心改进**:
- ✅ 升级 schema-dsl 到 v1.1.3（修复类型错误消息模板变量未替换 bug）
- ✅ 修复测试用例中错误的 Schema 语法（17处）
- ✅ 所有测试通过（38/38 测试套件，100%）
- ✅ 将 schema-dsl 从 devDependencies 移至 dependencies（Model 层运行时依赖）

**详细信息**: [查看 changelogs/v1.0.7.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.7.md)

---

### v1.0.6 - 文档完善 📚

**发布日期**: 2026-01-08  
**重要性**: ⭐⭐⭐

**核心成就**:
- ✅ 文档完整性达到 100%
- ✅ 新增 ObjectId 自动转换完整文档（600行）
- ✅ 验证所有 v1.3.0+ 功能都有文档

**详细信息**: [查看 changelogs/v1.0.6.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.6.md)

---

### v1.0.5 - Model 层易用性提升 🚀

**发布日期**: 2026-01-08  
**重要性**: ⭐⭐⭐⭐

**核心特性**:
- ✅ Schema 验证默认启用（提升数据质量）
- ✅ Model 自动加载机制（减少样板代码）
- ✅ 类型定义完善

**详细信息**: [查看 changelogs/v1.0.5.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.5.md)

---

### v1.0.4 - 虚拟字段与 Bug 修复 ✨

**发布日期**: 2026-01-07  
**重要性**: ⭐⭐⭐⭐

**核心特性**:
- ✅ 虚拟字段（计算属性）
- ✅ 默认值（插入时自动填充）
- ✅ 嵌套 Populate Bug 修复

**详细信息**: [查看 changelogs/v1.0.4.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.4.md)

---

### v1.0.0 - 正式发布 🎉

**发布日期**: 2025-12-03  
**重要性**: ⭐⭐⭐⭐⭐

**核心成就**:
- ✅ 已发布到 npm
- ✅ 生产就绪
- ✅ 企业级质量（96/100 A+）
- ✅ 1000+ 测试用例
- ✅ 77%+ 测试覆盖率

**详细信息**: [查看 changelogs/v1.0.0.md](https://github.com/vextjs/monSQLize/blob/main/changelogs/v1.0.0.md)

---

## 详细变更文档

> **说明**: 详细变更文档位于 `changelogs/` 目录

```
changelogs/
├── README.md          # 变更文档说明
├── TEMPLATE.md        # 变更文档模板
├── v3.0.0.md         # 当前 Major 稳定发布详细变更
├── v2.0.7.md         # 从未发布的历史候选归档
├── v2.0.6.md         # v2.0.6 详细变更
├── v2.0.5.md         # v2.0.5 详细变更
├── v2.0.4.md         # v2.0.4 详细变更
├── v2.0.3.md         # v2.0.3 详细变更
├── v2.0.2.md         # v2.0.2 详细变更
├── v2.0.1.md         # v2.0.1 详细变更
├── v2.0.0.md         # v2 TypeScript 重写发布详细变更
└── v1.x.y.md         # 历史版本详细变更（仓库归档）
```

**注意**: 
- `changelogs/` 目录包含所有版本的详细变更文档
- 本文件（CHANGELOG.md）仅提供版本概览和里程碑摘要
- 早期 `STATUS.md` 状态看板已不再作为当前仓库和 npm 包资产保留。

---

## 维护说明

### 添加新版本的步骤

1. **创建详细变更文档**
   ```bash
   cp changelogs/TEMPLATE.md changelogs/vX.Y.Z.md
   # 填充详细变更信息
   ```

2. **更新 CHANGELOG.md**（本文件）
   - 在"版本概览"表格最上方添加新行
   - 格式：版本列和详情列都指向 `./changelogs/vX.Y.Z.md`，当前 npm 包默认只随带当前发布版本的详细文档。

3. **更新状态看板**（如项目重新启用）
   - 当前仓库未保留 `STATUS.md` 作为发布资产；如后续恢复状态看板，再同步版本章节和需求状态。

4. **提交变更**
   ```bash
   git add CHANGELOG.md changelogs/vX.Y.Z.md
   git commit -m "docs: 发布 vX.Y.Z"
   ```

### 版本号规则

遵循[语义化版本](https://semver.org/lang/zh-CN/)（Semantic Versioning）:

- **MAJOR** (x.0.0) - 不兼容的 API 变更
- **MINOR** (0.x.0) - 向后兼容的新增功能
- **PATCH** (0.0.x) - 向后兼容的问题修复

示例：
- `1.0.0 → 1.0.1` - Bug 修复
- `1.0.0 → 1.1.0` - 新功能
- `1.0.0 → 2.0.0` - 破坏性变更

---

## 相关文档

- [changelogs/v3.0.0.md](./changelogs/v3.0.0.md) - 当前 Major 稳定发布详细变更文档
- [changelogs/v2.0.7.md](./changelogs/v2.0.7.md) - 从未发布的候选归档
- [changelogs/v2.0.6.md](./changelogs/v2.0.6.md) - v2.0.6 详细变更文档
- [changelogs/v2.0.5.md](./changelogs/v2.0.5.md) - v2.0.5 详细变更文档
- [changelogs/v2.0.4.md](./changelogs/v2.0.4.md) - v2.0.4 详细变更文档
- [changelogs/v2.0.3.md](./changelogs/v2.0.3.md) - v2.0.3 详细变更文档
- [changelogs/v2.0.2.md](./changelogs/v2.0.2.md) - v2.0.2 详细变更文档
- [changelogs/v2.0.1.md](./changelogs/v2.0.1.md) - v2.0.1 详细变更文档
- [README.md](./README.md) - 项目说明
- [docs/](https://github.com/vextjs/monSQLize/blob/main/docs/index.md) - API 文档

---

**最后更新**: 2026-07-10

