# Upgrade from 3.3.1 to 3.3.2

Use this guide to upgrade an application from **3.3.1 to 3.3.2**. Treat an untagged checkout as a release candidate. Check `npm view monsqlize@3.3.2 version --registry=https://registry.npmjs.org/` and the immutable tag before installing that exact version; until it exists, qualify the candidate's packed artifact in staging. Preparing a candidate does not publish npm or update the stable site.

The patch corrects BSON query/cache identity, Model cache invalidation, pagination, transactions, sync and resource cleanup. It retains public package entry points, Node.js `>=18`, direct runtime dependencies and build formats. Automatic cache invalidation remains disabled by default.

## Plan the rollout

1. Run your application tests against the candidate, especially cached queries, Model soft deletion, custom cursor restoration and sync targets.
2. Plan for cold query/aggregate results, totals and bookmarks. Refill hot queries and call `prewarmBookmarks()` where used. Old entries may expire normally; no global Redis flush or business-data migration is required.
3. Upgrade instances sharing caches together. If versions must coexist, isolate their cache backends or use broad collection/operation invalidation; exact descriptors build the current key generation.
4. If sync is enabled, stop writers and drain work before upgrading. Preserve checkpoints, both generations of idempotency markers and a recovery snapshot. Do not run mixed key-format writers.
5. After npm publication, install the exact version in staging, verify your application and restore traffic gradually. Stable bilingual documentation must deploy from the same immutable `v3.3.2` tag after registry acceptance.

## Cache and query compatibility

Shared BSON query encoding uses generation `v4`. It distinguishes effective input and decoding options, ordered BSON documents, undefined values, negative zero and binary views/subtypes. Functions serialize per native occurrence; shared inputs are captured for one logical page/totals operation. The public bookmark prefix remains `bm:v4`, but its hash changes. See [cache migration](./cache.md).

JSON-incompatible result modes bypass JSON-backed result caches. Dynamic decoding maps retain their documented lazy behavior; dimensioned bookmark operations may reject them. A custom `cursorValueNormalizer` needs a non-empty, stable `cursorValueNormalizerVersion` for page/bookmark reuse. Without it, queries still execute, those caches are bypassed, prewarming throws `INVALID_ARGUMENT`, and deep jumps can reach `jump.maxHops`.

Pipeline-based `findPage()` supports ordinary include/exclude projections and applies them after custom stages. Find-only `$slice`, `$elemMatch` and positional projections are rejected with `INVALID_OPERATION`. Ordered `findByIds()` uses one native query for supported excluded/computed identities; combinations that cannot retain the original identity are rejected. `preserveOrder: false` retains native execution. Read the [pagination](./findPage.md) and [ID lookup](./find.md) boundaries for special `_id` projections and BSON result modes.

Explicit Model aggregate/page invalidation accounts for soft-delete visibility. Writes clear caches only when the existing invalidation controls request it. Invalidation runs best-effort after a successful write or commit and does not roll back committed MongoDB data. See [cache invalidation](./cache-invalidation.md).

## Transactions

Transaction `timeout` and `maxDuration` bound work before commit begins. Driver/server limits govern commit timing. An unknown commit result does not prove rollback and must not trigger automatic replay of a business callback. Affected caches are invalidated conservatively. See [transactions](./transaction.md).

## Sync checkpoints and rollback

An empty checkpoint store now receives an opaque initial operation-time envelope containing a canonical EJSON BSON Timestamp before the stream opens. Custom stores must round-trip it. Existing raw event resume tokens remain supported. Strict persistence failures, malformed checkpoints and expired history stop progress without deleting the checkpoint.

**Before downgrade, pause sync and preserve the store.** Older readers cannot use the initial envelope as a raw resume token. A successfully saved raw event token restores format compatibility only subject to the older reader's behavior and MongoDB history retention. Never clear the initial envelope or restart from now to force a downgrade.

Per-target idempotency keys use v2 JSON tuples. Legacy concatenated markers can be ambiguous and are not unconditional v2 duplicate evidence. Unless a finite mapping is provable, rely on target-owned business idempotence and allow replay. A generic get/set/del store cannot enumerate or reverse legacy keys automatically.

Rollback requires another stop/drain, preservation of both marker generations, a compatible raw token and a verified target recovery point. Keep the recovery snapshot and reconcile affected data deliberately; do not clear either store. Full details: [Change Stream sync](./sync-backup.md).

## Release notes and recovery

The [versioned 3.3.2 notes](../../changelogs/v3.3.2.md) list the complete repair groups. Use the [support matrix](./support-matrix.md) to interpret public CI and optional private-environment coverage. Package maintainers should follow the separate repository [release and recovery runbook](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/release-preflight.md); OIDC readiness does not establish npm publication or verify npm-side publisher settings.
