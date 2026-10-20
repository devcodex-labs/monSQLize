# findPage 方法详细文档

totals 缓存键区分 BSON/RegExp 查询和实际 count 选项，包括继承的 `let`、collation、hint。参数化 `$expr` 筛选在数据读取与计数时都接收 `let`，保留 BSON 文档字段顺序。已定义的顶层选项覆盖嵌套 `options`；totals 专属 hint/collation/maxTimeMS 覆盖仍优先。带 session 的读取绕过 totals 缓存。书签保留复合排序顺序，并与维护 API 共用生效查询选项。totals 与书签 `v4` 键冷启动，旧条目通过 TTL 或已有集合失效机制退出。


## 概述

`findPage` 是只读操作：`pipeline` 中的顶层 `$out` 或 `$merge` 会在访问缓存或数据库前报 `INVALID_OPERATION`，管道结构在调用时固定。写管道请使用 `aggregate`，并遵守写路径策略。

使用自定义管道时，`projection`/`project` 在用户阶段之后应用，返回项仍保留游标排序字段。支持包含、排除和数组投影；与管道组合的 find 专用 `$slice`、`$elemMatch`、positional 投影会报 `INVALID_OPERATION`，可改用 `aggregate` 的聚合表达式。未传管道时沿用原生 find 投影路径。

`findPage` 是 monSQLize 提供的高级分页查询方法，支持多种分页模式，包括游标分页、跳页、流式查询和总数统计等功能。

## 方法签名

```javascript
async findPage(options = {})
```

## 参数说明

### options 对象属性

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | Object | 否 | `{}` | MongoDB 查询条件 |
| `sort` | MongoDB `Sort` | 否 | `{ _id: 1 }` | 支持对象、字段字符串、Map、字段列表、单个键值对或元组列表；方向为 `1`、`-1`、`asc`、`ascending`、`desc`、`descending`。缺少 `_id` 时补充 `_id: 1`；无效方向及 `$meta` 抛出 `INVALID_ARGUMENT`。 |
| `limit` | Number | 是 | - | 每页返回的文档数量，最大值由 `findPageMaxLimit` 配置（默认 500） |
| `after` | String | 否 | - | 游标分页：获取指定游标之后的数据 |
| `before` | String | 否 | - | 游标分页：获取指定游标之前的数据 |
| `page` | Number | 否 | - | 跳页模式：指定要获取的页码（从 1 开始） |
| `projection` / `project` | Object/Array | 否 | - | 字段投影：指定返回的字段。`project` 是 `projection` 的别名；两者同时存在时 `projection` 优先。支持包含型 `{ field: 1 }` 和排除型 `{ field: 0 }`，也支持数组形式 `['field1', 'field2']`。**注意**：排序字段会被自动保留以确保游标正确生成，无需手动包含。 |
| `pipeline` | Array | 否 | `[]` | 附加的 MongoDB 聚合管道阶段（仅对当页数据生效，在 projection 之前执行） |
| `hint` | Object/String | 否 | - | 指定查询使用的索引 |
| `collation` | Object | 否 | - | 指定排序规则 |
| `maxTimeMS` | Number | 否 | 全局配置 | 查询超时时间（毫秒） |
| `allowDiskUse` | Boolean | 否 | `false` | 是否允许使用磁盘进行聚合操作 |
| `stream` | Boolean | 否 | `false` | 是否返回流对象 |
| `batchSize` | Number | 否 | - | 流式查询时的批次大小 |
| `jump` | Object | 否 | - | 跳页配置选项 |
| `offsetJump` | Object | 否 | - | 基于 offset 的跳页配置 |
| `totals` | Object | 否 | - | 总数统计配置 |
| `meta` | Boolean | 否 | `false` | 是否返回查询元信息 |
| `cache` | Number | 否 | `0` | 非流式、非 explain 分页结果缓存 TTL（毫秒）；`async` totals 使用独立缓存 |
| `explain` | Boolean/String | 否 | - | 返回查询执行计划，可选值：`true`、`'queryPlanner'`、`'executionStats'`、`'allPlansExecution'` |
| `cursorTypes` | Object | 否 | 实例配置 | 按字段提供恢复类型提示，与实例提示合并。 |
| `cursorValueNormalizer` | Function | 否 | 实例配置 | 自定义 `(field, value) => restoredValue`，替代所有游标字段的默认恢复。 |
| `cursorValueNormalizerVersion` | String | 否 | 实例配置 | 稳定策略标识与版本；单次覆盖转换函数时，配合结果缓存或书签预热必须显式提供。 |

### jump 配置项

用于优化跳页性能的书签机制。

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `step` | Number | `10` | 书签步长，每隔多少页保存一次书签 |
| `maxHops` | Number | `20` | 最大跳跃次数，防止过度跳页 |
| `keyDims` | Object | 自动生成 | 自定义书签键维度（高级用法） |

**书签机制说明**：
- 书签保存在 `<cache-namespace>:bm:` 下，命名空间包含数据源/认证指纹、连接池、数据库、集合及可选实例标识。
- 书签键根据实际查询值、规范化排序、limit、pipeline、游标类型提示及转换策略版本计算摘要；查询值不同不会共享锚点。
- 默认 TTL 为 6 小时（可通过 `defaults.bookmarks.ttlMs` 配置）
- 最多保存 10000 页的书签（可通过 `defaults.bookmarks.maxPages` 配置）

### offsetJump 配置项

