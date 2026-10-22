# MongoDB 驱动版本兼容性指南

## 概述

本文档说明 monSQLize 如何处理 MongoDB Node.js 驱动的版本差异，以及如何确保未来驱动升级时的兼容性。

**当前基线**: monSQLize 以 `mongodb@6.21.0` 作为运行时依赖基线；Driver 7.7.0 已通过扩展兼容性验证。Driver 4.x / 5.x 属于历史兼容背景，不再作为当前支持矩阵。

---

## 当前支持的驱动版本

### 当前支持矩阵

| MongoDB 驱动版本 | 支持状态 | 测试状态 | 说明 |
|-----------------|---------|---------|------|
| **6.x** (6.21.0) | 运行时基线 | 默认验证 | package 精确依赖，开箱即用 |
| **7.x** (7.7.0) | 扩展兼容 | 矩阵验证 | 用于提前发现上游 breaking change |
| **4.x / 5.x** | 历史兼容参考 | 不在当前矩阵 | 旧版本迁移背景；新项目建议使用当前包依赖基线 |
| **8.x+** | 待评估 | ⏸️ 未纳入当前矩阵 | 升级前需按本文验证流程确认 |

### 依赖声明

`package.json` 中的声明：
```json
{
  "dependencies": {
    "mongodb": "6.21.0"
  }
}
```

**说明**: 
- 用户安装 monSQLize 后会通过当前包依赖基线获得 `mongodb@6.21.0`，无需额外安装 MongoDB driver。
- Driver 7.7.0 通过兼容性验证，但不是当前 package 的运行时依赖基线。
- 如包管理器裁剪、覆盖依赖或 workspace 解析导致 driver 不可用，优先恢复完整安装，再执行本文验证命令。

---

## monSQLize 对版本差异的处理

### 1. findOneAnd* 方法的返回值

这是最重要的差异。当前 monSQLize 运行时依赖基线是 MongoDB Driver 6.21.0，并通过 Driver 7.7.0 扩展矩阵验证公共 API 行为。

#### MongoDB 驱动版本差异

**Driver 4.x 返回格式**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
// result 格式：
{
  value: { _id: ..., name: "Alice" },  // 文档
  ok: 1,                                // 操作状态
  lastErrorObject: {                    // 错误信息
    n: 1,
    updatedExisting: true
  }
}
```

**Driver 5.x 返回格式**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
// result 格式：
{
  value: { _id: ..., name: "Alice" }  // 只返回文档
}
```

**Driver 6.x / 7.x 默认返回格式**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
// result 格式：
{
  _id: ...,
  name: "Alice"
}
```

#### monSQLize 当前行为

**使用当前 monSQLize 包依赖基线时，用户代码直接接收文档或 `null`：**

```javascript
const user = await collection.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } }
);

// 所有版本都返回统一格式：文档本身
console.log(user);  // { _id: ..., name: "Alice", age: 31 }

// 不需要判断版本：
// 不需要: if (result.value) return result.value;
// 不需要: if (result.ok) return result;
```

**实现边界**:

- monSQLize 以 `mongodb@6.21.0` 精确依赖提供开箱即用行为。
- Driver 7.7.0 通过 `test:compatibility` 与 server matrix 验证。
- 如果应用强制覆盖为历史 Driver 4.x / 5.x，需要自行验证返回值差异，不建议新项目这样做。

**适用的方法**：
- findOneAndUpdate
- findOneAndReplace
- findOneAndDelete

---

### 2. `includeResultMetadata` 明确控制

```javascript
// 默认行为（不带选项）
const result = await collection.findOneAndUpdate(filter, update);

console.log(result);
// 输出：
// { _id: ..., name: "Alice" }  // 直接返回文档！

// 获取完整元数据（需要显式指定）
const result = await collection.findOneAndUpdate(filter, update, {
  includeResultMetadata: true
});

