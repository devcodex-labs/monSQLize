# deleteOne() - 删除单个文档


`deleteOne()` 方法删除集合中第一个匹配筛选条件的文档。

## 语法

```javascript
collection(name).deleteOne(filter, options?)
```

## 参数

### filter（必需）

**类型**: `Object`

用于匹配要删除的文档的筛选条件。使用 MongoDB 查询操作符。

```javascript
// 删除特定用户
await collection("users").deleteOne({ userId: "user123" });

// 使用查询操作符
await collection("products").deleteOne({
  price: { $lt: 10 },
  stock: 0
});
```

### options（可选）

**类型**: `Object`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `collation` | Object | - | 指定排序规则 |
| `hint` | string \| Object | - | 索引提示，强制使用特定索引 |
| `maxTimeMS` | number | - | 操作的最大执行时间（毫秒） |
| `writeConcern` | Object | - | 写关注选项 |
| `comment` | string | - | 操作注释，用于日志追踪 |

## 返回值

**类型**: `Promise<Object>`

返回一个包含删除结果的对象：

```javascript
{
  deletedCount: 1,     // 被删除的文档数量（0 或 1）
  acknowledged: true   // 操作是否被确认
}
```

## 面向已声明关系的受保护 Model 删除

`collection.deleteOne()` 保持原有行为。如果删除时必须阻止仍被已声明 Model relation 引用的目标，请显式使用 Model API：

```ts
const usage = await runtime.model('posts').checkRelationUsage(
  { _id: postId },
  { session, maxTargets: 100, maxSamples: 20 },
);

const deleted = await runtime.model('posts').deleteOneWithRelations(
  { _id: postId },
  { session },
);

// 物理删除目标，包括已经软删除的目标。
const forceDeleted = await runtime.model('posts').forceDeleteWithRelations(
  { _id: postId },
  { session },
);
```

`checkRelationUsage()` 是零写入检查，返回 `used`、每条关系的数量/有限 sample ID 以及 `coverage`。发现范围刻意限定为 `registered-declared`：只能发现当前 runtime 已注册、且明确声明为入站 relation 的 Model 关系。默认仍把软删除来源文档计作引用；只有诊断性查询才应显式设置 `includeSoftDeletedReferences: false`。

`deleteOneWithRelations()` 和 `forceDeleteWithRelations()` 要求传入非空对象 filter。它们先解析一个目标，扫描所有已声明入站关系，只有 `coverage.complete` 为 true 且不存在引用时，才调用既有的 Model 软删除或物理删除。为了不削弱安全性，受保护删除会拒绝 `includeRelations` 和 `excludeRelations`；使用它们缩小范围的只读检查会明确返回不完整 coverage。

- `RELATION_IN_USE`：至少发现一条已声明引用；不会发出删除写入。
- `RELATION_USAGE_UNAVAILABLE`：目标/来源扫描失败、命中 `maxTargets` 或 coverage 不完整；不会发出删除写入。

这是 restrict 风格的保护，不是数据库外键：不会从任意数据或 `$lookup` 管道反推关系，不会 cascade/更新引用，也无法消除扫描后并发新建引用的竞态。部署和业务工作流能够协调时，请用同一个 session/transaction 包裹相关写入。

## 核心特性

### ✅ 只删除第一个匹配的文档

即使有多个文档匹配筛选条件，`deleteOne()` 也只删除第一个匹配的文档。

```javascript
// 即使有多个 status="inactive" 的用户，也只删除第一个
const result = await collection("users").deleteOne({ status: "inactive" });
console.log(result.deletedCount); // 1（或 0 如果没有匹配）
```

### ✅ 显式缓存失效

删除成功后，monSQLize 默认不清理查询缓存。需要清理时，使用 `cache.invalidate` 精准失效，或使用 `autoInvalidate: true` 做集合级 broad 失效。

