# findPage method detailed documentation

## Overview

`findPage` is an advanced paging query method provided by monSQLize. It supports multiple paging modes, including cursor paging, page jump, streaming query, and total statistics.

## Method signature

```javascript
async findPage(options = {})
```

## Parameter description

### options object properties

| Parameters | Type | Required | Default value | Description |
|------|------|------|--------|------|
| `query` | Object | No | `{}` | MongoDB query conditions |
| `sort` | MongoDB `Sort` | No | `{ _id: 1 }` | Object, field string, Map, field list, single pair or tuple list; directions are `1`, `-1`, `asc`, `ascending`, `desc`, `descending`. Adds `_id: 1` when absent; invalid directions and `$meta` are rejected with `INVALID_ARGUMENT`. |
| `limit` | Number | Yes | - | The number of documents returned per page, the maximum value is configured by `findPageMaxLimit` (default 500) |
| `after` | String | No | - | Cursor paging: Get the data after the specified cursor |
| `before` | String | No | - | Cursor paging: Get the data before the specified cursor |
| `page` | Number | No | - | Page jump mode: Specify the page number to be obtained (starting from 1) |
| `projection` / `project` | Object/Array | No | - | Field projection: Specifies the fields returned. `project` is an alias for `projection`; `projection` wins when both are provided. Supports inclusive type `{ field: 1 }` and exclusive type `{ field: 0 }`, and also supports array form `['field1', 'field2']`. **NOTE**: The sort field is automatically preserved to ensure the cursor is generated correctly, no manual inclusion is required. |
| `pipeline` | Array | No | `[]` | Additional MongoDB aggregation pipeline stage (only effective for current page data, executed before projection) |
| `hint` | Object/String | No | - | Specify the index used by the query |
| `collation` | Object | No | - | Specify collation |
| `maxTimeMS` | Number | No | Global configuration | Query timeout (milliseconds) |
| `allowDiskUse` | Boolean | No | `false` | Whether to allow disk aggregation operations |
| `stream` | Boolean | No | `false` | Whether to return a stream object |
| `batchSize` | Number | No | - | Batch size during streaming query |
| `jump` | Object | No | - | Jump page configuration options |
| `offsetJump` | Object | No | - | Page jump configuration based on offset |
| `totals` | Object | No | - | Total statistics configuration |
| `meta` | Boolean | No | `false` | Whether to return query meta information |
| `cache` | Number | No | `0` | Cache TTL for non-stream/non-explain page results (milliseconds). `async` totals are cached separately |
| `explain` | Boolean/String | No | - | Returns the query execution plan, optional values: `true`, `'queryPlanner'`, `'executionStats'`, `'allPlansExecution'` |
| `cursorTypes` | Object | No | Instance defaults | Per-field restoration hints, merged with instance hints. |
| `cursorValueNormalizer` | Function | No | Instance default | Custom `(field, value) => restoredValue`; handles every cursor field instead of default restoration. |
| `cursorValueNormalizerVersion` | String | No | Instance default | Stable strategy identity/version. A per-query function override needs an explicit version for result caching and bookmark prewarming. |

### jump configuration item

Bookmark mechanism for optimizing page jump performance.

| Properties | Type | Default Value | Description |
|------|------|--------|------|
| `step` | Number | `10` | Bookmark step size, how many pages to save bookmarks |
| `maxHops` | Number | `20` | Maximum number of jumps to prevent excessive page jumps |
| `keyDims` | Object | Automatically generated | Custom bookmark key dimensions (advanced usage) |

**Bookmark mechanism description**:
- Bookmarks are saved under `<cache-namespace>:bm:`; the namespace includes source/authentication fingerprints, pool, database, collection and optional instance identity.
- Bookmark keys hash actual query values, normalized sort, limit, pipeline, cursor type hints and normalizer version; queries with different values do not share anchors.
- Default TTL is 6 hours (configurable via `defaults.bookmarks.ttlMs`)
- Save bookmarks for up to 10000 pages (configurable via `defaults.bookmarks.maxPages`)

### offsetJump configuration item

Use the traditional offset method to jump pages (suitable for small data volumes).

| Properties | Type | Default Value | Description |
|------|------|--------|------|
| `enable` | Boolean | `false` | Whether to enable offset page jump |
| `maxSkip` | Number | `50000` | Maximum skip value, beyond which the bookmark mechanism will be used. This value cannot exceed the runtime `findMaxSkip` cap. |

**Performance Suggestion**: Although offset page jumping is simple, its performance is poor on large data sets, and it is only suitable for scenarios where the amount of data is less than 100,000.

### totals configuration items

Used to obtain the total number and total page number information.

| Properties | Type | Default Value | Description |
|------|------|--------|------|
| `mode` | String | `'none'` | Statistics mode: `'none'`, `'sync'`, `'async'`, `'approx'` |
| `maxTimeMS` | Number | `2000` | Statistical query timeout |
| `ttlMs` | Number | `600000` | Cache validity period (10 minutes) |
| `hint` | Object/String | - | Index used for statistical query |
| `collation` | Object | - | Sorting rules for statistical queries |

