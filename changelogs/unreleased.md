# Unreleased

## Changes after v3.4.0

- Add GridFS buckets on `msq.gridfs()` and `model.gridfs()`, including upload, download, ranges, `ensureIndexes`, and phase-1 resumable upload. `writePathPolicy` gains a `gridfs` field and category. Policy violations stay `INVALID_OPERATION` with `reason: 'WRITE_PATH_POLICY'`. These notes stage the work after 3.4.0; the npm package version is unchanged and this file is not a 3.5.0 release. The Search index lifecycle API remains in the [3.4.0 versioned notes](./v3.4.0.md).

## Archived preparation notes for the 3.3.2 candidate

The entries below preserve the implementation sequence after 3.3.1. Intermediate key generations, byte budgets and validation status are historical; the final contracts and approved 820,000/50,000-byte budgets are consolidated in the versioned 3.3.2 notes.

- Preserve native repeated Code scope access and disabled DBRef function handling in cache keys. Isolate malformed explicit invalidation descriptors so valid siblings still run and successful aggregate writes retain their result. Add regression controls for these RF13–RF15 review follow-ups; the approved root bundle budget is 820,000 bytes and the independent CLI budget stays 50,000 bytes.

- Repair soft-delete Model page descriptor invalidation across raw/Model visibility, delayed aggregate writes and transactions. Preserve native Code scope and per-occurrence function serialization; share captured inputs across page hops/totals. Key effective BSON inheritance across all read consumers and isolate shared bookmark dimensions; bypass nonstandard JSON result modes and lazy dynamic decoding maps. Shared query encoding advances to v4 with cold result/totals/bookmark prewarming; the public bm:v4 prefix, default invalidation and B02 checkpoints remain unchanged. Bilingual documentation and regression controls accompany RF13–RF16.

- Upgrade shared query-key encoding to v3 for undefined members, negative zero, native binary views/effective Binary length, Maps and cross-realm BSON leaves. Align effective ignoreUndefined across read keys, count execution, exact descriptors, totals and bookmark management. Preserve executed page pipeline literals. Query/totals/bookmark caches start cold; business data, sync checkpoints and package budgets remain unchanged.

- Respect every ECMAScript comment line terminator when comparing schema factories, preserving captured values and stable local factories through comments, templates and automatic semicolon insertion.

- Classify native aggregate `out` before write checks and capture result options across cache waits while preserving sessions/signals. Start aggregate caches at a new generation. Align explicit soft-delete Model aggregate invalidation, retain native matching for uppercase converted relation keys, and distinguish contextual words, complete default-call parameters, separate parameter/body bindings and template scopes in schema factories. Default invalidation, checkpoint formats, dependency versions and package budgets remain unchanged.

- Align supported DSL aggregate descriptor invalidation with captured execution pipelines without reinterpreting prepared literals. Preserve native relation equality for colliding BSON key types, distinguish factory display names from lexical bindings, and retain scalar-override and invalid-input compatibility in special-key MemoryCache batches. Regression coverage and bilingual boundaries accompany these fixes; dependency versions, public signatures, checkpoint formats and package budgets are unchanged.

- Recheck aggregate write targets after DSL compilation and retain Model origin. Support frozen cache adapters and prototype-name batch keys without changing TTL, timeout or backfill fencing. Correct object-property/function-expression/block-function schema bindings; use native collation equality for unsorted string population, with documented metadata and query costs.
- Keep slow-log queues usable after synchronous adapter failures, accept nested partial configuration in strict CJS/ESM consumers, and isolate synchronous diagnostic sink exceptions under the log policy. Regression coverage and bilingual documentation accompany these repairs; no dependency, checkpoint protocol or package-budget change is included.

- Capture aggregate pipelines before policy checks; reject pagination write stages and unsupported find-only pipeline projections, and apply supported page projections after custom stages.
- Preserve input ID order with ordinary excluded/computed identities in one native query, bypassing internal-identity caches; reject combinations that cannot retain identity. Use MongoDB sorting for sorted population and update soft-delete timestamps in the original mutation.
- Correct quoted/literal DSL strings, escaped delimiters, match-expression roles and block-scoped schema factories; align generic ModelInstance, synchronous totals and metadata toArray types.
- Drain admitted slow-log work before close, preserve event-time bounds and sort derived averages before pagination. Retain remote TTL/tag capabilities and coordinate shared-L1 backfills across tag/key/batch/pattern invalidation, L1 clear, cleanup and retry; preserve deletion results and unrelated keys.
- Generate Logger trace IDs in pure ESM, honor explicit trace-output disabling and preserve successful insertMany results if diagnostic logging fails. Bilingual user documentation and strict packed CJS/ESM consumers accompany these unreleased changes.

- Repair review follow-ups: guard relation deletes after final hooks; filter Model ID lookups before unchanged projections and isolate visibility caches, including exact invalidation and caches without pattern deletion.
- Include effective let/collation and ordered BSON let literals in bookmark identities; forward let to totals and start bookmark/totals v4 keys cold. Separate DSL lambda and native variable scopes through nested JSON expressions without rewriting literal data.
- Fence slow-log initialization against close, retain failed owned-client and sync-target cleanup for retry, and encode sync idempotency keys as v2 JSON tuples. Upgrades and rollback require the documented stop/drain, checkpoint/store preservation and replay safeguards; legacy concatenated markers are not unconditionally trusted.

- Audit repair candidate: tighten Data Task CAS, Model version/soft-delete concurrency, ID-only projections and hook contracts; persist an initial Change Stream checkpoint and reject duplicate target names. Initial envelopes require the documented pause-and-preserve downgrade procedure.
- Isolate typed totals/bookmark keys, preserve partial-write invalidation and report only confirmed batch inserts; new keys start cold. Fence runtime/pool startup, retain failed releases, unify health checks, derive CMAP statistics and honor primary fallback.
- Correct nested expression contexts, dynamic arguments, lexical scope, LET separators, explicit SWITCH defaults and exponents. Honor slow-query error/index policies, delegate function-cache invalidation, expose CJS ModelInstance and reject collMod target overrides.
- Candidate validation is recorded separately; these entries do not claim publication or a new package version.
- Isolate query, page, totals and bookmark caches by data source, authentication identity and pool; link invalidation across same-source routes.
- Add `cursorValueNormalizerVersion` for stable strategy identities. Unversioned custom normalizers bypass page/bookmark caching.
- Prevent stale in-flight reads and asynchronous cache fills from surviving write, transaction or received remote invalidation.
- Invalidate read caches after partial `insertMany` failures while preserving the original write error and per-write invalidation controls.
- Correct null/missing BSON pagination boundaries, supported sort forms, and exclusion projections that retain cursor fields.
- Serialize transaction commit, abort and end; apply work deadlines before commit and conservatively invalidate uncertain commit results.
- Reserve CountQueue slots during handoff, track lock lease expiry and renewal, and attempt every pool close while retaining failed clients for retry.
- Document cold-cache upgrades, stable cursor strategy configuration, partial-write invalidation, transaction work deadlines and retryable pool shutdown; align bilingual references, examples and public type comments.
- Keep lint exclusions in flat config, add regression suites to the server matrix, and raise the main bundle budget from 740,000 to 750,000 bytes for the added coordination safeguards.
