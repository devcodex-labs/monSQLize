# find()

## 概述

`find()` 用于从 MongoDB 集合读取多条文档。列表查询、排序、分页、投影、流式读取、缓存读取，以及任何返回零条或多条记录的查询，都可以从这个方法开始。

### ObjectId 自动转换

查询条件中包含合法 24 位十六进制 ObjectId 字符串时，monSQLize 会在发送给 MongoDB 前完成转换。多数来自 HTTP 参数的 ID 可以直接按字符串传入，不需要手动调用 `new ObjectId()`。

```javascript
const posts = await collection('posts').find({
    authorId: '507f1f77bcf86cd799439011',
    categoryId: '507f1f77bcf86cd799439012'
});

const docs = await collection('docs').find({
    $or: [
        { authorId: userId1 },
        { editorId: userId2 }
    ]
});
```

如果业务字段本身可能是 24 位十六进制字符串，见 [ObjectId 自动转换](./objectid-auto-convert.md) 中的逃生开关。

## 调用方式

monSQLize 支持链式调用和 options 参数两种写法。选择团队更容易阅读的写法即可。

### 方式 1: 链式调用（推荐）

```javascript
// 基础链式调用
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .skip(5)
  .sort({ price: -1 });

// 复杂链式调用
const results = await collection('products')
  .find({ category: 'electronics', inStock: true })
  .sort({ rating: -1, sales: -1 })
  .skip(10)
  .limit(20)
  .project({ name: 1, price: 1, rating: 1 })
  .hint({ category: 1, price: -1 })
  .maxTimeMS(5000)
  .comment('ProductAPI:getList');
```

**支持的链式方法**:
- `.limit(n)` - 限制返回数量
- `.skip(n)` - 跳过文档数
- `.sort(spec)` - 排序规则
- `.project(spec)` - 字段投影
- `.hint(spec)` - 索引提示
- `.collation(spec)` - 排序规则
- `.comment(str)` - 查询注释
- `.maxTimeMS(ms)` - 超时时间
- `.batchSize(n)` - 批处理大小
- `.explain(v)` - 执行计划
- `.stream()` - 流式返回
- `.toArray()` - 显式转换为数组

`limit(0)` 保留 MongoDB 语义，表示不限制返回数量。显式正整数 limit 受 `findMaxLimit` 限制，显式 skip 受 `findMaxSkip` 限制。

📚 **详细文档**: 查看 [链式调用完整 API 文档](./chaining-api.md)

### 方式 2: options 参数

```javascript
const results = await collection('products').find(
  { category: 'electronics' },
  {
    sort: { price: -1 },
    limit: 10,
    skip: 5,
    projection: { name: 1, price: 1 }
  }
);
```

两种写法进入同一查询路径。

---

## 方法签名

```javascript
// 链式调用方式
collection(name).find(query)
  .limit(n)
  .skip(n)
  .sort(spec)
  // ... 其他链式方法

// options 参数方式
async find(query = {}, options = {})
```

**参数说明**：
- `query` (Object): MongoDB 查询条件，如 `{ status: 'active', age: { $gt: 18 } }`
- `options` (Object): 查询选项配置（仅 options 参数方式需要）

## 参数说明

### query 参数

MongoDB 标准查询条件对象，支持所有 MongoDB 查询操作符。

### options 对象属性