使用传统的 offset 方式进行跳页（适合小数据量）。

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enable` | Boolean | `false` | 是否启用 offset 跳页 |
| `maxSkip` | Number | `50000` | 最大 skip 值，超过此值将使用书签机制；该值不能超过运行时 `findMaxSkip` 上限 |

**性能建议**：offset 跳页虽然简单，但在大数据集上性能较差，仅适合数据量小于 10 万条的场景。

### totals 配置项

用于获取总数和总页数信息。

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | String | `'none'` | 统计模式：`'none'`、`'sync'`、`'async'`、`'approx'` |
| `maxTimeMS` | Number | `2000` | 统计查询的超时时间 |
| `ttlMs` | Number | `600000` | 缓存有效期（10 分钟） |
| `hint` | Object/String | - | 统计查询使用的索引 |
| `collation` | Object | - | 统计查询的排序规则 |

#### totals 模式说明

- **none**: 不统计总数（默认），性能最佳
- **sync**: 同步统计，立即返回总数，可能影响响应时间（适合数据量较小或有索引优化的场景）
- **async**: 异步统计，首次返回 token，后台计算后缓存结果（适合大数据量）
- **approx**: 快速近似统计路径。空查询使用 `estimatedDocumentCount`；带过滤条件的查询使用 `countDocuments` 并透传 `hint` / `collation`，确保统计条件与查询一致。

**注意事项**：
- 统计结果会按 `ttlMs` 缓存，键前缀为 `findPageTotals:`
- 统计失败时会缓存 `total: null` 并附带 `error` 字段
- async 模式使用飞行中去重（inflight deduplication），同一 totals 计算尚未完成时会共享同一后台任务

## 返回值

### 普通模式返回对象

```javascript
{
  items: [
    { /* 文档数据 1 */ },
    { /* 文档数据 2 */ },
    // ...
  ],
  pageInfo: {
    hasNext: true,        // 是否有下一页
    hasPrev: false,       // 是否有上一页
    startCursor: "...",   // 起始游标（用于 before 分页）
    endCursor: "...",     // 结束游标（用于 after 分页）
    currentPage: 1        // 当前页码（仅在使用 page 参数时存在）
  },
  totals: {  // 仅在配置了 totals 时存在
    mode: "sync",         // 统计模式
    total: 1000,          // 总记录数
    totalPages: 100,      // 总页数
    ts: 1234567890,       // 统计时间戳
    token: "...",         // async 模式下的查询标识
    error: "..."          // 统计失败时的错误信息（可选）
  },
  meta: {  // 仅在 meta: true 时存在
    op: "findPage",
    durationMs: 123,
    cacheHit: false
  }
}
```

### 流式模式返回

当 `stream: true` 时，返回一个 MongoDB Cursor Stream 对象，可以使用流式 API：

```javascript
const stream = await collection('users').findPage({
  query: { status: 'active' },
  sort: { createdAt: -1 },
  limit: 100,
  stream: true,
  batchSize: 100  // 推荐设置合适的批次大小
});

stream.on('data', (doc) => {
  console.log(doc);
});

stream.on('end', () => {
  console.log('Stream ended');
});

stream.on('error', (err) => {
  console.error('Stream error:', err);
});
```

**流式模式限制**：
- 不支持跳页功能（page 参数只能为 1 或省略）
- 不支持 totals 统计
- 只支持游标分页（after/before）或首页查询
- 返回的是原始流对象，不包含 pageInfo

## 使用模式

### 1. 游标分页（推荐）

游标分页是最高效的分页方式，适合大数据集和实时数据。

```javascript
// 获取第一页
const page1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log('数据:', page1.items);
console.log('有下一页:', page1.pageInfo.hasNext);

// 获取下一页
const page2 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  after: page1.pageInfo.endCursor
});

// 获取上一页
const page0 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  before: page2.pageInfo.startCursor
});
```

**优势**：
- O(1) 性能，不受数据量影响
- 支持实时数据变化
- 内存占用小

**注意**：
- 游标包含排序字段的值，排序规则必须保持一致
- 未配置 `cursorSecret` 时，游标为纯 Base64url 编码，客户端可解码内容；配置后附加 HMAC-SHA256 签名，篡改的游标会被服务端拒绝
- 游标比较会在构造 MongoDB 过滤条件前恢复 JSON 往返后的值：默认会把 24 位十六进制字符串按 ObjectId 处理，把形如 ISO 时间戳的字符串按 Date 处理。如果字符串排序字段本身可能保存 ObjectId-like 或 ISO-like 值，请使用 `cursorTypes` 或 `cursorValueNormalizer` 固定类型。
- 游标锚点会按点路径读取排序值，因此支持 `{ 'metrics.rank': 1 }` 这类嵌套排序字段。
- 不要在客户端自行拼接或修改游标
- 如需长期跨会话持久化游标，请同时配合服务端自己的过期控制

**游标签名（推荐在生产环境启用）**：

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  cursorSecret: process.env.CURSOR_SECRET,  // 32+ 字节随机字符串
  requireCursorSecret: true
});
```

启用后，`endCursor` / `startCursor` 的格式变为 `<payload>.<signature>`，服务端在每次 `findPage` 调用时自动验签。签名不匹配时抛出 `INVALID_ARGUMENT` 错误。

> **升级注意**：如果你在 v1 运行期间生成了游标 token 并持久化（如存入数据库），在 v2 中开启 `cursorSecret` 后，这些旧 token 将因缺少签名字段而失效。迁移方案见下方"游标令牌升级策略"章节。

如果排序字段是可能长得像 Date 或 ObjectId 的字符串，请固定游标类型：

```ts
const page = await collection('events').findPage({
  sort: { token: 1 },
  cursorTypes: { token: 'string' }
});
```

### 2. 跳页模式

适合需要随机访问任意页码的场景。

```javascript
// 使用书签机制跳页
const page5 = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 5,
  jump: {
    step: 10,      // 每 10 页保存一次书签
    maxHops: 20    // 最多连续跳 20 次
  }
});

console.log(`第 ${page5.pageInfo.currentPage} 页数据:`, page5.items);

// 使用 offset 跳页（小数据量）
const page3 = await collection('products').findPage({
  query: { category: 'books' },
  sort: { title: 1 },
  limit: 50,
  page: 3,
  offsetJump: {
    enable: true,
    maxSkip: 10000
  }
});
```

