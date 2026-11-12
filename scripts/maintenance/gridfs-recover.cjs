'use strict';

/**
 * Operator-only recovery for GridFS ownership records after an externally
 * verified writer shutdown. Never run against a live or potentially paused
 * writer; MongoDB cannot fence a previously issued driver chunk write.
 *
 * Dry-run is default. The caller must supply the exact observed state,
 * updatedAt timestamp and (where applicable) ownership token to apply.
 * A durable "recovering" claim makes interruption/retry fail closed.
 */
const { randomUUID, createHash } = require('node:crypto');
const { MongoClient, ObjectId } = require('mongodb');

const TTL_MS = 604800000;

function fail(message) {
    const error = new Error(message);
    error.code = 'GRIDFS_RECOVERY_PRECONDITION_FAILED';
    throw error;
}

function toBuffer(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data && typeof data.value === 'function') return Buffer.from(data.value(true));
    if (data instanceof Uint8Array) return Buffer.from(data);
    fail('Encountered a chunk with unsupported BSON binary data');
}

async function verifyVisibleFile(db, bucket, id, session) {
    const files = db.collection(bucket + '.files');
    const doc = await files.findOne({ _id: id });
    if (!doc) return false;
    if (!Number.isSafeInteger(doc.length) || doc.length < 0 ||
        !Number.isSafeInteger(doc.chunkSize) || doc.chunkSize < 1) {
        fail('Visible file has invalid length/chunkSize; preserve ownership');
    }
    const totalChunks = Math.ceil(doc.length / doc.chunkSize);
    const digest = createHash('sha256');
    let n = 0;
    let length = 0;
    for await (const chunk of db.collection(bucket + '.chunks')
        .find({ files_id: id }).sort({ n: 1 })) {
        if (chunk.n !== n || n >= totalChunks) fail('Visible file has a missing, extra or out-of-order chunk');
        const bytes = toBuffer(chunk.data);
        const want = n === totalChunks - 1 ? doc.length - n * doc.chunkSize : doc.chunkSize;
        if (bytes.length !== want) fail('Visible file has a corrupt chunk length');
        digest.update(bytes);
        length += bytes.length;
        n++;
    }
    if (length !== doc.length || n !== totalChunks) {
        fail('Visible file is incomplete; preserve ownership and chunks');
    }
    if (session) {
        if (session.length !== doc.length || session.chunkSizeBytes !== doc.chunkSize ||
            doc.metadata?.sha256 !== session.sha256 ||
            digest.digest('hex') !== session.sha256) {
            fail('Finalizing session and visible bytes mismatch; preserve ownership and chunks');
        }
    }
    return true;
}

function snapshotToken(doc) {
    return doc.recovery?.token || doc.ownerToken || doc.activeAppend?.token || null;
}

function classify(doc) {
    if (doc.status === 'recovering' && doc.recovery?.fromStatus) return doc.recovery.fromStatus;
    if (doc.kind === 'direct' && doc.status === 'uploading') return 'uploading';
    if (doc.kind === 'delete' && doc.status === 'deleting') return 'deleting';
    if (doc.kind === 'rename' && doc.status === 'renaming') return 'renaming';
    if (doc.kind === 'cleanup' && doc.status === 'cleaning') return 'cleaning';
    if (doc.status === 'pending' && doc.activeAppend) return 'activeAppend';
    if ((!doc.kind || doc.kind === 'resumable') &&
        (doc.status === 'finalizing' || doc.status === 'aborting')) return doc.status;
    fail('Unsupported owner state: do not recover automatically');
}

async function contiguousChunkPrefix(db, bucket, id) {
    let next = 0;
    for await (const doc of db.collection(bucket + '.chunks')
        .find({ files_id: id }).sort({ n: 1 }).project({ n: 1 })) {
        if (doc.n !== next) break;
        next++;
    }
    return next;
}