| 参数 | 类型 | 必填 | 默认值 | 来源 | 说明 |
|------|------|------|--------|------|------|
| `projection` / `project` | Object/Array | 否 | - | MongoDB 原生 ✅ | 字段投影配置，指定返回的字段。`project` 是 `projection` 的别名；两者同时存在时 `projection` 优先。 |
| `sort` | Object | 否 | - | MongoDB 原生 ✅ | 排序规则，如 `{ createdAt: -1, name: 1 }` |
| `limit` | Number | 否 | 全局配置 | MongoDB 原生 ✅ | 限制返回的文档数量 |
| `skip` | Number | 否 | - | MongoDB 原生 ✅ | 跳过指定数量的文档（不推荐大数据量使用） |
| `hint` | Object/String | 否 | - | MongoDB 原生 ✅ | 指定查询使用的索引 |
| `collation` | Object | 否 | - | MongoDB 原生 ✅ | 指定排序规则（用于字符串排序） |
| `maxTimeMS` | Number | 否 | 全局配置 | MongoDB 原生 ✅ | 查询超时时间（毫秒） |
| `batchSize` | Number | 否 | - | MongoDB 原生 ✅ | 流式查询或数组查询时的批次大小 |
| `comment` | String | 否 | - | MongoDB 原生 ✅ | 查询注释，用于生产环境日志跟踪和性能分析 |
| `explain` | Boolean/String | 否 | - | MongoDB 原生 ✅ | 返回查询执行计划，可选值：`true`、`'queryPlanner'`、`'executionStats'`、`'allPlansExecution'` |
| `stream` | Boolean | 否 | `false` | monSQLize 扩展 🔧 | 是否返回流对象（也可通过 `.stream()` 链式方法调用） |
| `cache` | Number | 否 | `0` | monSQLize 扩展 🔧 | 缓存 TTL（毫秒），大于 0 时启用缓存 |

**图例说明**:
- ✅ **MongoDB 原生**: 该参数/方法是 MongoDB 官方支持的标准功能
- 🔧 **monSQLize 扩展**: monSQLize 独有的扩展功能，提供额外的便利性

