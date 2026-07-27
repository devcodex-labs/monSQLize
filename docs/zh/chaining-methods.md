# monSQLize 链式调用方法支持文档


## 📋 概述

本文档总结 monSQLize 项目中 `find` 和 `aggregate` 方法目前支持的**原生 MongoDB 链式调用方法**。

现在您可以像使用原生 MongoDB 驱动一样，使用链式调用方法构建查询。链式方法都完全支持缓存、参数验证和错误处理。

---

## 🎯 支持的链式调用方法（已完整实现）

### 1. `find()` 方法

#### ✅ 已支持的链式调用（共 12 个方法）

| 方法 | 语法 | 说明 | 公开能力 |
|------|------|------|---------|
| **`.limit(n)`** | `.limit(number)` | 限制返回文档数量 | `find()` query chain |
| **`.skip(n)`** | `.skip(number)` | 跳过文档数量 | `find()` query chain |
| **`.sort(spec)`** | `.sort(object)` | 排序规则 | `find()` query chain |
| **`.project(spec)`** | `.project(object)` | 字段投影 | `find()` query chain |
| **`.hint(spec)`** | `.hint(object\|string)` | 索引提示 | `find()` query chain |
| **`.collation(spec)`** | `.collation(object)` | 排序规则 | `find()` query chain |
| **`.comment(str)`** | `.comment(string)` | 查询注释 | `find()` query chain |
| **`.maxTimeMS(ms)`** | `.maxTimeMS(number)` | 查询超时时间 | `find()` query chain |
| **`.batchSize(n)`** | `.batchSize(number)` | 批处理大小 | `find()` query chain |
| **`.explain(v)`** | `.explain(string?)` | 返回查询执行计划 | `find()` query chain |
| **`.stream()`** | `.stream()` | 返回流式结果 | `find()` query chain |
| **`.toArray()`** | `.toArray()` | 显式转换为数组 | `find()` query chain |

`limit(0)` 会保留 MongoDB 游标语义：表示“不限制返回数量”，可能返回全部匹配文档。需要有界读取时请使用正整数 limit；显式正整数 limit 会受 `findMaxLimit` 限制。

#### 📝 使用示例

```javascript
// 基础用法 - limit 和 skip
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .skip(5);

// 排序查询
const results = await collection('products')
  .find({ inStock: true })
  .sort({ price: -1 })
  .limit(10);

// 字段投影
const results = await collection('products')
  .find({ category: 'books' })
  .project({ name: 1, price: 1 })
  .limit(5);

// 复杂组合 - 多个链式方法
const results = await collection('products')
  .find({ category: 'electronics', inStock: true })
  .sort({ rating: -1, sales: -1 })
  .skip(5)
  .limit(10)
  .project({ name: 1, price: 1 })
  .hint({ category: 1, price: -1 })
  .maxTimeMS(5000)
  .comment('复杂查询');

// 查询执行计划
const plan = await collection('products')
  .find({ category: 'electronics' })
  .sort({ price: -1 })
  .limit(10)
  .explain('executionStats');

// 流式查询
const stream = collection('products')
  .find({ category: 'books' })
  .sort({ createdAt: -1 })
  .limit(100)
  .stream();
```

---

### 2. `aggregate()` 方法

#### ✅ 已支持的链式调用（共 9 个方法）

| 方法 | 语法 | 说明 | 公开能力 |
|------|------|------|---------|
| **`.hint(spec)`** | `.hint(object\|string)` | 索引提示 | `aggregate()` query chain |
| **`.collation(spec)`** | `.collation(object)` | 排序规则 | `aggregate()` query chain |
| **`.comment(str)`** | `.comment(string)` | 查询注释 | `aggregate()` query chain |
| **`.maxTimeMS(ms)`** | `.maxTimeMS(number)` | 查询超时时间 | `aggregate()` query chain |
| **`.allowDiskUse(bool)`** | `.allowDiskUse(boolean)` | 允许使用磁盘 | `aggregate()` query chain |
| **`.batchSize(n)`** | `.batchSize(number)` | 批处理大小 | `aggregate()` query chain |
| **`.explain(v)`** | `.explain(string?)` | 返回聚合执行计划 | `aggregate()` query chain |
| **`.stream()`** | `.stream()` | 返回流式结果 | `aggregate()` query chain |
| **`.toArray()`** | `.toArray()` | 显式转换为数组 | `aggregate()` query chain |

#### 📝 使用示例（2. aggregate() 方法）