#### totals mode description

- **none**: Do not count the total number (default), best performance
- **sync**: Synchronize statistics, return the total number immediately, which may affect response time (suitable for scenarios with small data volume or index optimization)
- **async**: Asynchronous statistics, returning token for the first time, caching the results after background calculation (suitable for large data volumes)
- **approx**: Fast approximate-style statistics. Empty queries use `estimatedDocumentCount`; filtered queries use `countDocuments` with the provided `hint` / `collation` so the query condition is respected.

**Note**:
- Statistical results are cached with the `findPageTotals:` key prefix and the `ttlMs` value.
- When statistics fails, `total: null` will be cached with the `error` field
- async mode uses inflight deduplication while the same totals calculation is still running.

## Return value

### Normal mode returns object

```javascript
{
  items: [
    { /* Document data 1 */ },
    { /* Document data 2 */ },
    // ...
  ],
  pageInfo: {
    hasNext: true,        // Is there a next page?
    hasPrev: false,       // Is there a previous page?
    startCursor: "...",   // Starting cursor (for before paging)
    endCursor: "...",     // end cursor (for after paging)
    currentPage: 1        // Current page number (only exists when using the page parameter)
  },
  totals: {  // Only present if totals is configured
    mode: "sync",         // Statistics mode
    total: 1000,          // Total number of records
    totalPages: 100,      // Total pages
    ts: 1234567890,       // Statistics timestamp
    token: "...",         // Query flag in async mode
    error: "..."          // Error message when statistics fails (optional)
  },
  meta: {  // Only exists when meta: true
    op: "findPage",
    durationMs: 123,
    cacheHit: false
  }
}
```

### Streaming mode return

When `stream: true` is used, a MongoDB Cursor Stream object is returned, and the streaming API can be used:

```javascript
const stream = await collection('users').findPage({
  query: { status: 'active' },
  sort: { createdAt: -1 },
  limit: 100,
  stream: true,
  batchSize: 100  // It is recommended to set the appropriate batch size
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

**Streaming Mode Limitations**:
- The page jump function is not supported (the page parameter can only be 1 or omitted)
- Does not support totals statistics
- Only supports cursor paging (after/before) or homepage query
- Returns the original stream object, excluding pageInfo

## Usage mode

### 1. Cursor paging (recommended)

Cursor paging is the most efficient paging method and is suitable for large data sets and real-time data.

```javascript
// Get the first page
const page1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log('data:', page1.items);
console.log('There is next page:', page1.pageInfo.hasNext);

// Get next page
const page2 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  after: page1.pageInfo.endCursor
});

// Get previous page
const page0 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  before: page2.pageInfo.startCursor
});
```

**Advantages**:
- O(1) performance, independent of data volume
- Support real-time data changes
- Small memory footprint

**Notice**:
- The cursor contains the value of the sorting field, and the sorting rules must be consistent
- When `cursorSecret` is not configured, the cursor is purely Base64url encoded, and the client can decode the content; after configuration, an HMAC-SHA256 signature is appended, and the tampered cursor will be rejected by the server.
- Cursor comparison restores JSON-round-tripped values before building the MongoDB filter: by default, 24-character hexadecimal strings are treated as ObjectId values, and ISO timestamp-like strings are treated as Date values. Use `cursorTypes` or `cursorValueNormalizer` when a string sort field intentionally contains ObjectId-like or ISO-like values.
- Cursor anchors read sort values by dot path, so nested sort fields such as `{ 'metrics.rank': 1 }` are supported.
- Do not splice or modify the cursor on the client side
- If you need long-term cross-session persistence of the cursor, please also cooperate with the server's own expiration control.

**Cursor signing (recommended in production)**:

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  cursorSecret: process.env.CURSOR_SECRET,  // 32+ bytes random string
  requireCursorSecret: true
});
```

After enabling, the format of `endCursor` / `startCursor` becomes `<payload>.<signature>`, and the server automatically verifies the signature every time `findPage` is called. Throws `INVALID_ARGUMENT` error when signatures do not match.

> **Upgrade Note**: If you generated cursor tokens during the running of v1 and persisted them (such as saving them to the database), after turning on `cursorSecret` in v2, these old tokens will become invalid due to the lack of signature fields. See the "Cursor Token Upgrade Strategy" section below for the migration plan.

If the sort field is a string that can look like a Date or ObjectId, pin its cursor type:

```ts
const page = await collection('events').findPage({
  sort: { token: 1 },
  cursorTypes: { token: 'string' }
});
```

### 2. Page jump mode

Suitable for scenarios where random access to any page number is required.

