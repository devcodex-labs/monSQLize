import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function delayed(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function gate(): { wait: Promise<void>; open: () => void } {
    let open = (): void => {};
    const wait = new Promise<void>((resolve) => { open = resolve; });
    return { wait, open };
}

describe('GridFS remaining-issue regressions (begin race, finalize rollback, streaming append)', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let raw: MongoClient;

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

    async function withRuntime(databaseName: string, fn: (runtime: any, db: Db) => Promise<void>): Promise<void> {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName, config: { uri } });
        await runtime.connect();
        try {
            await fn(runtime, raw.db(databaseName));
        } finally {
            await runtime.close();
            await raw.db(databaseName).dropDatabase();
        }
    }

    it('beginResumableUpload does not delete chunks of a file that became visible after precheck', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_begin_precheck_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const payload = Buffer.from('ABCD');
            const original = Collection.prototype.insertOne;
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const document = args[0] as Record<string, unknown>;
                if (this.collectionName === 'b.uploads' && document.kind === 'resumable' && (document._id as ObjectId).equals(id)) {
                    await original.call(db.collection('b.files'), {
                        _id: id,
                        filename: 'visible.bin',
                        length: 4,
                        chunkSize: 4,
                        uploadDate: new Date(),
                        metadata: { sha256: sha(payload) },
                    });
                    await original.call(db.collection('b.chunks'), { files_id: id, n: 0, data: payload });
                }
                return (original as any).apply(this, args);
            };
            try {
                await assert.rejects(
                    bucket.beginResumableUpload('raced.bin', { id, length: 4, sha256: sha(payload) }),
                    (error: unknown) => (error as { code?: string }).code === 'GRIDFS_FILE_EXISTS',
                );
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
                assert.deepEqual(await bucket.download(id), payload);
                assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            } finally {
                Collection.prototype.insertOne = original;
            }
        });
    });

    it('excludes writes and reuse of an explicit ID until begin cleanup completes', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_initializing', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const payload = Buffer.from('GOOD');
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('OLD!') });
            const entered = gate();
            const proceed = gate();
            const original = Collection.prototype.deleteMany;
            let paused = false;
            Collection.prototype.deleteMany = async function (this: Collection, filter, options) {
                if (!paused && this.collectionName === 'b.chunks' && id.equals(filter?.files_id)) {
                    paused = true;
                    entered.open();
                    await proceed.wait;
                }
                return original.call(this, filter, options);
            };
            const starting = bucket.beginResumableUpload('starting.bin', { id, length: 4, sha256: sha(payload) });
            try {
                await entered.wait;
                const busy = { code: 'GRIDFS_UPLOAD_BUSY' };
                await assert.rejects(bucket.appendChunks(id, 0, payload), busy);
                await assert.rejects(bucket.finalizeResumableUpload(id), busy);
                await assert.rejects(bucket.abortResumableUpload(id), busy);
                await assert.rejects(bucket.upload('replacement.bin', payload, { id }), busy);
                const owner = await db.collection('b.uploads').findOne({ _id: id });
                assert.equal(owner?.status, 'initializing');
                assert.equal(owner?.expiresAt, undefined);
            } finally {
                proceed.open();
                Collection.prototype.deleteMany = original;
                await starting;
            }
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);
            await bucket.appendChunks(id, 0, payload);
            await bucket.finalizeResumableUpload(id);
            assert.deepEqual(await bucket.download(id), payload);
        });
    });

    it('finalize FILE_EXISTS rolls back to pending so public abort works and visible chunks stay', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_finalize_rollback', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const session = await bucket.beginResumableUpload('conflict.bin', {
                length: 4, sha256: sha(payload),
            });
            await bucket.appendChunks(session.uploadId, 0, payload);
            await db.collection('b.files').insertOne({
                _id: session.uploadId,
                filename: 'other.bin',
                length: 4,
                chunkSize: 4,
                uploadDate: new Date(),
                metadata: { sha256: 'a'.repeat(64) },
            });
            await assert.rejects(
                bucket.finalizeResumableUpload(session.uploadId),
                (error: unknown) => (error as { code?: string }).code === 'GRIDFS_FILE_EXISTS',
            );
            assert.equal((await db.collection('b.uploads').findOne({ _id: session.uploadId }))?.status, 'pending');
            await bucket.abortResumableUpload(session.uploadId);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: session.uploadId }), 0);
            assert.ok(await db.collection('b.files').findOne({ _id: session.uploadId }));
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 1);
        });
    });

    it('retains the finalizing session when the visible file declares a different chunk size', async () => {
        await withRuntime('gridfs_finalize_wrong_size', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('aaaabbbbcccc');
            const { uploadId } = await bucket.beginResumableUpload('retry.bin', { length: 12, sha256: sha(payload) });
            await bucket.appendChunks(uploadId, 0, payload);
            const uploads = db.collection('b.uploads');
            const files = db.collection('b.files');
            await uploads.updateOne({ _id: uploadId }, { $set: { status: 'finalizing' }, $unset: { expiresAt: '' } });
            await files.insertOne({
                _id: uploadId, filename: 'retry.bin', length: 12, chunkSize: 8,
                uploadDate: new Date(), metadata: { sha256: sha(payload) },
            });
            const owner = await uploads.findOne({ _id: uploadId });
            await assert.rejects(bucket.finalizeResumableUpload(uploadId), { code: 'GRIDFS_INTEGRITY_MISMATCH' });
            assert.deepEqual(await uploads.findOne({ _id: uploadId }), owner);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: uploadId }), 3);

            await files.updateOne({ _id: uploadId }, { $set: { chunkSize: 4 } });
            assert.equal((await bucket.finalizeResumableUpload(uploadId)).chunkSize, 4);
            assert.deepEqual(await bucket.download(uploadId), payload);
        });
    });

    it('returns the file committed by this finalize after a concurrent deletion and ID reuse', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_finalize_result_reuse', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const firstBytes = Buffer.from('OLD!');
            const replacementBytes = Buffer.from('NEW!NEW!');
            await bucket.beginResumableUpload('first.bin', {
                id, length: firstBytes.length, sha256: sha(firstBytes),
                contentType: 'application/octet-stream', metadata: { label: 'first' },
            });
            await bucket.appendChunks(id, 0, firstBytes);

            const released = gate();
            const returnFirst = gate();
            const original = Collection.prototype.deleteOne;
            let pauseFirst = true;
            Collection.prototype.deleteOne = async function (this: Collection, filter, options) {
                const result = await original.call(this, filter, options);
                if (pauseFirst && this.collectionName === 'b.uploads' && filter?.status === 'finalizing' && id.equals(filter._id)) {
                    pauseFirst = false;
                    released.open();
                    await returnFirst.wait;
                }
                return result;
            };
            const first = bucket.finalizeResumableUpload(id);
            try {
                await released.wait;
                const committed = await bucket.getFile(id);
                assert.equal(committed?.filename, 'first.bin');
                assert.equal(committed?.length, firstBytes.length);
                assert.equal(committed?.metadata?.sha256, sha(firstBytes));
                assert.equal(committed?.contentType, 'application/octet-stream');

                await bucket.delete(id);
                await bucket.beginResumableUpload('replacement.bin', {
                    id, length: replacementBytes.length, sha256: sha(replacementBytes),
                    chunkSizeBytes: 8, metadata: { label: 'replacement' },
                });
                await bucket.appendChunks(id, 0, replacementBytes);
                const replacement = await bucket.finalizeResumableUpload(id);

                returnFirst.open();
                assert.deepEqual(await first, committed);
                assert.deepEqual(await bucket.getFile(id), replacement);
                assert.deepEqual(await bucket.download(id), replacementBytes);
                assert.equal(await db.collection('b.uploads').findOne({ _id: id }), null);
            } finally {
                returnFirst.open();
                Collection.prototype.deleteOne = original;
                await Promise.allSettled([first]);
            }
        });
    });

    it('rejects a stale finalize retry that sees a replacement with the same bytes', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_finalize_stale_retry', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const payload = Buffer.from('SAME');
            const opts = { id, length: payload.length, sha256: sha(payload) };
            await bucket.beginResumableUpload('first.bin', opts);
            await bucket.appendChunks(id, 0, payload);

            const inserted = gate();
            const reading = gate();
            const releaseFirst = gate();
            const resumeRetry = gate();
            const originalDelete = Collection.prototype.deleteOne;
            const originalFind = Collection.prototype.findOne;
            let pauseRelease = true;
            let pauseRead = false;
            Collection.prototype.deleteOne = async function (this: Collection, filter, options) {
                if (pauseRelease && this.collectionName === 'b.uploads' && filter?.status === 'finalizing') {
                    pauseRelease = false;
                    inserted.open();
                    await releaseFirst.wait;
                }
                return originalDelete.call(this, filter, options);
            };
            Collection.prototype.findOne = async function (this: Collection, ...args: unknown[]) {
                if (this.collectionName === 'b.files' && pauseRead) {
                    pauseRead = false;
                    reading.open();
                    await resumeRetry.wait;
                }
                return Reflect.apply(originalFind, this, args);
            } as typeof originalFind;

            const first = bucket.finalizeResumableUpload(id);
            const pending = [first];
            try {
                await inserted.wait;
                pauseRead = true;
                const retry = assert.rejects(bucket.finalizeResumableUpload(id), { code: 'GRIDFS_UPLOAD_BUSY' });
                pending.push(retry);
                await reading.wait;
                releaseFirst.open();
                await first;
                await bucket.delete(id);
                await bucket.beginResumableUpload('replacement.bin', { ...opts, metadata: { label: 'replacement' } });
                await bucket.appendChunks(id, 0, payload);
                await bucket.finalizeResumableUpload(id);
                resumeRetry.open();
                await retry;
                assert.equal((await bucket.getFile(id))?.filename, 'replacement.bin');
                assert.deepEqual(await bucket.download(id), payload);
                assert.equal(await db.collection('b.uploads').findOne({ _id: id }), null);
            } finally {
                releaseFirst.open();
                resumeRetry.open();
                Collection.prototype.findOne = originalFind;
                Collection.prototype.deleteOne = originalDelete;
                await Promise.allSettled(pending);
            }
        });
    });

    for (const operation of ['finalizeResumableUpload', 'abortResumableUpload'] as const) {
        for (const legacy of [false, true]) {
            it(`${operation} does not take over a replacement pending session after reading a ${legacy ? 'legacy' : 'tokenized'} session`, { timeout: 10_000 }, async () => {
                await withRuntime('gridfs_pending_session_reuse', async (runtime, db) => {
                    const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
                    const id = new ObjectId();
                    const payload = Buffer.from('DATA');
                    const options = { id, length: payload.length, sha256: sha(payload) };
                    await bucket.beginResumableUpload('old.bin', options);
                    await bucket.appendChunks(id, 0, payload);
                    const uploads = db.collection('b.uploads');
                    if (legacy) await uploads.updateOne({ _id: id }, { $unset: { sessionToken: '' } });
                    const oldSession = await uploads.findOne({ _id: id });
                    assert.ok(oldSession?.createdAt instanceof Date);

                    const claiming = gate();
                    const resume = gate();
                    const original = Collection.prototype.updateOne;
                    const status = operation === 'finalizeResumableUpload' ? 'finalizing' : 'aborting';
                    let pause = true;
                    Collection.prototype.updateOne = async function (this: Collection, filter, update, opts) {
                        if (pause && this.collectionName === 'b.uploads' && id.equals(filter?._id) &&
                            !Array.isArray(update) && update.$set?.status === status) {
                            pause = false;
                            claiming.open();
                            await resume.wait;
                        }
                        return original.call(this, filter, update, opts);
                    };

                    const stale = bucket[operation](id);
                    try {
                        await claiming.wait;
                        await bucket.abortResumableUpload(id);
                        await bucket.beginResumableUpload('new.bin', options);
                        await bucket.appendChunks(id, 0, payload);
                        await uploads.updateOne({ _id: id }, { $set: { createdAt: oldSession.createdAt } });
                        const replacement = await uploads.findOne({ _id: id });
                        assert.equal(replacement?.status, 'pending');

                        resume.open();
                        await assert.rejects(stale, { code: 'GRIDFS_UPLOAD_BUSY' });
                        assert.deepEqual(await uploads.findOne({ _id: id }), replacement);
                        assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
                        assert.equal(await bucket.getFile(id), null);
                        assert.equal((await bucket.finalizeResumableUpload(id)).filename, 'new.bin');
                        assert.deepEqual(await bucket.download(id), payload);
                    } finally {
                        resume.open();
                        Collection.prototype.updateOne = original;
                        await Promise.allSettled([stale]);
                    }
                });
            });
        }
    }

    it('bounds missing-chunk diagnostics and counts the complete gap', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_finalize_gap_bound', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 1 });
            const length = 10_000_000_000;
            const { uploadId } = await bucket.beginResumableUpload('large.bin', {
                length, sha256: sha(Buffer.from('unused')),
            });
            await db.collection('b.chunks').insertMany([
                { files_id: uploadId, n: 0, data: Buffer.from('A') },
                { files_id: uploadId, n: length - 2, data: Buffer.from('B') },
            ]);
            await assert.rejects(bucket.finalizeResumableUpload(uploadId), (error: unknown) => {
                const incomplete = error as { code: string; details: { missingChunks: number[]; missingChunkCount: number }[] };
                assert.equal(incomplete.code, 'GRIDFS_UPLOAD_INCOMPLETE');
                assert.equal(incomplete.details[0].missingChunkCount, length - 2);
                assert.deepEqual(incomplete.details[0].missingChunks, Array.from({ length: 1024 }, (_, index) => index + 1));
                return true;
            });
            assert.equal((await db.collection('b.uploads').findOne({ _id: uploadId }))?.status, 'pending');
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: uploadId }), 2);
            assert.equal(await db.collection('b.files').countDocuments({ _id: uploadId }), 0);
        });
    });

    it('uses primary reads for visibility checks before orphan cleanup', async () => {
        await withRuntime('gridfs_primary_cleanup', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('LIVE');
            const { id } = await bucket.upload('visible.bin', payload);
            const original = Collection.prototype.findOne;
            Collection.prototype.findOne = async function (this: Collection, ...args: unknown[]) {
                const options = args[1] as { readPreference?: string } | undefined;
                // Model a secondary that has not yet observed the file commit.
                if (this.collectionName === 'b.files' && options?.readPreference !== 'primary') return null;
                return Reflect.apply(original, this, args);
            } as typeof original;
            try {
                await bucket.abortResumableUpload(id);
                await assert.rejects(bucket.beginResumableUpload('duplicate.bin', {
                    id, length: payload.length, sha256: sha(payload),
                }), { code: 'GRIDFS_FILE_EXISTS' });
            } finally {
                Collection.prototype.findOne = original;
            }
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            assert.deepEqual(await bucket.download(id), payload);
        });
    });

    it('keeps the new finalize owner when an older retry completes after ID reuse', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_finalize_owner_reuse', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const oldBytes = Buffer.from('OLD!');
            const newBytes = Buffer.from('NEW!');
            const firstCleanup = gate();
            const retryCleanup = gate();
            const newInsert = gate();
            const finishFirst = gate();
            const finishRetry = gate();
            const finishNew = gate();
            const originalDelete = Collection.prototype.deleteOne;
            const originalInsert = Collection.prototype.insertOne;
            await bucket.beginResumableUpload('old.bin', { id, length: 4, sha256: sha(oldBytes) });
            await bucket.appendChunks(id, 0, oldBytes);
            let cleanups = 0;
            Collection.prototype.deleteOne = async function (this: Collection, filter, options) {
                if (this.collectionName === 'b.uploads' && filter?.status === 'finalizing' && id.equals(filter._id)) {
                    cleanups += 1;
                    if (cleanups === 1) {
                        firstCleanup.open();
                        await finishFirst.wait;
                    } else if (cleanups === 2) {
                        retryCleanup.open();
                        await finishRetry.wait;
                    }
                }
                return originalDelete.call(this, filter, options);
            };
            Collection.prototype.insertOne = async function (this: Collection, doc, options) {
                if (this.collectionName === 'b.files' && doc.filename === 'new.bin') {
                    newInsert.open();
                    await finishNew.wait;
                }
                return originalInsert.call(this, doc, options);
            };
            const pending = [];
            try {
                const first = bucket.finalizeResumableUpload(id);
                pending.push(first);
                await firstCleanup.wait;
                const oldRetry = assert.rejects(bucket.finalizeResumableUpload(id), { code: 'GRIDFS_UPLOAD_BUSY' });
                pending.push(oldRetry);
                await retryCleanup.wait;
                finishFirst.open();
                await first;
                await bucket.delete(id);
                await bucket.beginResumableUpload('new.bin', { id, length: 4, sha256: sha(newBytes) });
                await bucket.appendChunks(id, 0, newBytes);
                const current = bucket.finalizeResumableUpload(id);
                pending.push(current);
                await newInsert.wait;
                const uploads = db.collection('b.uploads');
                const owner = await uploads.findOne({ _id: id });
                assert.equal(owner?.status, 'finalizing');

                finishRetry.open();
                await oldRetry;
                assert.deepEqual(await uploads.findOne({ _id: id }), owner);
                await assert.rejects(bucket.abortResumableUpload(id), { code: 'GRIDFS_UPLOAD_BUSY' });

                finishNew.open();
                assert.equal((await current).filename, 'new.bin');
                assert.deepEqual(await bucket.download(id), newBytes);
                assert.equal(await uploads.findOne({ _id: id }), null);
            } finally {
                finishFirst.open();
                finishRetry.open();
                finishNew.open();
                Collection.prototype.deleteOne = originalDelete;
                Collection.prototype.insertOne = originalInsert;
                await Promise.allSettled(pending);
            }
        });
    });

    it('rejects malformed or extra chunk indexes even when the expected bytes are present', async () => {
        await withRuntime('gridfs_finalize_invalid_index', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            for (const n of [-1, 'invalid', 0.5, 1, Number.MAX_SAFE_INTEGER + 1]) {
                const { uploadId } = await bucket.beginResumableUpload(`bad-index-${n}.bin`, {
                    length: payload.length, sha256: sha(payload),
                });
                await bucket.appendChunks(uploadId, 0, payload);
                const chunks = db.collection('b.chunks');
                const extra = await chunks.insertOne({ files_id: uploadId, n, data: Buffer.from('BAD!') });

                await assert.rejects(bucket.finalizeResumableUpload(uploadId), {
                    code: 'GRIDFS_INTEGRITY_MISMATCH',
                }, `chunk index ${n}`);
                assert.equal(await db.collection('b.files').findOne({ _id: uploadId }), null);
                assert.equal((await db.collection('b.uploads').findOne({ _id: uploadId }))?.status, 'pending');
                assert.equal(await chunks.countDocuments({ files_id: uploadId }), 2);

                await chunks.deleteOne({ _id: extra.insertedId });
                const info = await bucket.finalizeResumableUpload(uploadId);
                assert.deepEqual(await bucket.download(info.id), payload);
            }
        });
    });

    it('streams a Readable append with ownership, idempotent replay, and recoverable partial failure', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_stream_append', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('aaaabbbbcccc');
            const otherId = new ObjectId();
            await db.collection('b.chunks').insertOne({ files_id: otherId, n: 0, data: Buffer.from('KEEP') });

            const session = await bucket.beginResumableUpload('stream.bin', {
                length: payload.length, sha256: sha(payload),
            });
            const first = await bucket.appendChunks(
                session.uploadId,
                0,
                Readable.from([payload.subarray(0, 4), payload.subarray(4, 8)]),
            );
            assert.equal(first.nextChunk, 2);
            await assert.rejects(
                bucket.appendChunks(session.uploadId, 2, Readable.from([Buffer.from('cc')])),
                (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
            );
            assert.deepEqual(
                (await db.collection('b.chunks').find({ files_id: session.uploadId }).sort({ n: 1 }).toArray()).map((chunk) => chunk.n),
                [0, 1],
            );
            const rest = await bucket.appendChunks(session.uploadId, 2, Readable.from([payload.subarray(8)]));
            assert.equal(rest.nextChunk, 3);
            const replay = await bucket.appendChunks(session.uploadId, 0, Readable.from([payload]));
            assert.equal(replay.nextChunk, 3);
            const info = await bucket.finalizeResumableUpload(session.uploadId);
            assert.deepEqual(await bucket.download(info.id), payload);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: otherId }), 1);
        });
    });

    it('releases activeAppend after a mid-write stream close so retry and abort work', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_stream_close', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('aaaabbbb');
            const session = await bucket.beginResumableUpload('close.bin', {
                length: payload.length, sha256: sha(payload),
            });
            let pushed = false;
            const source = new Readable({
                read() {
                    if (pushed) return;
                    pushed = true;
                    this.push(payload.subarray(0, 4));
                },
            });
            const original = Collection.prototype.insertOne;
            let writeStarted: () => void = () => undefined;
            const inFlight = new Promise<void>((resolve) => { writeStarted = resolve; });
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const document = args[0] as Record<string, unknown>;
                const filesId = document.files_id as ObjectId | undefined;
                if (this.collectionName.endsWith('.chunks') && filesId && String(filesId) === String(session.uploadId)) {
                    writeStarted();
                    await delayed(40);
                }
                return (original as any).apply(this, args);
            };
            const appending = bucket.appendChunks(session.uploadId, 0, source);
            try {
                await Promise.race([inFlight, delayed(2000)]);
                source.destroy();
                await Promise.race([
                    assert.rejects(
                        appending,
                        (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
                    ),
                    delayed(5000).then(() => {
                        throw new Error('appendChunks did not reject within 5s after stream.destroy()');
                    }),
                ]);
            } finally {
                Collection.prototype.insertOne = original;
            }
            const owner = await db.collection('b.uploads').findOne({ _id: session.uploadId });
            assert.equal(owner?.status, 'pending');
            assert.equal(owner?.activeAppend, undefined);
            const stored = await db.collection('b.chunks').countDocuments({ files_id: session.uploadId });
            if (stored === 0) {
                const resumed = await bucket.appendChunks(session.uploadId, 0, payload);
                assert.equal(resumed.nextChunk, 2);
            } else {
                await assert.rejects(
                    bucket.appendChunks(session.uploadId, stored + 1, payload.subarray(stored * 4)),
                    (error: unknown) => (error as { code?: string }).code === 'GRIDFS_RESUME_MISMATCH'
                        && (error as { details?: { expectedNextChunk?: number }[] }).details?.[0]?.expectedNextChunk === stored,
                );
                const resumed = await bucket.appendChunks(session.uploadId, stored, payload.subarray(stored * 4));
                assert.equal(resumed.nextChunk, 2);
            }
            await bucket.abortResumableUpload(session.uploadId);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: session.uploadId }), 0);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 0);
        });
    });

    it('handles a source failure while acquiring the append claim', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_append_claim_error', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const { uploadId } = await bucket.beginResumableUpload('claim.bin', { length: 4, sha256: sha(payload) });
            const claiming = gate();
            const proceed = gate();
            const original = Collection.prototype.updateOne;
            Collection.prototype.updateOne = async function (this: Collection, filter, update, options) {
                if (this.collectionName === 'b.uploads' && !Array.isArray(update) && update.$set?.activeAppend) {
                    claiming.open();
                    await proceed.wait;
                }
                return original.call(this, filter, update, options);
            };
            const source = new Readable({ read() {} });
            const error = new Error('source failed before claim');
            const rejected = assert.rejects(bucket.appendChunks(uploadId, 0, source), (actual) => actual === error);
            try {
                await claiming.wait;
                source.destroy(error);
                await new Promise<void>((resolve) => setImmediate(resolve));
            } finally {
                proceed.open();
                Collection.prototype.updateOne = original;
                await rejected;
            }
            assert.equal((await db.collection('b.uploads').findOne({ _id: uploadId }))?.activeAppend, undefined);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: uploadId }), 0);
            assert.equal((await bucket.appendChunks(uploadId, 0, payload)).nextChunk, 1);
        });
    });

    it('rejects an append when automatic destruction fails after EOF', async () => {
        await withRuntime('gridfs_append_eof_error', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const { uploadId } = await bucket.beginResumableUpload('eof.bin', { length: 4, sha256: sha(payload) });
            const destroying = gate();
            const complete = gate();
            const failure = new Error('asynchronous EOF cleanup failed');
            const source = new Readable({
                read() { this.push(payload); this.push(null); },
                destroy(_error, callback) {
                    destroying.open();
                    void complete.wait.then(() => callback(failure));
                },
            });
            const rejected = assert.rejects(bucket.appendChunks(uploadId, 0, source), (error) => error === failure);
            try {
                await destroying.wait;
                await assert.rejects(bucket.abortResumableUpload(uploadId), { code: 'GRIDFS_UPLOAD_BUSY' });
            } finally {
                complete.open();
                await rejected;
            }
            const owner = await db.collection('b.uploads').findOne({ _id: uploadId });
            assert.equal(owner?.nextChunk, 0);
            assert.equal(owner?.activeAppend, undefined);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: uploadId }), 1);
            assert.equal((await bucket.appendChunks(uploadId, 0, payload)).nextChunk, 1);
        });
    });

    it('scans the stored prefix in bounded batches after a large stream append', async () => {
        await withRuntime('gridfs_append_batch_scan', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 1 });
            const payload = Buffer.alloc(600, 7);
            const { uploadId } = await bucket.beginResumableUpload('batched.bin', { length: payload.length, sha256: sha(payload) });
            const original = Collection.prototype.find;
            const batchSizes: number[] = [];
            Collection.prototype.find = function (this: Collection, ...args: unknown[]) {
                const cursor = Reflect.apply(original, this, args);
                const filter = args[0] as { files_id?: ObjectId; n?: { $gte?: number } } | undefined;
                if (this.collectionName === 'b.chunks' && uploadId.equals(filter?.files_id) && filter?.n?.$gte !== undefined) {
                    const batchSize = cursor.batchSize.bind(cursor);
                    cursor.batchSize = (size: number) => { batchSizes.push(size); return batchSize(size); };
                    cursor.toArray = async () => { throw new Error('prefix scan materialized all matching chunk indexes'); };
                }
                return cursor;
            } as typeof original;
            try {
                const result = await bucket.appendChunks(uploadId, 0, Readable.from([payload]));
                assert.deepEqual(result, { nextChunk: 600, bytesAccepted: 600 });
                assert.deepEqual(batchSizes, [256, 256]);
            } finally {
                Collection.prototype.find = original;
            }
            await bucket.finalizeResumableUpload(uploadId);
            assert.deepEqual(await bucket.download(uploadId), payload);
        });
    });

    it('keeps an unread source reusable after pre-consumption rejections', async () => {
        await withRuntime('gridfs_append_unread_retry', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const { uploadId } = await bucket.beginResumableUpload('retry.bin', { length: 4, sha256: sha(payload) });
            const uploads = db.collection('b.uploads');
            let reads = 0;
            const source = new Readable({
                read() {
                    reads += 1;
                    this.push(payload);
                    this.push(null);
                },
            });
            await assert.rejects(bucket.appendChunks(new ObjectId(), 0, source), { code: 'GRIDFS_FILE_NOT_FOUND' });
            await uploads.updateOne({ _id: uploadId }, { $set: { activeAppend: { token: 'other-writer' } } });
            await assert.rejects(bucket.appendChunks(uploadId, 0, source), { code: 'GRIDFS_UPLOAD_BUSY' });
            await uploads.updateOne({ _id: uploadId }, { $unset: { activeAppend: '' } });
            await assert.rejects(bucket.appendChunks(uploadId, 1, source), (error: unknown) => {
                const mismatch = error as { code: string; details: { expectedNextChunk: number }[] };
                return mismatch.code === 'GRIDFS_RESUME_MISMATCH' && mismatch.details[0].expectedNextChunk === 0;
            });
            assert.equal(reads, 0);
            assert.equal(source.destroyed, false);
            assert.equal(source.listenerCount('error'), 0);
            assert.equal((await bucket.appendChunks(uploadId, 0, source)).nextChunk, 1);
            await bucket.finalizeResumableUpload(uploadId);
            assert.deepEqual(await bucket.download(uploadId), payload);
        });
    });

    it('releases the append claim when an idle source is destroyed without a close event', { timeout: 10_000 }, async () => {
        await withRuntime('gridfs_append_silent_close', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const { uploadId } = await bucket.beginResumableUpload('idle.bin', { length: 4, sha256: sha(payload) });
            const reading = gate();
            const source = new Readable({ emitClose: false, read() { reading.open(); } });
            const rejected = assert.rejects(bucket.appendChunks(uploadId, 0, source), { code: 'INVALID_ARGUMENT' });
            await reading.wait;
            await new Promise<void>((resolve) => setImmediate(resolve));
            source.destroy();
            await rejected;
            const owner = await db.collection('b.uploads').findOne({ _id: uploadId });
            assert.equal(owner?.activeAppend, undefined);
            assert.ok(owner?.expiresAt instanceof Date);
            await bucket.abortResumableUpload(uploadId);
        });
    });

    it('resumes after a streaming append writes one full chunk then rejects a trailing partial', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_stream_resume_partial', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('aaaabbbb');
            const session = await bucket.beginResumableUpload('partial-resume.bin', {
                length: payload.length, sha256: sha(payload),
            });
            await assert.rejects(
                bucket.appendChunks(session.uploadId, 0, Readable.from([payload.subarray(0, 4), Buffer.from('bb')])),
                (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
            );
            assert.deepEqual(
                (await db.collection('b.chunks').find({ files_id: session.uploadId }).sort({ n: 1 }).toArray()).map((chunk) => chunk.n),
                [0],
            );
            const resumed = await bucket.appendChunks(session.uploadId, 1, payload.subarray(4));
            assert.equal(resumed.nextChunk, 2);
            assert.deepEqual(await bucket.download((await bucket.finalizeResumableUpload(session.uploadId)).id), payload);
        });
    });
});
