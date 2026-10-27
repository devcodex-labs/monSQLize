import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createHash } from 'node:crypto';
import { createMonSQLizeGridFSBucket } from '../../../src/capabilities/gridfs';
import { gridFSUploadStreamOptions } from '../../../src/capabilities/gridfs/driver';
import { toFileInfo } from '../../../src/capabilities/gridfs/normalize';
import { openModelGridFS, openRuntimeGridFS } from '../../../src/entry/runtime-gridfs';
import { normalizeWritePathPolicy } from '../../../src/capabilities/write-path-policy';
import { sha256Hex } from '../../../src/capabilities/gridfs/validate';

type Doc = Record<string, any>;

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function sameId(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (left && right && typeof (left as { equals?: (value: unknown) => boolean }).equals === 'function') {
        return (left as { equals: (value: unknown) => boolean }).equals(right);
    }
    return false;
}

function readPath(doc: Doc, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
        if (!current || typeof current !== 'object') return undefined;
        return (current as Doc)[key];
    }, doc);
}

function matches(doc: Doc, filter: Doc): boolean {
    return Object.entries(filter).every(([key, expected]) => {
        const actual = readPath(doc, key);
        if (expected && typeof expected === 'object' && typeof (expected as { equals?: unknown }).equals === 'function') {
            return sameId(actual, expected);
        }
        return actual === expected;
    });
}

function sortRows(rows: Doc[], spec?: Doc): Doc[] {
    if (!spec) return rows;
    const [key, direction] = Object.entries(spec)[0] ?? [];
    if (!key) return rows;
    const dir = direction === -1 ? -1 : 1;
    return [...rows].sort((left, right) => {
        const a = readPath(left, key) as number | Date;
        const b = readPath(right, key) as number | Date;
        if (a < b) return -1 * dir;
        if (a > b) return 1 * dir;
        return 0;
    });
}

class MemoryCollection {
    docs: Doc[] = [];
    indexes: Doc[] = [];

    private matched(filter: Doc): Doc[] {
        return this.docs.filter((doc) => matches(doc, filter));
    }

    async findOne(filter: Doc, options?: { sort?: Doc }): Promise<Doc | null> {
        const [first] = sortRows(this.matched(filter), options?.sort);
        return first ? { ...first } : null;
    }

    find(filter: Doc) {
        let rows = this.matched(filter);
        const cursor = {
            sort: (spec: Doc) => { rows = sortRows(rows, spec); return cursor; },
            skip: (count: number) => { rows = rows.slice(count); return cursor; },
            limit: (count: number) => { rows = rows.slice(0, count); return cursor; },
            project: () => cursor,
            toArray: async () => rows.map((row) => ({ ...row })),
            async *[Symbol.asyncIterator]() {
                for (const row of rows) yield { ...row };
            },
        };
        return cursor;
    }

    async insertOne(doc: Doc) {
        const duplicateId = doc._id !== undefined && this.docs.some((row) => sameId(row._id, doc._id));
        const duplicateChunk = doc.files_id !== undefined && doc.n !== undefined
            && this.docs.some((row) => sameId(row.files_id, doc.files_id) && row.n === doc.n);
        if (duplicateId || duplicateChunk) {
            const error = new Error('E11000 duplicate key') as Error & { code: number };
            error.code = 11000;
            throw error;
        }
        this.docs.push({ ...doc });
        return { insertedId: doc._id };
    }

    async updateOne(filter: Doc, update: { $set?: Doc }) {
        const row = this.docs.find((doc) => matches(doc, filter));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, update.$set ?? {});
        return { matchedCount: 1 };
    }

    async deleteOne(filter: Doc) {
        const index = this.docs.findIndex((doc) => matches(doc, filter));
        if (index < 0) return { deletedCount: 0 };
        this.docs.splice(index, 1);
        return { deletedCount: 1 };
    }

    async deleteMany(filter: Doc) {
        const before = this.docs.length;
        this.docs = this.docs.filter((doc) => !matches(doc, filter));
        return { deletedCount: before - this.docs.length };
    }

    async createIndex(keys: Doc, options?: Doc) {
        this.indexes.push({ key: keys, ...(options ?? {}) });
        return 'index';
    }

    async drop() {
        this.docs = [];
    }
}

