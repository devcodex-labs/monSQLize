# findByIds Reference

Model `findByIds` applies soft-delete visibility in the same database query, using the final `before` hook options. Supported inclusion, exclusion, computed projections and the `project` alias keep their native meaning, including explicitly projected deletion markers; the `preserveOrder` boundary below applies. `onlyDeleted` and `withDeleted` keep their existing precedence and validation. Raw Collection queries remain unfiltered. An `after` hook may replace the result without a second visibility filter.

Filtered Model cache entries are isolated by visibility condition and included in exact `findByIds` write-invalidation descriptors. Caches without pattern deletion bypass these filtered entries; session reads also bypass the cache. ID validation and deduplication are unchanged.

## Projection with input order

With `preserveOrder: true`, ordinary `_id: 0`/`false` exclusions and supported computed `_id` expressions, including `$$REMOVE`, retain input ID order. Internal identities are removed or restored before returning results; these paths bypass result caching. MongoDB still applies `sort`, `skip` and `limit` first to select the subset, and one native query is used.

Find-only `_id` projections (`$slice`, `$elemMatch`, `$meta`), nested or dotted rewrites of `_id`, and an explicit `_id: undefined` cannot reliably retain that identity and throw `INVALID_OPERATION`. Combining `returnKey: true` with input-order preservation also throws, including with an `_id_` hint, because projection metadata can still replace the returned identity. Special projections on other fields remain native where they preserve the identity. Use `preserveOrder: false` for the original native projection path.

Native raw BSON result mode (`raw: true`) is also incompatible with input-order preservation. A computed `_id` cannot be combined with truthy `fieldsAsRaw._id` or `fieldsAsRaw.value`: BSON applies these field names at every nesting depth and can decode the internal identity wrapper as raw bytes. Computed identities require a data-only `fieldsAsRaw` map; dynamic Proxy/accessor maps throw `INVALID_OPERATION` before lookup. Use `preserveOrder: false` for native lazy decoding with these maps. These checks use the effective Collection configuration; per-call `raw: false` and `fieldsAsRaw: {}` override inherited settings using native driver precedence.

Native result-cache entries distinguish effective BSON serialization and decoding options, including inherited settings and non-enumerable `fieldsAsRaw` flags. Raw results cannot warm the same entry as ordinary decoded documents. Exact `findByIds` invalidation uses the same key calculation.

## Method overview

`findByIds(ids, options)` is an optional helper for looking up multiple documents by `_id`. It normalizes ObjectId-like values, removes duplicate ids, and runs an `_id: { $in: ... }` query.

You can also use the standard `find()` API directly. The normal query path supports ObjectId auto conversion as well:

```javascript
const users = await collection('users').find({
  _id: { $in: userIds }
});
```

Use `findByIds()` when your codebase prefers a dedicated id-list helper or when you need its `preserveOrder` option:

```javascript
const users = await collection('users').findByIds(userIds, {
  preserveOrder: true
});
```

### Behavior summary

| Behavior | Description |
|------|------|
| ObjectId normalization | ObjectId-shaped strings and ObjectId values are accepted |
| Deduplication | Duplicate ids are queried once |
| Order | Results follow MongoDB result order unless `preserveOrder: true` is set |
| Missing ids | Missing documents are omitted from the result array |

---

## Method signature
```typescript
async findByIds(
  ids: Array<string | ObjectId>,
  options?: {
    projection?: Object,
    sort?: Object,
    cache?: number,
    maxTimeMS?: number,
    comment?: string,
    preserveOrder?: boolean
  }
): Promise<Array<Document>>
```

### Parameter description

| Parameters | Type | Required | Description |
|------|------|------|------|
| `ids` | Array<string \| ObjectId> | Yes | _id array; string and ObjectId values may be mixed |
| `options` | Object | No | Query options |
| `options.projection` / `options.project` | Object | No | Field projection. `project` is an alias for `projection`; `projection` wins when both are provided. |
| `options.sort` | Object | No | Sort option |
| `options.cache` | number | No | Cache TTL in milliseconds |
| `options.maxTimeMS` | number | No | Query timeout in milliseconds |
| `options.comment` | string | No | Query comment |
| `options.preserveOrder` | boolean | No | Preserve input id order in the returned array; default is `false` |