```javascript
// Use bookmark mechanism to jump pages
const page5 = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 5,
  jump: {
    step: 10,      // Save bookmarks every 10 pages
    maxHops: 20    // Jump up to 20 times in a row
  }
});

console.log(`No.${page5.pageInfo.currentPage} page data:`, page5.items);

// Use offset to jump pages (small data volume)
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

**Bookmark Jump Principle**:
1. Save a bookmark (cursor) every `step` page
2. When jumping, first locate the recent bookmark page
3. Jump from bookmark page to target page page by page
4. The number of jumps does not exceed the `maxHops` limit

Bookmarks created by `prewarmBookmarks()` are read by `findPage()` during page navigation. When a matching bookmark exists, `maxHops` is evaluated from that bookmark page to the requested page, not from page 1.

### Bookmark maintenance APIs

Bookmark maintenance belongs to the `findPage()` pagination workflow. Use these APIs when page jumps need predictable latency, or when operations staff need to inspect or reset stored page bookmarks.

| API | When to use |
|------|-------------|
| `prewarmBookmarks(keyDims, pages)` | Warm known hot pages before users jump to them. |
| `listBookmarks(keyDims?)` | Inspect the bookmark pages currently stored for a query or collection. |
| `clearBookmarks(keyDims?)` | Clear stale bookmark entries after large data changes or during manual cleanup. |

`keyDims` should describe the same `query`, `sort`, and `limit` shape used by `findPage()`. The runtime normalizes stable sort fields so the maintenance APIs address the same bookmark group as page navigation.

For full return shapes and operational examples, see the [bookmark maintenance API reference](./bookmarks.md).

**Applicable scenarios**:
- Need to display page number navigation
- Users may jump to any page
- Data is relatively stable

### 3. Streaming query

Suitable for processing large amounts of data and reducing memory usage.

```javascript
// Home page streaming query
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
  console.log(`Processed${count} logs`);
});

stream1.on('error', (err) => {
  console.error('Stream processing error:', err);
});

// Streaming queries using cursors
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

**Usage Suggestions**:
- Set a reasonable `batchSize` (recommended 100-1000)
- Use `limit` to limit the amount of returned data (to prevent infinite streaming)
- Handle error events properly
- Consider backpressure control

### 4. Get total statistics

```javascript
// Get the total number of synchronization
const pageWithTotal = await collection('users').findPage({
  query: { active: true },
  sort: { _id: 1 },
  limit: 20,
  totals: {
    mode: 'sync',
    maxTimeMS: 5000,
    hint: { active: 1 }  // Using index optimization statistics
  }
});

console.log(`total${pageWithTotal.totals.total} records`);
console.log(`common${pageWithTotal.totals.totalPages} Page`);

// Asynchronously obtain the total number (token returned for the first time)
const page1 = await collection('users').findPage({
  query: { active: true },
  sort: { _id: 1 },
  limit: 20,
  totals: { mode: 'async' }
});

if (page1.totals.total === null) {
  console.log('In total calculation, token:', page1.totals.token);

  // Query again later to get results
  setTimeout(async () => {
    const page1Again = await collection('users').findPage({
      query: { active: true },
      sort: { _id: 1 },
      limit: 20,
      totals: { mode: 'async' }
    });

    if (page1Again.totals.total !== null) {
      console.log(`total:${page1Again.totals.total}`);
    } else {
      console.log('Statistics are still in progress...');
    }
  }, 1000);
}
```

**Best Practice**:
- Small data size (< 100,000): use `sync` mode
- Large data volume: use `async` mode to avoid blocking
- Properly configured `maxTimeMS` to prevent slow queries
- Use `hint` to specify index optimization `countDocuments`

### 5. View execution plan (explain)

The `explain` parameter can help you analyze query performance and see how MongoDB performs paginated queries.

```javascript
// Basic execution plan (queryPlanner mode)
const explainResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  explain: true  // or 'queryPlanner'
});

console.log('query plan:', JSON.stringify(explainResult, null, 2));
console.log('index used:', explainResult.queryPlanner?.winningPlan);

// Get detailed execution statistics (executionStats mode)
const statsResult = await collection('orders').findPage({
  query: { status: 'paid', amount: { $gt: 1000 } },
  sort: { createdAt: -1 },
  limit: 50,
  hint: { status: 1, createdAt: -1 },
  explain: 'executionStats'
});

console.log('Execution statistics:');
console.log('  - Number of scanned documents:', statsResult.executionStats.totalDocsExamined);
console.log('  - Return the number of documents:', statsResult.executionStats.nReturned);
console.log('  - Execution time:', statsResult.executionStats.executionTimeMillis, 'ms');
console.log('  - Index usage:', statsResult.executionStats.executionStages);

// Analyze all alternative plans (allPlansExecution mode)
const allPlansResult = await collection('products').findPage({
  query: { category: 'electronics', price: { $lt: 500 } },
  sort: { price: 1 },
  limit: 30,
  explain: 'allPlansExecution'
});

console.log('All alternative query plans:', allPlansResult.executionStats.allPlansExecution);

// Explain combined with cursor paging
const cursorExplain = await collection('orders').findPage({
  query: { status: 'completed' },
  sort: { completedAt: -1 },
  limit: 20,
  after: 'eyJzIjp7ImNvbXBsZXRlZEF0IjotMSwiX2lkIjoxfSwiYSI6eyJjb21wbGV0ZWRBdCI6eyIkZGF0ZSI6IjIwMjUtMDEtMTVUMTA6MDA6MDAuMDAwWiJ9LCJfaWQiOiI2Nzg5YWJjZDEyMzQ1Njc4OTBhYmNkZWYifX0=',
  explain: 'executionStats'
});

console.log('Cursor paging execution plan:', cursorExplain.executionStats);
```