**书签跳转原理**：
1. 每隔 `step` 页保存一个书签（游标）
2. 跳转时先定位到最近的书签页
3. 从书签页逐页跳转到目标页
4. 跳转次数不超过 `maxHops` 限制

`prewarmBookmarks()` 创建的 bookmark 会被 `findPage()` 在页码导航时读取。存在匹配 bookmark 时，`maxHops` 按“bookmark 页到目标页”的剩余跳数计算，而不是始终从第 1 页计算。

### 分页书签维护 API

分页书签维护属于 `findPage()` 的分页工作流。需要让跳页延迟更可控，或需要排查、查看、重置已保存的分页书签时，使用这些 API。

| API | 使用场景 |
|------|----------|
| `prewarmBookmarks(keyDims, pages)` | 在用户跳转前预热已知热点页。 |
| `listBookmarks(keyDims?)` | 查看某个查询或集合当前保存的书签页。 |
| `clearBookmarks(keyDims?)` | 大批量数据变化后或手动维护时清理旧书签。 |

`keyDims` 应描述与 `findPage()` 相同的 `query`、`sort` 和 `limit` 形态。运行时会规范化稳定排序字段，因此维护 API 会命中与页码导航一致的书签组。

完整返回结构和运维示例见 [Bookmark 维护 API 参考](./bookmarks.md)。

**适用场景**：
- 需要显示页码导航
- 用户可能跳转到任意页
- 数据相对稳定

### 3. 流式查询

适合处理大量数据，减少内存占用。

```javascript
// 首页流式查询
const stream1 = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 1000,
  stream: true,
  batchSize: 100
});

let count = 0;
stream1.on('data', (doc) => {
  count++;
  processLog(doc);
});

stream1.on('end', () => {
  console.log(`处理了 ${count} 条日志`);
});

stream1.on('error', (err) => {
  console.error('流处理错误:', err);
});

// 使用游标的流式查询
const firstPage = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 100
});

const stream2 = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 1000,
  after: firstPage.pageInfo.endCursor,
  stream: true,
  batchSize: 100
});
```

**使用建议**：
- 设置合理的 `batchSize`（推荐 100-1000）
- 使用 `limit` 限制返回数据量（防止无限流）
- 妥善处理错误事件
- 考虑背压（backpressure）控制

### 4. 获取总数统计

```javascript
// 同步获取总数
const pageWithTotal = await collection('users').findPage({
  query: { active: true },
  sort: { _id: 1 },
  limit: 20,
  totals: {
    mode: 'sync',
    maxTimeMS: 5000,
    hint: { active: 1 }  // 使用索引优化统计
  }
});

console.log(`总共 ${pageWithTotal.totals.total} 条记录`);
console.log(`共 ${pageWithTotal.totals.totalPages} 页`);

// 异步获取总数（首次返回 token）
const page1 = await collection('users').findPage({
  query: { active: true },
  sort: { _id: 1 },
  limit: 20,
  totals: { mode: 'async' }
});

if (page1.totals.total === null) {
  console.log('总数计算中，token:', page1.totals.token);

  // 稍后再次查询以获取结果
  setTimeout(async () => {
    const page1Again = await collection('users').findPage({
      query: { active: true },
      sort: { _id: 1 },
      limit: 20,
      totals: { mode: 'async' }
    });

    if (page1Again.totals.total !== null) {
      console.log(`总数：${page1Again.totals.total}`);
    } else {
      console.log('统计仍在进行中...');
    }
  }, 1000);
}
```

**最佳实践**：
- 小数据量（< 10 万）：使用 `sync` 模式
- 大数据量：使用 `async` 模式，避免阻塞
- 配置合理的 `maxTimeMS` 防止慢查询
- 使用 `hint` 指定索引优化 `countDocuments`

### 5. 查看执行计划（explain）

`explain` 参数可以帮助你分析查询性能，查看 MongoDB 如何执行分页查询。

```javascript
// 基础执行计划（queryPlanner 模式）
const explainResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  explain: true  // 或 'queryPlanner'
});

console.log('查询计划:', JSON.stringify(explainResult, null, 2));
console.log('使用的索引:', explainResult.queryPlanner?.winningPlan);

// 获取详细的执行统计（executionStats 模式）
const statsResult = await collection('orders').findPage({
  query: { status: 'paid', amount: { $gt: 1000 } },
  sort: { createdAt: -1 },
  limit: 50,
  hint: { status: 1, createdAt: -1 },
  explain: 'executionStats'
});

console.log('执行统计:');
console.log('  - 扫描文档数:', statsResult.executionStats.totalDocsExamined);
console.log('  - 返回文档数:', statsResult.executionStats.nReturned);
console.log('  - 执行时间:', statsResult.executionStats.executionTimeMillis, 'ms');
console.log('  - 索引使用:', statsResult.executionStats.executionStages);

// 分析所有备选计划（allPlansExecution 模式）
const allPlansResult = await collection('products').findPage({
  query: { category: 'electronics', price: { $lt: 500 } },
  sort: { price: 1 },
  limit: 30,
  explain: 'allPlansExecution'
});

console.log('所有备选查询计划:', allPlansResult.executionStats.allPlansExecution);

// 结合游标分页的 explain
const cursorExplain = await collection('orders').findPage({
  query: { status: 'completed' },
  sort: { completedAt: -1 },
  limit: 20,
  after: 'eyJzIjp7ImNvbXBsZXRlZEF0IjotMSwiX2lkIjoxfSwiYSI6eyJjb21wbGV0ZWRBdCI6eyIkZGF0ZSI6IjIwMjUtMDEtMTVUMTA6MDA6MDAuMDAwWiJ9LCJfaWQiOiI2Nzg5YWJjZDEyMzQ1Njc4OTBhYmNkZWYifX0=',
  explain: 'executionStats'
});

console.log('游标分页的执行计划:', cursorExplain.executionStats);
```