console.log(result);
// 输出：
// {
//   value: { _id: ..., name: "Alice" },
//   ok: 1,
//   lastErrorObject: { 
//     updatedExisting: true, 
//     n: 1 
//   }
// }
```

**特点**:
- 默认不返回元数据，直接返回文档或 `null`。
- 需要 `includeResultMetadata: true` 时，显式传入原生 MongoDB Driver 选项。
- 从旧 Driver 元数据返回值迁移时，应避免继续无条件读取 `result.lastErrorObject`。

### 其他受影响的方法

| 方法 | Driver 5.x 历史默认 | Driver 6.21.0 / 7.7.0 默认 | 当前建议 |
|------|---------|---------|---------|
| **findOneAndUpdate** | `{ value, ok, lastErrorObject }` | 文档对象或 `null` | 使用当前依赖基线，无需提取 `value` |
| **findOneAndReplace** | `{ value, ok, lastErrorObject }` | 文档对象或 `null` | 使用当前依赖基线，无需提取 `value` |
| **findOneAndDelete** | `{ value, ok, lastErrorObject }` | 文档对象或 `null` | 使用当前依赖基线，无需提取 `value` |
| **updateOne** | `{ acknowledged, matchedCount, ... }` | 相同 | 按原生结果处理 |
| **updateMany** | `{ acknowledged, matchedCount, ... }` | 相同 | 按原生结果处理 |
| **deleteOne** | `{ acknowledged, deletedCount }` | 相同 | 按原生结果处理 |
| **deleteMany** | `{ acknowledged, deletedCount }` | 相同 | 按原生结果处理 |
| **replaceOne** | `{ acknowledged, matchedCount, ... }` | 相同 | 按原生结果处理 |

**注**: Driver 4.x / 5.x 只作为历史迁移参考。当前文档不再把它们作为常规用户验证路径。

---

## monSQLize 的兼容性保证

### 核心策略：精确依赖 + 薄封装 + 矩阵验证

monSQLize 不要求用户手动安装或选择 MongoDB Driver。当前包通过以下方式降低使用负担：

- `package.json` 精确声明 `mongodb@6.21.0`，安装后即可使用。
- 写入与查询 API 保持薄封装，默认透传当前 Driver 的稳定行为。
- `test:compatibility` 与 server matrix 覆盖当前基线和 Driver 7.7.0 扩展验证。
- 历史 Driver 4.x / 5.x 只作为迁移参考，不作为当前用户路径承诺。

### 关键实现位置

**位置**: `src/adapters/mongodb/writes/`

**职责**:
1. 调用原生 `collection.findOneAndUpdate` / `findOneAndReplace` / `findOneAndDelete`
2. 保持当前 Driver 默认返回文档或 `null` 的行为
3. 对批量写入、upsert、increment 等扩展方法提供 monSQLize 自身封装
4. 通过测试矩阵发现上游 Driver 行为漂移

**核心函数**:

```javascript
findOneAndUpdateDocument(collection, filter, update, options)
findOneAndReplaceDocument(collection, filter, replacement, options)
findOneAndDeleteDocument(collection, filter, options)
```

### 版本治理机制

- 正常 monSQLize 使用不需要用户直接声明 `mongodb`。
- 兼容性验证临时覆盖 driver 版本，验证后恢复 `mongodb@6.21.0`。
- CI 兼容性检查应以 `npm ls mongodb` 和 `npm run test:compatibility` 作为证据。

### 异常情况处理

- 没有匹配文档时，`findOneAnd*` 返回 `null`。
- 如果调用方显式传入 `includeResultMetadata: true`，返回值遵循 MongoDB Driver 原生元数据结构。
- 如果应用覆盖为历史 Driver 并得到 `{ value, ok, lastErrorObject }`，应先恢复当前包依赖基线或在应用层完成迁移验证。

---

## 未来驱动升级指南

### 升级前检查清单

当 MongoDB 发布新的主版本驱动时（如未来 8.x），请按以下步骤操作：

#### 步骤 1：阅读官方文档 ✅

- [ ] 阅读 MongoDB 驱动的 CHANGELOG
- [ ] 重点关注 `findOneAnd*` 方法的变更
- [ ] 查看是否有其他破坏性变更

**官方资源**:
- [MongoDB Node.js Driver Release Notes](https://github.com/mongodb/node-mongodb-native/releases)
- [Migration Guide](https://www.mongodb.com/docs/drivers/node/current/whats-new/)

#### 步骤 2：本地测试 ✅

```bash
# 1. 创建测试分支
git checkout -b test/mongodb-driver-upgrade