```javascript
// 第一次查询（从数据库）
const user = await collection("users").findOne(
  { userId: "user123" },
  { cache: 5000 }
);

// 删除用户，并按需清理缓存
await collection("users").deleteOne({ userId: "user123" });

// 再次查询（不会从缓存返回，因为已被清理）
const deletedUser = await collection("users").findOne(
  { userId: "user123" },
  { cache: 5000 }
); // null
```

### ✅ 慢查询监控

超过阈值（默认 1000ms）的删除操作会自动记录警告日志。

```javascript
// 配置慢查询阈值
const monsqlize = new MonSQLize({
  slowQueryMs: 500  // 超过 500ms 记录警告
});

// 慢删除操作会被记录
await collection("logs").deleteOne({
  timestamp: { $lt: new Date("2024-01-01") }
});
// 日志: [WARN] [deleteOne] 慢操作警告 { duration: 650ms, ... }
```

## 常见场景

### 场景 1: 删除单个用户

```javascript
// 根据用户ID删除
const result = await collection("users").deleteOne({ userId: "user123" });

if (result.deletedCount === 1) {
  console.log("用户已删除");
} else {
  console.log("用户不存在");
}
```

### 场景 2: 清理过期数据

```javascript
// 删除第一个过期的会话
const result = await collection("sessions").deleteOne({
  expiresAt: { $lt: new Date() }
});

console.log(`删除了 ${result.deletedCount} 个过期会话`);
```

### 场景 3: 删除特定状态的记录

```javascript
// 删除第一个待处理的任务
const result = await collection("tasks").deleteOne({
  status: "pending",
  priority: { $lt: 3 }
});

if (result.deletedCount === 0) {
  console.log("没有待删除的低优先级任务");
}
```

### 场景 4: 使用索引提示优化性能

```javascript
// 强制使用特定索引
const result = await collection("orders").deleteOne(
  {
    customerId: "cust123",
    status: "cancelled"
  },
  {
    hint: { customerId: 1, status: 1 },  // 使用复合索引
    comment: "cleanup-cancelled-orders"
  }
);
```

### 场景 5: 设置操作超时

```javascript
// 限制删除操作的最大执行时间
try {
  const result = await collection("logs").deleteOne(
    { level: "debug" },
    { maxTimeMS: 2000 }  // 最多 2 秒
  );
} catch (error) {
  if (error.code === ErrorCodes.OPERATION_TIMEOUT) {
    console.error("删除操作超时");
  }
}
```

## 与其他方法的区别

### vs deleteMany

| 特性 | deleteOne | deleteMany |
|------|-----------|------------|
| **删除数量** | 只删除第一个匹配的文档 | 删除所有匹配的文档 |
| **返回值** | `deletedCount: 0或1` | `deletedCount: 0或多个` |
| **性能** | 更快（找到第一个即停止） | 较慢（需要扫描所有匹配） |
| **使用场景** | 删除特定的单个记录 | 批量清理数据 |

```javascript
// deleteOne - 只删除一个
await collection("users").deleteOne({ status: "inactive" });
// 结果: 删除第一个 inactive 用户

// deleteMany - 删除所有匹配
await collection("users").deleteMany({ status: "inactive" });
// 结果: 删除所有 inactive 用户
```

### vs findOneAndDelete

| 特性 | deleteOne | findOneAndDelete |
|------|-----------|------------------|
| **返回内容** | 删除结果（`deletedCount`） | 被删除的文档内容 |
| **原子性** | 是（删除操作本身是原子的） | 是（查找和删除是原子操作） |
| **性能** | 稍快（不需要返回文档） | 稍慢（需要读取并返回文档） |
| **使用场景** | 只需知道是否删除成功 | 需要删除前的文档内容 |

```javascript
// deleteOne - 只返回删除计数
const result1 = await collection("users").deleteOne({ userId: "user123" });
console.log(result1); // { deletedCount: 1, acknowledged: true }

// findOneAndDelete - 返回被删除的文档
const result2 = await collection("users").findOneAndDelete({ userId: "user456" });
console.log(result2); // { _id: ..., userId: "user456", name: "Alice", ... }
```

