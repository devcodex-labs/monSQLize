# Cache Configuration

Use the `cache` block on `new MonSQLize()` to configure database read caching.

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

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cache.maxEntries` | `number` | `100000` | Maximum number of local memory cache entries. |
| `cache.maxMemory` | `number` | `0` | Maximum memory budget in bytes. `0` means unlimited. |
| `cache.defaultTtl` | `number` | implementation default | Default TTL used by direct cache writes. Query caching still uses the per-query `cache` TTL. |
| `cache.enableStats` | `boolean` | `true` | Track hits, misses, sets, deletes, and evictions. |
| `cache.enabled` | `boolean` | `true` | Disable the cache subsystem when set to `false`. |
| `cache.autoInvalidate` | `boolean` | `false` | Broadly invalidate collection read caches after monSQLize writes, including dispatched bulk inserts that may partially succeed before failing. |
| `cache.distributed` | `object` | disabled | Redis Pub/Sub invalidation for multi-instance deployments. |

## Query TTL

Read caching is opt-in per query:

```ts
const products = await msq.collection('products').find(
  { category: 'phone' },
  { cache: 30_000, limit: 20 }
);
```

`cache` on a read option is a TTL in milliseconds. Omitting it means the query is not cached.

## Write Invalidation Default

Writes do not invalidate read caches by default. Enable broad invalidation globally only when that tradeoff is acceptable:

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

For precise write paths, prefer per-write `cache.invalidate`. See [Cache Invalidation](./cache-invalidation.md).