### Return value description

Returns an array of documents. No results will be returned for non-existent IDs.

---

## Basic example

### Example 1: Batch query documents (string ID)

```javascript
const userIds = [
  '507f1f77bcf86cd799439011',
  '507f1f77bcf86cd799439012',
  '507f1f77bcf86cd799439013'
];

const users = await collection('users').findByIds(userIds);
console.log(`Found ${users.length} users`);
```

### Example 2: Batch query documents (ObjectId)

```javascript
const { ObjectId } = require('mongodb');
const userIds = [
  new ObjectId('507f1f77bcf86cd799439011'),
  new ObjectId('507f1f77bcf86cd799439012')
];

const users = await collection('users').findByIds(userIds);
```

### Example 3: Mixed types (String + ObjectId)

```javascript
const userIds = [
  '507f1f77bcf86cd799439011',  // string
  new ObjectId('507f1f77bcf86cd799439012'),  // ObjectId
  '507f1f77bcf86cd799439013'   // string
];

const users = await collection('users').findByIds(userIds);
```

### Example 4: Using projection (return only specific fields)

```javascript
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, email: 1, role: 1 }
});

// The result only contains _id, name, email, role
```

### Example 5: Using sort (sorting results)

```javascript
const users = await collection('users').findByIds(userIds, {
  sort: { name: 1 }  // Sort by name ascending
});
```

### Example 6: Keep original order

```javascript
const orderedIds = ['id3', 'id1', 'id2'];
const users = await collection('users').findByIds(orderedIds, {
  preserveOrder: true  // The result order is consistent with orderedIds
});
```

---

## Real scene example

### Scenario 1: Batch query of user information (associated query)

Extract user IDs from the comment list and query user information in batches.

```javascript
// Comment list
const comments = [
  { _id: 1, userId: '507f...011', content: 'Great!' },
  { _id: 2, userId: '507f...012', content: 'Nice!' },
  { _id: 3, userId: '507f...011', content: 'Thanks!' }  // repeat
];

// Extract unique user ID
const userIds = [...new Set(comments.map(c => c.userId))];

// Query users in batches
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, avatar: 1 }
});

// Build user mapping
const userMap = new Map(users.map(u => [u._id.toString(), u]));

// Populate user information for comments
const commentsWithUser = comments.map(comment => ({
  ...comment,
  user: userMap.get(comment.userId)
}));

console.log(commentsWithUser);
```

### Scenario 2: Batch permission verification

Check if multiple users have specific permissions.

```javascript
async function checkUsersPermission(userIds, requiredPermission) {
  const users = await collection('users').findByIds(userIds, {
    projection: { permissions: 1, role: 1 }
  });

  const authorized = users.filter(user => 
    user.role === 'admin' || 
    user.permissions?.includes(requiredPermission)
  );

  return {
    total: userIds.length,
    authorized: authorized.length,
    authorizedIds: authorized.map(u => u._id.toString())
  };
}

// use
const result = await checkUsersPermission(
  ['user1', 'user2', 'user3'],
  'edit_content'
);
console.log(`${result.authorized}/${result.total} User has permission`);
```

### Scenario 3: Batch data export (maintain order)

Export user data in the specified order.

```javascript
async function exportUsers(orderedUserIds) {
  const users = await collection('users').findByIds(orderedUserIds, {
    projection: { password: 0, internalNotes: 0 },  // Exclude sensitive fields
    preserveOrder: true  // Keep export order
  });

  // Convert to CSV format
  const csv = users.map(user => 
    `${user._id},${user.name},${user.email},${user.role}`
  ).join('\n');

  return csv;
}

// use
const csvData = await exportUsers(['id1', 'id2', 'id3']);
```

### Scenario 4: Batch data preloading (caching)

Preload popular user data into cache.

```javascript
async function preloadPopularUsers() {
  // Get popular user IDs
  const popularUserIds = await collection('stats')
    .aggregate([
      { $sort: { views: -1 } },
      { $limit: 100 },
      { $project: { userId: 1 } }
    ]);

  const ids = popularUserIds.map(s => s.userId);

  // Batch query and cache (1 hour)
  const users = await collection('users').findByIds(ids, {
    cache: 60 * 60 * 1000  // 1 hour
  });

  console.log(`Preloaded${users.length} popular users`);
  return users;
}
```

