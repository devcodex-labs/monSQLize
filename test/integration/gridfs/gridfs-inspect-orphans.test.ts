import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const { inspectGridFSOrphans } = require(process.cwd() + '/scripts/maintenance/gridfs-inspect-orphans.cjs');

describe('GridFS inspect-only orphan reporter', () => {
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
    });

    async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
        const db = raw.db('gridfs_inspect_' + (++counter));
        try {
            await db.collection('b.chunks').createIndex({ files_id: 1, n: 1 }, { unique: true });
            await fn(db);
        } finally {
            await db.dropDatabase();
        }
    }

    it('classifies visible, owned, and candidate orphan files_id groups without deleting', async () => {
        await withDb(async (db) => {
            const visible = new ObjectId();
            const owned = new ObjectId();
            const orphan = new ObjectId();
            const ancient = new Date('2018-01-01T00:00:00.000Z');
            await db.collection('b.files').insertOne({
                _id: visible, filename: 'ok.bin', length: 4, chunkSize: 4, uploadDate: new Date(),
            });
            await db.collection('b.chunks').insertMany([
                { files_id: visible, n: 0, data: Buffer.from('ABCD') },
                { files_id: owned, n: 0, data: Buffer.from('PEND') },
                { files_id: orphan, n: 0, data: Buffer.from('ORPH') },
                { files_id: orphan, n: 1, data: Buffer.from('ANED') },
            ]);
            await db.collection('b.uploads').insertOne({
                _id: owned, kind: 'resumable', status: 'pending', createdAt: ancient, updatedAt: ancient,
            });

            const originalDeleteMany = Collection.prototype.deleteMany;
            let deletes = 0;
            (Collection.prototype as any).deleteMany = async function (...args: unknown[]) {
                deletes += 1;
                return (originalDeleteMany as any).apply(this, args);
            };
            try {
                await assert.rejects(
                    () => inspectGridFSOrphans({ db, bucket: 'b', apply: true }),
                    /no apply mode/,
                );
                const report = await inspectGridFSOrphans({ db, bucket: 'b', pageSize: 2 });
                assert.equal(report.filesIdsScanned, 3);
                assert.equal(report.visibleFiles, 1);
                assert.equal(report.owned, 1);
                assert.equal(report.candidateOrphans, 1);
                assert.ok(report.pages >= 2);
                const byId = Object.fromEntries(report.findings.map((row: { filesId: string }) => [row.filesId, row]));
                assert.equal(byId[visible.toHexString()].classification, 'visible_file');
                assert.equal(byId[owned.toHexString()].classification, 'owned');
                assert.equal(byId[owned.toHexString()].ownerStatus, 'pending');
                assert.equal(byId[orphan.toHexString()].classification, 'candidate_orphan');
                assert.equal(byId[orphan.toHexString()].chunkCount, 2);
                assert.equal(deletes, 0);
                assert.equal(await db.collection('b.chunks').countDocuments(), 4);
                assert.equal(await db.collection('b.uploads').countDocuments(), 1);
            } finally {
                Collection.prototype.deleteMany = originalDeleteMany;
            }
        });
    });

    it('re-checks ownership after pagination and does not classify a late-visible id as an orphan', async () => {
        await withDb(async (db) => {
            const first = new ObjectId();
            const second = new ObjectId();
            const third = new ObjectId();
            // ObjectIds are time-ordered; insert so walk order is first, second, third.
            const ids = [first, second, third].sort((a, b) => a.toString().localeCompare(b.toString()));
            await db.collection('b.chunks').insertMany(ids.map((id) => ({
                files_id: id, n: 0, data: Buffer.from('DATA'),
            })));

            const originalFindOne = Collection.prototype.findOne;
            let published = false;
            (Collection.prototype as any).findOne = async function (...args: unknown[]) {
                // After the first files_id is classified, make the last id visible before its re-check.
                if (this.collectionName === 'b.files') {
                    const filter = args[0] as { _id?: ObjectId };
                    if (!published && filter?._id && filter._id.equals(ids[0])) {
                        published = true;
                        await db.collection('b.files').insertOne({
                            _id: ids[2], filename: 'late.bin', length: 4, chunkSize: 4, uploadDate: new Date(),
                        });
                    }
                }
                return (originalFindOne as any).apply(this, args);
            };
            try {
                const report = await inspectGridFSOrphans({ db, bucket: 'b', pageSize: 1 });
                const byId = Object.fromEntries(report.findings.map((row: { filesId: string }) => [row.filesId, row]));
                assert.equal(byId[ids[0].toHexString()].classification, 'candidate_orphan');
                assert.equal(byId[ids[2].toHexString()].classification, 'visible_file');
                assert.equal(await db.collection('b.chunks').countDocuments(), 3);
            } finally {
                Collection.prototype.findOne = originalFindOne;
            }
        });
    });

    it('recognizes a file published between the files and owner lookups', async () => {
        await withDb(async (db) => {
            const id = new ObjectId();
            await db.collection('b.chunks').insertOne({ files_id: id, n: 0, data: Buffer.from('DATA') });
            await db.collection('b.uploads').insertOne({ _id: id, status: 'uploading' });
            const original = Collection.prototype.findOne;
            Collection.prototype.findOne = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as { _id?: ObjectId } | undefined;
                if (this.collectionName === 'b.uploads' && id.equals(filter?._id)) {
                    await db.collection('b.files').insertOne({
                        _id: id, filename: 'published.bin', length: 4, chunkSize: 4, uploadDate: new Date(),
                    });
                    await db.collection('b.uploads').deleteOne({ _id: id });
                }
                return Reflect.apply(original, this, args);
            } as typeof original;
            try {
                const report = await inspectGridFSOrphans({ db, bucket: 'b' });
                assert.equal(report.findings[0].classification, 'visible_file');
                assert.equal(report.candidateOrphans, 0);
            } finally {
                Collection.prototype.findOne = original;
            }
        });
    });

    it('counts a group split across batches starting with a negative chunk index', async () => {
        await withDb(async (db) => {
            const id = new ObjectId();
            const nextId = new ObjectId();
            await db.collection('b.chunks').insertMany([
                ...[-1, 0, 1].map((n) => ({ files_id: id, n, data: Buffer.from('DATA') })),
                { files_id: nextId, n: 0, data: Buffer.from('NEXT') },
            ]);
            const first = await inspectGridFSOrphans({ db, bucket: 'b', pageSize: 1, maxFindings: 1 });
            assert.deepEqual(first.findings, [{
                filesId: id.toHexString(), chunkCount: 3, minN: -1, maxN: 1, classification: 'candidate_orphan',
            }]);
            assert.equal(first.truncated, true);
            const resumed = await inspectGridFSOrphans({ db, bucket: 'b', pageSize: 1, maxFindings: 1, after: first.resumeAfter });
            assert.equal(resumed.truncated, false);
            assert.equal(resumed.findings[0].filesId, nextId.toHexString());
            assert.equal(await db.collection('b.chunks').countDocuments(), 4);
        });
    });

    it('caps findings, streams results, and resumes a large-cardinality scan without deleting', async () => {
        await withDb(async (db) => {
            const total = 250;
            const ids = Array.from({ length: total }, () => new ObjectId());
            ids.sort((left, right) => left.toString().localeCompare(right.toString()));
            await db.collection('b.chunks').insertMany(ids.map((id) => ({
                files_id: id, n: 0, data: Buffer.from('DATA'),
            })));
            const streamed: string[] = [];
            const first = await inspectGridFSOrphans({
                db, bucket: 'b', pageSize: 11, maxFindings: 40,
                onFinding: (row: { filesId: string }) => { streamed.push(row.filesId); },
            });
            assert.equal(first.filesIdsScanned, 40);
            assert.equal(first.findings.length, 40);
            assert.equal(first.truncated, true);
            assert.ok(first.resumeAfter?.filesId);
            assert.equal(streamed.length, 40);
            assert.equal(first.candidateOrphans, 40);
            const second = await inspectGridFSOrphans({
                db, bucket: 'b', pageSize: 11, maxFindings: 40, after: first.resumeAfter,
                collectFindings: false,
                onFinding: (row: { filesId: string }) => { streamed.push(row.filesId); },
            });
            assert.equal(second.findings, undefined);
            assert.equal(second.filesIdsScanned, 40);
            assert.equal(second.truncated, true);
            const rest = await inspectGridFSOrphans({
                db, bucket: 'b', pageSize: 17, maxFindings: 200, after: second.resumeAfter,
            });
            assert.equal(rest.truncated, false);
            assert.equal(rest.resumeAfter, null);
            assert.equal(first.filesIdsScanned + second.filesIdsScanned + rest.filesIdsScanned, total);
            // streamed includes first+second pages; rest.findings is the remainder
            const all = new Set([
                ...first.findings.map((row: { filesId: string }) => row.filesId),
                ...streamed.slice(40),
                ...rest.findings.map((row: { filesId: string }) => row.filesId),
            ]);
            assert.equal(all.size, total);
            assert.equal(await db.collection('b.chunks').countDocuments(), total);
        });
    });
});