**explain mode description**:

| Mode | Description | Applicable Scenarios |
|------|------|----------|
| `true` or `'queryPlanner'` | Returns the execution plan selected by the query planner | View the indexes and query strategies used |
| `'executionStats'` | Return execution statistics (number of scanned/returned documents, time consumption, etc.) | Performance analysis and optimization |
| `'allPlansExecution'` | Return execution information of all alternative plans | In-depth optimization and comparison of different index strategies |

**Usage Tips**:
1. **Index verification**: Use `explain: true` to confirm whether the query uses the expected index
2. **Performance Analysis**: Use `explain: 'executionStats'` to view the actual number of scanned documents
3. **Optimization Index**: Pay attention to the ratio of `totalDocsExamined` to `nReturned`, which should ideally be close to 1
4. **Do not cache results**: Results will not be cached in `explain` mode and will not affect normal query caching.

**Note**:
- `explain` mode will directly return the execution plan object and will not return the paging results.
- Cannot be used with `stream` mode
- `explain` applies to all paging modes (cursor, page jump, offset)

## Error handling

### Common error codes

| Error code | Description | Solution |
|--------|------|----------|
| `VALIDATION_ERROR` | Parameter validation failed | Check whether the parameters meet the requirements, such as page and after/before are mutually exclusive |
| `JUMP_TOO_FAR` | The page jump span is too large | Increase the maxHops value or use offsetJump |
| `STREAM_NO_JUMP` | Streaming mode does not support page jumps | Streaming mode can only be used for home page or cursor paging |
| `STREAM_NO_TOTALS` | Streaming mode does not support statistics | Streaming mode cannot use the totals function |
| `CURSOR_INVALID` | Invalid cursor | Use a valid cursor string |
| `SORT_MISMATCH` | The collation does not match | Make sure the collation corresponding to the cursor is consistent |

### Error handling example

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
    console.error('Page jump distance is too far:', error.details);
    // Solution: Increase maxHops or use offsetJump
    const result = await collection('orders').findPage({
      query: { status: 'paid' },
      sort: { createdAt: -1 },
      limit: 50,
      page: 1000,
      jump: { maxHops: 50 }  // increase limit
    });
  } else if (error.code === 'VALIDATION_ERROR') {
    console.error('Parameter error:', error.details);
  } else {
    console.error('Other errors:', error);
  }
}
```

## Performance optimization suggestions

### 1. Index optimization

Make sure you have appropriate indexes on the query and sort fields:

```javascript
// Create composite indexes for common queries
await collection('orders').createIndex({ status: 1, createdAt: -1 });

// Use hint in findPage to specify the index
const result = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  hint: { status: 1, createdAt: -1 }
});
```

**Index design principles**:
- The query field comes first and the sorting field comes last
- Including `_id` as the last field ensures uniqueness
- Use `explain()` to verify index usage

### 2. Choose the paging mode reasonably

- **Cursor paging**: suitable for sequential browsing, real-time data, and large data sets
- **Jump Page Mode**: Suitable for scenarios where random access to page numbers is required
- **offset page jump**: only suitable for small data volume (< 10000 items)
- **Streaming query**: suitable for batch processing, ETL, export and other scenarios

### 3. Caching strategy

```javascript
// Instance-level configuration bookmarks and caching
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  bookmarks: {
    step: 10,           // Save bookmarks every 10 pages
    maxHops: 20,        // Jump up to 20 times in a row
    ttlMs: 6 * 3600000, // Bookmark cache 6 hours
    maxPages: 10000     // Cache up to 10,000 pages of bookmarks
  },
  cache: {
    maxEntries: 100000, // Maximum number of cache entries
    enableStats: true   // Enable statistics
  }
});

// Enable caching at query level
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 20,
  cache: 60000  // Cache for 1 minute
});
```

**Caching Best Practices**:
- Enable caching for popular queries
- Set a reasonable TTL based on the data update frequency
- Writes do not invalidate `findPage` read caches by default; use `cache.invalidate`, `autoInvalidate: true`, or call `collection.invalidate('findPage')` manually when needed.

### 4. Correctly handle total statistics

**❌ Wrong practice**: Using synchronized statistics for large amounts of data
```javascript
// Bad: tens of millions of data use sync mode
const result = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 50,
  totals: { mode: 'sync' }  // It may take several seconds or even time out
});
```

**✅ Correct approach**: Choose the appropriate statistical mode based on the amount of data
```javascript
// Small data size (< 100,000) - use sync mode
const smallResult = await collection('categories').findPage({
  query: { active: true },
  sort: { name: 1 },
  limit: 30,
  totals: {
    mode: 'sync',
    maxTimeMS: 2000,
    hint: { active: 1 }  // Using indexes to speed up statistics
  }
});