class MemoryDb {
    private readonly collections = new Map<string, MemoryCollection>();
    collection(name: string): MemoryCollection {
        let collection = this.collections.get(name);
        if (!collection) {
            collection = new MemoryCollection();
            this.collections.set(name, collection);
        }
        return collection;
    }
}

function codeOf(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function detailsOf(error: unknown): Record<string, unknown> {
    const details = error && typeof error === 'object' ? (error as { details?: unknown[] }).details : undefined;
    return (details?.[0] ?? {}) as Record<string, unknown>;
}

function bucketFor(options: { policy?: ReturnType<typeof normalizeWritePathPolicy>; source?: 'db' | 'model'; driver?: boolean } = {}) {
    const db = new MemoryDb();
    const calls: string[] = [];
    const bytes = new Map<string, Buffer>();
    const driver = {
        openUploadStream(id: ObjectId, filename: string, streamOptions: { chunkSizeBytes: number; metadata?: Doc; contentType?: string }) {
            calls.push('upload');
            const { PassThrough } = require('node:stream') as typeof import('node:stream');
            const stream = new PassThrough();
            const parts: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => parts.push(Buffer.from(chunk)));
            stream.on('finish', () => {
                const data = Buffer.concat(parts);
                bytes.set(id.toHexString(), data);
                void db.collection('fs.files').insertOne({
                    _id: id,
                    filename,
                    length: data.length,
                    chunkSize: streamOptions.chunkSizeBytes,
                    uploadDate: new Date(),
                    ...(streamOptions.contentType ? { contentType: streamOptions.contentType } : {}),
                    ...(streamOptions.metadata ? { metadata: streamOptions.metadata } : {}),
                });
            });
            (stream as unknown as { abort: () => Promise<void> }).abort = async () => {
                calls.push('abort');
                bytes.delete(id.toHexString());
            };
            return stream;
        },
        openDownloadStream(id: ObjectId, range?: { start?: number; end?: number }) {
            const data = bytes.get(id.toHexString());
            if (!data) return Readable.from(async function* fail() { throw Object.assign(new Error('File not found'), { code: 'ENOENT' }); }());
            const start = range?.start ?? 0;
            const end = range?.end ?? data.length;
            return Readable.from([data.subarray(start, end)]);
        },
        async delete(id: ObjectId) {
            calls.push('delete');
            const removed = await db.collection('fs.files').deleteOne({ _id: id });
            bytes.delete(id.toHexString());
            if (!removed.deletedCount) throw new Error(`File not found for id ${id}`);
        },
        async rename(id: ObjectId, filename: string) {
            calls.push('rename');
            const updated = await db.collection('fs.files').updateOne({ _id: id }, { $set: { filename } });
            if (!updated.matchedCount) throw new Error(`File with id ${id} not found`);
        },
        async drop() {
            calls.push('drop');
            await db.collection('fs.files').drop();
            await db.collection('fs.chunks').drop();
        },
    };
    const bucket = createMonSQLizeGridFSBucket({
        db: db as never,
        bucketName: 'fs',
        dbName: 'app',
        source: options.source ?? 'db',
        policy: options.policy,
        driver: options.driver === false ? undefined : driver as never,
    });
    return { bucket, db, calls, bytes };
}