**explain 模式说明**：

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `true` 或 `'queryPlanner'` | 返回查询计划器选择的执行计划 | 查看使用的索引和查询策略 |
| `'executionStats'` | 返回执行统计信息（扫描/返回文档数、耗时等） | 性能分析和优化 |
| `'allPlansExecution'` | 返回所有备选计划的执行信息 | 深度优化和比较不同索引策略 |

**使用技巧**：
1. **索引验证**：使用 `explain: true` 确认查询是否使用了预期的索引
2. **性能分析**：使用 `explain: 'executionStats'` 查看实际扫描的文档数
3. **优化指标**：关注 `totalDocsExamined` 与 `nReturned` 的比值，理想情况下应接近 1
4. **不缓存结果**：`explain` 模式下不会缓存结果，不影响正常查询缓存

**注意事项**：
- `explain` 模式会直接返回执行计划对象，不返回分页结果
- 不能与 `stream` 模式同时使用
- `explain` 适用于所有分页模式（游标、跳页、offset）

## 错误处理

### 常见错误码

| 错误码 | 说明 | 解决方案 |
|--------|------|----------|
| `VALIDATION_ERROR` | 参数验证失败 | 检查参数是否符合要求，如 page 与 after/before 互斥 |
| `JUMP_TOO_FAR` | 跳页跨度过大 | 增加 maxHops 值或使用 offsetJump |
| `STREAM_NO_JUMP` | 流式模式不支持跳页 | 流式模式只能用于首页或游标分页 |
| `STREAM_NO_TOTALS` | 流式模式不支持统计 | 流式模式不能使用 totals 功能 |
| `CURSOR_INVALID` | 游标无效 | 使用有效的游标字符串 |
| `SORT_MISMATCH` | 排序规则不匹配 | 确保游标对应的排序规则一致 |

### 错误处理示例

```javascript
try {
  const result = await collection('orders').findPage({
    query: { status: 'paid' },
    sort: { createdAt: -1 },
    limit: 50,
    page: 1000,
    jump: { maxHops: 10 }
  });
} catch (error) {
  if (error.code === 'JUMP_TOO_FAR') {
    console.error('跳页距离太远:', error.details);
    // 解决方案：增加 maxHops 或使用 offsetJump
    const result = await collection('orders').findPage({
      query: { status: 'paid' },
      sort: { createdAt: -1 },
      limit: 50,
      page: 1000,
      jump: { maxHops: 50 }  // 增加限制
    });
  } else if (error.code === 'VALIDATION_ERROR') {
    console.error('参数错误:', error.details);
  } else {
    console.error('其他错误:', error);
  }
}
```

## 性能优化建议

### 1. 索引优化

确保查询字段和排序字段上有合适的索引：

```javascript
// 为常用查询创建复合索引
await collection('orders').createIndex({ status: 1, createdAt: -1 });

// 在 findPage 中使用 hint 指定索引
const result = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  hint: { status: 1, createdAt: -1 }
});
```

**索引设计原则**：
- 查询字段在前，排序字段在后
- 包含 `_id` 作为最后一个字段确保唯一性
- 使用 `explain()` 验证索引使用情况

### 2. 合理选择分页模式

- **游标分页**：适合顺序浏览、实时数据、大数据集
- **跳页模式**：适合需要随机访问页码的场景
- **offset 跳页**：仅适合小数据量（< 10000 条）
- **流式查询**：适合批量处理、ETL、导出等场景

### 3. 缓存策略

```javascript
// 实例级配置书签和缓存
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  bookmarks: {
    step: 10,           // 每 10 页保存书签
    maxHops: 20,        // 最多连续跳 20 次
    ttlMs: 6 * 3600000, // 书签缓存 6 小时
    maxPages: 10000     // 最多缓存 10000 页的书签
  },
  cache: {
    maxEntries: 100000, // 最大缓存条目数
    enableStats: true   // 启用统计
  }
});

// 查询级别启用缓存
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 20,
  cache: 60000  // 缓存 1 分钟
});
```

**缓存最佳实践**：
- 热门查询启用缓存
- 根据数据更新频率设置合理的 TTL
- 写入默认不失效 `findPage` 读缓存；需要写后清理时，使用 `cache.invalidate`、`autoInvalidate: true` 或手动调用 `collection.invalidate('findPage')`

### 4. 正确处理总数统计

**❌ 错误做法**：大数据量使用同步统计
```javascript
// 不好：千万级数据使用 sync 模式
const result = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 50,
  totals: { mode: 'sync' }  // 可能等待数秒甚至超时
});
```

**✅ 正确做法**：根据数据量选择合适的统计模式
```javascript
// 小数据量（< 10 万）- 使用 sync 模式
const smallResult = await collection('categories').findPage({
  query: { active: true },
  sort: { name: 1 },
  limit: 30,
  totals: {
    mode: 'sync',
    maxTimeMS: 2000,
    hint: { active: 1 }  // 使用索引加速统计
  }
});

// 大数据量 - 使用 async 模式
async function getPaginatedDataWithTotal(query, page) {
  const result = await collection('orders').findPage({
    query,
    sort: { createdAt: -1 },
    limit: 50,
    page,
    totals: {
      mode: 'async',
      maxTimeMS: 5000,
      ttlMs: 600000  // 缓存 10 分钟
    }
  });

  // 首次请求：total 为 null，返回 token
  if (result.totals && result.totals.total === null) {
    console.log('总数计算中...', result.totals.token);
  } else if (result.totals && result.totals.total !== null) {
    console.log(`共 ${result.totals.total} 条，${result.totals.totalPages} 页`);
  }

  return result;
}

// 不需要总数的场景 - 不统计（性能最佳）
const noTotalResult = await collection('feeds').findPage({
  query: { userId: currentUserId },
  sort: { createdAt: -1 },
  limit: 20,
  after: lastCursor
  // 不设置 totals，通过 hasNext 判断是否还有更多数据
});

console.log('还有更多:', noTotalResult.pageInfo.hasNext);
```