// Large data volumes - using async mode
async function getPaginatedDataWithTotal(query, page) {
  const result = await collection('orders').findPage({
    query,
    sort: { createdAt: -1 },
    limit: 50,
    page,
    totals: {
      mode: 'async',
      maxTimeMS: 5000,
      ttlMs: 600000  // Caching for 10 minutes
    }
  });

  // First request: total is null, return token
  if (result.totals && result.totals.total === null) {
    console.log('The total is being calculated...', result.totals.token);
  } else if (result.totals && result.totals.total !== null) {
    console.log(`common${result.totals.total} strip,${result.totals.totalPages} Page`);
  }

  return result;
}

// Scenarios where totals are not required - no statistics (best performance)
const noTotalResult = await collection('feeds').findPage({
  query: { userId: currentUserId },
  sort: { createdAt: -1 },
  limit: 20,
  after: lastCursor
  // Without setting totals, use hasNext to determine whether there is more data.
});

console.log('and more:', noTotalResult.pageInfo.hasNext);
```

### 5. Correct use of streaming queries

```javascript
// 1. Set appropriate batchSize
const stream1 = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: 1 },
  limit: 1000000,
  stream: true,
  batchSize: 1000,  // 1000 items per batch
  allowDiskUse: true  // Large data volumes allow disk usage
});

let processedCount = 0;
stream1.on('data', (doc) => {
  // Only process the current document, no accumulation
  processOrder(doc);
  processedCount++;

  if (processedCount % 10000 === 0) {
    console.log(`Processed${processedCount} orders`);
  }
});

stream1.on('end', () => {
  console.log(`Processing completed! total: ${processedCount}`);
});

// 2. Export large amounts of data to files
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

  console.log('Export completed');
}
```

### 6. Page jump performance optimization

**❌ Wrong practice**: Improper configuration when jumping to a remote page
```javascript
// Bad: Jump to page 500 but the step size is too big
const result = await collection('products').findPage({
  query: { category: 'books' },
  sort: { publishDate: -1 },
  limit: 50,
  page: 500,
  jump: {
    step: 100,  // Step size too large, page 500 has no bookmarks
    maxHops: 10  // The limit is too small to reach
  }
});
// May throw JUMP_TOO_FAR error
```

**✅ Correct approach**: Optimize jump page configuration based on usage patterns
```javascript
// 1. Frequent page jump scenarios - dense bookmarks
const result1 = await collection('products').findPage({
  query: { category: 'books' },
  sort: { publishDate: -1 },
  limit: 50,
  page: 500,
  jump: {
    step: 5,       // Save bookmarks every 5 pages
    maxHops: 50,   // 50 jumps allowed
    ttlMs: 12 * 3600000  // Cached for 12 hours
  }
});

// 2. Small amount of data - use offset to jump pages
const result2 = await collection('categories').findPage({
  query: { active: true },
  sort: { name: 1 },
  limit: 20,
  page: 15,
  offsetJump: {
    enable: true,
    maxSkip: 10000  // The amount of data is less than 10,000
  }
});

// 3. Detect page jump errors and degrade them
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
      console.log('The page jump distance is too far, try using offset mode');
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

**Jump page configuration suggestions**:
- **< 100 pages**: step = 5-10, maxHops = 20
- **100-1000 pages**: step = 10-20, maxHops = 30-50
- **>1000 pages**: Consider using cursor paging or limiting the jumpable range
- **Small data size**: Use offsetJump first

## Frequently Asked Questions (FAQ)

### Q: What is the difference between cursor paging and traditional paging?

**A**: Cursor paging uses the sort value as the anchor point, and the performance is O(1); traditional paging uses skip/offset, and the performance decreases as the page number increases. Cursor paging is more suitable for large data sets and real-time data.

### Q: Why do I need to set maxHops for page jumps?

**A**: Prevent malicious or incorrect requests from causing excessive jumps. Each jump is a database query, and the maxHops limit protects system performance.

### Q: When should streaming mode be used?

**A**: Used when processing a large amount of data that does not need to be loaded into memory at once, such as data export, batch processing, ETL and other scenarios.

### Q: Will the totals statistic affect performance?

**A**: sync mode will affect response time, it is recommended to use async mode. The first query triggers background statistics, and subsequent queries return cached results.

### Q: How much memory will bookmarks take up?

**A**: Approximately 200-500 bytes per bookmark. The default cache is up to 10,000 pages, and the total memory usage is about 2-5 MB, which can be adjusted through configuration.

### Q: How to deal with cursor failure caused by data changes?

**A**: Capture `CURSOR_INVALID` error and restart the query from the home page. For data that changes frequently, it is recommended to use stable fields such as timestamp to sort.

