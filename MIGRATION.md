# Migration Guide: monSQLize

Start with the 3.3.1 to 3.3.2 upgrade notes for this candidate, then consult the
older v3 and v1/v2 paths if needed. Review the operational boundaries that
intersect your application before changing its installed version.

## Upgrade from v3.3.1 to v3.3.2

An untagged checkout is a release candidate; verify the immutable tag and npm
registry before deployment. The upgrade guide is also available in [English](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/upgrade-3.3.2.md) and
[简体中文](https://github.com/devcodex-labs/monSQLize/blob/main/docs/zh/upgrade-3.3.2.md).

- Query, page, totals and bookmark caches now include source/authentication and
  pool identities. Upgrade all application instances sharing a backend together;
  old entries are not read, so expect a cold start and plan for refill traffic.
  No global Redis flush is needed. TTL/cleanup can reclaim old keys. Applications
  with custom cache-key patterns should use collection invalidation APIs or
  result-matching descriptors rather than rebuilding internal prefixes from
  `getNamespace()`.
- Custom `cursorValueNormalizer` functions need a non-empty stable
  `cursorValueNormalizerVersion` such as `token-string:v1` to use page caching or
  bookmark prewarming. Change the identifier when behavior or captured config
  changes. A per-query function override needs its own version. Without one,
  queries still run, page caches and automatic bookmark reads are bypassed,
  prewarming throws `INVALID_ARGUMENT`, and deep jumps can reach `jump.maxHops`.
  Prefer `cursorTypes` for simple hints. Custom functions restore every cursor
  field, including `_id`, instead of default Date/ObjectId restoration.
- Transaction `timeout` / `maxDuration` now bound work before commit starts;
  commit timing belongs to driver/server limits. For direct `Transaction`
  construction, use `transactionOptions.maxCommitTimeMS`; high-level helper
  options do not currently forward this field. Unknown commit results invalidate
  affected caches conservatively and preserve the original error; they do not
  imply rollback or permit automatic business-callback replay.
- Cache refill coordination applies to the same CacheLike object in one process.
  Cross-process Redis notifications remain eventually consistent. Same-source
  routes invalidate together when registered on that cache object; host aliases
  need consistent endpoints or explicit related-route invalidation.

- Shared BSON query-key encoding uses generation `v4`, including effective BSON
  input/decoding options and native per-occurrence function serialization.
  Query, aggregate, totals and bookmark entries start cold. The public `bm:v4`
  prefix is retained, but its hash changes. Use broad invalidation or isolate
  cache backends during mixed-version operation; exact descriptors use the
  current generation. JSON-incompatible result modes bypass result caching.
- Pipeline-based `findPage()` rejects find-only projections such as `$slice`,
  `$elemMatch` and positional projection with `INVALID_OPERATION`. Ordered
  `findByIds()` retains one-query native identity for supported projections and
  rejects combinations that cannot preserve it; `preserveOrder: false` retains
  native execution. Check the query guides before relying on special `_id`
  transformations or dynamic BSON decoding maps.
- Before enabling Change Stream sync on an empty checkpoint store, confirm that
  a custom store can round-trip the opaque initial operation-time envelope and
  its canonical EJSON Timestamp. Existing raw resume tokens remain supported.
  Before downgrade, pause sync and preserve the checkpoint; an older reader
  cannot treat the initial envelope as a raw token. A persisted event token
  restores format compatibility only subject to history retention and the
  older reader's behavior. Never clear the envelope to restart from now.
- Sync idempotency markers use v2 JSON tuple keys. Stop writers and drain work
  before upgrade or rollback; preserve the checkpoint, both marker generations
  and a recovery snapshot. Do not run mixed key-format writers or blindly trust
  ambiguous legacy concatenated keys. Use target-owned business idempotence for
  replay unless a finite mapping is provable. Rollback also needs a compatible
  raw token and a verified target recovery point; do not clear either store.

See the [3.3.2 notes](./changelogs/v3.3.2.md), [cache guide](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/cache.md)
and [sync upgrade/rollback guide](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/sync-backup.md) for details.

## Upgrade from v3.0.0 to v3.1.0

monSQLize v3.1 consumes schema-dsl v3 without installing schema-dsl's legacy
String prototype extensions. Applications that need those extensions must opt
in through `schema-dsl/compat` or `schema-dsl/register-string`; monSQLize itself
continues to use the isolated `schema-dsl/runtime` entry and does not require
them.

Successful full-document Model validation now persists schema-dsl's normalized
`data` for `insertOne`, `insertMany`, `insertBatch`, `replaceOne`,
`findOneAndReplace`, and hydrated document `save()`. Coerced values and schema
defaults therefore reach MongoDB. The order is model defaults, before hook,
schema normalization, timestamps, version, then driver write. Replacement
writes do not apply model defaults, and `save()` has no new before-hook stage.

Validation failures still throw `VALIDATION_ERROR`, and public errors remain
`{ field, message }`; `field` is mapped from schema-dsl's canonical `path`.
Update operators and pipelines do not expose a complete final document and are
not included in normalized-data persistence. If an application relied on
schema-dsl coercion being discarded before v3.1, review stored value types in a
staging environment before upgrading.

## Upgrade from v2.0.6 to v3.0.0

### 1. Run the release checks before changing production

Use Node.js 18 or newer, install v3 in a staging branch, and run your own
Model, cache, sync, transaction, and data rollout tests. monSQLize v3 pins
`schema-dsl@2.1.6` and keeps the isolated `schema-dsl/runtime` integration.

### 2. Review bounded query and optimistic-locking behavior

- `find()` defaults to 500 documents. Configure an explicit safe limit when a
  service previously depended on an unbounded result.
- Versioned single-document Model writes use optimistic concurrency control and
  may throw `WRITE_CONFLICT` for stale state.
- Versioned `updateMany()` defaults to `counter`; select `strict` or `off` when
  that better matches the existing write contract.
- `updateBatch({ upsert: true })` is rejected. Use `upsertOne()` or MongoDB's
  native `updateMany(..., { upsert: true })` according to the required semantics.

### 3. Review sync, index, and production guards

- Resume-token persistence failures stop Change Stream sync unless a legacy
  best-effort option is selected explicitly.
- `autoIndex: true` now preflights with `listIndexes()`, creates only missing
  indexes, and reports conflicts. Keep production index rollout reviewed.
- `production`, `prod`, and `live` all activate production-like safety guards.

### 4. Use the new bounded data-task path for release data

For selected release data and declared indexes, use
`dataTasks.preview(job)` followed by `dataTasks.apply(job, { approval })`.
Production jobs require a durable affected-scope backup directory. This feature
does not replace schema migrations, full database export/import, or disaster
recovery. See the data-tasks and production-rollout guides before first use.

## Historical v1 to v2 notes

The sections below document intentional behavioural and contract changes between
monSQLize v1.x and v2.x. Most v2 type-level differences from v1 have been
softened (optional fields, alias keys, permissive callbacks) so that v1
fixtures and call sites continue to type-check unchanged. The items below
are the **deliberately tightened** semantics that v2 keeps for safety; v1
callers in these spots may need code changes.

## Tightened semantics retained in v2

### 1. `Model.findOne` returns `T | null` (not `T | undefined`)

- v1 returned `undefined` when no document matched.
- v2 returns `null`, matching the underlying MongoDB driver and removing
  the `undefined` vs `null` ambiguity.
- **Migration**: replace `result === undefined` with `result === null`,
  or use `!result` which works for both.

### 2. `ConnectionPoolManager#selectPool()` returns a typed handle

- v1 returned an opaque object whose shape was not declared.
- v2 returns a `PoolHandle` interface with documented fields
  (`name`, `client`, etc.).
- **Migration**: no source change is required if you only consume fields
  v2 declares. If your v1 code accessed undeclared fields, declare them
  through module augmentation or assert through `as unknown as ...`.

### 3. Cache event payloads use `unknown` rather than `any`

- The cache `publish()` / subscriber callback payload type is now
  `unknown` instead of `any`, forcing call sites to narrow before use.
- **Migration**: add a runtime check or a type assertion at the
  consumption point. The wire shape is unchanged.

## Type-level compatibility additions (no source change required)

For reference, v2 type files were extended with the following alias /
optional fields so that v1 fixtures and runtime payloads continue to
type-check; you do **not** need to migrate code for these:

- `BatchRetryRecord`: added optional `attempts` (alias of `attempt`) and
  `success?: boolean`. The runtime now also emits both fields on retry
  records to match v1.
- `FindPageOptions`: added top-level `comment?: string` shortcut that
  mirrors `options.comment`.
- `SagaContext.get<T = any>`: default generic relaxed from `unknown` to
  `any` to match v1 ergonomics.
- `SagaResult.sagaId` / `sagaName`: marked optional alongside
  `executionId`.
- `SagaStats`: aliased v2-only fields
  (`successfulExecutions` / `failedExecutions` / `compensatedExecutions`)
  are optional; `successCount` / `failureCount` / `compensationCount`
  remain the v1 primary fields.
- `MongoSession.transaction?.state`: re-exposed for v1 callers reading
  `session.transaction?.state`.
- `SyncConfig.transform`: accepts both v1 single-arg
  `(document) => ...` and v2 `(document, event) => ...` forms.
- `Lock.released`: marked `readonly` to match v1.
- `PoolStats`: counter fields are optional to accept v1 fixture shapes.

If a previously-undocumented field still does not type-check, please
file an issue with the v1 reproduction so the public types can be
extended.