### 5. 流式查询的正确使用

```javascript
// 1. 设置合适的 batchSize
const stream1 = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: 1 },
  limit: 1000000,
  stream: true,
  batchSize: 1000,  // 每批次 1000 条
  allowDiskUse: true  // 大数据量允许使用磁盘
});

let processedCount = 0;
stream1.on('data', (doc) => {
  // 只处理当前文档，不累积
  processOrder(doc);
  processedCount++;

  if (processedCount % 10000 === 0) {
    console.log(`已处理 ${processedCount} 条订单`);
  }
});

stream1.on('end', () => {
  console.log(`处理完成！总计: ${processedCount}`);
});

// 2. 导出大量数据到文件
const fs = require('fs');
const { Transform } = require('stream');

async function exportToCSV() {
  const stream = await collection('users').findPage({
    query: { registered: true },
    sort: { registeredAt: 1 },
    limit: 500000,
    stream: true,
    batchSize: 1000,
    pipeline: [
      { $project: { email: 1, name: 1, registeredAt: 1 } }
    ]
  });

  const csvTransform = new Transform({
    objectMode: true,
    transform(doc, encoding, callback) {
      const row = `${doc._id},${doc.email},${doc.name},${doc.registeredAt}\n`;
      callback(null, row);
    }
  });

  const writeStream = fs.createWriteStream('users_export.csv');
  writeStream.write('id,email,name,registeredAt\n');

  stream.pipe(csvTransform).pipe(writeStream);

  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  console.log('导出完成');
}
```

### 6. 跳页性能优化

**❌ 错误做法**：跳转到远距离页面时配置不当
```javascript
// 不好：跳转到第 500 页但步长太大
const result = await collection('products').findPage({
  query: { category: 'books' },
  sort: { publishDate: -1 },
  limit: 50,
  page: 500,
  jump: {
    step: 100,  // 步长太大，第 500 页没有书签
    maxHops: 10  // 限制太小，无法到达
  }
});
// 可能抛出 JUMP_TOO_FAR 错误
```

**✅ 正确做法**：根据使用模式优化跳页配置
```javascript
// 1. 频繁跳页场景 - 密集书签
const result1 = await collection('products').findPage({
  query: { category: 'books' },
  sort: { publishDate: -1 },
  limit: 50,
  page: 500,
  jump: {
    step: 5,       // 每 5 页保存书签
    maxHops: 50,   // 允许跳 50 次
    ttlMs: 12 * 3600000  // 缓存 12 小时
  }
});

// 2. 小数据量 - 使用 offset 跳页
const result2 = await collection('categories').findPage({
  query: { active: true },
  sort: { name: 1 },
  limit: 20,
  page: 15,
  offsetJump: {
    enable: true,
    maxSkip: 10000  // 数据量小于 1 万条
  }
});

// 3. 检测跳页错误并降级处理
async function robustPagination(page) {
  try {
    return await collection('products').findPage({
      query: { inStock: true },
      sort: { updatedAt: -1 },
      limit: 50,
      page,
      jump: { step: 10, maxHops: 20 }
    });
  } catch (error) {
    if (error.code === 'JUMP_TOO_FAR') {
      console.log('跳页距离太远，尝试使用 offset 模式');
      return await collection('products').findPage({
        query: { inStock: true },
        sort: { updatedAt: -1 },
        limit: 50,
        page,
        offsetJump: { enable: true, maxSkip: 100000 }
      });
    }
    throw error;
  }
}
```

**跳页配置建议**：
- **< 100 页**：step = 5-10, maxHops = 20
- **100-1000 页**：step = 10-20, maxHops = 30-50
- **> 1000 页**：考虑使用游标分页或限制可跳转范围
- **小数据量**：优先使用 offsetJump

## 常见问题 (FAQ)

### Q: 游标分页和传统分页有什么区别？

**A**: 游标分页使用排序值作为定位点，性能为 O(1)；传统分页使用 skip/offset，性能随页码增加而下降。游标分页更适合大数据集和实时数据。

### Q: 为什么跳页需要设置 maxHops？

**A**: 防止恶意或错误请求导致过度跳转。每次跳转都是一次数据库查询，maxHops 限制可以保护系统性能。

### Q: 流式模式什么时候使用？

**A**: 处理大量数据且不需要一次性加载到内存时使用，如数据导出、批量处理、ETL 等场景。

### Q: totals 统计会影响性能吗？

**A**: sync 模式会影响响应时间，建议使用 async 模式。首次查询触发后台统计，后续查询返回缓存结果。

### Q: 书签会占用多少内存？

**A**: 每个书签大约 200-500 字节。默认最多缓存 10000 页，总内存占用约 2-5 MB，可以通过配置调整。

### Q: 如何处理数据变化导致的游标失效？

**A**: 捕获 `CURSOR_INVALID` 错误，重新从首页开始查询。对于经常变化的数据，建议使用时间戳等稳定字段排序。

### Q: page、after、before 参数可以同时使用吗？

**A**: 不可以。这三个参数是互斥的：
- `page` 用于跳页模式，不能与 `after` 或 `before` 同时使用
- `after` 和 `before` 用于游标分页，两者也不能同时使用
- 同时使用会抛出 `VALIDATION_ERROR` 错误

```javascript
// ❌ 错误：不能同时使用
await collection('orders').findPage({
  page: 5,
  after: 'cursor123'  // 错误！
});

// ✅ 正确：选择一种模式
await collection('orders').findPage({
  page: 5  // 跳页模式
});
// 或
await collection('orders').findPage({
  after: 'cursor123'  // 游标分页
});
```

### Q: 游标分页时，如何实现"上一页"功能？

**A**: 使用 `before` 参数结合 `startCursor`：