### Scenario 5: Batch friend information query

Query all the user's friend information.

```javascript
async function getUserFriends(userId) {
  // Get the user's friends list
  const user = await collection('users').findOne(
    { _id: new ObjectId(userId) },
    { projection: { friends: 1 } }
  );

  if (!user || !user.friends || user.friends.length === 0) {
    return [];
  }

  // Query friend information in batches
  const friends = await collection('users').findByIds(user.friends, {
    projection: { name: 1, avatar: 1, status: 1 }
  });

  return friends;
}

// use
const friends = await getUserFriends('507f1f77bcf86cd799439011');
console.log(`This user has${friends.length} friends`);
```

### Scenario 6: Batch notification sending

Send notifications in batches based on a list of user IDs.

```javascript
async function sendBatchNotifications(userIds, notification) {
  // Query users in batches (only notification settings and contact information required)
  const users = await collection('users').findByIds(userIds, {
    projection: { 
      email: 1, 
      phone: 1, 
      notificationSettings: 1 
    }
  });

  const results = {
    email: 0,
    sms: 0,
    skipped: 0
  };

  for (const user of users) {
    // Send notifications based on user preferences
    if (user.notificationSettings?.email) {
      await sendEmail(user.email, notification);
      results.email++;
    }
    
    if (user.notificationSettings?.sms) {
      await sendSMS(user.phone, notification);
      results.sms++;
    }
    
    if (!user.notificationSettings?.email && !user.notificationSettings?.sms) {
      results.skipped++;
    }
  }

  return results;
}
```

---

## Detailed explanation of option parameters

### projection - field projection

Only the required fields are returned to reduce the amount of data transmission.

```javascript
// Only return name and email
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, email: 1 }
});

// Exclude sensitive fields
const users = await collection('users').findByIds(userIds, {
  projection: { password: 0, secretKey: 0 }
});
```

### sort - Sort

Sort the results.

```javascript
// Sort by name ascending
const users = await collection('users').findByIds(userIds, {
  sort: { name: 1 }
});

// Descending order by creation time
const users = await collection('users').findByIds(userIds, {
  sort: { createdAt: -1 }
});
```

### cache - cache

Cache query results to speed up repeated queries.

```javascript
// Cache for 5 minutes
const users = await collection('users').findByIds(userIds, {
  cache: 5 * 60 * 1000
});
```

### maxTimeMS - query timeout

Limit the maximum query execution time.

```javascript
const users = await collection('users').findByIds(userIds, {
  maxTimeMS: 5000  // up to 5 seconds
});
```

### comment - Query comments

Used for log tracing and performance analysis.

```javascript
const users = await collection('users').findByIds(userIds, {
  comment: 'CommentAPI:loadUsers:v1.2'
});
```

### preserveOrder - preserve order

The result order is consistent with the input ids array.

```javascript
const orderedIds = ['id3', 'id1', 'id2'];
const users = await collection('users').findByIds(orderedIds, {
  preserveOrder: true
});

// users[0]._id === 'id3'
// users[1]._id === 'id1'
// users[2]._id === 'id2'
```

---

## Usage guidance

`findByIds()` runs one `_id: { $in: ... }` query after normalizing and deduplicating the input IDs. Actual latency depends on the number of IDs, document size, projection, indexes, network, cache settings, and deployment topology.

### Reduce returned data with projection

```javascript
const users = await collection('users').findByIds(ids, {
  projection: { name: 1, email: 1 }
});
```

### Cache repeated reads when the data is suitable

```javascript
const users = await collection('users').findByIds(hotUserIds, {
  cache: 60000  // 1 minute
});
```

### Keep batch size bounded

Avoid passing unbounded user input directly into a single `$in` query. Choose a service-level batch size based on your payload size, latency target, and MongoDB command limits.

```javascript
const batchSize = 100;
const results = [];

for (let i = 0; i < ids.length; i += batchSize) {
  const batch = await collection('users').findByIds(
    ids.slice(i, i + batchSize)
  );
  results.push(...batch);
}
```

---

## Error handling

### Error type