async function recoverGridFSOwnership(input) {
    const { db, bucket, id, expectedStatus, expectedUpdatedAt, expectedToken,
        quiesced, operator, reason, apply = false } = input;
    if (!db || !bucket || typeof bucket !== 'string' || !(id instanceof ObjectId)) fail('Invalid database, bucket or ObjectId');
    if (!expectedStatus || !expectedUpdatedAt) fail('Exact expected status and updatedAt are required');
    const uploads = db.collection(bucket + '.uploads');
    const doc = await uploads.findOne({ _id: id });
    if (!doc) return { outcome: 'no_owner', modified: false };
    if (!(doc.updatedAt instanceof Date) ||
        doc.status !== expectedStatus ||
        doc.updatedAt.toISOString() !== expectedUpdatedAt) {
        fail('Owner status or updatedAt changed since inspection');
    }
    const token = snapshotToken(doc);
    if ((token || null) !== (expectedToken || null)) fail('Owner token changed since inspection');
    const sourceStatus = classify(doc);
    const visible = await db.collection(bucket + '.files').findOne({ _id: id }, { projection: { _id: 1 } });
    const plan = {
        bucket, uploadId: id.toHexString(), fromStatus: sourceStatus,
        fileVisible: !!visible,
        action: ({
            uploading: 'verify-visible-or-remove-orphan-chunks',
            deleting: 'complete-file-and-chunk-deletion',
            renaming: 'release-after-inspecting-rename-outcome',
            cleaning: 'remove-invisible-orphan-chunks',
            activeAppend: 'restore-pending-and-reconcile-prefix',
            finalizing: visible ? 'verify-visible-bytes-and-release-session' : 'restore-pending-for-retry',
            aborting: visible ? 'BLOCK-visible-file-conflict' : 'finish-invisible-chunk-removal',
        })[sourceStatus],
    };
    if (!apply) return { outcome: 'dry_run', modified: false, plan };
    if (quiesced !== true || typeof operator !== 'string' || !operator.trim() ||
        typeof reason !== 'string' || !reason.trim()) {
        fail('Apply requires external writer quiescence, named operator and reason');
    }
    if (sourceStatus === 'aborting' && visible) fail('Visible file conflicts with aborting state; manual inspection required');

    const audit = db.collection(bucket + '.ownership_recovery_audit');
    const attemptId = randomUUID();
    await audit.insertOne({
        _id: attemptId, fileId: id, bucket, fromStatus: sourceStatus,
        operator, reason, startedAt: new Date(), outcome: 'started', plan,
    });
    let recoveryToken;
    if (doc.status === 'recovering') {
        recoveryToken = doc.recovery.token;
        await audit.updateOne({ _id: attemptId }, { $set: { outcome: 'resumed', recoveryToken } });
    } else {
        recoveryToken = randomUUID();
        const filter = { _id: id, status: doc.status, updatedAt: doc.updatedAt };
        if (doc.kind === undefined) filter.kind = { $exists: false };
        else filter.kind = doc.kind;
        if (doc.ownerToken !== undefined) filter.ownerToken = doc.ownerToken;
        if (doc.activeAppend) filter['activeAppend.token'] = doc.activeAppend.token;
        const claim = await uploads.updateOne(filter, {
            $set: {
                status: 'recovering', updatedAt: new Date(),
                recovery: { token: recoveryToken, fromStatus: sourceStatus, operator, attemptId, startedAt: new Date() },
            },
            $unset: { expiresAt: '' },
        });
        if (claim.matchedCount !== 1) {
            await audit.updateOne({ _id: attemptId }, { $set: { outcome: 'claim_conflict', finishedAt: new Date() } });
            fail('Concurrent state change prevented recovery claim');
        }
    }
    const held = { _id: id, status: 'recovering', 'recovery.token': recoveryToken };
    try {
        const chunks = db.collection(bucket + '.chunks');
        const files = db.collection(bucket + '.files');
        if (sourceStatus === 'activeAppend') {
            const nextChunk = await contiguousChunkPrefix(db, bucket, id);
            const changed = await uploads.updateOne(held, {
                $set: { status: 'pending', nextChunk, updatedAt: new Date(),
                    expiresAt: new Date(Date.now() + TTL_MS) },
                $unset: { activeAppend: '', recovery: '' },
            });
            if (changed.matchedCount !== 1) fail('Lost recovery claim while restoring append');
        } else if (sourceStatus === 'finalizing' && !visible) {
            const changed = await uploads.updateOne(held, {
                $set: { status: 'pending', updatedAt: new Date(),
                    expiresAt: new Date(Date.now() + TTL_MS) },
                $unset: { recovery: '' },
            });
            if (changed.matchedCount !== 1) fail('Lost recovery claim while restoring finalize');
        } else {
            // Verify before ANY deletion. Never delete chunks of a visible file
            // unless this is an explicitly quiesced, retained "deleting" owner.
            if (sourceStatus === 'finalizing') {
                await verifyVisibleFile(db, bucket, id, doc);
            } else if (sourceStatus === 'uploading' && visible) {
                await verifyVisibleFile(db, bucket, id, null);
            }
            if (sourceStatus === 'deleting') {
                await files.deleteOne({ _id: id });
                await chunks.deleteMany({ files_id: id });
            } else if ((sourceStatus === 'uploading' || sourceStatus === 'cleaning' ||
                        sourceStatus === 'aborting') && !visible) {
                await chunks.deleteMany({ files_id: id });
            }
            const removed = await uploads.deleteOne(held);
            if (removed.deletedCount !== 1) fail('Lost recovery claim while releasing owner');
        }
        await audit.updateOne({ _id: attemptId }, { $set: { outcome: 'completed', finishedAt: new Date() } });
        return { outcome: 'completed', modified: true, plan, attemptId };
    } catch (error) {
        // Deliberately retain recovering state; retry using its exact token and
        // updatedAt only after re-verifying process quiescence.
        try {
            await audit.updateOne({ _id: attemptId },
                { $set: { outcome: 'blocked', error: String(error), finishedAt: new Date() } });
        } catch { /* The recovery claim remains; preserve original error. */ }
        throw error;
    }
}

function readArg(args, name) {
    const prefix = '--' + name + '=';
    const found = args.find((a) => a.startsWith(prefix));
    return found && found.slice(prefix.length);
}

async function main() {
    const args = process.argv.slice(2);
    const uri = process.env.MONSQLIZE_RECOVERY_MONGODB_URI;
    if (!uri) fail('MONSQLIZE_RECOVERY_MONGODB_URI is required (do not put credentials in argv)');
    const dbName = readArg(args, 'db');
    const bucket = readArg(args, 'bucket');
    const idString = readArg(args, 'id');
    if (!dbName || !bucket || !idString || !ObjectId.isValid(idString)) fail('--db, --bucket and --id are required');
    const client = new MongoClient(uri);
    await client.connect();
    try {
        const report = await recoverGridFSOwnership({
            db: client.db(dbName), bucket, id: new ObjectId(idString),
            expectedStatus: readArg(args, 'expected-status'),
            expectedUpdatedAt: readArg(args, 'expected-updated-at'),
            expectedToken: readArg(args, 'expected-token') || null,
            operator: readArg(args, 'operator'), reason: readArg(args, 'reason'),
            quiesced: args.includes('--quiesced'),
            apply: args.includes('--apply'),
        });
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } finally {
        await client.close();
    }
}

module.exports = { recoverGridFSOwnership, verifyVisibleFile };
if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(String(error.code || 'RECOVERY_ERROR') + ': ' + error.message + '\n');
        process.exitCode = 1;
    });
}
