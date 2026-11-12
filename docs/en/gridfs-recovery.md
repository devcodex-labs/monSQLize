# GridFS crash recovery and no-data-loss upgrade runbook (V0.1 candidate)

> **Operator-only.** This is a draft recovery design, not a completed or verified release. Never run recovery against a running, paused or network-partitioned GridFS writer. **Age alone is not proof that a writer is dead.** No automated TTL-based owner unlock is permitted.

## Scope and invariant

The ownership registry is the per-bucket `<bucket>.uploads` collection. A reservation excludes ordinary upload, uploadStream, resumable append/finalize/abort, delete, rename and orphan cleanup for the same ObjectId. A missing file document **does not** prove its chunks are orphaned: an ordinary upload may still be writing, or GridFS driver delete may have removed the files document before chunks. Recovering while an old writer can resume can destroy new data, even with a token-CAS. The maintenance process cannot prove cluster/process shutdown on its own.

The script `scripts/maintenance/gridfs-recover.cjs` uses a default read-only preview, exact state/token/timestamp checks, a persisted `recovering` ownership claim, verified preservation of committed visible chunks, and an append-only-by-intent audit collection `<bucket>.ownership_recovery_audit`. It never performs a time-based lock steal.

## Deployment and rollback gates (required)

1. Stop all HTTP/worker/job/cron processes that can mutate this GridFS bucket, across **all** deployments, driver versions, replica instances, queue consumers and old binaries. Disable automatic restarts and new GridFS requests. Resolve in-flight operations, check for network-partitioned/paused workers, and ensure the old writer fleet is fully drained. A mixed old/new-writer deployment is unsupported because the old version ignores the new registry.
2. Back up `<bucket>.files`, `<bucket>.chunks`, `<bucket>.uploads`, current indexes and relevant deployment version/worker inventory. Record a timestamp, operator, target database/bucket/id, intended delete/finalize outcome, and why no writer can resume. Retain backups and audit logs outside the cluster.
3. Deploy the new version while writes remain disabled. Run `ensureIndexes()` after verifying the old `createdAt_1` TTL and any legacy pending sessions. The migration derives `expiresAt` from the last update for eligible idle sessions, removes the legacy TTL index, and creates `expiresAt_1` with `expireAfterSeconds: 0`. TTL can already have removed sessions before migration; examine orphan chunks separately. Never treat an expiring session as safe while a legacy writer may still run.
4. Inspect every retained owner that must be recovered. Reconcile visible file and chunks, determine its original operation and the desired post-recovery state, and record the evidence. An owner without expiry is not automatically stale. Use the script only for an owner that has been conclusively quiesced.
5. Run dry-run and compare the proposed action with the recorded intent. To apply, supply the exact observed `status`, `updatedAt` ISO timestamp, and `ownerToken`, `activeAppend.token`, or `recovery.token` when present. Any mismatch is a stop signal. An audit document is written before a change; if a step fails the state remains `recovering` and must be re-inspected.
6. Recheck file visibility, stored chunk count, lengths, and any relevant SHA. Complete the latest-HEAD Node 18/20/22 CI, MongoDB 7.0.37/8.0.26 targeted suite, applicable Driver 6/7 compatibility checks and release preflight before unfreezing. Verify no `recovering` or unintended active reservations remain.
7. Only then restart new writers. Rollback to an old binary is **not safe while a new-version writer or reservation is active**; first stop/drain all new writers, reconcile operations, and assess the old binary's inability to honor `<bucket>.uploads` ownership. Preserve the migrated index configuration; do not recreate `createdAt` TTL blindly.

## Manual command

Use a checkout with installed dependencies and a MongoDB driver. Never pass the connection string in CLI arguments or paste credentials into an issue.

```sh
export MONSQLIZE_RECOVERY_MONGODB_URI='<MongoDB URI from the secrets manager>'
node scripts/maintenance/gridfs-recover.cjs \
  --db=my_database --bucket=fs \
  --id=0123456789abcdef01234567 \
  --expected-status=aborting \
  --expected-updated-at=2026-11-12T02:00:00.000Z
```

