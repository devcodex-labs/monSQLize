# Unreleased

## Changes after v3.3.1

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
