import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function codeOf(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function detailsOf(error: unknown): Record<string, unknown> {
    const details = error && typeof error === 'object' ? (error as { details?: unknown[] }).details : undefined;
    return (details?.[0] ?? {}) as Record<string, unknown>;
}

async function readStream(stream: AsyncIterable<Uint8Array | Buffer>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

describe('gridfs memory-server integration', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';

    before(async () => {
        uri = (await bootstrap.setup()).uri;
    });

    after(async () => {
        await bootstrap.teardown();
        MonSQLize.Model._clear();
    });

    async function connect(databaseName: string, options: Record<string, unknown> = {}) {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName, config: { uri }, ...options });
        await runtime.connect();
        return runtime;
    }

    it('round-trips at least three chunks, ranges, streams, and ifExists', async () => {
        const runtime = await connect('gridfs_roundtrip');
        try {
        const bucket = runtime.gridfs('artifacts', { chunkSizeBytes: 8 });
        const payload = Buffer.from('abcdefghijklmnopqrst');
        const digest = sha(payload);
        const info = await bucket.upload('report.bin', payload, {
            sha256: digest,
            metadata: { tenantId: 't1', sha256: 'caller-value' },
            contentType: 'application/octet-stream',
        });
        assert.equal(info.length, payload.length);
        assert.equal(info.chunkSize, 8);
        assert.equal(info.metadata?.sha256, digest);
        assert.equal(info.metadata?.contentType, 'application/octet-stream');
        assert.equal(info.metadata?.tenantId, 't1');
        assert.deepEqual(await bucket.download(info.id), payload);
        assert.deepEqual(await bucket.download({ filename: 'report.bin' }), payload);

        const part1 = await readStream(bucket.downloadStream(info.id, { start: 0, end: 8 }));
        const part2 = await readStream(bucket.downloadStream(info.id, { start: 8 }));
        assert.deepEqual(Buffer.concat([part1, part2]), payload);

        await assert.rejects(() => bucket.upload('other.bin', payload, { sha256: digest }), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_EXISTS');
        const skipped = await bucket.upload('other.bin', payload, { sha256: digest, ifExists: 'skip' });
        assert.equal(String(skipped.id), String(info.id));

        const streamed = bucket.uploadStream('stream.bin', { sha256: digest });
        Readable.from([payload]).pipe(streamed);
        const streamedInfo = await streamed.done;
        assert.deepEqual(await readStream(bucket.downloadStream(streamedInfo.id)), payload);
        const named = await bucket.upload('notes.txt', Buffer.from('notes'));
        const sameName = await bucket.upload('notes.txt', Buffer.from('notes-2'), { ifExists: 'skip' });
        assert.equal(String(sameName.id), String(named.id));
        const copy = await bucket.upload('notes.txt', Buffer.from('notes-3'), { ifExists: 'duplicate' });
        assert.notEqual(String(copy.id), String(named.id));
        const latest = await bucket.download({ filename: 'notes.txt', revision: -1 });
        assert.equal(latest.toString(), 'notes-3');

        await assert.rejects(() => bucket.upload('bad.bin', Buffer.from('nope'), { sha256: digest }), (error: unknown) => codeOf(error) === 'GRIDFS_INTEGRITY_MISMATCH');
        assert.equal(await bucket.getFile(new ObjectId()), null);
        await assert.rejects(() => bucket.download({ filename: 'missing.bin' }), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_NOT_FOUND');
        const ranged = bucket.downloadStream(info.id, { start: 3, end: 3 });
        const rangeError = await new Promise<unknown>((resolve) => ranged.once('error', resolve));
        assert.equal(codeOf(rangeError), 'GRIDFS_RANGE_INVALID');
        assert.equal(detailsOf(rangeError).length, undefined);
        const tooFar = bucket.downloadStream(info.id, { start: payload.length });
        const tooFarError = await new Promise<unknown>((resolve) => tooFar.once('error', resolve));
        assert.equal(codeOf(tooFarError), 'GRIDFS_RANGE_INVALID');
        assert.equal(detailsOf(tooFarError).length, payload.length);

        await bucket.rename(named.id, 'notes-renamed.txt');
        assert.equal((await bucket.getFile(named.id))?.filename, 'notes-renamed.txt');
        await assert.rejects(() => bucket.delete(new ObjectId()), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_NOT_FOUND');
        await bucket.delete(new ObjectId(), { ignoreMissing: true });
        await bucket.delete(named.id);
        assert.equal(await bucket.getFile(named.id), null);
        const found = await bucket.findFiles({ 'metadata.sha256': digest }, { sort: { uploadDate: 1 } });
        assert.ok(found.some((file: { id: unknown }) => String(file.id) === String(info.id)));
        } finally {
            await runtime.close();
        }
    });

    it('resumes across a reconnect, then rejects incomplete, mismatched, and aborted uploads', async () => {
        const databaseName = 'gridfs_resume';
        const bucketName = 'resumable';
        const payload = Buffer.from('abcdefghijklmnopqrst');
        const digest = sha(payload);
        const first = await connect(databaseName);
        let started: { uploadId: InstanceType<typeof ObjectId> };
        try {
        const bucket = first.gridfs(bucketName, { chunkSizeBytes: 8 });
        started = await bucket.beginResumableUpload('big.bin', { length: payload.length, sha256: digest, chunkSizeBytes: 8, contentType: 'application/octet-stream' });
        assert.equal((await bucket.appendChunks(started.uploadId, 0, payload.subarray(0, 8))).nextChunk, 1);
        assert.equal(await bucket.getFile(started.uploadId), null);
        } finally {
            await first.close();
        }

        const second = await connect(databaseName);
        try {
        const resumed = second.gridfs(bucketName);
        const next = await resumed.appendChunks(started.uploadId, 1, payload.subarray(8));
        assert.equal(next.nextChunk, 3);
        const info = await resumed.finalizeResumableUpload(started.uploadId);
        assert.equal(info.metadata?.sha256, digest);
        assert.equal(info.metadata?.contentType, 'application/octet-stream');
        assert.equal(info.contentType, 'application/octet-stream');
        assert.deepEqual(await resumed.download(info.id), payload);
        const skipped = await resumed.upload('again.bin', payload, { sha256: digest, ifExists: 'skip' });
        assert.equal(String(skipped.id), String(info.id));

        const incomplete = await resumed.beginResumableUpload('partial.bin', { length: payload.length, sha256: digest, chunkSizeBytes: 8 });
        await resumed.appendChunks(incomplete.uploadId, 0, payload.subarray(0, 8));
        await assert.rejects(() => resumed.finalizeResumableUpload(incomplete.uploadId), (error: unknown) => codeOf(error) === 'GRIDFS_UPLOAD_INCOMPLETE');
        assert.equal(await resumed.getFile(incomplete.uploadId), null);
        await assert.rejects(() => resumed.appendChunks(incomplete.uploadId, 5, payload.subarray(0, 8)), (error: unknown) => codeOf(error) === 'GRIDFS_RESUME_MISMATCH');
        await assert.rejects(() => resumed.appendChunks(incomplete.uploadId, 1, Buffer.from('short')), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT');

        const mismatched = await resumed.beginResumableUpload('wrong.bin', { length: 8, sha256: sha(Buffer.from('xxxxxxxx')), chunkSizeBytes: 8 });
        await resumed.appendChunks(mismatched.uploadId, 0, Buffer.from('abcdefgh'));
        await assert.rejects(() => resumed.finalizeResumableUpload(mismatched.uploadId), (error: unknown) => codeOf(error) === 'GRIDFS_INTEGRITY_MISMATCH');
        assert.equal(await resumed.getFile(mismatched.uploadId), null);

        await resumed.abortResumableUpload(incomplete.uploadId);
        await resumed.abortResumableUpload(incomplete.uploadId);
        assert.equal((await second.collection(`${bucketName}.chunks`).find({ files_id: incomplete.uploadId })).length, 0);
        assert.equal((await second.collection(`${bucketName}.files`).find({ _id: incomplete.uploadId })).length, 0);
        await resumed.drop();
        assert.equal((await second.collection(`${bucketName}.files`).find({})).length, 0);
        assert.equal((await second.collection(`${bucketName}.uploads`).find({})).length, 0);
        } finally {
            await second.close();
        }
    });

    it('enforces gridfs and management policy for instance and Model buckets', async () => {
        MonSQLize.Model.define('gridfs_files', { schema: {} });
        const blocked = await connect('gridfs_policy_block', { writePathPolicy: { default: 'model-only' } });
        try {
        const model = blocked.model('gridfs_files');
        assert.throws(() => blocked.gridfs('locked').upload('a.bin', Buffer.from('x')), (error: unknown) => {
            assert.equal(codeOf(error), 'INVALID_OPERATION');
            assert.equal(detailsOf(error).category, 'gridfs');
            assert.equal(detailsOf(error).reason, 'WRITE_PATH_POLICY');
            assert.equal(detailsOf(error).source, 'db');
            return true;
        });
        assert.throws(() => model.gridfs('locked').upload('a.bin', Buffer.from('x')), (error: unknown) => detailsOf(error).source === 'model');
        assert.equal(await model.gridfs('locked').getFile(new ObjectId()), null);
        assert.throws(() => blocked.gridfs('locked').drop(), (error: unknown) => detailsOf(error).category === 'management');
        await model.gridfs('locked').drop();
        } finally {
            await blocked.close();
        }

        const warnings: unknown[] = [];
        const warned = await connect('gridfs_policy_warn', {
            logger: { debug() {}, info() {}, error() {}, warn: (...args: unknown[]) => { warnings.push(args); } },
            writePathPolicy: { default: { mode: 'model-only', onViolation: 'warn' } },
        });
        try {
        const warnedInfo = await warned.gridfs('warned', { chunkSizeBytes: 8 }).upload('a.bin', Buffer.from('abcdefghi'));
        assert.equal(warnedInfo.length, 9);
        assert.ok(warnings.length > 0);
        } finally {
            await warned.close();
        }

        const allowed = await connect('gridfs_policy_allow', { writePathPolicy: { default: { mode: 'model-only', gridfs: 'allow' } } });
        try {
        const allowedModel = allowed.model('gridfs_files');
        const fromModel = await allowedModel.gridfs('shared').upload('from-model.bin', Buffer.from('model-bytes'), { sha256: sha(Buffer.from('model-bytes')) });
        assert.deepEqual(await allowed.gridfs('shared').download(fromModel.id), Buffer.from('model-bytes'));
        await allowed.gridfs('shared').ensureIndexes();
        const indexes = await allowed.collection('shared.files').listIndexes();
        assert.ok(indexes.some((index: { key?: Record<string, number> }) => index.key?.['metadata.sha256'] === 1));
        } finally {
            await allowed.close();
            MonSQLize.Model._clear();
        }
    });

    it('throws NOT_CONNECTED before connect', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'gridfs_offline', config: { uri } });
        assert.throws(() => runtime.gridfs(), (error: unknown) => codeOf(error) === 'NOT_CONNECTED');
    });
});
