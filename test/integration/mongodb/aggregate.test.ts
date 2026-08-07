import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type Product = {
    _id?: unknown;
    sku: string;
    category: string;
    price: number;
    stock: number;
    rating: number;
    active: boolean;
};

describe('aggregate() / distinct() / count() / explain()', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let col: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_aggregate',
            config: { uri },
            findLimit: 200,
        });
        await runtime.connect();
        col = runtime.collection('products');
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const db = runtime._adapter.db;
        await db.collection('products').deleteMany({});
        await db.collection('product_summary').deleteMany({});
        await db.collection('product_summary_no_invalidate').deleteMany({});
        await Promise.all([
            'lookup_users',
            'lookup_orders',
            'lookup_authors',
            'lookup_articles',
            'lookup_students',
            'lookup_enrollments',
            'lookup_courses',
        ].map((name) => db.collection(name).deleteMany({})));

        const categories = ['electronics', 'clothing', 'food'];
        const docs: Omit<Product, '_id'>[] = [];
        for (let i = 1; i <= 60; i++) {
            docs.push({
                sku: `SKU-${String(i).padStart(4, '0')}`,
                category: categories[(i - 1) % 3],
                price: i * 10,
                stock: (i % 10) * 5,
                rating: ((i % 5) + 1),
                active: i % 4 !== 0,
            });
        }
        await db.collection('products').insertMany(docs);
    });

    // ── aggregate() ───────────────────────────────────────────────────────────

    describe('aggregate() basic results', () => {
        it('returns all documents via $match all', async () => {
            const results = await col.aggregate([{ $match: {} }]);
            assert.ok(Array.isArray(results));
            assert.equal(results.length, 60);
        });

        it('$match filters documents', async () => {
            const results = await col.aggregate([{ $match: { category: 'electronics' } }]);
            assert.ok(results.length > 0);
            for (const doc of results) {
                assert.equal(doc.category, 'electronics');
            }
        });

        it('$group produces grouped results', async () => {
            const results = await col.aggregate([
                { $group: { _id: '$category', total: { $sum: 1 } } },
            ]);
            assert.equal(results.length, 3);
            for (const doc of results) {
                assert.ok(typeof doc._id === 'string');
                assert.ok(typeof doc.total === 'number');
                assert.ok(doc.total > 0);
            }
        });

        it('$sort + $limit pipeline', async () => {
            const results = await col.aggregate([
                { $sort: { price: -1 } },
                { $limit: 5 },
            ]);
            assert.equal(results.length, 5);
            for (let i = 1; i < results.length; i++) {
                assert.ok(results[i - 1].price >= results[i].price);
            }
        });

        it('$project reshapes documents', async () => {
            const results = await col.aggregate([
                { $match: { category: 'food' } },
                { $project: { sku: 1, price: 1, _id: 0 } },
                { $limit: 3 },
            ]);
            assert.ok(results.length > 0);
            for (const doc of results) {
                assert.ok(typeof doc.sku === 'string');
                assert.ok(typeof doc.price === 'number');
                assert.equal(doc._id, undefined);
                assert.equal(doc.category, undefined);
            }
        });

        it('returns empty array when nothing matches', async () => {
            const results = await col.aggregate([{ $match: { category: 'nonexistent' } }]);
            assert.deepEqual(results, []);
        });

        it('empty pipeline returns all documents', async () => {
            const results = await col.aggregate([]);
            assert.equal(results.length, 60);
        });

        it('$count stage counts matching documents', async () => {
            const results = await col.aggregate([
                { $match: { active: true } },
                { $count: 'total' },
            ]);
            assert.equal(results.length, 1);
            assert.ok(typeof results[0].total === 'number');
            assert.ok(results[0].total > 0);
        });
    });

    describe('aggregate() chain API', () => {
        it('toArray() executes and returns array', async () => {
            const results = await col.aggregate([{ $match: { category: 'clothing' } }]).toArray();
            assert.ok(Array.isArray(results));
            assert.ok(results.length > 0);
        });

        it('hint option is accepted without error', async () => {
            const results = await col.aggregate([{ $match: {} }]).hint({ _id: 1 }).toArray();
            assert.equal(results.length, 60);
        });

        it('maxTimeMS option is accepted without error', async () => {
            const results = await col.aggregate([]).maxTimeMS(5000).toArray();
            assert.equal(results.length, 60);
        });

        it('allowDiskUse option is accepted without error', async () => {
            const results = await col.aggregate([{ $sort: { price: 1 } }]).allowDiskUse(true).toArray();
            assert.equal(results.length, 60);
        });

        it('comment option is accepted without error', async () => {
            const results = await col.aggregate([{ $limit: 5 }]).comment('test query').toArray();
            assert.equal(results.length, 5);
        });

        it('batchSize option is accepted without error', async () => {
            const results = await col.aggregate([]).batchSize(10).toArray();
            assert.equal(results.length, 60);
        });

        it('chained options work together', async () => {
            const results = await col.aggregate([
                { $match: { active: true } },
                { $sort: { price: 1 } },
                { $limit: 5 },
            ]).maxTimeMS(5000).allowDiskUse(false).toArray();
            assert.equal(results.length, 5);
        });
    });

    describe('aggregate() explain', () => {
        it('chain .explain() returns queryPlanner', async () => {
            const plan = await col.aggregate([{ $match: { category: 'electronics' } }]).explain();
            assert.ok(plan !== null && typeof plan === 'object');
            assert.ok('queryPlanner' in plan || 'stages' in plan || 'command' in plan);
        });

        it('chain .explain("executionStats") returns executionStats', async () => {
            const plan = await col.aggregate([{ $match: {} }]).explain('executionStats');
            assert.ok(plan !== null && typeof plan === 'object');
        });

        it('{ explain: true } option in then() returns plan', async () => {
            const result = await col.aggregate([{ $match: {} }], { explain: true });
            assert.ok(result !== null && typeof result === 'object');
        });

        it('supports cache option and aggregate invalidation', async () => {
            const db = runtime._adapter.db;
            const pipeline = [
                { $match: { category: 'electronics' } },
                { $group: { _id: null, total: { $sum: 1 } } },
            ];

            const first = await col.aggregate(pipeline, { cache: 60_000 });
            assert.equal(first[0].total, 20);

            await db.collection('products').insertOne({
                sku: 'SKU-CACHE-AGG',
                category: 'electronics',
                price: 1,
                stock: 1,
                rating: 5,
                active: true,
            });

            const second = await col.aggregate(pipeline, { cache: 60_000 });
            assert.equal(second[0].total, 20);

            await col.invalidate('aggregate');
            const third = await col.aggregate(pipeline, { cache: 60_000 });
            assert.equal(third[0].total, 21);
        });

        it('direct .toArray() honors aggregate cache option', async () => {
            const db = runtime._adapter.db;
            const pipeline = [
                { $match: { category: 'clothing' } },
                { $group: { _id: null, total: { $sum: 1 } } },
            ];

            const first = await col.aggregate(pipeline, { cache: 60_000 }).toArray();
            assert.equal(first[0].total, 20);

            await db.collection('products').insertOne({
                sku: 'SKU-CACHE-AGG-TOARRAY',
                category: 'clothing',
                price: 1,
                stock: 1,
                rating: 5,
                active: true,
            });

            const second = await col.aggregate(pipeline, { cache: 60_000 }).toArray();
            assert.equal(second[0].total, 20);
        });

        it('direct .toArray() honors aggregate meta option', async () => {
            const result = await col.aggregate([{ $match: { category: 'food' } }], { meta: true }).toArray() as any;
            assert.ok(Array.isArray(result.data));
            assert.equal(result.meta.op, 'aggregate');
            assert.equal(result.meta.ns.coll, 'products');
        });

        it('keeps target collection cache after $merge without explicit invalidation', async () => {
            const db = runtime._adapter.db;
            const summary = runtime.collection('product_summary_no_invalidate');
            await db.collection('product_summary_no_invalidate').insertOne({ _id: 'electronics', total: 1 });

            const first = await summary.find({ _id: 'electronics' }, { cache: 60_000 });
            assert.equal(first[0].total, 1);

            await col.aggregate([
                { $match: { category: 'electronics' } },
                { $group: { _id: '$category', total: { $sum: 1 } } },
                { $merge: { into: 'product_summary_no_invalidate', on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
            ], { cache: 60_000 });

            const second = await summary.find({ _id: 'electronics' }, { cache: 60_000 });
            assert.equal(second[0].total, 1);
        });

        it('invalidates target collection cache after $merge with explicit cache.invalidate', async () => {
            const db = runtime._adapter.db;
            const summary = runtime.collection('product_summary');
            await db.collection('product_summary').insertOne({ _id: 'electronics', total: 1 });

            const first = await summary.find({ _id: 'electronics' }, { cache: 60_000 });
            assert.equal(first[0].total, 1);

            await col.aggregate([
                { $match: { category: 'electronics' } },
                { $group: { _id: '$category', total: { $sum: 1 } } },
                { $merge: { into: 'product_summary', on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } },
            ], {
                cache: {
                    invalidate: [{
                        operation: 'find',
                        query: { _id: 'electronics' },
                        options: { cache: 60_000 },
                    }],
                },
            });

            const second = await summary.find({ _id: 'electronics' }, { cache: 60_000 });
            assert.equal(second[0].total, 20);
        });
    });

    describe('aggregate() $lookup relation pipelines', () => {
        it('supports one-to-one lookup with $unwind', async () => {
            const db = runtime._adapter.db;
            await db.collection('lookup_users').insertOne({ _id: 'user-1', name: 'Ada' });
            await db.collection('lookup_orders').insertOne({ _id: 'order-1', userId: 'user-1', total: 42 });

            const result = await runtime.collection('lookup_orders').aggregate([
                { $lookup: { from: 'lookup_users', localField: 'userId', foreignField: '_id', as: 'user' } },
                { $unwind: '$user' },
                { $project: { _id: 0, total: 1, userName: '$user.name' } },
            ]);

            assert.deepEqual(result, [{ total: 42, userName: 'Ada' }]);
        });

        it('keeps one-to-many lookup results as arrays and supports let pipelines', async () => {
            const db = runtime._adapter.db;
            await db.collection('lookup_authors').insertOne({ _id: 'author-1', name: 'Grace' });
            await db.collection('lookup_articles').insertMany([
                { _id: 'article-1', authorId: 'author-1', title: 'First', published: true, rank: 1 },
                { _id: 'article-2', authorId: 'author-1', title: 'Second', published: true, rank: 3 },
                { _id: 'article-3', authorId: 'author-1', title: 'Draft', published: false, rank: 4 },
                { _id: 'article-4', authorId: 'author-1', title: 'Third', published: true, rank: 2 },
            ]);

            const result = await runtime.collection('lookup_authors').aggregate([
                { $match: { _id: 'author-1' } },
                {
                    $lookup: {
                        from: 'lookup_articles',
                        let: { authorId: '$_id' },
                        pipeline: [
                            { $match: { $expr: { $eq: ['$authorId', '$$authorId'] }, published: true } },
                            { $project: { _id: 0, title: 1, rank: 1 } },
                            { $sort: { rank: -1 } },
                            { $limit: 2 },
                        ],
                        as: 'articles',
                    },
                },
                { $project: { _id: 0, name: 1, articles: 1 } },
            ]);

            assert.deepEqual(result, [{
                name: 'Grace',
                articles: [
                    { title: 'Second', rank: 3 },
                    { title: 'Third', rank: 2 },
                ],
            }]);
        });

        it('supports many-to-many traversal through a junction collection', async () => {
            const db = runtime._adapter.db;
            await db.collection('lookup_students').insertOne({ _id: 'student-1', name: 'Lin' });
            await db.collection('lookup_courses').insertMany([
                { _id: 'course-1', title: 'Databases' },
                { _id: 'course-2', title: 'Search' },
            ]);
            await db.collection('lookup_enrollments').insertMany([
                { _id: 'enrollment-1', studentId: 'student-1', courseId: 'course-2' },
                { _id: 'enrollment-2', studentId: 'student-1', courseId: 'course-1' },
            ]);

            const result = await runtime.collection('lookup_students').aggregate([
                { $match: { _id: 'student-1' } },
                { $lookup: { from: 'lookup_enrollments', localField: '_id', foreignField: 'studentId', as: 'enrollments' } },
                { $unwind: '$enrollments' },
                { $lookup: { from: 'lookup_courses', localField: 'enrollments.courseId', foreignField: '_id', as: 'course' } },
                { $unwind: '$course' },
                { $sort: { 'course.title': 1 } },
                { $group: { _id: '$name', courses: { $push: '$course.title' } } },
                { $project: { _id: 0, name: '$_id', courses: 1 } },
            ]);

            assert.deepEqual(result, [{ name: 'Lin', courses: ['Databases', 'Search'] }]);
        });
    });

    // ── distinct() ────────────────────────────────────────────────────────────

    describe('distinct() basic results', () => {
        it('returns distinct values for a field', async () => {
            const values = await col.distinct('category');
            assert.ok(Array.isArray(values));
            assert.equal(values.length, 3);
            assert.ok(values.includes('electronics'));
            assert.ok(values.includes('clothing'));
            assert.ok(values.includes('food'));
        });

        it('returns sorted or unsorted distinct values', async () => {
            const values = await col.distinct('rating');
            assert.ok(Array.isArray(values));
            assert.equal(new Set(values).size, values.length);
        });

        it('filters with query parameter', async () => {
            const values = await col.distinct('category', { active: true });
            assert.ok(Array.isArray(values));
            for (const v of values) {
                assert.ok(typeof v === 'string');
            }
        });

        it('returns empty array when query matches nothing', async () => {
            const values = await col.distinct('category', { category: 'nonexistent' });
            assert.deepEqual(values, []);
        });

        it('distinct on numeric field', async () => {
            const values = await col.distinct('rating');
            for (const v of values) {
                assert.ok(typeof v === 'number');
            }
        });

        it('distinct with maxTimeMS option is accepted without error', async () => {
            const values = await col.distinct('category', {}, { maxTimeMS: 5000 });
            assert.ok(Array.isArray(values));
            assert.equal(values.length, 3);
        });

        it('supports cache option and distinct invalidation', async () => {
            const db = runtime._adapter.db;

            const first = await col.distinct('category', {}, { cache: 60_000 });
            assert.equal(first.includes('books'), false);

            await db.collection('products').insertOne({
                sku: 'SKU-CACHE-DISTINCT',
                category: 'books',
                price: 1,
                stock: 1,
                rating: 5,
                active: true,
            });

            const second = await col.distinct('category', {}, { cache: 60_000 });
            assert.equal(second.includes('books'), false);

            await col.invalidate('distinct');
            const third = await col.distinct('category', {}, { cache: 60_000 });
            assert.equal(third.includes('books'), true);
        });
    });

    // ── count() ───────────────────────────────────────────────────────────────

    describe('count() basic results', () => {
        it('empty query uses estimatedDocumentCount (all documents)', async () => {
            const n = await col.count();
            assert.equal(n, 60);
        });

        it('empty object query also returns all documents', async () => {
            const n = await col.count({});
            assert.equal(n, 60);
        });

        it('counts documents matching a filter', async () => {
            const n = await col.count({ category: 'electronics' });
            assert.ok(n > 0);
            assert.ok(n < 60);
            assert.equal(n, 20);
        });

        it('returns 0 when no documents match', async () => {
            const n = await col.count({ category: 'nonexistent' });
            assert.equal(n, 0);
        });

        it('respects skip option', async () => {
            const total = await col.count({ category: 'food' });
            const skipped = await col.count({ category: 'food' }, { skip: 5 });
            assert.equal(skipped, Math.max(0, total - 5));
        });

        it('respects limit option', async () => {
            const limited = await col.count({ category: 'clothing' }, { limit: 5 });
            assert.equal(limited, 5);
        });

        it('supports maxTimeMS option', async () => {
            const n = await col.count({ active: true }, { maxTimeMS: 5000 });
            assert.ok(typeof n === 'number');
            assert.ok(n > 0);
        });

        it('supports cache option', async () => {
            const first = await col.count({ category: 'electronics' }, { cache: 60_000 });
            const second = await col.count({ category: 'electronics' }, { cache: 60_000 });
            assert.equal(first, second);
            assert.equal(first, 20);
        });
    });

    describe('count() explain mode', () => {
        it('explain: true on empty query returns synthetic plan', async () => {
            const plan = await col.count({}, { explain: true });
            assert.ok(plan !== null && typeof plan === 'object');
        });

        it('explain: true on filtered query returns aggregate plan', async () => {
            const plan = await col.count({ category: 'electronics' }, { explain: true });
            assert.ok(plan !== null && typeof plan === 'object');
        });

        it('explain: "executionStats" on filtered query returns plan', async () => {
            const plan = await col.count({ active: true }, { explain: 'executionStats' });
            assert.ok(plan !== null && typeof plan === 'object');
        });
    });

    // ── explain() ─────────────────────────────────────────────────────────────

    describe('explain() standalone method', () => {
        it('returns queryPlanner for a simple filter', async () => {
            const plan = await col.explain({ category: 'electronics' });
            assert.ok(plan !== null && typeof plan === 'object');
            assert.ok('queryPlanner' in plan);
        });

        it('returns queryPlanner for empty filter', async () => {
            const plan = await col.explain({});
            assert.ok('queryPlanner' in plan);
        });

        it('accepts explain: "executionStats" option', async () => {
            const plan = await col.explain({ active: true }, { explain: 'executionStats' });
            assert.ok('executionStats' in plan);
        });

        it('returns queryPlanner for no arguments', async () => {
            const plan = await col.explain();
            assert.ok(plan !== null && typeof plan === 'object');
            assert.ok('queryPlanner' in plan);
        });

        it('maxTimeMS is accepted without error', async () => {
            const plan = await col.explain({ category: 'food' }, { maxTimeMS: 5000 });
            assert.ok('queryPlanner' in plan);
        });
    });
});