## 错误处理

### 无效的筛选条件

```javascript
try {
  // 错误：filter 必须是对象
  await collection("users").deleteOne("user123");
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "filter 必须是对象类型"
}
```

### 操作超时

```javascript
try {
  await collection("logs").deleteOne(
    { timestamp: { $lt: new Date("2020-01-01") } },
    { maxTimeMS: 100 }  // 很短的超时
  );
} catch (error) {
  if (error.code === ErrorCodes.OPERATION_TIMEOUT) {
    console.error("删除操作超时");
  }
}
```

### 写关注错误

```javascript
try {
  await collection("users").deleteOne(
    { userId: "user123" },
    {
      writeConcern: { w: "majority", wtimeout: 1000 }
    }
  );
} catch (error) {
  if (error.code === ErrorCodes.WRITE_ERROR) {
    console.error("写操作失败:", error.message);
  }
}
```

## 性能优化建议

### 1. 使用索引

确保筛选条件中的字段有索引：

```javascript
// 先创建索引
await collection("users").createIndex({ userId: 1 });

// 然后删除（会使用索引）
await collection("users").deleteOne({ userId: "user123" });
```

### 2. 使用索引提示

对于复杂查询，明确指定使用哪个索引：

```javascript
await collection("orders").deleteOne(
  {
    customerId: "cust123",
    status: "cancelled",
    createdAt: { $lt: new Date("2024-01-01") }
  },
  {
    hint: { customerId: 1, createdAt: 1 }  // 使用复合索引
  }
);
```

### 3. 设置合理的超时

```javascript
// 避免长时间阻塞
await collection("logs").deleteOne(
  { level: "debug" },
  { maxTimeMS: 5000 }  // 5秒超时
);
```

### 4. 使用精确的筛选条件

```javascript
// 好：使用精确条件（通过索引快速查找）
await collection("users").deleteOne({ userId: "user123" });

// 不好：使用范围查询（可能需要扫描多个文档）
await collection("users").deleteOne({ age: { $gt: 18 } });
```

## 注意事项

### ⚠️ 删除是不可逆的

```javascript
// 删除后无法恢复
const result = await collection("users").deleteOne({ userId: "user123" });

// 如果需要保留记录，考虑使用软删除（标记为已删除）
await collection("users").updateOne(
  { userId: "user123" },
  { $set: { deleted: true, deletedAt: new Date() } }
);
```

### ⚠️ 删除顺序不确定

如果有多个文档匹配，删除哪个是不确定的（除非使用排序）：

```javascript
// 不确定删除哪个 inactive 用户
await collection("users").deleteOne({ status: "inactive" });

// 如果需要确定性，使用 findOneAndDelete 并指定排序
await collection("users").findOneAndDelete(
  { status: "inactive" },
  { sort: { createdAt: 1 } }  // 删除最早创建的
);
```

### ⚠️ 删除不影响索引

删除文档不会删除索引，索引会自动更新。

### ⚠️ 缓存失效的范围

`autoInvalidate: true` 会清理整个集合的相关缓存，不仅仅是被删除的文档：

```javascript
// 删除一个用户
await collection("users").deleteOne({ userId: "user123" });

// 所有 users 集合的缓存都会被清理
// 包括其他用户的缓存查询
```

## 相关方法

- [deleteMany()](./delete-many.md) - 删除所有匹配的文档
- [findOneAndDelete()](./find-one-and-delete.md) - 原子地查找并删除文档，返回被删除的文档
- [updateOne()](./update-one.md) - 更新单个文档（软删除的替代方案）

## 示例代码

完整的示例代码请参考 [delete 可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete.ts)。

## MongoDB 文档

- [MongoDB deleteOne 文档](https://www.mongodb.com/docs/manual/reference/method/db.collection.deleteOne/)
