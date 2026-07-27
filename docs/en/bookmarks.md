# Bookmark Maintenance API

## Overview

monSQLize provides three bookmark maintenance APIs for managing `findPage()` bookmark caches. These APIs are intended for operational diagnostics and pagination performance tuning.

## Core Features

- ✅ **Smart Hash Matching**: Automatically applies `ensureStableSort` normalization, ensuring the same cache key as findPage is used
- ✅ **Precise Control**: Supports managing bookmarks for specific queries by `keyDims`
- ✅ **Global Cleanup**: Omit `keyDims` to operate on all bookmarks in the collection
- ✅ **Out-of-range Detection**: `prewarmBookmarks` automatically detects pages beyond the available data
- ✅ **Cache Availability Check**: All APIs throw a `CACHE_UNAVAILABLE` error when cache is not available

## Usage scenarios

1. **Startup warm-up** - Warm hot pages to reduce first-query latency
2. **Operations monitoring** - View cached page distribution
3. **Refresh bookmarks after data changes** - Keep page navigation aligned with current data
4. **Memory management** - Clean bookmarks to release resources on demand

## API Description


## 1. prewarmBookmarks(keyDims, pages)

Warm up bookmark cache entries for the specified pages.


### Method signature

```javascript
async prewarmBookmarks(keyDims, pages)
```


### Parameters

| Parameters | Type | Required | Description |
|------|------|------|------|
| `keyDims` | Object | Yes | Query dimensions (query, sort, limit) |
| `pages` | Array<Number> | Yes | Array of page numbers to be preheated |

**keyDims object**:
```javascript
{
  query: { status: 'active' },      //Query conditions
  sort: { createdAt: -1 },          //Sorting rules (automatically normalized)
  limit: 10                          //Quantity per page
}
```


### Return value

```javascript
{
  warmed: 3,           //Number of pages successfully warmed up
  failed: 1,           //Number of pages that failed (out of range, etc.)
  keys: [              //cached key list
    'bm:iid123:mongodb:mydb:products:hash456:p1',
    'bm:iid123:mongodb:mydb:products:hash456:p2',
    'bm:iid123:mongodb:mydb:products:hash456:p3'
  ]
}
```


### Usage examples

```javascript
import MonSQLize from 'monsqlize';
const { collection } = await new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
}).connect();

//Warm up frequently used pages
const result = await collection('products').prewarmBookmarks(
  {
    query: { status: 'active' },
    sort: { createdAt: -1 },
    limit: 10
  },
  [1, 2, 3, 4, 5]  //Warm-up first 5 pages
);

console.log('Warm-up successful:', result.warmed);  // 5
console.log('Warm-up failed:', result.failed);  // 0
console.log('Number of cache keys:', result.keys.length);  // 5
```


### Error handling

```javascript
try {
  const result = await collection('orders').prewarmBookmarks(
    { query: { status: 'paid' }, sort: { createdAt: -1 }, limit: 20 },
    [1, 2, 3, 1000]  //Page 1000 may be out of range
  );

  if (result.failed > 0) {
    console.warn(`${result.failed} page(s) failed to warm up (possibly out of range)`);
  }
} catch (error) {
  if (error.code === 'CACHE_UNAVAILABLE') {
    console.error('Cache is unavailable; cannot warm up bookmarks');
  } else {
    console.error('Warm-up failed:', error.message);
  }
}
```

---


## 2. listBookmarks(keyDims?)

List cached bookmarks (supports filtering by query or viewing all).


### Method signature (2. listBookmarks(keyDims?))

```javascript
async listBookmarks(keyDims?)
```


### Parameters (2. listBookmarks(keyDims?))

| Parameters | Type | Required | Description |
|------|------|------|------|
| `keyDims` | Object | No | Query dimensions (if not passed, all will be listed) |


### Return value (2. listBookmarks(keyDims?))

**Filter by query**:
```javascript
{
  pages: [1, 2, 3, 5, 10],  //Cached page number list
  count: 5,                  //Number of caches
  keyPrefix: 'bm:iid123:mongodb:mydb:products:hash456'
}
```

**View All**:
```javascript
{
  keys: [                    //All bookmark keys
    'bm:iid123:mongodb:mydb:products:hash456:p1',
    'bm:iid123:mongodb:mydb:orders:hash789:p2',
    // ...
  ],
  count: 15                  //Total cache count
}
```


### Usage example (2. listBookmarks(keyDims?))

```javascript
//List bookmarks for a specific query
const list = await collection('orders').listBookmarks({
  query: { status: 'pending' },
  sort: { createdAt: -1 },
  limit: 50
});

console.log('Cached pages:', list.pages);  // [1, 2, 3, 5, 10, 20]
console.log('Number of caches:', list.count);     // 6

//List all bookmarks (without passing keyDims)
const allList = await collection('orders').listBookmarks();
console.log('Total cache count:', allList.count);  // 25
console.log('All cache keys:', allList.keys);
```