**MongoDB 参考文档**: 
- [find() 方法](https://www.mongodb.com/docs/manual/reference/method/db.collection.find/)
- [游标方法](https://www.mongodb.com/docs/manual/reference/method/js-cursor/)

### comment 配置

查询注释用于在 MongoDB 日志中标识查询来源，便于生产环境的运维监控和性能分析：

```javascript
comment: 'UserAPI:listProducts:user_12345'
```

**命名建议**：
```javascript
// 格式：服务名:操作:标识符
comment: 'ProductAPI:getList:session_abc123'
comment: 'OrderService:getUserOrders:traceId=xyz789'
comment: 'AdminDashboard:getTotalActive:admin_user_5'
```

**使用场景**：
- **生产环境监控**：在 MongoDB 日志中识别查询来源
- **慢查询诊断**：快速定位慢查询的业务场景
- **分布式追踪**：结合 traceId 实现完整链路追踪
- **性能优化**：A/B 测试不同查询策略的性能差异
- **审计与合规**：记录查询发起者和业务场景

**最佳实践**：
- ✅ 使用统一的命名格式："服务名:操作:标识符"
- ✅ 包含关键信息（用户ID、会话ID、traceId）
- ✅ 避免包含敏感数据（密码、身份证号等）
- ✅ 保持简洁（建议 <100 字符）
- ✅ 在生产环境启用 MongoDB 慢查询日志（slowOpThresholdMs）

**MongoDB 日志示例**：
```json
{
  "t": { "$date": "2025-11-07T08:00:00.000Z" },
  "c": "COMMAND",
  "msg": "Slow query",
  "attr": {
    "type": "find",
    "ns": "mydb.products",
    "command": {
      "find": "products",
      "filter": { "category": "electronics" },
      "comment": "ProductAPI:listProducts:user_12345"
    },
    "durationMillis": 523
  }
}
```
**参考文档**：
- [MongoDB comment 参数官方文档](https://www.mongodb.com/docs/manual/reference/command/find/#std-label-find-cmd-comment)
- [Database Profiler](https://www.mongodb.com/docs/manual/reference/command/profile/)

### projection 配置

投影配置用于指定查询结果中包含或排除的字段，支持两种格式：

**对象格式**：
```javascript
projection: {
  name: 1,        // 包含 name 字段
  email: 1,       // 包含 email 字段
  password: 0     // 排除 password 字段
}
```

**数组格式**：
```javascript
projection: ['name', 'email', 'createdAt']  // 只返回这些字段（加上 _id）
```

**注意**：
- MongoDB 不允许混合使用包含（1）和排除（0），除了 `_id` 字段
- 数组格式会自动转换为包含模式
- `_id` 字段默认总是包含，除非显式排除：`{ _id: 0 }`

### sort 配置

排序配置指定结果的排序方式：

```javascript
sort: {
  createdAt: -1,  // -1 表示降序
  name: 1,        // 1 表示升序
  _id: 1          // 建议添加 _id 作为最后的排序字段，确保排序稳定
}
```

**性能建议**：
- 对于大数据集，确保排序字段上有索引
- 避免对未索引的字段进行排序
- 使用复合索引可以优化多字段排序

### hint 配置

强制 MongoDB 使用指定的索引：

```javascript
// 使用索引名称
hint: 'status_createdAt_idx'

// 使用索引定义
hint: { status: 1, createdAt: -1 }
```

**使用场景**：
- MongoDB 查询优化器选择了错误的索引
- 需要强制使用特定索引以保证性能
- 测试不同索引的性能差异

### collation 配置

指定字符串比较和排序的规则：

```javascript
collation: {
  locale: 'zh',           // 中文
  strength: 2,            // 忽略大小写和重音符号
  caseLevel: false,
  numericOrdering: true   // 数字字符串按数值排序
}
```

**常见场景**：
- 需要不区分大小写的查询和排序
- 多语言环境下的正确排序
- 数字字符串的自然排序

## 返回值

### 普通模式返回数组

默认情况下，`find` 方法返回一个 Promise，resolve 为文档数组：

```javascript
const users = await collection('users').find(
  { status: 'active' },
  { limit: 10 }
);

// users = [
//   { _id: '...', name: 'Alice', status: 'active', ... },
//   { _id: '...', name: 'Bob', status: 'active', ... },
//   ...
// ]
```

**返回值类型**：`Promise<Array<Object>>`

### 流式模式返回流对象

当 `stream: true` 时，返回一个 MongoDB Cursor Stream 对象：

```javascript
const stream = await collection('orders').find(
  { status: 'completed' },
  {
    sort: { completedAt: -1 },
    stream: true,
    batchSize: 100
  }
);

// stream 是 Node.js Readable Stream
stream.on('data', (doc) => console.log(doc));
stream.on('end', () => console.log('完成'));
stream.on('error', (err) => console.error('错误:', err));
```

**返回值类型**：`ReadableStream`

### explain 模式返回执行计划

当 `explain` 为 true 或指定级别时，返回查询执行计划：

```javascript
const plan = await collection('orders').find(
  { status: 'paid' },
  { explain: 'executionStats' }
);

// plan = {
//   queryPlanner: { ... },
//   executionStats: {
//     executionTimeMillis: 5,
//     totalDocsExamined: 100,
//     totalKeysExamined: 100,
//     ...
//   }
// }
```

**返回值类型**：`Promise<Object>`

## 使用模式

### 1. 基础查询

最简单的查询方式，返回所有匹配的文档：

```javascript
// 查询所有活跃用户
const users = await collection('users').find(
  { status: 'active' }
);

// 查询指定字段
const users = await collection('users').find(
  { status: 'active' },
  { projection: { name: 1, email: 1 } }
);

// 带排序的查询
const users = await collection('users').find(
  { status: 'active' },
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);
```

**适用场景**：
- 数据量较小的集合
- 需要一次性获取所有结果
- 结果数量可控（建议设置 limit）

### 2. 分页查询（skip + limit）

使用 skip 和 limit 实现传统的分页：

```javascript
const page = 2;
const pageSize = 20;

const users = await collection('users').find(
  { status: 'active' },
  {
    sort: { createdAt: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize
  }
);
```

**性能注意**：
- skip 在大数据集上性能差（需要遍历跳过的文档）
- 不推荐 skip 超过 10,000
- 对于高性能分页，推荐使用 `findPage` 方法

### 3. 流式处理

流式处理大数据集，避免内存溢出：

```javascript
const stream = await collection('orders').find(
  {
    createdAt: { $gte: new Date('2024-01-01') }
  },
  {
    sort: { createdAt: 1 },
    stream: true,
    batchSize: 1000
  }
);

let count = 0;
let totalAmount = 0;

stream.on('data', (order) => {
  count++;
  totalAmount += order.amount;
});

stream.on('end', () => {
  console.log(`处理了 ${count} 条订单，总金额：${totalAmount}`);
});

stream.on('error', (err) => {
  console.error('流处理错误:', err);
});
```

**优势**：
- 内存占用恒定（只保存当前批次）
- 适合处理百万级数据
- 支持管道（pipe）操作

**注意**：
- 流式处理不支持缓存
- 建议设置合适的 batchSize（默认 1000）

### 4. 复杂查询条件

使用 MongoDB 查询操作符构建复杂查询：

```javascript
// 范围查询
const orders = await collection('orders').find(
  {
    amount: { $gte: 100, $lte: 1000 },
    status: { $in: ['paid', 'completed'] },
    createdAt: { $gte: new Date('2024-01-01') }
  },
  { sort: { amount: -1 } }
);

// 逻辑组合查询
const users = await collection('users').find(
  {
    $or: [
      { role: 'admin' },
      { $and: [{ level: { $gte: 5 } }, { verified: true }] }
    ]
  }
);

// 数组查询
const products = await collection('products').find(
  {
    tags: { $all: ['electronics', 'discount'] },
    'reviews.rating': { $gte: 4.5 }
  }
);
```

### 5. 使用索引优化

通过 hint 强制使用索引，explain 查看执行计划：

```javascript
// 查看执行计划
const plan = await collection('orders').find(
  { status: 'paid', amount: { $gte: 1000 } },
  {
    sort: { createdAt: -1 },
    explain: 'executionStats'
  }
);
});

console.log('执行时间:', plan.executionStats.executionTimeMillis, 'ms');
console.log('扫描文档数:', plan.executionStats.totalDocsExamined);
console.log('使用的索引:', plan.executionStats.inputStage?.indexName);

// 强制使用索引
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },
    hint: 'status_createdAt_idx',
    limit: 100
  }
);
```

### 6. 缓存查询结果

对于频繁查询且变化不大的数据，使用缓存提升性能：

```javascript
// 缓存 5 分钟
const categories = await collection('categories').find(
  { enabled: true },
  {
    sort: { order: 1 },
    cache: 300000  // 5 * 60 * 1000
  }
);

// 热门商品列表，缓存 10 分钟
const hotProducts = await collection('products').find(
  { hot: true, inStock: true },
  {
    sort: { sales: -1 },
    limit: 20,
    projection: ['name', 'price', 'image'],
    cache: 600000  // 10 * 60 * 1000
  }
);
```

**缓存说明**：
- 缓存键基于查询条件、排序、投影等参数自动生成
- 相同查询条件会复用缓存
- 缓存存储在实例级别（进程内存）
- 适合读多写少的场景

## 性能优化建议

### 1. 合理使用 limit

始终为查询设置合理的 limit，避免返回过多数据：

```javascript
// ❌ 不好：可能返回数百万条数据
const users = await collection('users').find(
  { status: 'active' }
);

// ✅ 好：限制返回数量
const users = await collection('users').find(
  { status: 'active' },
  { limit: 100 }
);
```

### 2. 只查询需要的字段

使用 projection 减少数据传输：

```javascript
// ❌ 不好：返回所有字段
const users = await collection('users').find(
  { status: 'active' }
);

// ✅ 好：只返回需要的字段
const users = await collection('users').find(
  { status: 'active' },
  { projection: { name: 1, email: 1 } }
);
```

### 3. 为排序字段建立索引

```javascript
// 确保有索引：db.orders.createIndex({ status: 1, createdAt: -1 })
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);
```

### 4. 避免大 skip

```javascript
// ❌ 不好：skip 大数据量性能差
const page10000 = await collection('orders').find(
  {},
  {
    skip: 99990,
    limit: 10
  }
);

// ✅ 好：使用 findPage 进行游标分页
const page = await collection('orders').findPage(
  {},
  {
    limit: 10,
    after: lastCursor
  }
);
```

### 5. 大数据集使用流式处理

```javascript
// ❌ 不好：一次性加载所有数据到内存
const allOrders = await collection('orders').find(
  { year: 2024 }
);
allOrders.forEach(order => process(order));

// ✅ 好：流式处理
const stream = await collection('orders').find(
  { year: 2024 },
  { stream: true }
);
stream.on('data', order => process(order));
```

### 6. 设置查询超时

防止慢查询阻塞系统：

```javascript
const users = await collection('users').find(
  { complexCondition: '...' },
  { maxTimeMS: 5000 }  // 5 秒超时
);
```

## 错误处理

```javascript
try {
  const users = await collection('users').find(
    { status: 'active' },
    { maxTimeMS: 5000 }
  );
  
  console.log(`找到 ${users.length} 个用户`);
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.error('查询超时');
  } else if (error.code === 'INVALID_QUERY') {
    console.error('查询条件无效:', error.message);
  } else {
    console.error('查询失败:', error);
  }
}
```

## 与 findPage 的区别

| 特性 | find | findPage |
|------|------|----------|
| 返回格式 | 数组 | 带分页信息的对象 |
| 游标分页 | ❌ | ✅ |
| 跳页功能 | ❌ | ✅（书签机制） |
| 总数统计 | ❌ | ✅ |
| 流式处理 | ✅ | ✅ |
| 传统分页（skip） | ✅ | ✅（offsetJump） |
| 适用场景 | 简单查询 | 高性能分页 |

**选择建议**：
- 简单的一次性查询：使用 `find`
- 需要分页的列表：使用 `findPage`
- 大数据集处理：两者都支持 stream
- 需要总数统计：使用 `findPage`

## 参考资料

- [MongoDB find 文档](https://docs.mongodb.com/manual/reference/method/db.collection.find/)
- [findPage 方法文档](./findPage.md)
- [find 方法示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find.ts)
- [find 方法测试](../../test/integration/mongodb/find.test.ts)

## 常见问题 FAQ

### Q1: find 和 findPage 应该如何选择？

**A**: 根据使用场景选择：

- **使用 find**：
  - 一次性获取少量数据（< 100 条）
  - 不需要分页功能
  - 简单的数据导出或统计
  - 已知数据量很小

- **使用 findPage**：
  - 需要分页展示列表
  - 数据量较大（> 1000 条）
  - 需要游标分页功能
  - 需要获取总数统计

### Q2: 为什么不推荐大量使用 skip？

**A**: skip 的性能问题：
- MongoDB 必须遍历所有被跳过的文档
- skip(10000) 需要扫描 10000 个文档
- 在大数据集上性能呈线性下降
- 推荐使用 findPage 的游标分页替代

### Q3: 如何优化 find 查询性能？

**A**: 性能优化清单：
1. ✅ 为查询字段和排序字段创建索引
2. ✅ 使用 projection 只查询需要的字段
3. ✅ 设置合理的 limit 限制
4. ✅ 使用 explain 分析查询计划
5. ✅ 对频繁查询启用缓存
6. ✅ 大数据集使用流式处理
7. ✅ 设置 maxTimeMS 防止慢查询

### Q4: 流式查询什么时候使用？

**A**: 适合使用流式查询的场景：
- 数据量超过 10 万条
- 需要逐条处理数据
- 内存有限制
- 数据导出或 ETL 操作
- 实时数据处理

### Q5: 缓存什么时候失效？

**A**: 缓存失效机制：
- 达到 TTL 时间自动失效
- 调用 `collection.invalidate()` 手动失效
- 进程重启后缓存清空
- 缓存键基于查询参数生成，参数变化则缓存失效

### Q6: 如何处理大数据量的排序？

**A**: 大数据排序优化：
```javascript
// 1. 创建覆盖索引
db.orders.createIndex({ status: 1, createdAt: -1, amount: 1 });

// 2. 使用索引排序
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },  // 使用索引字段排序
    projection: { amount: 1, createdAt: 1 },  // 投影使用索引字段
    limit: 100,
    hint: { status: 1, createdAt: -1 }  // 强制使用索引
  }
);

// 3. 避免：对未索引字段排序大数据集
// ❌ 性能差
const orders = await collection('orders').find(
  {},
  {
    sort: { randomField: -1 },  // 未索引字段
    limit: 10000  // 大数据量
  }
);
```

### Q7: 如何调试慢查询？

**A**: 慢查询调试步骤：
```javascript
// 1. 使用 explain 查看执行计划
const plan = await collection('orders').find(
  { status: 'paid', amount: { $gte: 1000 } },
  {
    sort: { createdAt: -1 },
    explain: 'executionStats'
  }
);

console.log('执行时间:', plan.executionStats.executionTimeMillis, 'ms');
console.log('扫描文档:', plan.executionStats.totalDocsExamined);
console.log('返回文档:', plan.executionStats.nReturned);
console.log('使用索引:', plan.executionStats.inputStage?.indexName || '无');

// 2. 检查索引使用效率
const efficiency = plan.executionStats.nReturned / 
                   (plan.executionStats.totalDocsExamined || 1);
if (efficiency < 0.1) {
  console.warn('⚠️ 查询效率低于 10%，建议优化索引');
}

// 3. 监听慢查询事件
msq.on('slow-query', (meta) => {
  console.warn('慢查询:', meta);
});
```

## 最佳实践

### 1. 始终设置 limit

```javascript
// ❌ 危险：可能返回数百万条数据
const users = await collection('users').find(
  { status: 'active' }
});

// ✅ 安全：限制返回数量
const users = await collection('users').find(
  { status: 'active' },
  {
    limit: 100
  }
);
```

### 2. 使用投影减少数据传输

```javascript
// ❌ 返回所有字段（包括大文本、二进制等）
const users = await collection('users').find(
  { status: 'active' },
  {
    limit: 100
  }
);

// ✅ 只返回需要的字段
const users = await collection('users').find(
  { status: 'active' },
  {
    projection: { name: 1, email: 1, avatar: 1 },
    limit: 100
  }
);
```

### 3. 复合排序确保稳定性

```javascript
// ❌ 不稳定：相同 createdAt 的顺序不确定
const orders = await collection('orders').find(
  {},
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);

// ✅ 稳定：添加 _id 确保排序稳定
const orders = await collection('orders').find(
  {},
  {
    sort: { createdAt: -1, _id: 1 },
    limit: 20
  }
);
```

### 4. 合理使用缓存

```javascript
// 适合缓存的场景
const categories = await collection('categories').find(
  { enabled: true },
  {
    sort: { order: 1 },
    cache: 600000  // 缓存 10 分钟（数据变化不频繁）
  }
);

// 不适合缓存的场景
const realtimeOrders = await collection('orders').find(
  { status: 'pending' },
  {
    sort: { createdAt: -1 }
    // 不设置 cache（实时数据）
  }
);
```

### 5. 处理异常情况

```javascript
async function safeFind(collectionName, query, options) {
  try {
    const result = await collection(collectionName).find(query, options);
    return { success: true, data: result };
  } catch (error) {
    if (error.code === 50) {  // MongoDB 超时错误
      console.error('查询超时，请优化查询条件或添加索引');
      return { success: false, error: 'TIMEOUT', data: [] };
    } else if (error.name === 'MongoServerError') {
      console.error('数据库错误:', error.message);
      return { success: false, error: 'DB_ERROR', data: [] };
    } else {
      console.error('未知错误:', error);
      return { success: false, error: 'UNKNOWN', data: [] };
    }
  }
}
```

### 6. 批量处理大数据

```javascript
// 使用流式处理批量操作
async function batchProcess(collectionName, processFunc, batchSize = 1000) {
  const stream = await collection(collectionName).find(
    {},
    {
      stream: true,
      batchSize
    }
  );

  let batch = [];
  let processedCount = 0;

  stream.on('data', async (doc) => {
    batch.push(doc);
    
    if (batch.length >= batchSize) {
      stream.pause();
      await processFunc(batch);
      processedCount += batch.length;
      console.log(`已处理: ${processedCount} 条`);
      batch = [];
      stream.resume();
    }
  });

  stream.on('end', async () => {
    if (batch.length > 0) {
      await processFunc(batch);
      processedCount += batch.length;
    }
    console.log(`总共处理: ${processedCount} 条`);
  });
}
```