| Error type | Error code | Trigger condition |
|---------|--------|---------|
| **Parameter error** | `INVALID_ARGUMENT` | ids is not an array or contains an invalid ID |
| **Timeout Error** | `QUERY_TIMEOUT` | maxTimeMS exceeded |

### Error handling example

```javascript
try {
  const users = await collection('users').findByIds(userIds);
  
  // Check for missing users
  const foundIds = new Set(users.map(u => u._id.toString()));
  const missingIds = userIds.filter(id => !foundIds.has(id));
  
  if (missingIds.length > 0) {
    console.warn(`not found${missingIds.length} users:`, missingIds);
  }
} catch (error) {
  if (error.code === 'INVALID_ARGUMENT') {
    console.error('Parameter error:', error.message);
  } else if (error.code === 'QUERY_TIMEOUT') {
    console.error('Query timeout');
  } else {
    console.error('unknown error:', error);
  }
}
```

---

## Usage patterns

### Load related documents in one query

```javascript
const userIds = [...new Set(comments.map(c => c.userId))];
const users = await collection('users').findByIds(userIds);
```

### Let the helper deduplicate IDs

```javascript
const users = await collection('users').findByIds(userIds);
```

### Check for missing documents when completeness matters

```javascript
const users = await collection('users').findByIds(userIds);

if (users.length < userIds.length) {
  console.warn('Some users do not exist');
}
```

---

## Compare with other methods

### vs findOneById

| Dimension | findByIds | findOneById |
|------|-----------|-------------|
| **Scope** | Multiple IDs | One ID |
| **Query shape** | `_id: { $in: ids }` | `_id: id` |
| **Helper behavior** | Deduplicates input and can preserve input order | Single-document convenience wrapper |
| **Main use case** | Batch related records | A single known document |

### vs find({ _id: { $in }})

| dimensions | findByIds | find({ _id: { $in }}) |
|------|-----------|-----------------------|
| **ObjectId conversion** | Supported | Supported |
| **Deduplication** | Built in | Handle before calling if needed |
| **Preserve input order** | `preserveOrder: true` | Handle after query if needed |
| **When to use** | ID-only batch helper | General query path |

---

## FAQ

### Q1: What is the difference between findByIds and find?

**A**: `findByIds()` is an optional convenience wrapper for ID-only batch reads. `find({ _id: { $in: ids } })` remains the standard query path and also supports ObjectId auto conversion. Use `findByIds()` when you want built-in deduplication and optional input-order preservation.

### Q2: How to deal with non-existent IDs?

**A**: `findByIds` only returns existing documents, and no results will be returned for non-existing IDs.

```javascript
const users = await collection('users').findByIds([
  'existingId1',
  'nonExistentId',  // does not exist
  'existingId2'
]);
// users.length === 2 (only returns existing ones)
```

### Q3: How many IDs are supported?

**A**: There is no monSQLize-specific hard limit, but every query still needs to fit MongoDB command and BSON limits as well as your service latency target. For large or user-controlled arrays, set an application-level batch size and split the work.

### Q4: Does the preserveOrder option have any performance impact?

**A**: Has a slight impact (requires reordering), but can usually be ignored:
- None preserveOrder: O(n)
- With preserveOrder: O(n log n)

### Q5: Will it automatically remove duplicates?

**A**: Yes. Duplicate IDs are deduplicated before querying.

```javascript
const users = await collection('users').findByIds([
  'id1', 'id1', 'id2', 'id2', 'id2'  // repeat
]);
// Actually only query ['id1', 'id2'] (automatic deduplication)
```

### Q6: Does it support caching?

**A**: Yes. Use the `cache` option when the result is suitable for caching.

```javascript
const users = await collection('users').findByIds(ids, {
  cache: 60000  // Cache for 1 minute
});
```

### Q7: How is the performance?

**A**: Measure it in your environment. The `_id` field is indexed by MongoDB by default, but latency still depends on ID count, projection, document size, network, cache, and deployment topology. Use MongoDB profiler, APM, or your service metrics for production tuning.

---

## See also

- [findOneById()](./find-one-by-id.md) - Query a single document by _id
- [find()](./find.md) - Basic query method
- [findOne()](./findOne.md) - Query a single document
- [MongoDB official documentation: $in operator](https://www.mongodb.com/docs/manual/reference/operator/query/in/)