```javascript
// 基础聚合
const results = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
  ])
  .allowDiskUse(true);

// 完整链式调用
const results = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } }
  ])
  .hint({ status: 1, createdAt: -1 })
  .allowDiskUse(true)
  .maxTimeMS(10000)
  .comment('分类销售统计');

// 聚合执行计划
const plan = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
  ])
  .explain('executionStats');

// 流式聚合
const stream = collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $limit: 100 }
  ])
  .stream();
```

---

## 🆚 MongoDB 原生链式方法对比

### 完整对比表

| 方法 | MongoDB 原生支持 | monSQLize v3 | 说明 |
|------|-----------------|----------------|------|
| `.limit()` | ✅ | ✅ | 完全支持 |
| `.skip()` | ✅ | ✅ | 完全支持 |
| `.sort()` | ✅ | ✅ | 完全支持 |
| `.project()` | ✅ | ✅ | 完全支持 |
| `.hint()` | ✅ | ✅ | 完全支持 |
| `.collation()` | ✅ | ✅ | 完全支持 |
| `.comment()` | ✅ | ✅ | 完全支持 |
| `.maxTimeMS()` | ✅ | ✅ | 完全支持 |
| `.batchSize()` | ✅ | ✅ | 完全支持 |
| `.explain()` | ✅ | ✅ | 完全支持 |
| `.toArray()` | ✅ | ✅ | 完全支持 |
| `.stream()` | ✅ | ✅ | 完全支持（使用 `.stream()` 而非 `.forEach()`） |
| `.forEach()` | ✅ | 通过 `.stream()` 实现 | 使用流式处理替代 |
| `.map()` | ✅ | 通过 `.stream()` 实现 | 使用流式处理替代 |
| `.hasNext()` | ✅ | ❌ | 不支持（与缓存架构冲突） |
| `.next()` | ✅ | ❌ | 不支持（与缓存架构冲突） |
| `.close()` | ✅ | ❌ | 不需要（自动管理） |

**总结**：monSQLize v3 支持上表列出的 12 个链式方法。该表是能力契约；对应用的覆盖程度取决于服务实际使用的查询模式。

---

## ✨ 新功能亮点

### 1. Promise 兼容性

链式调用对象实现了完整的 Promise 接口：

```javascript
// 直接 await
const results = await collection('products').find({}).limit(10);

// 使用 .then()
collection('products')
  .find({}).limit(10)
  .then(results => console.log(results));

// 使用 .catch()
const results = await collection('products')
  .find({}).limit(10)
  .catch(err => []);
```

### 2. 参数自动验证

```javascript
// ✅ 正确
.limit(10)
.skip(5)

// ❌ 错误 - 自动抛出异常
.limit(-1)        // Error: limit() requires a non-negative integer
.skip("invalid")  // Error: skip() requires a non-negative integer
.sort("invalid")  // Error: sort() requires an object or array
```

### 3. 执行保护

防止意外的重复执行：

```javascript
const chain = collection('products').find({}).limit(5);

// 第一次执行 ✅
await chain.toArray();

// 第二次执行 ❌ 抛出错误
await chain.toArray(); // Error: Query already executed
```

### 4. 完整缓存支持

链式调用与 options 参数使用**相同的缓存键**：

```javascript
// 这两种方式共享缓存
await collection('products').find({}).limit(10).sort({ price: -1 });
await collection('products').find({}, { limit: 10, sort: { price: -1 } });
```

---

## 🔄 向后兼容性

### 100% 向后兼容

所有现有代码**无需修改**：

```javascript
// 旧代码 - 继续工作 ✅
const results = await collection('products').find(
  { category: 'electronics' },
  { limit: 10, sort: { price: -1 } }
);

// 新代码 - 链式调用 ✅
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .sort({ price: -1 });
```

### 自动检测

monSQLize 会自动检测调用方式：

- **无 options 参数** → 返回链式构建器
- **有 options 参数** → 直接执行查询

---

## 📚 相关文档

- **[链式调用完整 API 文档](./chaining-api.md)** - 详细的使用指南和最佳实践
- **[链式调用示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/chaining-api.ts)** - 当前 TypeScript 示例
- **[find 方法文档](./find.md)** - find 方法详细说明
- **[aggregate 方法文档](./aggregate.md)** - aggregate 方法详细说明
- **[explain 方法文档](./explain.md)** - 性能分析工具

**反馈与建议**: 如有问题或建议，请提交 [GitHub Issue](https://github.com/devcodex-labs/monSQLize/issues)。
