# Write Path Policy

`writePathPolicy` lets a runtime decide whether writes may use both `collection()` and `model()`, or whether a namespace must be written through the Model layer.

Policy lookup uses only rules explicitly owned by the configuration object. Inherited prototype properties never become rules; explicit namespace keys such as `toString` and `constructor` remain valid.

The default is intentionally permissive: when `writePathPolicy` is omitted, collection APIs and Model APIs are both allowed. Enable this policy only for applications that want the runtime to enforce a stronger write boundary around schema defaults, hooks, timestamps, optimistic locking, soft delete, and other Model mutation rules.

## Configuration

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'app.audit_logs': 'allow-both',
      'analytics:app.reports': {
        mode: 'allow-both',
        raw: 'block',
        management: 'allow'
      }
    }
  }
});
```

## Rule Shape

```ts
type WritePathPolicyMode = 'allow-both' | 'model-only';

type WritePathPolicyRule = {
  mode?: WritePathPolicyMode;
  raw?: 'inherit' | 'allow' | 'block';
  management?: 'inherit' | 'allow' | 'block';
  onViolation?: 'throw' | 'warn';
};

type WritePathPolicyOptions = {
  default?: WritePathPolicyMode | WritePathPolicyRule;
  namespaces?: Record<string, WritePathPolicyMode | WritePathPolicyRule>;
};
```

| Field | Default | Meaning |
|-------|---------|---------|
| `mode` | `allow-both` | `allow-both` allows collection and Model writes. `model-only` blocks direct collection, db, and legacy writes unless overridden. |
| `raw` | `inherit` | Controls `collection.raw()`, `db.raw()`, and db command access. Inherits `block` from `model-only` and `allow` from `allow-both`. |
| `management` | `inherit` | Controls index and collection management operations. In `model-only`, Model management methods are allowed while direct collection management is blocked. |
| `onViolation` | `throw` | `throw` rejects the operation. `warn` logs a warning and allows the operation. |

## Namespace Matching

Namespace rules are matched from most specific to least specific:

1. Internal instance namespace, when present.
2. Pool-scoped namespace: `poolName:dbName.collectionName`.
3. Database namespace: `dbName.collectionName`.
4. Collection name only.
5. `default`.

Prefer `poolName:dbName.collectionName` or `dbName.collectionName` in user configuration. They are stable across runtime instance IDs.

Inside `namespaces`, the key `default` is reserved for the fallback matcher and is rejected at construction time; use the top-level `writePathPolicy.default` field instead. If an actual collection is named `default`, configure it with a qualified key such as `dbName.default` or `poolName:dbName.default`. Namespace keys must not include leading or trailing whitespace.

## Governed Operations

`writePathPolicy` applies to write-capable paths:

- Collection writes: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `replaceOne`, `findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`, `upsertOne`, `deleteOne`, `deleteMany`.
- Batch helpers: `insertBatch`, `updateBatch`, `deleteBatch`, `incrementOne`.
- Collection management: index creation/drop, collection creation/drop, validators, `renameCollection`, `collMod`, and capped conversion.
- Raw/db/legacy write surfaces: `collection.raw()`, `db.raw()`, `db.runCommand()`, `dropDatabase()`, and legacy adapter writes.
- Aggregation pipelines whose final stage writes with `$out` or `$merge`; the policy is checked against the write target namespace.

Read-only queries are not governed by this policy.

## Model-Only Example

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: { default: 'model-only' }
});

MonSQLize.Model.define('users', {
  schema: {},
  options: {
    timestamps: true,
    version: true,
    softDelete: true
  }
});

await msq.connect();

await msq.model('users').insertOne({ name: 'Ada' }); // allowed
await msq.collection('users').insertOne({ name: 'Ada' }); // throws
```

Use namespace overrides for operational collections that intentionally remain native:

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'app.audit_logs': 'allow-both'
    }
  }
});
```

## Boundary

This policy controls the API path used to issue writes. It does not make cache invalidation transaction-atomic, does not make Change Stream sync exactly-once, and does not replace application-level idempotency or authorization.
