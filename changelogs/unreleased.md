# Unreleased

## Changes after v3.3.1

- Isolate query, page, totals and bookmark caches by data source, authentication identity and pool; link invalidation across same-source routes.
- Add `cursorValueNormalizerVersion` for stable strategy identities. Unversioned custom normalizers bypass page/bookmark caching.
- Prevent stale in-flight reads and asynchronous cache fills from surviving write, transaction or received remote invalidation.
- Invalidate read caches after partial `insertMany` failures while preserving the original write error and per-write invalidation controls.
- Correct null/missing BSON pagination boundaries, supported sort forms, and exclusion projections that retain cursor fields.
- Serialize transaction commit, abort and end; apply work deadlines before commit and conservatively invalidate uncertain commit results.
- Reserve CountQueue slots during handoff, track lock lease expiry and renewal, and attempt every pool close while retaining failed clients for retry.
- Keep lint exclusions in flat config, add regression suites to the server matrix, and raise the main bundle budget from 740,000 to 750,000 bytes for the added coordination safeguards.