describe('gridfs bucket', () => {
    it('rejects an empty filename, a bad sha256, and a polluted filter', async () => {
        const { bucket } = bucketFor();
        await assert.rejects(() => bucket.upload('', Buffer.from('x')), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
        await assert.rejects(() => bucket.upload('a.bin', Buffer.from('x'), { sha256: 'ABC' }), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
        await assert.rejects(() => bucket.findFiles({ ['__proto__']: { admin: true } } as never), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
        await assert.rejects(() => bucket.findFiles({}, { limit: 0 }), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
    });

    it('checks sha256 before any GridFS write and keeps ifExists semantics', async () => {
        const { bucket, calls } = bucketFor();
        const payload = Buffer.from('alpha');
        const digest = sha(payload);
        await assert.rejects(
            () => bucket.upload('a.bin', Buffer.from('other'), { sha256: digest }),
            (error: unknown) => codeOf(error) === 'GRIDFS_INTEGRITY_MISMATCH' && detailsOf(error).actual === sha256Hex(Buffer.from('other')),
        );
        assert.deepEqual(calls, []);

        const info = await bucket.upload('a.bin', payload, { sha256: digest, metadata: { tenant: 't1' }, contentType: 'text/plain' });
        assert.equal(info.filename, 'a.bin');
        assert.equal(info.metadata?.sha256, digest);
        assert.equal(info.metadata?.tenant, 't1');
        assert.equal(info.contentType, 'text/plain');
        assert.deepEqual(await bucket.download(info.id), payload);
        await assert.rejects(() => bucket.upload('b.bin', payload, { sha256: digest }), (error: unknown) => {
            assert.equal(codeOf(error), 'GRIDFS_FILE_EXISTS');
            assert.equal(detailsOf(error).sha256, digest);
            return true;
        });
        const skipped = await bucket.upload('c.bin', payload, { sha256: digest, ifExists: 'skip' });
        assert.equal(String(skipped.id), String(info.id));
        const duplicate = await bucket.upload('d.bin', payload, { sha256: digest, ifExists: 'duplicate' });
        assert.notEqual(String(duplicate.id), String(info.id));
        const named = await bucket.upload('report.bin', Buffer.from('report'));
        const again = await bucket.upload('report.bin', Buffer.from('other-report'), { ifExists: 'skip' });
        assert.equal(String(again.id), String(named.id));
    });

    it('returns download misses and illegal ranges as coded errors', async () => {
        const { bucket } = bucketFor();
        const missing = new ObjectId();
        await assert.rejects(() => bucket.download(missing), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_NOT_FOUND');
        await assert.rejects(() => bucket.download({ filename: 'absent.txt' }), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_NOT_FOUND');
        const stream = bucket.downloadStream(missing, { start: 0, end: 1 });
        const streamed = await new Promise<unknown>((resolve) => stream.once('error', resolve));
        assert.equal(codeOf(streamed), 'GRIDFS_FILE_NOT_FOUND');
        const ranged = bucket.downloadStream(new ObjectId(), { start: 4, end: 4 });
        const rangeError = await new Promise<unknown>((resolve) => ranged.once('error', resolve));
        assert.equal(codeOf(rangeError), 'GRIDFS_RANGE_INVALID');
        assert.equal(await bucket.getFile(missing), null);
    });

    it('blocks model-only inherit writes from both sources and still allows reads and model drop', async () => {
        const policy = normalizeWritePathPolicy({ default: 'model-only' });
        const modelBucket = bucketFor({ policy, source: 'model' });
        assert.throws(() => modelBucket.bucket.upload('a.bin', Buffer.from('x')), (error: unknown) => {
            assert.equal(codeOf(error), 'INVALID_OPERATION');
            assert.equal(detailsOf(error).category, 'gridfs');
            assert.equal(detailsOf(error).reason, 'WRITE_PATH_POLICY');
            assert.equal(detailsOf(error).source, 'model');
            return true;
        });
        assert.equal(await modelBucket.bucket.getFile(new ObjectId()), null);
        await modelBucket.bucket.drop();
        assert.deepEqual(modelBucket.calls, ['drop']);

        const instanceBucket = bucketFor({ policy, source: 'db' });
        assert.throws(() => instanceBucket.bucket.upload('a.bin', Buffer.from('x')), (error: unknown) => detailsOf(error).source === 'db' && detailsOf(error).category === 'gridfs');
        assert.throws(() => instanceBucket.bucket.drop(), (error: unknown) => detailsOf(error).category === 'management');
        const allowed = bucketFor({ policy: normalizeWritePathPolicy({ default: { mode: 'model-only', gridfs: 'allow' } }), source: 'model' });
        const info = await allowed.bucket.upload('a.bin', Buffer.from('ok'));
        assert.equal(info.length, 2);
    });

    it('resumes appends, rejects gaps and bad sizes, and hides the file until finalize', async () => {
        const { bucket, db } = bucketFor({ driver: false });
        const payload = Buffer.from('abcdefghij');
        const digest = sha(payload);
        const started = await bucket.beginResumableUpload('big.bin', { length: payload.length, sha256: digest, chunkSizeBytes: 4, metadata: { kind: 'bin' } });
        assert.equal(started.nextChunk, 0);
        assert.equal(await bucket.getFile(started.uploadId), null);
        await assert.rejects(() => bucket.appendChunks(started.uploadId, 1, payload.subarray(0, 4)), (error: unknown) => {
            assert.equal(codeOf(error), 'GRIDFS_RESUME_MISMATCH');
            assert.equal(detailsOf(error).expectedNextChunk, 0);
            return true;
        });
        await assert.rejects(() => bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 3)), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
        const first = await bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 4));
        assert.equal(first.nextChunk, 1);
        const replay = await bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 4));
        assert.equal(replay.nextChunk, 1);
        await assert.rejects(() => bucket.appendChunks(started.uploadId, 0, Buffer.from('xxxx')), (error: unknown) => codeOf(error) === 'GRIDFS_RESUME_MISMATCH');
        await assert.rejects(() => bucket.finalizeResumableUpload(started.uploadId), (error: unknown) => {
            assert.equal(codeOf(error), 'GRIDFS_UPLOAD_INCOMPLETE');
            assert.deepEqual(detailsOf(error).missingChunks, [1, 2]);
            return true;
        });
        assert.equal(await bucket.getFile(started.uploadId), null);
        const rest = await bucket.appendChunks(started.uploadId, 1, payload.subarray(4));
        assert.equal(rest.nextChunk, 3);
        const bad = await bucket.beginResumableUpload('bad.bin', { length: 4, sha256: sha(Buffer.from('nope')), chunkSizeBytes: 4 });
        await bucket.appendChunks(bad.uploadId, 0, Buffer.from('abcd'));
        await assert.rejects(() => bucket.finalizeResumableUpload(bad.uploadId), (error: unknown) => codeOf(error) === 'GRIDFS_INTEGRITY_MISMATCH');
        assert.equal(await bucket.getFile(bad.uploadId), null);

        const info = await bucket.finalizeResumableUpload(started.uploadId);
        assert.equal(info.metadata?.sha256, digest);
        assert.equal(info.metadata?.kind, 'bin');
        assert.equal(info.length, payload.length);
        assert.equal(await db.collection('fs.uploads').findOne({ _id: started.uploadId }), null);
        const chunks = await db.collection('fs.chunks').find({ files_id: started.uploadId }).sort({ n: 1 }).toArray();
        assert.equal(Buffer.concat(chunks.map((chunk) => chunk.data as Buffer)).toString(), payload.toString());
        await bucket.abortResumableUpload(started.uploadId);
        const retained = await db.collection('fs.chunks').find({ files_id: started.uploadId }).toArray();
        assert.equal(retained.length, 3);
        await bucket.abortResumableUpload(new ObjectId());
    });

    it('validates an append before writing and does not extend a replay', async () => {
        const { bucket, db } = bucketFor({ driver: false });
        const payload = Buffer.from('abcdefghijkl');
        const started = await bucket.beginResumableUpload('big.bin', { length: payload.length, sha256: sha(payload), chunkSizeBytes: 4 });
        await assert.rejects(() => bucket.appendChunks(started.uploadId, 0, Buffer.from('abcdef')), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');
        assert.equal((await db.collection('fs.chunks').find({ files_id: started.uploadId }).toArray()).length, 0);

        await bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 8));
        await assert.rejects(
            () => bucket.appendChunks(started.uploadId, 0, Buffer.concat([payload.subarray(0, 8), Buffer.from('WXYZ')])),
            (error: unknown) => {
                assert.equal(codeOf(error), 'GRIDFS_RESUME_MISMATCH');
                assert.equal(detailsOf(error).expectedNextChunk, 2);
                return true;
            },
        );
        const stored = await db.collection('fs.chunks').find({ files_id: started.uploadId }).sort({ n: 1 }).toArray();
        assert.deepEqual(stored.map((chunk) => chunk.n), [0, 1]);
        assert.equal((await db.collection('fs.uploads').findOne({ _id: started.uploadId }))?.nextChunk, 2);

        const replay = await bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 8));
        assert.equal(replay.nextChunk, 2);
        const advanced = await bucket.appendChunks(started.uploadId, 2, payload.subarray(8));
        assert.equal(advanced.nextChunk, 3);
    });

    it('abort removes pending chunks and ensureIndexes is idempotent', async () => {
        const { bucket, db } = bucketFor({ driver: false });
        const started = await bucket.beginResumableUpload('partial.bin', { length: 4, sha256: sha(Buffer.from('abcd')), chunkSizeBytes: 4 });
        await bucket.appendChunks(started.uploadId, 0, Buffer.from('abcd'));
        await bucket.abortResumableUpload(started.uploadId);
        await bucket.abortResumableUpload(started.uploadId);
        assert.equal((await db.collection('fs.chunks').find({}).toArray()).length, 0);
        assert.equal(await db.collection('fs.uploads').findOne({ _id: started.uploadId }), null);
        assert.equal(await bucket.getFile(started.uploadId), null);
        await bucket.ensureIndexes();
        await bucket.ensureIndexes();
        const indexes = db.collection('fs.files').indexes.concat(db.collection('fs.chunks').indexes, db.collection('fs.uploads').indexes);
        assert.equal(indexes.length, 4);
        assert.ok(indexes.some((index) => index.expireAfterSeconds === 604800));
        assert.ok(indexes.some((index) => index.key?.['metadata.sha256'] === 1));
    });

    it('stores contentType on metadata and omits it from driver upload options', () => {
        const options = gridFSUploadStreamOptions({
            chunkSizeBytes: 4,
            metadata: { kind: 'bin', contentType: 'from-metadata' },
            contentType: 'text/plain',
        });
        assert.equal(Object.prototype.hasOwnProperty.call(options, 'contentType'), false);
        assert.equal(options.metadata?.contentType, 'text/plain');
        assert.equal(options.metadata?.kind, 'bin');
        const unchanged = gridFSUploadStreamOptions({ chunkSizeBytes: 4, metadata: { kind: 'bin' } });
        assert.equal(unchanged.metadata?.contentType, undefined);
        const info = toFileInfo({
            _id: new ObjectId(),
            filename: 'a.bin',
            length: 1,
            chunkSize: 4,
            uploadDate: new Date(),
            metadata: { contentType: 'text/plain' },
        });
        assert.equal(info.contentType, 'text/plain');
        const legacy = toFileInfo({
            _id: new ObjectId(),
            filename: 'b.bin',
            length: 1,
            chunkSize: 4,
            uploadDate: new Date(),
            contentType: 'application/octet-stream',
        });
        assert.equal(legacy.contentType, 'application/octet-stream');
    });

    it('routes a named pool to that client and keeps Model pool and database fixed', () => {
        const seen: string[] = [];
        const client = (label: string) => ({
            db(name: string) {
                seen.push(`${label}:${name}`);
                return { collection: () => ({}) };
            },
        });
        const runtime = {
            ensureConnected() { return undefined; },
            options: { type: 'mongodb' as const, databaseName: 'main' },
            _client: client('default'),
            _poolManager: { getPool: (name: string) => name === 'archive' ? client('archive') : null, getPoolNames: () => ['archive'] },
            _runtimeDefaults: { writePathPolicy: normalizeWritePathPolicy() },
        };
        openRuntimeGridFS(runtime, 'photos', { pool: 'archive', db: 'assets' });
        openModelGridFS(runtime, 'assets', 'archive', undefined, 1024);
        openRuntimeGridFS(runtime, undefined, undefined);
        assert.deepEqual(seen, ['archive:assets', 'archive:assets', 'default:main']);
    });
});