```javascript
// 第一页
const page1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

// 下一页
const page2 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  after: page1.pageInfo.endCursor
});

// 返回上一页
const backToPage1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  before: page2.pageInfo.startCursor  // 使用 before + startCursor
});
```

### Q: 为什么流式模式不支持 totals 统计？

**A**: 流式模式的设计目标是高效处理大量数据，返回的是 MongoDB 原始 Cursor Stream，不包含分页元信息。如果需要总数统计，应该：

1. 先使用普通模式获取首页和总数
2. 再使用流式模式处理后续数据

```javascript
// 方案：先获取总数，再流式处理
const firstPage = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 100,
  totals: { mode: 'sync' }
});

console.log(`共 ${firstPage.totals.total} 条记录`);

// 然后使用流式处理所有数据
const stream = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: firstPage.totals.total,
  stream: true,
  batchSize: 1000
});
```

### Q: 如何判断是否已经到达最后一页？

**A**: 使用 `pageInfo.hasNext` 字段：

```javascript
const result = await collection('products').findPage({
  query: { category: 'books' },
  sort: { price: 1 },
  limit: 50,
  page: 10
});

if (!result.pageInfo.hasNext) {
  console.log('已经是最后一页了');
} else {
  console.log('还有更多数据');
}
```

对于游标分页，同样可以通过 `hasNext` 判断：

```javascript
let cursor = null;
let pageNum = 1;

while (true) {
  const result = await collection('orders').findPage({
    query: { status: 'paid' },
    sort: { createdAt: -1 },
    limit: 100,
    after: cursor
  });

  console.log(`第 ${pageNum} 页: ${result.items.length} 条`);

  if (!result.pageInfo.hasNext) {
    console.log('所有数据处理完毕');
    break;
  }

  cursor = result.pageInfo.endCursor;
  pageNum++;
}
```

### Q: 跳页时出现 JUMP_TOO_FAR 错误怎么办？

**A**: 这个错误表示跳转距离超过了 `maxHops` 限制。有以下几种解决方案：

**方案 1：增加 maxHops 值**
```javascript
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 200,
  jump: {
    step: 10,
    maxHops: 50  // 增加到 50
  }
});
```

**方案 2：减小 step 值（更密集的书签）**
```javascript
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 200,
  jump: {
    step: 5,  // 每 5 页保存书签
    maxHops: 20
  }
});
```

**方案 3：降级到 offset 跳页**
```javascript
try {
  const result = await collection('products').findPage({
    query: { category: 'electronics' },
    sort: { price: 1 },
    limit: 50,
    page: 200,
    jump: { step: 10, maxHops: 20 }
  });
} catch (error) {
  if (error.code === 'JUMP_TOO_FAR') {
    // 降级到 offset 模式
    const result = await collection('products').findPage({
      query: { category: 'electronics' },
      sort: { price: 1 },
      limit: 50,
      page: 200,
      offsetJump: { enable: true, maxSkip: 100000 }
    });
  }
}
```

### Q: 如何优化大数据量的总数统计性能？

**A**: 建议采用以下策略：

**1. 使用 async 模式 + 长缓存**
```javascript
const result = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: -1 },
  limit: 50,
  totals: {
    mode: 'async',
    ttlMs: 1800000,  // 缓存 30 分钟
    maxTimeMS: 10000
  }
});
```

**2. 为统计查询指定索引**
```javascript
// 创建索引
await collection('orders').createIndex({ year: 1 });

// 使用 hint 指定索引
const result = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: -1 },
  limit: 50,
  totals: {
    mode: 'sync',
    hint: { year: 1 },  // 使用索引加速
    maxTimeMS: 3000
  }
});
```

**3. 只在需要时统计，其他时候通过 hasNext 判断**
```javascript
// 首页查询：获取总数
const firstPageResult = await collection('products').findPage({
  query: { inStock: true },
  sort: { updatedAt: -1 },
  limit: 50,
  page: 1,
  totals: { mode: 'async' }
});

// 后续页：不统计总数
const otherPageResult = await collection('products').findPage({
  query: { inStock: true },
  sort: { updatedAt: -1 },
  limit: 50,
  page: 5
  // 不设置 totals，节省性能
});
```

### Q: explain 模式会返回实际数据吗？

**A**: 不会。当使用 `explain` 参数时，findPage 会直接返回 MongoDB 的执行计划对象，不返回实际的分页数据和 pageInfo。

```javascript
// explain 模式：只返回执行计划
const explainResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  explain: 'executionStats'
});

console.log(explainResult);
// 输出：{ queryPlanner: {...}, executionStats: {...} }
// 没有 items、pageInfo 等字段

// 正常查询模式：返回数据
const dataResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log(dataResult);
// 输出：{ items: [...], pageInfo: {...} }
```

**使用建议**：explain 主要用于开发和调试阶段分析查询性能，不应在生产环境的正常请求中使用。

### Q: 缓存是如何工作的？数据更新后会自动失效吗？

**A**: 缓存机制说明：

**缓存内容**：
- **查询结果缓存**：键前缀为 `findPage:`，当 `cache` 大于 `0` 时缓存非流式、非 explain 分页结果
- **书签缓存**：键前缀为 `<cache-namespace>:bm:`，缓存跳页书签
- **总数缓存**：键前缀为 `findPageTotals:`，按 `totals.ttlMs` 缓存总数统计结果

**缓存失效**：
- TTL 会控制缓存自动过期
- 通过 monSQLize collection accessor 写入时，只有显式配置 `cache.invalidate`、`autoInvalidate: true` 或全局 `cache.autoInvalidate` 才会清理读缓存
- 如果通过原生 MongoDB driver、其他进程或外部任务改写数据，需要手动失效相关缓存

```javascript
// 更新数据
await collection('products').updateOne(
  { _id: productId },
  { $set: { price: 99 } }
);

// 手动失效缓存
await collection('products').invalidate('findPage');

// 或失效该集合的所有读缓存
await collection('products').invalidate();
```

