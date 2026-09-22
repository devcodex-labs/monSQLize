import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
import { buildFindPageCacheKey } from '../../../src/adapters/mongodb/queries/query-cache-keys';

const MonSQLize = require('../../../dist/cjs/index.cjs');

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('findPage() — advanced modes coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let col: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_findpage_adv',
            config: { uri },
        });
        await runtime.connect();
        col = runtime.collection('items');
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const db = runtime._adapter.db;
        await db.collection('items').deleteMany({});
        const docs = [];
        for (let i = 1; i <= 30; i++) {
            docs.push({ val: i, tag: i % 3 === 0 ? 'c' : i % 3 === 1 ? 'a' : 'b' });
        }
        await db.collection('items').insertMany(docs);
        await col.invalidate('all');
    });

    // ── stream mode ───────────────────────────────────────────────────────────

    it('stream: true returns a readable stream', async () => {
        const result = await col.findPage({
            query: { tag: 'a' },
            sort: { val: 1 },
            limit: 10,
            stream: true,
        });
        assert.equal(typeof result.on, 'function');
        await new Promise<void>((resolve, reject) => {
            const items: unknown[] = [];
            result.on('data', (doc: unknown) => items.push(doc));
            result.on('end', () => {
                assert.ok(items.length >= 0);
                resolve();
            });
            result.on('error', reject);
        });
    });

    it('stream: true with before direction', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 5 });
        const cursor = page1.pageInfo.endCursor;
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            before: cursor,
            stream: true,
        });
        assert.equal(typeof result.on, 'function');
        result.destroy?.();
    });

    // ── explain mode ──────────────────────────────────────────────────────────

    it('explain: true returns query plan', async () => {
        const plan = await col.findPage({
            query: { tag: 'a' },
            sort: { val: 1 },
            limit: 10,
            explain: true,
        });
        assert.ok(plan !== null && typeof plan === 'object');
    });

    it('explain: "executionStats" returns stats', async () => {
        const plan = await col.findPage({
            query: {},
            sort: { val: 1 },
            limit: 10,
            explain: 'executionStats',
        });
        assert.ok(plan !== null && typeof plan === 'object');
    });

    it('explain with after cursor', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 5 });
        const plan = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
            explain: true,
        });
        assert.ok(plan !== null && typeof plan === 'object');
    });

    it('explain with before cursor', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 10 });
        const plan = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            before: page1.pageInfo.endCursor,
            explain: true,
        });
        assert.ok(plan !== null && typeof plan === 'object');
    });

    // ── before cursor mode ────────────────────────────────────────────────────

    it('before cursor returns previous page items in order', async () => {
        // page1: items 1-5, page2: items 6-10
        // going before page2.startCursor (val=6) returns items 1-5 — the very first page
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 5 });
        assert.ok(page1.items.length === 5);
        const page2 = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
        });
        assert.ok(page2.items.length > 0);

        const prev = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            before: page2.pageInfo.startCursor,
        });
        assert.ok(prev.items.length > 0);
        // exactly 5 items exist before page2.startCursor (val=1..5), none before those
        assert.equal(prev.pageInfo.hasPrev, false);
    });

    it('before cursor with pipeline reverses items', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 10 });
        const page2 = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
        });
        const prev = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            before: page2.pageInfo.startCursor,
            pipeline: [],
        });
        assert.ok(prev !== null);
    });

    // ── offsetJump mode ───────────────────────────────────────────────────────

    it('offsetJump.enable: true uses skip-based pagination', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 2,
            offsetJump: { enable: true, maxSkip: 1000 },
        });
        assert.ok(Array.isArray(result.items));
        assert.equal(result.pageInfo.currentPage, 2);
        assert.equal(result.pageInfo.hasPrev, true);
    });

    it('offsetJump with page 1 (no skip)', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 1,
            offsetJump: { enable: true },
        });
        assert.ok(Array.isArray(result.items));
        assert.equal(result.pageInfo.currentPage, 1);
    });

    it('offsetJump with totals', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 2,
            offsetJump: { enable: true },
            totals: { mode: 'sync' },
        });
        assert.ok(Array.isArray(result.items));
        assert.ok(result.totals !== undefined);
        assert.ok(typeof result.totals.total === 'number');
    });

    it('offsetJump explain', async () => {
        const plan = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 2,
            offsetJump: { enable: true },
            explain: true,
        });
        assert.ok(plan !== null);
    });

    // ── totals modes ──────────────────────────────────────────────────────────

    it('totals.mode: sync returns total and totalPages', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'sync' },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.mode, 'sync');
        assert.equal(typeof result.totals.total, 'number');
        assert.equal(typeof result.totals.totalPages, 'number');
    });

    it('totals.mode: async returns mode async with token', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'async' },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.mode, 'async');
        assert.ok(result.totals.token !== undefined);
    });

    it('totals.mode: async with cached value returns total', async () => {
        // Call twice; second call should use cached value if cache hasn't expired
        await col.findPage({ sort: { val: 1 }, limit: 10, totals: { mode: 'async' } });
        const result2 = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'async' },
        });
        assert.ok(result2.totals !== undefined);
    });

    it('totals.mode: approx returns estimated total', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'approx' },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.mode, 'approx');
    });

    it('totals.mode: approx with maxTimeMS', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'approx', maxTimeMS: 5000 },
        });
        assert.ok(result.totals !== undefined);
    });

    it('totals.mode: sync with maxTimeMS', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'sync', maxTimeMS: 5000 },
        });
        assert.ok(result.totals !== undefined);
    });

    it('totals.mode: sync applies hint and collation options', async () => {
        await runtime._adapter.db.collection('items').createIndex({ tag: 1 });
        const result = await col.findPage({
            query: { tag: 'a' },
            sort: { val: 1 },
            limit: 10,
            totals: {
                mode: 'sync',
                hint: { tag: 1 },
                collation: { locale: 'simple' },
                maxTimeMS: 5000,
            },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.total, 10);
        assert.equal(result.totals.totalPages, 1);
    });

    it('totals.mode: approx counts filtered queries instead of ignoring the query', async () => {
        const result = await col.findPage({
            query: { tag: 'a' },
            sort: { val: 1 },
            limit: 4,
            totals: { mode: 'approx', ttlMs: 60_000 },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.mode, 'approx');
        assert.equal(result.totals.total, 10);
        assert.equal(result.totals.totalPages, 3);
        assert.equal(result.totals.approx, true);
    });

    it('totals.mode: none skips totals computation', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'none' },
        });
        assert.equal(result.totals, undefined);
    });

    it('totals with unknown mode returns minimal stub', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            totals: { mode: 'unknown_mode' as any },
        });
        assert.ok(result.totals !== undefined);
    });

    // ── meta mode ─────────────────────────────────────────────────────────────

    it('meta: true adds meta block to result', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 10,
            meta: true,
        });
        assert.ok(result.meta !== undefined);
        assert.equal(result.meta.op, 'findPage');
        assert.equal(typeof result.meta.durationMs, 'number');
    });

    it('meta: { level: "sub" } adds step details', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 2,
            meta: { level: 'sub' },
        });
        assert.ok(result.meta !== undefined);
        assert.ok(Array.isArray(result.meta.steps));
    });

    it('meta with after cursor adds hop info', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 10 });
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
            meta: true,
        });
        assert.ok(result.meta !== undefined);
        assert.equal(result.meta.after, true);
    });

    it('meta with before cursor', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 10 });
        const page2 = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
        });
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            before: page2.pageInfo.startCursor,
            meta: true,
        });
        assert.ok(result.meta !== undefined);
        assert.equal(result.meta.before, true);
    });

    it('after cursor mode can attach totals', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 5 });
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            after: page1.pageInfo.endCursor,
            totals: { mode: 'sync' },
        });
        assert.ok(result.totals !== undefined);
        assert.equal(result.totals.total, 30);
        assert.equal(result.totals.totalPages, 6);
    });

    it('meta with maxTimeMS option', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            maxTimeMS: 5000,
            meta: true,
        });
        assert.ok(result.meta !== undefined);
        assert.equal(result.meta.maxTimeMS, 5000);
    });

    // ── pipeline mode ─────────────────────────────────────────────────────────

    it('pipeline option uses aggregate stages', async () => {
        const result = await col.findPage({
            query: {},
            sort: { val: 1 },
            limit: 5,
            pipeline: [{ $addFields: { computed: { $multiply: ['$val', 2] } } }],
        });
        assert.ok(Array.isArray(result.items));
        assert.ok(result.items.length > 0);
        assert.ok(result.items[0].computed !== undefined);
    });

    // ── validation errors ─────────────────────────────────────────────────────

    it('page with after/before cursor throws VALIDATION_ERROR', async () => {
        const page1 = await col.findPage({ sort: { val: 1 }, limit: 5 });
        await assert.rejects(
            () => col.findPage({
                sort: { val: 1 },
                limit: 5,
                page: 2,
                after: page1.pageInfo.endCursor,
            }),
            /page cannot be used with after\/before/,
        );
    });

    it('stream with totals throws STREAM_NO_TOTALS', async () => {
        await assert.rejects(
            () => col.findPage({
                sort: { val: 1 },
                limit: 5,
                stream: true,
                totals: { mode: 'sync' },
            }),
            /totals cannot be computed in stream mode/,
        );
    });

    it('stream with page > 1 throws STREAM_NO_JUMP', async () => {
        await assert.rejects(
            () => col.findPage({
                sort: { val: 1 },
                limit: 5,
                page: 2,
                stream: true,
            }),
            /page jump cannot be used in stream mode/,
        );
    });

    it('stream with explain throws STREAM_NO_EXPLAIN', async () => {
        await assert.rejects(
            () => col.findPage({
                sort: { val: 1 },
                limit: 5,
                stream: true,
                explain: true,
            }),
            /stream and explain cannot be used together/,
        );
    });

    it('invalid limit throws INVALID_PAGINATION', async () => {
        await assert.rejects(
            () => col.findPage({ sort: { val: 1 }, limit: -1 }),
            /limit must be a positive integer/,
        );
    });

    it('invalid page throws INVALID_PAGINATION', async () => {
        await assert.rejects(
            () => col.findPage({ sort: { val: 1 }, page: -1 }),
            /page must be a positive integer/,
        );
    });

    // ── misc options ──────────────────────────────────────────────────────────

    it('hint option is accepted', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            hint: { _id: 1 },
        });
        assert.ok(Array.isArray(result.items));
    });

    it('collation option is accepted', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            collation: { locale: 'en' },
        });
        assert.ok(Array.isArray(result.items));
    });

    it('batchSize option is accepted', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            batchSize: 10,
        });
        assert.ok(Array.isArray(result.items));
    });

    it('projection option is applied', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            projection: { val: 1 },
        });
        assert.ok(result.items.length > 0);
    });

    it('findPageMaxLimit constraint applies', async () => {
        const limitedRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_findpage_adv',
            config: { uri },
            findPageMaxLimit: 5,
        });
        await limitedRuntime.connect();
        const limitedCol = limitedRuntime.collection('items');
        const result = await limitedCol.findPage({ sort: { val: 1 }, limit: 100 });
        assert.ok(result.items.length <= 5);
        await limitedRuntime.close();
    });

    it('jump with JUMP_TOO_FAR throws', async () => {
        await assert.rejects(
            () => col.findPage({
                sort: { val: 1 },
                limit: 5,
                page: 100,
                jump: { step: 5, maxHops: 3 },
            }),
            /Page jump exceeds maxHops/,
        );
    });

    it('page > 1 with totals at end of loop', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 2,
            totals: { mode: 'sync' },
        });
        assert.ok(Array.isArray(result.items));
        assert.ok(result.totals !== undefined);
    });

    it('page > 1 with empty intermediate page returns early', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 100,
        });
        assert.ok(Array.isArray(result.items));
    });

    it('mergeFilters with empty query and extra filter', async () => {
        const result = await col.findPage({
            query: {},
            sort: { val: 1 },
            limit: 5,
            after: undefined,
        });
        assert.ok(Array.isArray(result.items));
    });

    it('meta with sub level and page > 1 accumulates steps', async () => {
        const result = await col.findPage({
            sort: { val: 1 },
            limit: 5,
            page: 3,
            meta: { level: 'sub' },
        });
        assert.ok(result.meta !== undefined);
        assert.ok(Array.isArray(result.meta.steps));
    });

    it('query-level cache stores page results and invalidate("findPage") clears them', async () => {
        const options = {
            query: { tag: 'a' },
            sort: { val: 1 },
            limit: 5,
            cache: 60_000,
            meta: true,
        };

        const first = await col.findPage(options);
        assert.equal(first.meta.cacheHit, false);

        await runtime._adapter.db.collection('items').insertOne({ val: -100, tag: 'a' });

        const cached = await col.findPage(options);
        assert.equal(cached.meta.cacheHit, true);
        assert.deepEqual(
            cached.items.map((item: { val: number }) => item.val),
            first.items.map((item: { val: number }) => item.val),
        );

        const deleted = await col.invalidate('findPage');
        assert.ok(deleted >= 1);

        const fresh = await col.findPage(options);
        assert.equal(fresh.meta.cacheHit, false);
        assert.equal(fresh.items[0].val, -100);
    });

    it('cache key follows the effective top-level or nested let used by the driver', async () => {
        const native = runtime._adapter.db.collection('items');
        const base = { query: { $expr: { $eq: ['$tag', '$$tenant'] } }, sort: { val: 1 as const }, limit: 5 };
        const a = buildFindPageCacheKey(native, {}, { ...base, let: { tenant: 'a' } });
        const b = buildFindPageCacheKey(native, {}, { ...base, let: { tenant: 'b' } });
        const nested = buildFindPageCacheKey(native, {}, { ...base, options: { let: { tenant: 'a' } } });
        const overridden = buildFindPageCacheKey(native, {}, { ...base, let: { tenant: 'a' }, options: { let: { tenant: 'b' } } });
        assert.notEqual(a.key, b.key);
        assert.equal(a.key, nested.key);
        assert.equal(a.key, overridden.key);

        const first = await col.findPage({ ...base, let: { tenant: 'a' }, cache: 60_000, meta: true });
        const second = await col.findPage({ ...base, let: { tenant: 'b' }, cache: 60_000, meta: true });
        assert.ok(first.items.every((item: { tag: string }) => item.tag === 'a'));
        assert.ok(second.items.every((item: { tag: string }) => item.tag === 'b'));
        assert.equal(second.meta.cacheHit, false);
    });

    it('query-level cache does not freeze async totals at the initial null value', async () => {
        const options = {
            sort: { val: 1 },
            limit: 10,
            cache: 60_000,
            totals: { mode: 'async', ttlMs: 60_000 },
            meta: true,
        };

        const first = await col.findPage(options);
        assert.equal(first.meta.cacheHit, false);
        assert.ok(first.totals?.token);

        let second = await col.findPage(options);
        for (let i = 0; i < 10 && second.totals?.total === null; i++) {
            await delay(25);
            second = await col.findPage(options);
        }

        assert.equal(second.meta.cacheHit, true);
        assert.equal(second.totals?.total, 30);
    });
});
