# 快速上手

## 本页内容

安装并完成第一次连接后，可以用这一页直接跑通最常用的数据操作。这里按日常开发顺序放短示例：先写入和查询，再分页、更新、缓存，最后判断什么时候切到 `model()`：

- 插入单条或多条数据
- 查询单个文档或列表
- 分页查询
- 更新、upsert、删除
- 给热点读加短 TTL 缓存
- 判断何时从 `collection()` 切到 `model()`

可运行版本见 [`examples/quick-start/basic-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts)。

## 准备连接

```typescript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' }
});

await msq.connect();

const users = msq.collection('users');
```

## 插入数据

交互式写入用 `insertOne()`；已经有小批量数组时用 `insertMany()`。

```typescript
await users.insertOne({
  email: 'ada@example.com',
  name: 'Ada',
  status: 'active',
  loginCount: 1,
  createdAt: new Date()
});

await users.insertMany([
  { email: 'lin@example.com', name: 'Lin', status: 'active', loginCount: 3, createdAt: new Date() },
  { email: 'grace@example.com', name: 'Grace', status: 'disabled', loginCount: 0, createdAt: new Date() }
]);
```

大量导入时再看 [`insertBatch()`](./insertBatch.md)。

## 查询数据

查单条用 `findOne()`；查列表用 `find()`。`find()` 支持 `sort()`、`limit()`、`project()` 等链式方法。

```typescript
const ada = await users.findOne({ email: 'ada@example.com' });

const activeUsers = await users
  .find({ status: 'active' })
  .sort({ createdAt: -1 })
  .limit(10)
  .project({ email: 1, name: 1, status: 1, _id: 0 });
```

完整查询能力见 [`findOne()`](./findOne.md)、[`find()`](./find.md) 与 [链式查询](./chaining-api.md)。

## 分页列表

列表需要翻页时使用 `findPage()`。

```typescript
const page = await users.findPage({
  query: { status: 'active' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log(page.items);
console.log(page.pageInfo.endCursor);
```

下一页传入 `after: page.pageInfo.endCursor`。总数、游标类型提示、bookmark 等能力见 [`findPage()`](./findPage.md)。

## 更新与 Upsert

已知目标文档时用 `updateOne()`；不存在时也要创建则用 `upsertOne()`。

```typescript
await users.updateOne(
  { email: 'ada@example.com' },
  { $set: { lastLoginAt: new Date() }, $inc: { loginCount: 1 } }
);

await users.upsertOne(
  { email: 'new@example.com' },
  {
    $set: { name: 'New User', status: 'active' },
    $setOnInsert: { loginCount: 0, createdAt: new Date() }
  }
);
```

更多写法见 [`updateOne()`](./update-one.md)、[`updateMany()`](./update-many.md)、[`upsertOne()`](./upsert-one.md) 和 [Upsert 指南](./upsert-guide.md)。

## 统计与删除

计数用 `count()`；清理数据用带明确条件的 `deleteMany()`。

```typescript
const totalActive = await users.count({ status: 'active' });

const deleted = await users.deleteMany({ status: 'disabled' });
console.log(deleted.deletedCount);
```

详见 [`count()`](./count.md)、[`deleteOne()`](./delete-one.md)、[`deleteMany()`](./delete-many.md)。

## 给热点读加缓存

读操作可以传 `cache`，单位是毫秒。适合能接受短时间缓存的数据。

```typescript
const firstRead = await users.find(
  { status: 'active' },
  { cache: 60_000 }
).limit(5);

await users.updateOne(
  { email: 'lin@example.com' },
  { $set: { name: 'Lin Updated' } }
);

const afterWrite = await users.find(
  { status: 'active' },
  { cache: 60_000 }
).limit(5);
```

写操作默认不失效查询缓存。需要写后清缓存时，在单次写入上使用 `cache.invalidate` 精准指定缓存，或使用 `autoInvalidate: true` 做集合级 broad 失效。边界见 [缓存失效](./cache-invalidation.md) 与 [运行时一致性与边界](./runtime-architecture.md)。

## 什么时候用 Model

只需要 MongoDB 原生语义，加上 ObjectId 自动转换、查询缓存、分页、事务、统一错误等 monSQLize 能力时，先用 `collection()`。

当写入必须经过 schema 校验、默认值、hooks、timestamps、soft delete、relations 或乐观锁时，切到 `model()`。

```typescript
import MonSQLize from 'monsqlize';

MonSQLize.Model.define('users', {
  schema: (s) => s({
    email: 'string',
    name: 'string',
    status: 'string'
  }),
  defaults: { status: 'active' },
  timestamps: true
});

const User = msq.model('users');
await User.insertOne({ email: 'ada@example.com', name: 'Ada' });
```

需要强制某些命名空间必须走 Model 写入时，继续看 [Model 概览](./model.md) 与 [写路径策略](./write-path-policy.md)。

## 关闭连接

```typescript
await msq.close();
```

## 下一步

- 查看构造函数参数：[`configuration.md`](./configuration.md)。
- 阅读完整集合 API：[`api-index.md`](./api-index.md)。
- 对照可运行源码：[`examples.md`](./examples.md)。