# 2. 临时覆盖到待验证版本
npm install mongodb@next --no-save --package-lock=false

# 3. 运行兼容性验证
npm run test:compatibility
npm run test:server-matrix

# 4. 恢复当前运行时依赖基线
npm install mongodb@6.21.0 --no-save --package-lock=false
```

#### 步骤 3：检查日志输出 ✅

```bash
# 查看当前解析到的 driver 版本
npm ls mongodb

# 查看兼容性矩阵结果
npm run test:compatibility
```

#### 步骤 4：修复兼容性问题 ✅

**如果测试失败**:

1. **定位问题**:
   ```bash
   # 运行特定测试套件
   npm run test:compatibility -- --grep "findOneAnd"
   ```

2. **分析错误**:
   - 是否是返回值格式变化？
   - 是否是新增/删除的字段？
   - 是否是行为逻辑变化？

3. **修改封装层或矩阵**:
   - 优先检查 `src/adapters/mongodb/writes/` 与 `src/adapters/mongodb/common/`
   - 保持公共 API 不变
   - 如只是验证范围变化，先更新 `test/compatibility/matrix.json`

4. **更新文档**:
   - 更新本文档的"支持的驱动版本"
   - 更新 CHANGELOG.md
   - 更新 API 文档中的兼容性说明

#### 步骤 5：回归测试 ✅

```bash
# 完整测试套件
npm test

# 覆盖率检查
npm run test:coverage

# 确保没有回归问题
```

### 修复示例：如何适配驱动 7.x（假设）

假设 MongoDB 驱动 7.x 再次改变了返回值格式：

**场景**: 驱动 7.x 返回 `{ document, metadata }` 格式

```javascript
// src/adapters/mongodb/writes/index.ts

function handleFindOneAndResult(result, options = {}, logger = null) {
    const driverVersion = detectDriverVersion();
    
    // 驱动 7.x 的新格式
    if (driverVersion >= 7) {
        // 适配新格式
        if (result && result.document !== undefined) {
            // 转换为统一格式
            result = {
                value: result.document,
                ok: 1,
                lastErrorObject: result.metadata || { n: result.document ? 1 : 0 }
            };
        }
    }
    
    // 驱动 6.x 的处理逻辑（保持不变）
    // ...existing code...
    
    // 统一返回
    if (options.includeResultMetadata) {
        return result;
    } else {
        return result.value !== undefined ? result.value : null;
    }
}
```

**关键点**:
- 先用临时 driver 覆盖验证公共 API 行为。
- 如发现 breaking change，优先在 `src/adapters/mongodb/` 的薄封装层修复。
- 公共 API 保持不变，用户代码无需修改。

---

## 测试策略

### 测试覆盖范围

| 测试类型 | 命令 / 入口 | 说明 |
|---------|-----------|------|
| **兼容性矩阵** | `npm run test:compatibility` | 覆盖当前基线与扩展 driver 组合 |
| **服务矩阵** | `npm run test:server-matrix` | 覆盖真实 MongoDB / memory server 场景 |
| **历史验证进度** | `test/validation/VERIFICATION-PROGRESS.md` | 较早的 Driver 7.5.0 记录；当前样本以 `test/compatibility/matrix.json` 为准 |
| **真实服务结果** | `test/validation/REAL-SERVER-MATRIX.md` | 记录真实服务矩阵验收 |
| **矩阵配置** | `test/compatibility/matrix.json` | 维护待验证的版本组合 |

### 关键测试场景

**必须测试的场景**:
1. 找到文档并修改
2. 未找到文档（返回 null）
3. upsert 插入新文档
4. 返回更新前的文档（`returnDocument: "before"`）
5. 返回更新后的文档（`returnDocument: "after"`）
6. 包含完整元数据（`includeResultMetadata: true`）
7. 显式缓存失效
8. 并发安全性

### 自动化测试命令

```bash
# 运行当前兼容性矩阵
npm run test:compatibility

