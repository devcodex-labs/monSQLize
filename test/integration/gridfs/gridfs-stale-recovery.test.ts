import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

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

    it('preserves committed direct upload bytes while releasing a stranded owner', async () => {
        await withRuntime(async (bucket, db) => {
            const id = new ObjectId();
            const data = Buffer.from('GOODGOOD');
            await bucket.upload('committed.bin', data, { id, sha256: digest(data) });
            const now = new Date();
            await db.collection('b.uploads').insertOne({
                _id: id, kind: 'direct', status: 'uploading', ownerToken: 'post-commit',
                createdAt: now, updatedAt: now,
            });
            await recover(db, id);
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
            await recover(db, id);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
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
});
