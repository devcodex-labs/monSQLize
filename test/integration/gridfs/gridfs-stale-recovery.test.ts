import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
import { releaseOwner } from '../../../src/capabilities/gridfs/ownership';

const MonSQLize = require('../../../dist/cjs/index.cjs');
const { recoverGridFSOwnership } = require(process.cwd() + '/scripts/maintenance/gridfs-recover.cjs');

function digest(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

describe('GridFS operator recovery: deterministic post-crash state and chunk safety', () => {
    const bootstrap = createMemoryServerBootstrap();
    let raw: MongoClient;
    let uri: string;
    let counter = 0;

    before(async () => {
        uri = (await bootstrap.setup()).uri;
        raw = new MongoClient(uri);
        await raw.connect();
    });
    after(async () => {
        await raw.close();
        await bootstrap.teardown();
        MonSQLize.Model._clear();
    });

    async function withRuntime(fn: (bucket: any, db: Db) => Promise<void>): Promise<void> {
        const dbName = 'gridfs_recovery_' + (++counter);
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: dbName, config: { uri } });
        await runtime.connect();
        try {
            await fn(runtime.gridfs('b', { chunkSizeBytes: 4 }), raw.db(dbName));
        } finally {
            await runtime.close();
            await raw.db(dbName).dropDatabase();
        }
    }

    async function recover(db: Db, id: ObjectId, overrides: Record<string, unknown> = {}) {
        const doc = await db.collection('b.uploads').findOne({ _id: id });
        assert.ok(doc, 'recovery owner must exist');
        return recoverGridFSOwnership({
            db, bucket: 'b', id,
            expectedStatus: doc.status,
            expectedUpdatedAt: doc.updatedAt.toISOString(),
            expectedToken: doc.recovery?.token || doc.ownerToken || doc.activeAppend?.token || null,
            operator: 'integration-test', reason: 'deterministic process quiescence simulation',
            quiesced: true, apply: true, ...overrides,
        });
    }

    it('is read-only by default and rejects apply without explicit quiescence', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'direct', status: 'uploading', ownerToken: 'direct-1',
                createdAt: now, updatedAt: now,
            });
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('ABCD') });
            const snapshot = await db.collection('b.uploads').findOne({ _id: id });
            const dry = await recover(db, id, { apply: false, quiesced: false });
            assert.equal(dry.outcome, 'dry_run');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            await assert.rejects(recover(db, id, { quiesced: false }),
                /external writer quiescence/);
            await assert.rejects(recover(db, id, { expectedToken: 'incorrect' }),
                /Owner token changed/);
            await assert.rejects(recover(db, id, { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
                /updatedAt changed/);
            assert.deepEqual(await db.collection('b.uploads').findOne({ _id: id }), snapshot);
            await recover(db, id);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal(await db.collection('b.ownership_recovery_audit').countDocuments({ outcome: 'completed' }), 1);
        });
    });

    it('preserves a pre-verified upload() SHA when the process crashes before owner release', { timeout: 30_000 }, async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const data = Buffer.from('GOODGOOD');
            const hash = digest(data);
            const original = Collection.prototype.deleteOne;
            let intercepted = false;
            (Collection.prototype as any).deleteOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as Record<string, any>;
                if (!intercepted && this.collectionName === 'b.uploads' &&
                    filter?._id?.equals(id) && typeof filter?.ownerToken === 'string') {
                    intercepted = true;
                    throw new Error('simulated process interruption before owner release');
                }
                return (original as any).apply(this, args);
            };
            try {
                await bucket.upload('committed.bin', data, { id, sha256: hash });
            } finally {
                Collection.prototype.deleteOne = original;
            }
            const owner = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(owner?.uploadMethod, 'upload');
            assert.equal(owner?.sha256Verified, true);
            assert.equal(owner?.expectedSha256, hash);
            assert.equal(owner?.claimedSha256, hash);
            const receipt = await recover(db, id);
            assert.equal(receipt.verification.sha256Policy, 'direct-upload-preverified');
            assert.equal(receipt.verification.sha256Verified, true);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 2);
            assert.deepEqual(await bucket.download(id), data);
        });
    });

    it('completes interrupted delete without exposing replacement chunks', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            await bucket.upload('old.bin', Buffer.from('ABCD'), { id });
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'delete', status: 'deleting', ownerToken: 'delete-1',
                createdAt: now, updatedAt: now,
            });
            await db.collection('b.files').deleteOne({ _id: id }); // failure after files deletion
            await recover(db, id);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            await bucket.upload('replacement.bin', Buffer.from('NEW!'), { id });
            assert.deepEqual(await bucket.download(id), Buffer.from('NEW!'));
        });
    });

    it('restores stale activeAppend with a reconciled contiguous nextChunk and expiry', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('AAAABBBB');
            const id = (await bucket.beginResumableUpload('append.bin',
                { length: body.length, sha256: digest(body) })).uploadId;
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('AAAA') });
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { activeAppend: { token: 'append-crash', startedAt: new Date() }, updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            await recover(db, id);
            const session = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(session?.status, 'pending');
            assert.equal(session?.nextChunk, 1);
            assert.equal(session?.activeAppend, undefined);
            assert.ok(session?.expiresAt instanceof Date);
            await bucket.appendChunks(id, 1, Buffer.from('BBBB'));
            await bucket.finalizeResumableUpload(id);
            assert.deepEqual(await bucket.download(id), body);
        });
    });

    it('keeps interrupted append fenced when an existing chunk is malformed', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('AAAABBBB');
            const id = (await bucket.beginResumableUpload('corrupt-append.bin',
                { length: body.length, sha256: digest(body) })).uploadId;
            await db.collection('b.chunks').insertOne({
                files_id: id, n: 0, data: Buffer.from('A'),
            });
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { activeAppend: { token: 'corrupt-append', startedAt: new Date() },
                    updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            await assert.rejects(recover(db, id), /malformed chunk/);
            const owner = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(owner?.status, 'recovering');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            assert.equal((await db.collection('b.chunks').findOne({ files_id: id }))?.n, 0);
        });
    });

    it('recovers pre-commit finalizing without deleting verified chunks', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('AAAABBBB');
            const id = (await bucket.beginResumableUpload('finalize.bin',
                { length: body.length, sha256: digest(body) })).uploadId;
            await bucket.appendChunks(id, 0, body);
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { status: 'finalizing', updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            await recover(db, id);
            const doc = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(doc?.status, 'pending');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 2);
            await bucket.finalizeResumableUpload(id);
            assert.deepEqual(await bucket.download(id), body);
        });
    });

    it('recovers post-commit finalizing only after rehash of actual visible bytes', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('GOOD');
            const hash = digest(body);
            const id = (await bucket.beginResumableUpload('done.bin',
                { length: body.length, sha256: hash })).uploadId;
            await bucket.appendChunks(id, 0, body);
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { status: 'finalizing', updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            await db.collection('b.files').insertOne({
                _id: id, filename: 'done.bin', length: 4, chunkSize: 4,
                uploadDate: new Date(), metadata: { sha256: hash },
            });
            await recover(db, id);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            assert.deepEqual(await bucket.download(id), body);
        });
    });

    it('fails closed on forged metadata SHA and leaves chunks/ownership untouched', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('GOOD');
            const id = (await bucket.beginResumableUpload('wrong.bin',
                { length: body.length, sha256: digest(body) })).uploadId;
            await bucket.appendChunks(id, 0, Buffer.from('EVIL'));
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { status: 'finalizing', updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            await db.collection('b.files').insertOne({
                _id: id, filename: 'wrong.bin', length: 4, chunkSize: 4,
                uploadDate: new Date(), metadata: { sha256: digest(body) },
            });
            await assert.rejects(recover(db, id), /visible bytes mismatch/);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            const owner = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(owner?.status, 'recovering', 'failed recovery remains fenced');
            assert.ok(owner?.recovery?.token);
            assert.equal(await db.collection('b.ownership_recovery_audit').countDocuments({ outcome: 'blocked' }), 1);
        });
    });

    it('completes aborting and is idempotent when the prior owner is gone', async () => {
        await withRuntime(async (bucket, db) => {
            const body = Buffer.from('GOOD');
            const id = (await bucket.beginResumableUpload('aborting.bin',
                { length: body.length, sha256: digest(body) })).uploadId;
            await bucket.appendChunks(id, 0, body);
            await db.collection('b.uploads').updateOne({ _id: id }, {
                $set: { status: 'aborting', updatedAt: new Date() },
                $unset: { expiresAt: '' },
            });
            const receipt = await recover(db, id);
            assert.equal(receipt.outcome, 'completed');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal((await recoverGridFSOwnership({
                db, bucket: 'b', id, expectedStatus: 'aborting',
                expectedUpdatedAt: new Date().toISOString(),
            })).outcome, 'no_owner');
            await bucket.beginResumableUpload('new.bin', { id, length: 4, sha256: digest(body) });
        });
    });

    it('recovers interrupted initialization after quiescence without deleting a visible file', async () => {
        await withRuntime(async (bucket, db) => {
            const payload = Buffer.from('GOOD');
            const uploads = db.collection('b.uploads');
            const chunks = db.collection('b.chunks');
            for (const visible of [false, true]) {
                const id = new ObjectId();
                if (visible) await bucket.upload('visible.bin', payload, { id });
                else await chunks.insertOne({ files_id: id, n: 0, data: payload });
                await uploads.insertOne({ _id: id, kind: 'resumable', status: 'initializing',
                    updatedAt: new Date(), ownerToken: 'initialization-token' });

                await assert.rejects(recover(db, id, { quiesced: false }), /requires external writer quiescence/);
                const receipt = await recover(db, id);
                assert.equal(receipt.outcome, 'completed');
                assert.equal(await uploads.findOne({ _id: id }), null);
                assert.equal(await chunks.countDocuments({ files_id: id }), visible ? 1 : 0);
                if (visible) assert.deepEqual(await bucket.download(id), payload);
                else await bucket.beginResumableUpload('retry.bin', { id, length: 4, sha256: digest(payload) });
            }
        });
    });

    it('can resume a recovery crash using the persistent recovery token', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'cleanup', status: 'recovering',
                ownerToken: 'old-claim', createdAt: now, updatedAt: now,
                recovery: { token: 'recovery-claim', fromStatus: 'cleaning', operator: 'original' },
            });
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('ABCD') });
            await recover(db, id, { resumeQuiesced: true });
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
        });
    });

    it('rejects corrupt recovery origin metadata rather than unlocking the ID', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'delete', status: 'recovering', ownerToken: 'old',
                createdAt: now, updatedAt: now,
                recovery: { token: 'recovery-token', fromStatus: 'uploading' },
            });
            await db.collection('b.chunks').insertOne({
                files_id: id, n: 0, data: Buffer.from('GOOD'),
            });
            await assert.rejects(recover(db, id), /Inconsistent or unsupported owner origin/);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 1);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
        });
    });

    it('rejects an unknown recovery origin before changing ownership or chunks', async () => {
        await withRuntime(async (bucket, db) => {
            const payload = Buffer.from('GOOD');
            const { uploadId: id } = await bucket.beginResumableUpload('interrupted.bin', {
                length: payload.length, sha256: digest(payload),
            });
            await bucket.appendChunks(id, 0, payload);
            const uploads = db.collection('b.uploads');
            await uploads.updateOne({ _id: id }, {
                $set: {
                    status: 'recovering', updatedAt: new Date(),
                    recovery: { token: 'recovery-token', fromStatus: 'unknown' },
                },
                $unset: { expiresAt: '' },
            });
            const owner = await uploads.findOne({ _id: id });
            const chunks = db.collection('b.chunks');
            const originalChunks = await chunks.find({ files_id: id }).toArray();

            await assert.rejects(recover(db, id, { resumeQuiesced: true }), {
                code: 'GRIDFS_RECOVERY_PRECONDITION_FAILED',
            });
            assert.deepEqual(await uploads.findOne({ _id: id }), owner);
            assert.deepEqual(await chunks.find({ files_id: id }).toArray(), originalChunks);
            assert.equal(await db.collection('b.ownership_recovery_audit').countDocuments({ fileId: id }), 0);
        });
    });

    it('refuses to clear aborting ownership if a visible file already owns the chunks', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            await bucket.upload('visible.bin', Buffer.from('GOOD'), { id });
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'resumable', status: 'aborting',
                filename: 'bad.bin', length: 4, chunkSizeBytes: 4, sha256: digest(Buffer.from('GOOD')),
                createdAt: now, updatedAt: now,
            });
            await assert.rejects(recover(db, id), /Visible file conflicts/);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 1);
        });
    });

    it('requires proof the previous recovery process stopped before resuming', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'cleanup', status: 'recovering',
                ownerToken: 'original', createdAt: now, updatedAt: now,
                recovery: { token: 'old-recovery', fromStatus: 'cleaning' },
            });
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('GOOD') });
            await assert.rejects(recover(db, id), /verified shutdown of the prior recovery executor/);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 1);
        });
    });

    it('atomically rejects two recovery resumptions holding the same snapshot', { timeout: 30_000 }, async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'cleanup', status: 'recovering',
                ownerToken: 'original', createdAt: now, updatedAt: now,
                recovery: { token: 'old-recovery', fromStatus: 'cleaning' },
            });
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('GOOD') });
            const original = Collection.prototype.updateOne;
            let ready!: () => void;
            const bothReached = new Promise<void>((resolve) => { ready = resolve; });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let claims = 0;
            (Collection.prototype as any).updateOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as Record<string, unknown>;
                if (this.collectionName === 'b.uploads' && filter.status === 'recovering'
                    && filter['recovery.token'] === 'old-recovery') {
                    claims += 1;
                    if (claims === 2) ready();
                    await gate;
                }
                return (original as any).apply(this, args);
            };
            try {
                const input = {
                    db, bucket: 'b', id,
                    expectedStatus: 'recovering', expectedUpdatedAt: now.toISOString(),
                    expectedToken: 'old-recovery', quiesced: true, resumeQuiesced: true,
                    operator: 'integration-test', reason: 'verified prior executor stop',
                    apply: true,
                };
                const first = recoverGridFSOwnership(input);
                const second = recoverGridFSOwnership(input);
                await bothReached;
                release();
                const outcomes = await Promise.allSettled([first, second]);
                assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
                assert.equal(outcomes.filter((x) => x.status === 'rejected').length, 1);
                assert.equal(await db.collection('b.ownership_recovery_audit').countDocuments({ outcome: 'completed' }), 1);
                assert.equal(await db.collection('b.ownership_recovery_audit').countDocuments({ outcome: 'claim_conflict' }), 1);
                assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
                const payload = Buffer.from('NEW!');
                await bucket.upload('replacement.bin', payload, { id });
                assert.deepEqual(await bucket.download(id), payload);
            } finally {
                release();
                Collection.prototype.updateOne = original;
            }
        });
    });


    it('keeps a trusted upload SHA strict when recovering a visible direct file', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const actual = Buffer.from('EVIL');
            const expectedSha256 = digest(Buffer.from('GOOD'));
            await bucket.upload('direct.bin', actual, { id });
            await db.collection('b.files').updateOne({ _id: id }, {
                $set: { 'metadata.sha256': expectedSha256 },
            });
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'direct', status: 'uploading', ownerToken: 'crash',
                uploadMethod: 'upload', sha256Verified: true,
                expectedSha256, claimedSha256: expectedSha256,
                createdAt: now, updatedAt: now,
            });
            await assert.rejects(recover(db, id), /Verified direct upload SHA provenance/);
            assert.equal((await db.collection('b.uploads').findOne({ _id: id }))?.status, 'recovering');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            assert.deepEqual(await bucket.download(id), actual);
        });
    });

    it('recovers a complete uploadStream with mismatching metadata-only SHA and audits a warning', { timeout: 30_000 }, async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const actual = Buffer.from('EVIL');
            const claimedSha256 = digest(Buffer.from('GOOD'));
            const original = Collection.prototype.deleteOne;
            let intercepted = false;
            (Collection.prototype as any).deleteOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as Record<string, any>;
                if (!intercepted && this.collectionName === 'b.uploads' &&
                    filter?._id?.equals(id) && typeof filter?.ownerToken === 'string') {
                    intercepted = true;
                    throw new Error('simulated process interruption before direct owner release');
                }
                return (original as any).apply(this, args);
            };
            try {
                const writable = bucket.uploadStream('stream.bin', { id, sha256: claimedSha256 });
                writable.end(actual);
                const uploaded = await writable.done;
                assert.equal(String(uploaded.id), String(id));
            } finally {
                Collection.prototype.deleteOne = original;
            }
            const stranded = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(stranded?.uploadMethod, 'uploadStream');
            assert.equal(stranded?.sha256Verified, false);
            assert.equal(stranded?.claimedSha256, claimedSha256);

            const receipt = await recover(db, id);
            assert.equal(receipt.outcome, 'completed');
            assert.equal(receipt.verification.sha256Policy, 'uploadStream-metadata-only');
            assert.equal(receipt.verification.sha256Verified, false);
            assert.equal(receipt.verification.actualSha256, digest(actual));
            assert.equal(receipt.verification.claimedSha256, claimedSha256);
            assert.deepEqual(receipt.verification.warnings, ['metadata_sha256_mismatch_unverified']);
            assert.deepEqual(await bucket.download(id), actual);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            const audit = await db.collection('b.ownership_recovery_audit').findOne({ fileId: id, outcome: 'completed' });
            assert.equal(audit?.verification?.sha256Policy, 'uploadStream-metadata-only');
            assert.deepEqual(audit?.verification?.warnings, ['metadata_sha256_mismatch_unverified']);
        });
    });

    it('rejects upload() SHA mismatch before creating files, chunks or an ownership record', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const actual = Buffer.from('EVIL');
            const expectedSha256 = digest(Buffer.from('GOOD'));
            await assert.rejects(bucket.upload('bad.bin', actual, { id, sha256: expectedSha256 }),
                (error: unknown) => (error as { code?: string }).code === 'GRIDFS_INTEGRITY_MISMATCH');
            assert.equal(await db.collection('b.files').countDocuments({ _id: id }), 0);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
        });
    });

    it('releases a quiesced rename only after checking a visible complete file', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const payload = Buffer.from('GOODGOOD');
            await bucket.upload('already-renamed.bin', payload, { id });
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'rename', status: 'renaming', ownerToken: 'rename-crash',
                createdAt: now, updatedAt: now,
            });
            await recover(db, id);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            assert.deepEqual(await bucket.download(id), payload);
        });
    });

    it('keeps a missing-file rename fenced pending manual inspection', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'rename', status: 'renaming', ownerToken: 'rename-crash',
                createdAt: now, updatedAt: now,
            });
            await assert.rejects(recover(db, id), /no visible file/);
            assert.equal((await db.collection('b.uploads').findOne({ _id: id }))?.status, 'recovering');
        });
    });


    it('does not let a stale original writer release an active recovery claim', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'direct', status: 'recovering',
                ownerToken: 'original-writer', createdAt: now, updatedAt: now,
                recovery: { token: 'active-recovery', fromStatus: 'uploading' },
            });
            const ctx = { db, bucketName: 'b' } as any;
            await assert.rejects(
                releaseOwner(ctx, { id, kind: 'direct', token: 'original-writer' }, 'upload'),
                (error: unknown) => (error as { code?: string }).code === 'GRIDFS_UPLOAD_BUSY',
            );
            const owner = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(owner?.status, 'recovering');
            assert.equal(owner?.recovery?.token, 'active-recovery');
        });
    });

    it('treats upload() metadata.sha256 without options.sha256 as an unverified claim', { timeout: 30_000 }, async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const actual = Buffer.from('EVIL');
            const claimedSha256 = digest(Buffer.from('GOOD'));
            const original = Collection.prototype.deleteOne;
            let intercepted = false;
            (Collection.prototype as any).deleteOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as Record<string, any>;
                if (!intercepted && this.collectionName === 'b.uploads' &&
                    filter?._id?.equals(id) && typeof filter?.ownerToken === 'string') {
                    intercepted = true;
                    throw new Error('simulated process interruption before owner release');
                }
                return (original as any).apply(this, args);
            };
            try {
                await bucket.upload('metadata.bin', actual, { id, metadata: { sha256: claimedSha256 } });
            } finally {
                Collection.prototype.deleteOne = original;
            }
            const owner = await db.collection('b.uploads').findOne({ _id: id });
            assert.equal(owner?.uploadMethod, 'upload');
            assert.equal(owner?.sha256Verified, false);
            assert.equal(owner?.claimedSha256, claimedSha256);
            const receipt = await recover(db, id);
            assert.equal(receipt.verification.sha256Policy, 'unverified-metadata');
            assert.equal(receipt.verification.sha256Verified, false);
            assert.deepEqual(receipt.verification.warnings, ['metadata_sha256_mismatch_unverified']);
            assert.deepEqual(await bucket.download(id), actual);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
        });
    });


    it('fails closed when visibility changes after the recovery claim', async () => {
        await withRuntime(async (_, db) => {
            const id = new ObjectId();
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'direct', status: 'uploading', ownerToken: 'direct-race',
                createdAt: now, updatedAt: now,
            });
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('ABCD') });
            const original = Collection.prototype.updateOne;
            (Collection.prototype as any).updateOne = async function (this: Collection, ...args: unknown[]) {
                const result = await (original as any).apply(this, args);
                const update = args[1] as { $set?: { status?: string } };
                if (this.collectionName === 'b.uploads' && update?.$set?.status === 'recovering') {
                    await db.collection('b.files').insertOne({
                        _id: id, filename: 'appeared.bin', length: 4, chunkSize: 4, uploadDate: new Date(),
                    });
                }
                return result;
            };
            try {
                await assert.rejects(recover(db, id), /visibility changed after recovery claim/);
                assert.equal((await db.collection('b.uploads').findOne({ _id: id }))?.status, 'recovering');
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
                assert.ok(await db.collection('b.files').findOne({ _id: id }));
            } finally {
                Collection.prototype.updateOne = original;
            }
        });
    });

    it('fails closed when a required visible file cannot be verified after the claim', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const payload = Buffer.from('ABCD');
            await bucket.upload('final.bin', payload, { id, sha256: digest(payload) });
            // upload already released; implant a leftover finalizing session on the visible id
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'resumable', status: 'finalizing', filename: 'final.bin',
                length: 4, sha256: digest(payload), chunkSizeBytes: 4,
                createdAt: now, updatedAt: now,
            });
            const original = Collection.prototype.findOne;
            let verifiedLookups = 0;
            (Collection.prototype as any).findOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as { _id?: ObjectId };
                const options = args[1] as { projection?: { _id?: number } } | undefined;
                if (this.collectionName === 'b.files' && filter?._id?.equals?.(id) && !options?.projection) {
                    verifiedLookups += 1;
                    return null;
                }
                return (original as any).apply(this, args);
            };
            try {
                await assert.rejects(recover(db, id), /could not be verified after claim/);
                assert.equal(verifiedLookups, 1);
                assert.equal((await db.collection('b.uploads').findOne({ _id: id }))?.status, 'recovering');
                assert.ok(await db.collection('b.chunks').countDocuments({ files_id: id }) >= 1);
            } finally {
                Collection.prototype.findOne = original;
            }
            assert.ok(await db.collection('b.files').findOne({ _id: id }));
        });
    });
});