### Operation and maintenance monitoring scenario

```javascript
//Check bookmark usage regularly
async function monitorBookmarks() {
  const all = await collection('products').listBookmarks();
  console.log(`📊 Bookmark statistics: ${all.count} caches`);

  //Check cache distribution for a specific query
  const hotQuery = await collection('products').listBookmarks({
    query: { featured: true },
    sort: { sales: -1 },
    limit: 20
  });

  console.log(`Hot product query: ${hotQuery.pages.length} page cached`);
  console.log(`Page number distribution: ${hotQuery.pages.join(', ')}`);
}
```

---


## 3. clearBookmarks(keyDims?)

Clears the specified query or all bookmark caches.


### Method signature (3. clearBookmarks(keyDims?))

```javascript
async clearBookmarks(keyDims?)
```


### Parameters (3. clearBookmarks(keyDims?))

| Parameters | Type | Required | Description |
|------|------|------|------|
| `keyDims` | Object | No | Query dimensions (clear all if not passed) |


### Return value (3. clearBookmarks(keyDims?))

```javascript
{
  cleared: 5,  //Number of caches cleared
  keyPrefix: 'bm:iid123:mongodb:mydb:products:hash456'  //Key prefix to clear (optional)
}
```


### Usage example (3. clearBookmarks(keyDims?))

```javascript
//Clear bookmarks for a specific query
const clearResult = await collection('products').clearBookmarks({
  query: { category: 'books' },
  sort: { title: 1 },
  limit: 10
});

console.log('Cleared:', clearResult.cleared, 'bookmark');

//Clear all bookmarks (without passing keyDims)
const clearAllResult = await collection('products').clearBookmarks();
console.log('All bookmarks have been cleared:', clearAllResult.cleared, 'bookmarks');
```


### Data update scenario

```javascript
//Clear related bookmarks after updating products in batches
async function updateProducts(updates) {
  //1. Perform batch updates
  await collection('products').updateMany(
    { category: 'electronics' },
    { $set: updates }
  );

  //2. Clear bookmarks for related queries
  await collection('products').clearBookmarks({
    query: { category: 'electronics' },
    sort: { price: 1 },
    limit: 50
  });

  //3. Optional: clear matching findPage read caches
  await collection('products').invalidate('findPage');

  console.log('✅ Product update completed; bookmarks have been refreshed');
}
```

---

## Complete workflow example


## Scenario 1: System startup warm-up

```javascript
import MonSQLize from 'monsqlize';

async function prewarmOnStartup() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();

  console.log('🚀 Starting bookmark warm-up...');

  //Warm popular product query pages (first 10 pages)
  const hotProducts = await collection('products').prewarmBookmarks(
    {
      query: { featured: true, inStock: true },
      sort: { sales: -1 },
      limit: 20
    },
    Array.from({ length: 10 }, (_, i) => i + 1)  // [1, 2, ..., 10]
  );

  console.log(`✅ Hot Products: warmed ${hotProducts.warmed} page(s)`);

  //Warm up recent order query (first 5 pages)
  const recentOrders = await collection('orders').prewarmBookmarks(
    {
      query: { status: 'pending' },
      sort: { createdAt: -1 },
      limit: 50
    },
    [1, 2, 3, 4, 5]
  );

  console.log(`✅ Pending orders: warmed ${recentOrders.warmed} page(s)`);
  console.log('🎉 Bookmark warm-up completed!');
}

prewarmOnStartup();
```


## Scenario 2: Clean up expired bookmarks regularly

```javascript
async function cleanupExpiredBookmarks() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();

  console.log('🧹 Cleaning up expired bookmarks...');

  //View current cache status
  const before = await collection('products').listBookmarks();
  console.log(`Before cleaning: ${before.count} bookmarks`);

  //Clean up bookmarks for a specific query
  const cleared1 = await collection('products').clearBookmarks({
    query: { category: 'discontinued' },
    sort: { name: 1 },
    limit: 20
  });

  console.log(`Cleared discontinued-product bookmarks: ${cleared1.cleared}`);

  //Check the status after cleaning
  const after = await collection('products').listBookmarks();
  console.log(`After cleaning: ${after.count} bookmarks`);
  console.log(`✅ Released ${before.count - after.count} bookmark entries`);
}

//Perform cleanup every hour
setInterval(cleanupExpiredBookmarks, 60 * 60 * 1000);
```


## Scenario 3: Refresh bookmarks after data updates

