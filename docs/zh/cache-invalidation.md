# 缓存失效

使用远端命中回填的 `MultiLevelCache` 在按标签失效时会清整个 L1，因为匿名回填可能没有标签元数据；无关的 L2 条目保留。共享同一物理 L1 的包装在进程内协调在途回填，包括 CJS/ESM 消费者。失效前或失效窗口内开始的读取不能在之后重新回填，已经派发的 setter 会在清理前排空。L1 清理失败后持续绕过本地读取和回填，直到后续清理成功。远端错误与广播策略保持原样，不构成数据库与 Redis 的原子操作。

按键、批量、模式删除，接收远端 key/pattern 失效，以及 `clear()` 同样会撤销旧回填并排空已派发的 setter。key/pattern 删除保留无关 L1 和原有 L1 布尔值/计数返回；`delMany([])` 仍无副作用返回 `0`。`clear()` 只清 L1，之后新读取仍可从 L2 回填。在途读取可以向原调用方返回旧快照，但不能在删除后重新填入 L1。远端错误及广播策略保持原样。同一活跃适配器操作内部等待删除或清理会以 `INVALID_OPERATION` 拒绝，防止等待自身；显式业务写入与删除不因此成为原子操作。

开启写失效后，返回 null 的 before-upsert、匹配到文档的 increment，以及 updateMany/批量写部分失败也会安排失效。受管事务在 commit 时处理 intent，abort 时丢弃；已结束事务不再广播新 intent。insertBatch 部分结果只统计驱动确认的插入，候选或预分配 ID 本身不证明成功。已有关闭失效选项继续有效。

缓存作用域包含数据源指纹、认证身份、连接池、数据库、集合和可选实例标识。键中只保存连接配置的摘要，不保存原始 URI 或密码。在同一个 CacheLike 对象及实例命名空间上登记、具有相同数据源主机配置的池会联动失效，不同数据源的结果缓存隔离。主机配置不同但实际指向同一数据源的别名，应配置一致的连接端点或显式清理相关池。缺少连接配置的自定义客户端按对象身份隔离结果，并保守联动清理已注册路由。

升级后查询缓存和书签会冷启动；不会读取旧格式条目，也不会执行 Redis 全库清空。旧条目由原 TTL／清理策略回收，所有共享缓存的应用实例应完成升级。

同一进程内，共享 CacheLike 对象的在途查询会在失效时撤销回填资格；已经开始的异步 set 会先完成，再删除。规则适用于普通查询、分页、totals、事务提交及接收远端失效消息。跨进程 Redis 通知仍是最终一致性，不能保证数据库与缓存的强一致事务。`cache.invalidate:false` 或空数组继续关闭该次失效。


读缓存需要在查询上显式开启，写入后的缓存失效也需要按单次写入或运行时配置显式开启。

从其他实例收到的分布式失效消息只清理本地缓存，不再次发布失效消息。本地主动失效仍正常发布；并发到来的本地写入和入站消息分别处理。

## 默认行为

写操作默认不失效读缓存：

```ts
await products.find({ category: 'phone' }, { cache: 60_000 });

await products.updateOne(
  { sku: 'p-100' },
  { $set: { price: 799 } }
);

// TTL 过期前，这里仍可能返回缓存值。
await products.find({ category: 'phone' }, { cache: 60_000 });
```

这样可以避免写多系统因为默认 broad 失效产生大量缓存删除和回填压力。

## 单次写入精准失效

如果明确知道本次写入影响哪个缓存读请求，使用 `cache.invalidate`：

```ts
await products.updateOne(
  { sku: 'p-100' },
  { $set: { price: 799 } },
  {
    cache: {
      invalidate: [{
        operation: 'findOne',
        query: { sku: 'p-100' },
        options: { cache: 60_000 }
      }]
    }
  }
);
```

支持的 descriptor 操作：`find`、`findOne`、`count`、`findPage`、`aggregate`、`distinct`、`findOneById`、`findByIds`。

对于聚合写入管道（`$merge` / `$out`），descriptor 失效会按写入目标集合解析。

aggregate descriptor 应传入与缓存读取相同的原始管道及影响结果的选项，包括受支持的 `expr` 值。读取与失效采用相同的 ObjectId 转换和表达式语义，已准备的 literal 值不会再次解释。无效 descriptor 仍按 best effort 处理，不撤销成功写入。事务保留登记时解析的 key，提交后失效，回滚则丢弃。

本次 key 代次更新会让 aggregate 缓存冷启动，避免复用此前混淆 literal 字符串和 ObjectId 的条目；按操作失效仍覆盖新旧两代。混合版本部署期间优先按操作或命名空间失效，因为旧进程的精确 descriptor 无法重建新 key。

| Descriptor 形态 | 作用 |
| --- | --- |
| `{ operation, query, options }` 或 `{ op, query, options }` | 重建 `find`、`findOne` 或 `count` 的精确读缓存 key。 |
| `{ operation: 'findPage', query, options }` | 重建分页缓存 key；当 `options.query` 不存在时会把 `query` 合并进去。 |
| `{ operation: 'aggregate', pipeline, options }` | 重建 aggregate 读缓存 key。 |
| `{ operation: 'distinct', field, query, options }` | 按指定 field 重建 distinct 读缓存 key。 |
| `{ operation: 'findOneById', id, options }` / `{ operation: 'findByIds', ids, options }` | 重建 ID 读取缓存 key。 |
| `{ cacheKey }` / `{ cacheKeys }` | 删除应用传入的一个或多个精确缓存 key。 |
| `{ pattern }` / `{ patterns }` | 按一个或多个 `delPattern` pattern 删除缓存。 |
| `true` | broad 失效当前命名空间下所有读缓存 pattern。 |
| `false` / `[]` | 本次写入显式不做缓存失效。 |

## 单次写入不失效覆盖

`cache.invalidate: false` 与 `cache.invalidate: []` 表示本次写入不失效任何缓存。即使实例配置了 `cache.autoInvalidate: true`，也会被本次空清单覆盖：

```ts
await products.updateOne(
  { sku: 'p-100' },
  { $set: { viewedAt: new Date() } },
  { cache: { invalidate: [] } }
);
```

## 广泛失效

当一次写入可能影响大量缓存读请求时，可以选择 broad 失效：

```ts
await products.insertOne(
  { sku: 'p-101', category: 'phone' },
  { autoInvalidate: true }
);
```

也可以全局开启：

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri },
  cache: {
    autoInvalidate: true
  }
});
```

全局 broad 失效更省心，但会增加缓存删除量、Redis Pub/Sub 消息量和缓存回填压力。

## 手动失效

使用原生 driver、外部任务或维护脚本改数据后，调用 `collection.invalidate()`：

```ts
await products.invalidate('find');
await products.invalidate();
```

`invalidate()` 清理集合读缓存 pattern。它不会让 MongoDB 写入与缓存失效变成原子提交。
