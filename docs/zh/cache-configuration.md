# 缓存配置

使用 `new MonSQLize()` 的 `cache` 配置数据库读缓存。

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017/shop' },
  cache: {
    maxEntries: 100_000,
    enableStats: true,
    autoInvalidate: false
  }
});
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `cache.maxEntries` | `number` | `100000` | 本地内存缓存最大条目数。 |
| `cache.maxMemory` | `number` | `0` | 最大内存预算，单位字节；`0` 表示不限制。 |
| `cache.defaultTtl` | `number` | 实现默认值 | 直接写 cache 时的默认 TTL。查询缓存仍使用查询参数里的 `cache` TTL。 |
| `cache.enableStats` | `boolean` | `true` | 统计命中、未命中、写入、删除和淘汰。 |
| `cache.enabled` | `boolean` | `true` | 设为 `false` 时关闭缓存子系统。 |
| `cache.autoInvalidate` | `boolean` | `false` | monSQLize 写入后按集合粒度广泛失效读缓存，包括已发送到驱动、可能部分成功再抛错的批量插入。 |
| `cache.distributed` | `object` | 关闭 | 多实例部署时用 Redis Pub/Sub 广播缓存失效。 |

## 查询 TTL

读缓存按查询显式开启：

```ts
const products = await msq.collection('products').find(
  { category: 'phone' },
  { cache: 30_000, limit: 20 }
);
```

读参数里的 `cache` 是毫秒级 TTL。未传 `cache` 时，该查询不进入缓存。

## 写入失效默认值

写操作默认不失效读缓存。只有接受集合级 broad 失效的性能与一致性取舍时，才建议全局开启：

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

需要精准控制的写路径，优先使用单次写入的 `cache.invalidate`。见 [缓存失效](./cache-invalidation.md)。