# 运行 MongoDB server matrix
npm run test:server-matrix

# 查看当前解析到的 driver
npm ls mongodb
```

---

## 开发者指南

### 添加新的 findOneAnd* 风格方法

如果未来需要添加类似的方法（如自定义的 `findOneAndModify`），请遵循以下模式：

```javascript
// src/adapters/mongodb/writes/custom-find-one-and-modify.ts

async function customFindOneAndModify(filter, modification, options = {}) {
    try {
        // 1. Pass through supported native driver options explicitly.
        const driverOptions = { ...options };

        // 2. Call the native driver method.
        const result = await nativeCollection.customMethod(filter, modification, driverOptions);

        // 3. Invalidate cache only after a confirmed write path.
        if (cache) {
            // cache invalidation logic
        }

        // 4. Return the native document/null shape for the current driver baseline.
        return result;
    } catch (error) {
        throw error;
    }
}
```

**关键点**:
- 保持 TypeScript 类型与 `Collection<TSchema>` 方法签名一致。
- 不新增隐藏版本探测逻辑；版本差异用矩阵测试发现。
- 需要元数据时由调用方显式传入 `includeResultMetadata: true`。
- 修改后同步更新 `test/compatibility/` 和验证文档。

---

## 相关资源

### 内部文档

- **验证入口**:
  - `test/validation/VERIFICATION-PROGRESS.md` - 当前验证进度
  - `test/validation/REAL-SERVER-MATRIX.md` - 真实服务矩阵结果
  - `test/compatibility/matrix.json` - Driver / server 版本矩阵配置

- **API 文档**:
  - `docs/find-one-and-update.md` - 包含兼容性说明
  - `docs/find-one-and-replace.md` - 包含兼容性说明
  - `docs/find-one-and-delete.md` - 包含兼容性说明

### 外部资源

- [MongoDB Node.js Driver Documentation](https://www.mongodb.com/docs/drivers/node/current/)
- [MongoDB Node.js Driver GitHub](https://github.com/mongodb/node-mongodb-native)
- [MongoDB Driver Release Notes](https://github.com/mongodb/node-mongodb-native/releases)

---

## FAQ

### Q1: 如果我使用的是 MongoDB 驱动 5.x，会有问题吗？

**A**: 当前依赖基线不会解析到 Driver 5.x。若应用通过 package manager overrides 强制替换为 5.x，请先恢复当前包依赖基线：

```bash
npm install mongodb@6.21.0
```

如果必须使用 5.x，请自行运行兼容性验证，并在应用层处理 `{ value, ok, lastErrorObject }` 与文档对象之间的差异。

### Q2: 如何知道当前使用的驱动版本？

**A**: 检查 `package-lock.json` 或运行：

```bash
npm list mongodb
```

或在代码中：

```javascript
const mongodb = require("mongodb");
console.log("MongoDB Driver Version:", mongodb.version);
```

### Q3: 升级到未来 driver 主版本后测试失败，怎么办？

**A**: 按照"未来驱动升级指南"操作：

1. 查看失败的测试套件（特别是 `findOneAnd*`）
2. 分析错误日志
3. 在 `src/adapters/mongodb/` 对应薄封装层评估是否需要兼容处理
4. 保持公共 API 不变

如需帮助，请附上 `test:compatibility` 与 server matrix 输出提交 Issue。

### Q4: 为什么只有 findOneAnd* 方法受影响？

**A**: 因为这些方法的返回值格式比较复杂（包含元数据），而其他方法（如 `updateOne`）的返回值格式简单且未变化。

### Q5: 未来会支持多个驱动版本吗？

**A**: 目前不计划支持多版本。原因：

- 增加维护成本
- 增加测试复杂度
- MongoDB 驱动遵循语义化版本，主版本间差异明确

推荐做法：随 MongoDB 驱动主版本升级而升级 monSQLize。
