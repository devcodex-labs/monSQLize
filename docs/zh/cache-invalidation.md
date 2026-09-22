# 缓存失效

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