### Q: Can the page, after, and before parameters be used at the same time?

**A**: No. These three parameters are mutually exclusive:
- `page` is used for page skip mode and cannot be used simultaneously with `after` or `before`
- `after` and `before` are used for cursor paging, and they cannot be used at the same time.
- Using both will throw `VALIDATION_ERROR` error

```javascript
// ❌ Error: cannot be used simultaneously
await collection('orders').findPage({
  page: 5,
  after: 'cursor123'  // mistake!
});

// ✅ Correct: Select a mode
await collection('orders').findPage({
  page: 5  // Page jump mode
});
// or
await collection('orders').findPage({
  after: 'cursor123'  // Cursor paging
});
```

### Q: How to implement the "previous page" function when the cursor is paging?

**A**: Use the `before` parameter in combination with `startCursor`:

```javascript
// First page
const page1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

// Next page
const page2 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  after: page1.pageInfo.endCursor
});

// Return to previous page
const backToPage1 = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  before: page2.pageInfo.startCursor  // Use before + startCursor
});
```

### Q: Why does streaming mode not support totals statistics?

**A**: The design goal of streaming mode is to efficiently process large amounts of data. What is returned is the original MongoDB Cursor Stream, which does not contain paging meta information. If total statistics are required, you should:

1. First use normal mode to get the homepage and total number
2. Then use streaming mode to process subsequent data

```javascript
// Solution: Get the total number first, then stream it
const firstPage = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: 100,
  totals: { mode: 'sync' }
});

console.log(`common${firstPage.totals.total} records`);

// Then use streaming to process all the data
const stream = await collection('logs').findPage({
  query: { level: 'error' },
  sort: { timestamp: -1 },
  limit: firstPage.totals.total,
  stream: true,
  batchSize: 1000
});
```

### Q: How to determine whether the last page has been reached?

**A**: Use `pageInfo.hasNext` field:

```javascript
const result = await collection('products').findPage({
  query: { category: 'books' },
  sort: { price: 1 },
  limit: 50,
  page: 10
});

if (!result.pageInfo.hasNext) {
  console.log('Already the last page');
} else {
  console.log('There is more data');
}
```

For cursor paging, it can also be judged by `hasNext`:

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

  console.log(`No.${pageNum} Page: ${result.items.length} strip`);

  if (!result.pageInfo.hasNext) {
    console.log('All data processed');
    break;
  }

  cursor = result.pageInfo.endCursor;
  pageNum++;
}
```

### Q: What should I do if the JUMP_TOO_FAR error occurs when jumping to a page?

**A**: This error indicates that the jump distance exceeds the `maxHops` limit. There are several solutions:

**Option 1: Increase maxHops value**
```javascript
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 200,
  jump: {
    step: 10,
    maxHops: 50  // increase to 50
  }
});
```

**Option 2: Reduce the step value (dense bookmarks)**
```javascript
const result = await collection('products').findPage({
  query: { category: 'electronics' },
  sort: { price: 1 },
  limit: 50,
  page: 200,
  jump: {
    step: 5,  // Save bookmarks every 5 pages
    maxHops: 20
  }
});
```

**Option 3: Downgrade to offset page jump**
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
    // Downgrade to offset mode
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

### Q: How to optimize the total statistics performance of large amounts of data?

**A**: The following strategies are recommended:

**1. Use async mode + long cache**
```javascript
const result = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: -1 },
  limit: 50,
  totals: {
    mode: 'async',
    ttlMs: 1800000,  // Caching for 30 minutes
    maxTimeMS: 10000
  }
});
```

**2. Specify index for statistical query**
```javascript
// Create index
await collection('orders').createIndex({ year: 1 });

// Use hint to specify index
const result = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: -1 },
  limit: 50,
  totals: {
    mode: 'sync',
    hint: { year: 1 },  // Speed ​​up using indexes
    maxTimeMS: 3000
  }
});
```

**3. Only count when needed, and judge by hasNext at other times**
```javascript
// Home page query: get total number
const firstPageResult = await collection('products').findPage({
  query: { inStock: true },
  sort: { updatedAt: -1 },
  limit: 50,
  page: 1,
  totals: { mode: 'async' }
});

// Subsequent pages: No total count
const otherPageResult = await collection('products').findPage({
  query: { inStock: true },
  sort: { updatedAt: -1 },
  limit: 50,
  page: 5
  // Do not set totals to save performance
});
```

### Q: Does explain mode return actual data?

**A**: No. When using the `explain` parameter, findPage will directly return the MongoDB execution plan object without returning the actual paging data and pageInfo.

```javascript
// explain mode: only returns the execution plan
const explainResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20,
  explain: 'executionStats'
});

console.log(explainResult);
// Output: { queryPlanner: {...}, executionStats: {...} }
// There are no items, pageInfo and other fields

