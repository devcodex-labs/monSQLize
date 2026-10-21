# Cache Invalidation

For a `MultiLevelCache` using remote-hit backfills, tag invalidation clears the entire L1 because an anonymous backfill may lack tag metadata. Unrelated L2 entries are retained. Wrappers sharing the same physical L1 coordinate pending backfills within the process, including CJS/ESM consumers. Reads started before or during invalidation cannot refill that L1 afterward; already dispatched setters are drained before clearing. A failed L1 clear keeps local reads/backfills bypassed until a later successful cleanup. Remote failure and publication policies remain unchanged, so this does not make database/Redis operations atomic.

Key, batch and pattern deletion, received key/pattern invalidation, and `clear()` also revoke older backfills and drain dispatched setters. Key/pattern deletion retains unrelated L1 entries and its original L1 boolean/count result. `delMany([])` remains a no-op returning `0`. `clear()` clears only L1; later fresh reads may fill it from L2 again. A read already in flight may still return its old snapshot to that caller, but cannot repopulate L1 after deletion. Remote error/publication policies remain unchanged. Awaiting deletion or cleanup from that same active adapter operation rejects with `INVALID_OPERATION` to prevent self-waiting; explicit business writes are not made atomic with deletion.

When write invalidation is enabled, null-before upserts, matched increments and partial updateMany/batch failures also schedule invalidation. Managed transactions retain intents until commit and discard them on abort; ended transactions do not broadcast new intents. Partial insertBatch results count only driver-confirmed inserts; candidate/preallocated IDs alone are not success evidence. Existing opt-out controls remain effective.

Cache scopes include a data-source fingerprint, authentication identity, pool, database, collection and optional instance identity. Keys contain configuration digests, never raw connection URIs or passwords. Registered pools sharing the same CacheLike object, instance namespace and source host configuration invalidate together; separate sources have isolated result caches. Aliases with different host configurations pointing at the same source need consistent endpoints or explicit invalidation of the related pools. Custom clients without connection configuration use object identities for isolation and conservatively invalidate registered routes.

After upgrading, query caches and bookmarks start cold. Old-format entries are not read and Redis is never flushed globally. Existing TTL/cleanup policies reclaim old entries; upgrade all application instances sharing the cache.

Within a process, invalidation revokes pending fills on the same CacheLike object. An asynchronous set already dispatched must finish before deletion. This covers queries, pages, totals, transaction commits and received remote invalidation messages. Cross-process Redis notifications remain eventually consistent; they do not provide an atomic database/cache transaction. `cache.invalidate:false` and empty arrays still disable that write's invalidation.


Read caching is opt-in per query, and write invalidation is opt-in per write or per runtime configuration.

Distributed invalidation received from another instance clears local cache entries without publishing another invalidation. Locally initiated invalidation still publishes normally, so concurrent local writes and incoming messages are handled independently.

## Default Behavior

Writes do not invalidate read caches by default:

```ts
await products.find({ category: 'phone' }, { cache: 60_000 });

await products.updateOne(
  { sku: 'p-100' },
  { $set: { price: 799 } }
);

// This can still return the cached value until TTL expiry.
await products.find({ category: 'phone' }, { cache: 60_000 });
```

This avoids unexpected broad cache deletes on write-heavy systems.

## Per-Write Precise Invalidation

Use `cache.invalidate` when a write is known to affect a cached read:

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

Supported descriptor operations: `find`, `findOne`, `count`, `findPage`, `aggregate`, `distinct`, `findOneById`, and `findByIds`.

For aggregate write pipelines (`$merge` / `$out`), descriptor invalidation is resolved against the write target collection.

For an aggregate descriptor, pass the same original pipeline and result-affecting options as the cached read, including supported `expr` values. Captured pipelines use the same ObjectId conversion and expression semantics for reading and invalidation; prepared literal values are not interpreted again. Invalid descriptors remain best effort and do not undo a successful write. Transaction intents retain the resolved key until commit; abort discards it.

Aggregate caches start cold after this key-generation update, so entries that previously conflated literal strings and ObjectIds are not reused. Operation-wide invalidation still covers both generations. During a mixed-version rollout, prefer operation-wide or namespace-wide invalidation because exact descriptors from older processes cannot rebuild the new keys.

| Descriptor shape | Effect |
| --- | --- |
| `{ operation, query, options }` or `{ op, query, options }` | Rebuilds the exact read cache key for `find`, `findOne`, or `count`. |
| `{ operation: 'findPage', query, options }` | Rebuilds the page cache key; `query` is folded into `options.query` when it is not already present. |
| `{ operation: 'aggregate', pipeline, options }` | Rebuilds the aggregate read cache key. |
| `{ operation: 'distinct', field, query, options }` | Rebuilds the distinct read cache key for the specified field. |
| `{ operation: 'findOneById', id, options }` / `{ operation: 'findByIds', ids, options }` | Rebuilds ID-read cache keys. |
| `{ cacheKey }` / `{ cacheKeys }` | Deletes one or more exact cache keys supplied by the application. |
| `{ pattern }` / `{ patterns }` | Deletes cache entries matching one or more `delPattern` patterns. |
| `true` | Broadly invalidates all read cache patterns for the affected namespace. |
| `false` / `[]` | Explicit no-op for this write. |

## Per-Write No-Op Override

`cache.invalidate: false` and `cache.invalidate: []` mean "do not invalidate anything for this write". They override instance-level `cache.autoInvalidate: true`:

```ts
await products.updateOne(
  { sku: 'p-100' },
  { $set: { viewedAt: new Date() } },
  { cache: { invalidate: [] } }
);
```

## Broad Invalidation

Use broad invalidation when the write can affect many cached reads:

```ts
await products.insertOne(
  { sku: 'p-101', category: 'phone' },
  { autoInvalidate: true }
);
```

Or enable it globally:

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

Global broad invalidation is convenient but can increase cache delete volume, Redis Pub/Sub traffic, and cache refill pressure.

## Manual Invalidation

Use `collection.invalidate()` after native driver writes, external jobs, or maintenance scripts:

```ts
await products.invalidate('find');
await products.invalidate();
```

`invalidate()` clears collection read-cache patterns. It does not make MongoDB writes and cache invalidation atomic.