**缓存键区分**：
- 同一缓存作用域内，查询、规范化排序、limit、投影、pipeline、游标及游标策略一致时，可以复用结果。
- 不同的查询条件会生成不同的缓存键
- 自定义转换函数需要稳定版本标识才能使用分页结果缓存和自动书签复用；原始键格式属于内部实现，详见[缓存失效](./cache-invalidation.md)。

```javascript
// 这两个查询使用相同的缓存
const r1 = await collection('products').findPage({
  query: { category: 'books' },
  sort: { price: 1 },
  limit: 20,
  cache: 60000
});

const r2 = await collection('products').findPage({
  query: { category: 'books' },
  sort: { price: 1 },
  limit: 20,
  cache: 60000
});
// r2 会命中 r1 的缓存

// 这个查询会使用不同的缓存（query 不同）
const r3 = await collection('products').findPage({
  query: { category: 'electronics' },  // 不同
  sort: { price: 1 },
  limit: 20,
  cache: 60000
});
```

### Q: pipeline 参数的作用范围是什么？

**A**: `pipeline` 只对**当页返回的 limit 条数据**生效，不影响分页逻辑和查询条件。

```javascript
// pipeline 只处理返回的 20 条数据
const result = await collection('orders').findPage({
  query: { status: 'completed' },
  sort: { completedAt: -1 },
  limit: 20,
  page: 1,
  pipeline: [
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user'
      }
    },
    { $unwind: '$user' },
    {
      $project: {
        orderId: 1,
        amount: 1,
        'user.name': 1,
        'user.email': 1
      }
    }
  ]
});

// result.items 包含 20 条经过 pipeline 处理的订单数据
// 包含关联的用户信息
```

**注意事项**：
1. pipeline 在分页逻辑**之后**执行
2. 不会影响 totals 统计（统计的是原始数据）
3. 不会影响游标计算（游标基于原始排序字段）
4. 适合做数据关联、字段转换等后处理

### Q: 如何实现无限滚动加载？

**A**: 使用游标分页配合前端状态管理：

**前端示例（React）**：
```javascript
import { useState, useEffect } from 'react';

function OrderList() {
  const [orders, setOrders] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);

  const loadMore = async () => {
    if (loading || !hasMore) return;

    setLoading(true);
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: { status: 'paid' },
          sort: { createdAt: -1 },
          limit: 20,
          after: cursor
        })
      });

      const result = await response.json();

      setOrders(prev => [...prev, ...result.items]);
      setCursor(result.pageInfo.endCursor);
      setHasMore(result.pageInfo.hasNext);
    } catch (error) {
      console.error('加载失败:', error);
    } finally {
      setLoading(false);
    }
  };

  // 初始加载
  useEffect(() => {
    loadMore();
  }, []);

  return (
    <div>
      {orders.map(order => (
        <div key={order._id}>{order.orderId}</div>
      ))}

      {hasMore && (
        <button onClick={loadMore} disabled={loading}>
          {loading ? '加载中...' : '加载更多'}
        </button>
      )}

      {!hasMore && <div>没有更多数据了</div>}
    </div>
  );
}
```

**后端示例（Node.js）**：
```javascript
app.post('/api/orders', async (req, res) => {
  try {
    const { query, sort, limit, after } = req.body;

    const result = await collection('orders').findPage({
      query,
      sort,
      limit: Math.min(limit, 100),  // 限制最大值
      after
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Q: findPage 和普通的 find 方法有什么区别？该如何选择？

**A**: 两者适用场景不同：

**使用 find 的场景**：
- 简单查询，不需要分页
- 数据量确定且较小（< 1000 条）
- 需要所有数据一次性返回
- 不需要游标、书签等高级功能

**使用 findPage 的场景**：
- 需要分页展示
- 数据量大或不确定
- 需要支持"下一页"、"上一页"、跳页等功能
- 需要总数统计
- 需要流式处理大数据
- 需要缓存分页结果

**示例对比**：
```javascript
// 场景 1：获取用户的前 10 个订单 -> 使用 find
const recentOrders = await collection('orders').find(
  { userId: '123' },
  {
    sort: { createdAt: -1 },
    limit: 10
  }
);

// 场景 2：分页浏览所有订单 -> 使用 findPage
const ordersPage = await collection('orders').findPage({
  query: { userId: '123' },
  sort: { createdAt: -1 },
  limit: 20,
  after: cursor
});

// 场景 3：导出大量数据 -> 使用 findPage 流式模式
const exportStream = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: 1 },
  limit: 1000000,
  stream: true,
  batchSize: 1000
});
```

**性能对比**：

| 操作 | find | findPage |
|------|------|----------|
| 简单查询 | ⚡ 更快 | 稍慢（有分页逻辑开销） |
| 大数据分页 | ❌ 不适用 | ✅ 高效 |
| 跳页 | ❌ 性能差 | ✅ 优化支持 |
| 流式处理 | ✅ 支持 | ✅ 支持 |
| 总数统计 | ❌ 需额外查询 | ✅ 内置支持 |

---

## 游标令牌安全与升级策略

### cursorSecret 的作用

`cursorSecret` 是一个可选的实例级配置项。未设置时，游标令牌是纯 Base64url 编码，任何人都可以解码或构造其内容（包含排序字段值）。设置后，每个令牌都会附加一个 HMAC-SHA256 签名：

```text
token 格式（无签名）:  <base64url-payload>
token 格式（有签名）:  <base64url-payload>.<base64url-signature>
```

服务端在每次 `findPage` 调用时自动验证签名。如果令牌被篡改（例如客户端手动修改了排序字段值来跳过数据），签名不匹配，服务端抛出 `INVALID_ARGUMENT` 错误。当前运行时使用 timing-safe comparison 验证签名。

**推荐在生产环境始终配置 cursorSecret**：

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  cursorSecret: process.env.CURSOR_SECRET,  // 随机字符串，建议 32+ 字节
  requireCursorSecret: true
});
```