This previews but does not write. Retrieve the exact observed fields from the backed-up `<bucket>.uploads` collection first. If the document contains a token, append `--expected-token=...`. **Do not copy** the example ObjectId or timestamp. Apply only after external process quiescence is verified and logged:

```sh
node scripts/maintenance/gridfs-recover.cjs \
  --db=my_database --bucket=fs \
  --id=0123456789abcdef01234567 \
  --expected-status=aborting \
  --expected-updated-at=2026-11-12T02:00:00.000Z \
  --operator=oncall-id --reason=verified-writer-shutdown \
  --quiesced --apply
```

For an already `recovering` owner only, verify that the previous recovery executor has stopped and add `--prior-recovery-stopped` to the apply command; this is separate from stopping ordinary GridFS writers.

Every apply attempt includes an audit entry. A crash can leave a `status: recovering` record with `recovery.token`; after proving **both all writers and the previous recovery executor have stopped**, re-inspect that record and use its new status, updatedAt and recovery token to retry. Supply the additional `--prior-recovery-stopped` flag. The restart acquires a fresh recovery token via atomic CAS. Two operators with the same observed snapshot cannot perform destructive steps simultaneously, but in-flight writes by an unquiesced prior executor still cannot be fenced by MongoDB alone. Never delete an ownership record by ID alone.

## State-by-state recovery contract

| Observed owner | After proven quiescence | Critical preservation rule |
|---|---|---|
| `kind:direct,status:uploading` | When a file is visible, verify every chunk and release ownership; otherwise delete orphan chunks and release | Visible-file chunks are never deleted |
| `kind:delete,status:deleting` | Complete the interrupted delete of file and chunks before releasing ownership | No new upload may claim the same ID until both steps finish |
| `kind:cleanup,status:cleaning` | Check visible file; delete chunks only if no file exists; release | Never delete a visible file's chunks |
| `kind:rename,status:renaming` | Release only after inspecting the resulting filename and intended rename | The tool does not choose or replay a rename target |
| `status:pending,activeAppend` | Recompute the contiguous chunk prefix, clear only the observed append claim, restore seven-day idle expiry | Existing chunks are preserved; caller replays/checks the data |
| `status:finalizing` without file | Restore pending with expiry; retry normal finalize, which revalidates bytes | Never discard chunks to unlock finalize |
| `status:finalizing` with file | Re-hash the **actual** ordered chunks and check expected file length, chunk size and digest before releasing session | Forged metadata SHA is not sufficient |
| `status:aborting` without file | Delete invisible chunks then remove session | No newly created file can take ownership during recovery |
| `status:aborting` with file | **Blocked** for human forensic review | Never silently delete or detach a visible file |
| `status:recovering` | Resume by exact recovery token and reverified quiescence | Keep claim if any destructive step is ambiguous |

### Known limitations and release criteria

- MongoDB cannot revoke an already-running Node.js process's in-memory chunk write. `--quiesced` is a mandatory **external operational assertion**, not a technical fencing guarantee. For non-quiesceable workloads, a future generation-aware writer fencing design and driver integration would be needed; do **not** automate unlocking based on age.
- A direct uploadStream `metadata.sha256` is not authenticated at write time. The tool verifies visible chunk structure and length, but does not treat this metadata as a trusted digest for ordinary uploads.
- The recovery code is a source-checkout maintenance utility. It is not an online public `GridFSBucket` API and must not be exposed to unprivileged application callers.
- `drop()` is bucket-wide and ignores per-ID reservations; maintenance must globally stop writers before dropping the bucket.
- Deterministic tests must show all state paths, wrong-token and wrong-timestamp rejection, fail-closed interrupted recovery, no deletion of visible chunks, and idempotent restart after an interrupted abort/delete. **No merge until the code and this runbook pass the latest-HEAD required CI matrices and independent review.**