```javascript
async function refreshCacheAfterUpdate(category, updates) {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();

  console.log(`🔄 Updating ${category} category products...`);

  //1. Clear old bookmarks
  const oldBookmarks = await collection('products').clearBookmarks({
    query: { category },
    sort: { price: 1 },
    limit: 20
  });

  console.log(`Old bookmarks cleared: ${oldBookmarks.cleared}`);

  //2. Perform updates
  const updateResult = await collection('products').updateMany(
    { category },
    { $set: updates }
  );

  console.log(`${updateResult.modifiedCount} items updated`);

  //3. Warm up new bookmarks (first 5 pages)
  const newBookmarks = await collection('products').prewarmBookmarks(
    {
      query: { category },
      sort: { price: 1 },
      limit: 20
    },
    [1, 2, 3, 4, 5]
  );

  console.log(`✅ New bookmark: ${newBookmarks.warmed} page has been warmed`);
}

//Usage example
refreshCacheAfterUpdate('electronics', { discount: 0.1 });
```


## Scenario 4: Monitoring and Statistics

```javascript
async function monitorBookmarkUsage() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();

  //Get all bookmarks
  const all = await collection('products').listBookmarks();
  console.log(`\n📊 Bookmark usage statistics:`);
  console.log(`Total cache count: ${all.count}`);

  //Check the cache distribution of popular queries
  const queries = [
    { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
    { query: { category: 'electronics' }, sort: { price: 1 }, limit: 50 },
    { query: { inStock: true }, sort: { updatedAt: -1 }, limit: 30 }
  ];

  for (const q of queries) {
    const list = await collection('products').listBookmarks(q);
    console.log(`\n Query: ${JSON.stringify(q.query)}`);
    console.log(`Number of cached pages: ${list.pages?.length || 0}`);
    console.log(`Page number distribution: ${list.pages?.join(', ') || 'none'}`);
  }
}

//Monitor every minute
setInterval(monitorBookmarkUsage, 60 * 1000);
```

---

## Best Practices


## 1. Warm-up strategy

```javascript
//✅ Good: Warm up frequently used pages
await collection('products').prewarmBookmarks(
  { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
  [1, 2, 3, 4, 5]  //The first 5 pages are usually the most visited
);

//❌ Bad: Warming up too many pages
await collection('products').prewarmBookmarks(
  { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
  Array.from({ length: 1000 }, (_, i) => i + 1)  //Taking up too much memory
);
```


## 2. Cleanup timing

```javascript
//✅ Good: Clear bookmarks after related data changes
async function updateProductPrice(productId, newPrice) {
  await collection('products').updateOne(
    { _id: productId },
    { $set: { price: newPrice } }
  );

  //Clean up bookmarks for related queries
  await collection('products').clearBookmarks({
    query: { category: 'electronics' },
    sort: { price: 1 },
    limit: 20
  });
}

//❌ Bad: Clear all bookmarks too frequently
setInterval(async () => {
  await collection('products').clearBookmarks();  //too often
}, 1000);
```


## 3. Monitoring and Alerting

```javascript
//✅ Good: Check cache health regularly
async function checkCacheHealth() {
  const all = await collection('products').listBookmarks();

  if (all.count > 10000) {
    console.warn('⚠️ There are too many bookmark entries; consider cleaning them');
  }

  if (all.count === 0) {
    console.info('ℹ️ No bookmark cache entries; consider warming popular queries');
  }
}
```

---

## Notes

1. **Cache key matching**: `sort` in `keyDims` automatically applies `ensureStableSort` normalization so the same cache key is used as `findPage()`
2. **Cache Availability**: All APIs throw `CACHE_UNAVAILABLE` errors when the cache is unavailable. Make sure the cache is configured before use.
3. **Memory Management**: Warming up too many pages will occupy a lot of memory. It is recommended to only warm up the first few pages that are commonly used.
4. **Failure page**: `prewarmBookmarks` automatically detects pages out of range. Failure pages will not affect the warm-up of successful pages.
5. **Read path usage**: matching bookmarks are consumed by `findPage()` page navigation to resume from the nearest warmed page.
6. **Global Cleanup**: when `clearBookmarks()` is called without parameters, all bookmarks in the collection are cleared. Use it carefully.

---

## Error handling (Part 2)

```javascript
try {
  //Try to warm up bookmarks
  const result = await collection('orders').prewarmBookmarks(
    { query: { status: 'paid' }, sort: { createdAt: -1 }, limit: 20 },
    [1, 2, 3, 1000]
  );

  if (result.failed > 0) {
    console.warn(`${result.failed} page(s) failed to warm up`);
  }
} catch (error) {
  if (error.code === 'CACHE_UNAVAILABLE') {
    console.error('Cache is not available, please check cache configuration');
  } else if (error.code === 'VALIDATION_ERROR') {
    console.error('Parameter validation failed:', error.details);
  } else {
    console.error('Operation failed:', error.message);
  }
}
```

---

## References

- [findPage method document](./findPage.md)
- [Cache Policy Document](./cache.md)
- [bookmarks sample code](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/bookmarks.ts)
- Performance optimization guide