// Normal query mode: return data
const dataResult = await collection('orders').findPage({
  query: { status: 'paid' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log(dataResult);
// Output: { items: [...], pageInfo: {...} }
```

**Usage Suggestions**: explain is mainly used to analyze query performance during the development and debugging stages and should not be used in normal requests in the production environment.

### Q: How does caching work? Will the data automatically become invalid after being updated?

**A**: Caching mechanism description:

**Cached content**:
- **Query result cache**: the key prefix is `findPage:`, and it stores non-stream/non-explain page results when `cache` is greater than `0`
- **Bookmark cache**: the key prefix is `<cache-namespace>:bm:`, and it stores jump bookmarks
- **Totals cache**: the key prefix is `findPageTotals:`, and it stores totals results controlled by `totals.ttlMs`

**Cache Invalidation**:
- TTL controls automatic expiration.
- Writes through the monSQLize collection accessor clear read caches only when `cache.invalidate`, `autoInvalidate: true`, or global `cache.autoInvalidate` is configured.
- If data is changed through the native MongoDB driver, another process, or an external job, manually invalidate the related cache.

```javascript
// Update data
await collection('products').updateOne(
  { _id: productId },
  { $set: { price: 99 } }
);

// Manual invalidation of cache
await collection('products').invalidate('findPage');

// or invalidate all read caches for this collection
await collection('products').invalidate();
```

**Cache key distinction**:
- Matching query, normalized sort, limit, projection, pipeline, cursor and cursor strategy can reuse results within the same cache scope.
- Different query conditions will generate different cache keys
- Custom normalizers need a stable version for page-result caching and automatic bookmark reuse; raw key formats are internal. See [Cache Invalidation](./cache-invalidation.md).

```javascript
// Both queries use the same cache
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
// r2 will hit r1's cache

// This query will use a different cache (different query)
const r3 = await collection('products').findPage({
  query: { category: 'electronics' },  // different
  sort: { price: 1 },
  limit: 20,
  cache: 60000
});
```

### Q: What is the scope of pipeline parameters?

**A**: `pipeline` only takes effect on the limit data** returned on the current page and does not affect the paging logic and query conditions.

```javascript
// The pipeline only processes the 20 returned documents
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

// result.items contains 20 pieces of order data processed by the pipeline
// Contains associated user information
```

**Note**:
1. The pipeline is executed after the paging logic**
2. It will not affect the totals statistics (the statistics are raw data)
3. Will not affect cursor calculation (cursor is based on original sorting field)
4. Suitable for post-processing such as data association and field conversion

### Q: How to achieve infinite scroll loading?

**A**: Use cursor paging with front-end status management:

**Front-end example (React)**:
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
      console.error('Loading failed:', error);
    } finally {
      setLoading(false);
    }
  };

  // initial load
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
          {loading ? 'loading...' : 'load more'}
        </button>
      )}

      {!hasMore && <div>No more data</div>}
    </div>
  );
}
```

**Backend Example (Node.js)**:
```javascript
app.post('/api/orders', async (req, res) => {
  try {
    const { query, sort, limit, after } = req.body;

    const result = await collection('orders').findPage({
      query,
      sort,
      limit: Math.min(limit, 100),  // Limit maximum
      after
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Q: What is the difference between findPage and the ordinary find method? How to choose?

**A**: The two applicable scenarios are different:

**Scenarios for using find**:
- Simple query, no paging required
- The amount of data is certain and small (< 1000 items)
- All data needs to be returned at once
- No need for advanced features such as cursors and bookmarks

**Scenarios for using findPage**:
- Need to be displayed in pages
- The amount of data is large or uncertain
- Need to support "next page", "previous page", page jump and other functions
- Need total statistics
- Requires streaming of big data
- Need to cache paginated results

**Example comparison**:
```javascript
// Scenario 1: Get the user’s first 10 orders -> use find
const recentOrders = await collection('orders').find(
  { userId: '123' },
  {
    sort: { createdAt: -1 },
    limit: 10
  }
);

// Scenario 2: Browse all orders by page -> use findPage
const ordersPage = await collection('orders').findPage({
  query: { userId: '123' },
  sort: { createdAt: -1 },
  limit: 20,
  after: cursor
});

// Scenario 3: Export large amounts of data -> use findPage streaming mode
const exportStream = await collection('orders').findPage({
  query: { year: 2024 },
  sort: { createdAt: 1 },
  limit: 1000000,
  stream: true,
  batchSize: 1000
});
```

**Performance comparison**:

| Operations | find | findPage |
|------|------|----------|
| Simple query | ⚡ Faster | Slightly slower (with paging logic overhead) |
| Big data paging | ❌ Not applicable | ✅ Efficient |
| Jump page | ❌ Poor performance | ✅ Optimization support |
| Streaming | ✅ Support | ✅ Support |
| Total statistics | ❌ Additional query required | ✅ Built-in support |

---

## Cursor token security and upgrade strategy

### The role of cursorSecret

`cursorSecret` is an optional instance-level configuration item. When not set, the cursor token is pure Base64url encoded and anyone can decode or construct its contents (including the sort field value). Once set, each token will have an HMAC-SHA256 signature attached:

```text
token Format (no signature):  <base64url-payload>
token Format (with signature):  <base64url-payload>.<base64url-signature>
```

The server automatically verifies the signature every time `findPage` is called. If the token has been tampered with (for example, the client manually modified the sorting field value to skip data), the signature does not match and the server throws an `INVALID_ARGUMENT` error. The signature comparison is performed with a timing-safe comparison in the current runtime.

**It is recommended to always configure cursorSecret in production environment**:

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  cursorSecret: process.env.CURSOR_SECRET,  // Random string, 32+ bytes recommended
  requireCursorSecret: true
});
```

`requireCursorSecret` is optional and defaults to `false` for compatibility. When set to `true`, `findPage()` throws `INVALID_CONFIG` until `cursorSecret` is configured, preventing unsigned cursor tokens from being emitted or accepted.

### Cursor value type hints

Cursor payloads are JSON encoded, so Date and ObjectId values are restored before MongoDB comparison filters are built. The default restoration preserves existing behavior: ISO timestamp-like strings become `Date` values and 24-character hex strings become `ObjectId` values.

Use `cursorTypes` when a sort field should be restored differently:

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

For custom conversion logic, pass `cursorValueNormalizer(field, value)` at the instance level or on a single `findPage()` call.

When using result caches or prewarmed bookmarks, also provide `cursorValueNormalizerVersion`, a stable strategy identity and version such as `token-string:v1`. Change it whenever conversion logic, captured configuration or restored types change. A given identifier must always describe the same conversion behavior.

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

The instance configuration accepts the same field. A per-query function override needs an explicit per-query version; it does not inherit the instance function's version. An unversioned custom function can still query, but bypasses page-result caching and automatic bookmark reads; bookmark prewarming rejects it. Deep jumps may therefore need more database queries and reach `jump.maxHops`. Both `cursorTypes` and the strategy version participate in page and bookmark keys.

A custom normalizer replaces default restoration and `cursorTypes` for every sort field, including the `_id` tie-breaker. Handle Date/ObjectId fields explicitly; returning an unchanged ObjectId string can produce incorrect cursor comparisons. An exclusion projection such as `{ _id: 0 }` retains business fields, and all cursor sort fields (including `_id`) remain in the returned items.

Cursor comparisons support null/missing boundaries and common scalar BSON sort types. Pagination uses `$expr` comparisons; verify index efficiency with `explain` for your query, sort and data distribution. Array sorting by minimum/maximum elements is outside this guarantee.

### Cursor token compatibility issues when upgrading from v1

**Source of the problem**: If you persistently store `endCursor` / `startCursor` (write to database, put into Redis, encode in URL) during v1 running, after v2 turns on `cursorSecret`, these old token formats will be `<payload>` (no signature), and v2 will fail to parse because the signature separator cannot be found during v2 verification.

**Will it affect you**:

| Scenario | Is it affected |
|------|-----------|
| The cursor is only used within a single HTTP request/response cycle (the front end turns the page immediately after getting it) | ❌ Not affected (the old token has expired before the upgrade) |
| The cursor is persisted to the database for "continue last browsed position" functions | ✅ Affected |
| Cursor encoding in shared link/bookmark URL | ✅ Affected |
| The cursor is stored in Redis for paging caching | ✅ Affected |

**Migration plan**

**Option A (recommended): Two-stage deployment**

1. **Do not set** `cursorSecret` when v2 goes online, maintaining the same unsigned format as v1
2. Wait for the TTL of the persistent cursor to expire naturally (usually hours to days)
3. After expiration, release the second deployment and add `cursorSecret`
4. At this time, all cursors in transit have expired, and no old format tokens will flow in.

```ts
// Phase 1: Not enabling signing yet
const msq = new MonSQLize({ type: 'mongodb', /* cursorSecret is not set yet */ });

// Phase 2: Enable after TTL expires
const msq = new MonSQLize({ type: 'mongodb', cursorSecret: process.env.CURSOR_SECRET });
```

**Option B: Actively clear persistent cursors**

Before v2 deployment, clear all persisted cursor data (set database fields to null, delete Redis key, etc.), and then directly bring `cursorSecret` online. The user's pagination status is reset to the first page.

```ts
// Cleanup before deployment (pseudocode)
await nativeDb.collection('user_states').updateMany({}, { $unset: { lastCursor: '' } });
await redis.del('session:cursor:*');

// Then enable signing directly
const msq = new MonSQLize({ type: 'mongodb', cursorSecret: process.env.CURSOR_SECRET });
```

**Scenario C: Custom error downgrade**

Catch the `INVALID_ARGUMENT` error at the API layer and reset the cursor to null (i.e. back to the first page):

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
      // Old format cursor, reset to homepage
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

## Related documents

- [find method document](./find.md)
- [Caching Policy](./cache.md)
- [Performance Optimization Guide](./count-queue.md)
- [API Reference](./api-index.md)
- [monSQLize README](../../README.md)