`requireCursorSecret` 是兼容性可选项，默认 `false`。设置为 `true` 后，如果没有配置 `cursorSecret`，`findPage()` 会抛出 `INVALID_CONFIG`，避免继续产生或接受未签名游标。

### 游标值类型提示

游标载荷使用 JSON 编码，因此在构造 MongoDB 比较过滤条件前，需要恢复 Date 与 ObjectId。默认恢复逻辑保持旧行为：形如 ISO 时间戳的字符串会变成 `Date`，24 位十六进制字符串会变成 `ObjectId`。

当排序字段需要不同恢复方式时，可以使用 `cursorTypes`：

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  cursorTypes: {
    createdAt: 'date',
    _id: 'objectId',
    token: 'string'
  }
});

await collection('events').findPage({
  sort: { token: 1 },
  cursorTypes: { token: 'raw' }
});
```

如需自定义转换逻辑，可以在实例级或单次 `findPage()` 调用上提供 `cursorValueNormalizer(field, value)`。

配合缓存或预热书签使用时，请同时提供稳定的策略标识 `cursorValueNormalizerVersion`，例如 `token-string:v1`。标识应包含策略名称和版本；转换逻辑、闭包配置或恢复类型变化时，需要更新标识。同一标识必须始终对应相同的转换行为。

```ts
import { ObjectId } from 'mongodb';

await collection('events').findPage({
  sort: { token: 1 },
  cache: 60000,
  cursorValueNormalizer: (field, value) =>
    field === '_id' && typeof value === 'string' ? new ObjectId(value) : value,
  cursorValueNormalizerVersion: 'token-string:v1'
});
```

实例级配置同样支持该字段。单次调用覆盖转换函数时，必须同时指定本次策略标识，不能自动继承实例函数的标识。未提供标识的自定义函数仍可查询，但会跳过分页结果缓存和自动书签读取；预热书签会拒绝该配置。这样会增加深页跳转的数据库查询次数，也可能达到 `jump.maxHops` 限制。`cursorTypes`、策略标识同时参与结果缓存和书签的键计算。

自定义转换函数会替代所有排序字段的默认恢复及 `cursorTypes`，包括作为平局判定字段的 `_id`。必须显式处理 Date/ObjectId；直接返回 ObjectId 字符串可能导致游标比较错误。`{ _id: 0 }` 等排除式投影保留业务字段，所有游标排序字段（包括 `_id`）仍会出现在返回项中。

游标比较支持 null／缺失字段与常见标量 BSON 类型之间的排序边界。分页过滤使用 `$expr` 比较，实际索引效率取决于查询、排序和数据分布，应通过 `explain` 验证。数组排序的最小／最大元素规则不在此保证范围内。

### 从 v1 升级时的游标令牌兼容问题

**问题根源**：如果你在 v1 运行期间将 `endCursor` / `startCursor` 持久化存储（写入数据库、放入 Redis、编码在 URL 里），在 v2 开启 `cursorSecret` 后，这些旧令牌格式为 `<payload>`（无签名），v2 验证时会因找不到签名分隔符而解析失败。

**是否会影响你**：

| 场景 | 是否受影响 |
|------|-----------|
| 游标只在单次 HTTP 请求/响应周期内使用（前端拿到后立即翻页） | ❌ 不受影响（旧令牌在升级前已失效） |
| 游标持久化到数据库，用于"继续上次浏览位置"类功能 | ✅ 受影响 |
| 游标编码在分享链接 / 书签 URL 中 | ✅ 受影响 |
| 游标存入 Redis 做分页缓存 | ✅ 受影响 |

**迁移方案**

**方案 A（推荐）：双阶段部署**

1. v2 上线时**不设置** `cursorSecret`，保持与 v1 相同的无签名格式
2. 等持久化游标的 TTL 自然过期（通常数小时到数天）
3. 过期后，发布第二次部署，加入 `cursorSecret`
4. 此时所有在途游标均已失效，不会有旧格式令牌流入

```ts
// 阶段 1：暂不启用签名
const msq = new MonSQLize({ type: 'mongodb', /* cursorSecret 暂不设置 */ });

// 阶段 2：TTL 过期后启用
const msq = new MonSQLize({ type: 'mongodb', cursorSecret: process.env.CURSOR_SECRET });
```

**方案 B：主动清除持久化游标**

在 v2 部署前，清空所有已持久化的游标数据（数据库字段置 null、Redis key 删除等），然后直接带 `cursorSecret` 上线。用户的分页状态会重置到第一页。

```ts
// 部署前清理（伪代码）
await nativeDb.collection('user_states').updateMany({}, { $unset: { lastCursor: '' } });
await redis.del('session:cursor:*');

// 然后直接启用签名
const msq = new MonSQLize({ type: 'mongodb', cursorSecret: process.env.CURSOR_SECRET });
```

**方案 C：自定义错误降级**

在 API 层捕获 `INVALID_ARGUMENT` 错误，将游标重置为 null（即回到第一页）：

```ts
app.get('/api/orders', async (req, res) => {
  let cursor = req.query.cursor ?? null;
  try {
    const result = await collection('orders').findPage({
      sort: { createdAt: -1 },
      limit: 20,
      after: cursor,
    });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_ARGUMENT' && cursor) {
      // 旧格式游标，重置到首页
      const result = await collection('orders').findPage({
        sort: { createdAt: -1 },
        limit: 20,
      });
      res.json(result);
    } else {
      throw err;
    }
  }
});
```

---

## 相关文档

- [find 方法文档](./find.md)
- [缓存策略](./cache.md)
- [性能优化指南](./count-queue.md)
- [API 参考](./api-index.md)
- [monSQLize README](../../README.md)
