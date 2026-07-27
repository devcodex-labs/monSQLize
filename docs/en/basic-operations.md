# Basic Usage

## What This Page Covers

After installation and the first connection, use this page to run the common data flow most applications need. The examples follow the usual development order: write and query data first, then paginate, update, cache reads, and decide when to switch to `model()`:

- Insert one or many documents
- Query one document or a list
- Paginate results
- Update, upsert, and delete
- Add a short read cache
- Decide when to switch from `collection()` to `model()`

For a runnable version of this flow, open [`examples/quick-start/basic-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts).

## Setup

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

## Insert Data

Use `insertOne()` for interactive writes and `insertMany()` when you already have a small batch.

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

For larger imports, use [`insertBatch()`](./insertBatch.md).

## Query Data

Use `findOne()` for one document and `find()` for lists. `find()` supports chain helpers such as `sort()`, `limit()`, and `project()`.

```typescript
const ada = await users.findOne({ email: 'ada@example.com' });

const activeUsers = await users
  .find({ status: 'active' })
  .sort({ createdAt: -1 })
  .limit(10)
  .project({ email: 1, name: 1, status: 1, _id: 0 });
```

See [`findOne()`](./findOne.md), [`find()`](./find.md), and [chain queries](./chaining-api.md) for the full query surface.

## Paginate Lists

Use `findPage()` when a list needs cursor pagination.

```typescript
const page = await users.findPage({
  query: { status: 'active' },
  sort: { createdAt: -1 },
  limit: 20
});

console.log(page.items);
console.log(page.pageInfo.endCursor);
```

Pass `after: page.pageInfo.endCursor` to load the next page. See [`findPage()`](./findPage.md) for totals, cursor type hints, and bookmark options.

## Update and Upsert

Use `updateOne()` for a known document and `upsertOne()` when the document should be created if it does not exist.

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

See [`updateOne()`](./update-one.md), [`updateMany()`](./update-many.md), [`upsertOne()`](./upsert-one.md), and the [upsert guide](./upsert-guide.md).

## Count and Delete

Use `count()` for counters and `deleteMany()` for cleanup jobs with an explicit filter.

```typescript
const totalActive = await users.count({ status: 'active' });

const deleted = await users.deleteMany({ status: 'disabled' });
console.log(deleted.deletedCount);
```

See [`count()`](./count.md), [`deleteOne()`](./delete-one.md), and [`deleteMany()`](./delete-many.md).

## Cache a Hot Read

Pass `cache` as a TTL in milliseconds on read operations that can tolerate short-lived cached data.

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

Writes do not invalidate query caches by default. Use per-write `cache.invalidate` for precise cache entries, or `autoInvalidate: true` for collection-wide broad invalidation. See [Cache Invalidation](./cache-invalidation.md) and [Runtime consistency and boundaries](./runtime-architecture.md).

## Collection or Model

Start with `collection()` when you want MongoDB-native behavior with monSQLize conveniences such as ObjectId conversion, query cache, pagination, transactions, and unified errors.

Switch to `model()` when writes must pass through schema validation, defaults, hooks, timestamps, soft delete, relations, or optimistic locking.

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

See [Model overview](./model.md) and [Write path policy](./write-path-policy.md) when a service needs to enforce Model-only writes for selected namespaces.

## Close the Runtime

```typescript
await msq.close();
```

## Next Steps

- Review constructor options in [`configuration.md`](./configuration.md).
- Read the collection API details in [`api-index.md`](./api-index.md).
- Compare runnable source files in [`examples.md`](./examples.md).
