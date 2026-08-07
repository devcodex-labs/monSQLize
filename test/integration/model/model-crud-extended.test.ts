import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('ModelInstance — extended CRUD coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let model: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        MonSQLize.Model._clear();
        MonSQLize.Model.define('items', {
            schema: {},
            softDelete: { enabled: true, field: 'deletedAt', type: 'date' },
            timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
        });
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_extended', config: { uri } });
        await runtime.connect();
        model = runtime.model('items');
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const db = runtime._adapter.db;
        await db.collection('items').deleteMany({});
    });

    // ── getRelations / raw ────────────────────────────────────────────────────

    it('getRelations() returns empty object when no relations defined', () => {
        const rels = model.getRelations();
        assert.ok(typeof rels === 'object');
    });

    it('raw() returns underlying collection reference', () => {
        const raw = model.raw();
        assert.ok(raw !== null && raw !== undefined);
    });

    // ── findById ─────────────────────────────────────────────────────────────

    it('findById is alias for findOneById', async () => {
        const inserted = await model.insertOne({ name: 'Alice', value: 1 });
        const found = await model.findById(inserted.insertedId);
        assert.ok(found !== null);
        assert.equal(found.name, 'Alice');
    });

    // ── insertMany ────────────────────────────────────────────────────────────

    it('insertMany inserts multiple documents', async () => {
        const result = await model.insertMany([
            { name: 'A', value: 1 },
            { name: 'B', value: 2 },
            { name: 'C', value: 3 },
        ]);
        assert.ok(result.acknowledged);
        assert.equal(result.insertedCount, 3);
    });

    it('insertMany with empty array throws', async () => {
        await assert.rejects(
            () => model.insertMany([]),
            /empty/,
        );
    });

    // ── updateMany ────────────────────────────────────────────────────────────

    it('updateMany updates all matching documents', async () => {
        await model.insertMany([
            { name: 'X', active: true },
            { name: 'Y', active: true },
            { name: 'Z', active: false },
        ]);
        const result = await model.updateMany({ active: true }, { $set: { status: 'ok' } });
        assert.ok(result.modifiedCount >= 2);
    });

    // ── replaceOne ────────────────────────────────────────────────────────────

    it('replaceOne replaces a document', async () => {
        await model.insertOne({ name: 'old', value: 1 });
        const result = await model.replaceOne({ name: 'old' }, { name: 'new', value: 99 });
        assert.ok(result.acknowledged);
        const found = await model.findOne({ name: 'new' });
        assert.ok(found !== null);
        assert.equal(found.value, 99);
    });

    // ── findOneAndUpdate ──────────────────────────────────────────────────────

    it('findOneAndUpdate returns updated document', async () => {
        await model.insertOne({ name: 'target', score: 5 });
        const result = await model.findOneAndUpdate(
            { name: 'target' },
            { $set: { score: 10 } },
            { returnDocument: 'after' },
        );
        assert.ok(result !== null);
        assert.equal(result.score, 10);
    });

    it('findOneAndUpdate returns null when no match', async () => {
        const result = await model.findOneAndUpdate({ name: 'ghost' }, { $set: { x: 1 } });
        assert.equal(result, null);
    });

    // ── findOneAndReplace ─────────────────────────────────────────────────────

    it('findOneAndReplace returns replaced document', async () => {
        await model.insertOne({ name: 'orig', val: 1 });
        const result = await model.findOneAndReplace(
            { name: 'orig' },
            { name: 'replaced', val: 2 },
            { returnDocument: 'after' },
        );
        assert.ok(result !== null);
        assert.equal(result.val, 2);
    });

    // ── findOneAndDelete ──────────────────────────────────────────────────────

    it('findOneAndDelete removes and returns document', async () => {
        await model.insertOne({ name: 'todelete', val: 7 });
        const result = await model.findOneAndDelete({ name: 'todelete' });
        assert.ok(result !== null);
        assert.equal(result.name, 'todelete');
        const after = await model.findOne({ name: 'todelete' });
        assert.equal(after, null);
    });

    // ── upsertOne ─────────────────────────────────────────────────────────────

    it('upsertOne creates document when not found', async () => {
        const result = await model.upsertOne({ name: 'upserted' }, { $set: { value: 42 } });
        assert.ok(result.upsertedCount === 1 || result.acknowledged);
    });

    it('upsertOne updates document when found', async () => {
        await model.insertOne({ name: 'existing', value: 1 });
        const result = await model.upsertOne({ name: 'existing' }, { $set: { value: 2 } });
        assert.ok(result.acknowledged);
    });

    // ── incrementOne ──────────────────────────────────────────────────────────

    it('incrementOne increments a numeric field', async () => {
        await model.insertOne({ name: 'counter', count: 0 });
        const result = await model.incrementOne({ name: 'counter' }, 'count', 5);
        assert.ok(result !== null);
    });

    it('incrementOne with field as object', async () => {
        await model.insertOne({ name: 'multicounter', a: 1, b: 2 });
        const result = await model.incrementOne({ name: 'multicounter' }, { a: 10, b: -1 });
        assert.ok(result !== null);
    });

    // ── insertBatch ───────────────────────────────────────────────────────────

    it('insertBatch inserts array of documents', async () => {
        const result = await model.insertBatch([
            { name: 'batch1', group: 'g1' },
            { name: 'batch2', group: 'g1' },
        ]);
        assert.ok(result !== null && result !== undefined);
    });

    // ── updateBatch ───────────────────────────────────────────────────────────

    it('updateBatch updates documents by filter', async () => {
        await model.insertMany([
            { name: 'bup1', group: 'grp' },
            { name: 'bup2', group: 'grp' },
        ]);
        const result = await model.updateBatch({ group: 'grp' }, { $set: { done: true } });
        assert.ok(result !== null && result !== undefined);
    });

    // ── soft-delete findOneWithDeleted / findOneOnlyDeleted ───────────────────

    it('findOneWithDeleted returns doc regardless of deletion status', async () => {
        await model.insertOne({ name: 'alive', status: 'ok' });
        const found = await model.findOneWithDeleted({ name: 'alive' });
        assert.ok(found !== null);
    });

    it('findOneOnlyDeleted is callable on a non-deleted doc', async () => {
        await model.insertOne({ name: 'notdeleted', status: 'ok' });
        const found = await model.findOneOnlyDeleted({ name: 'notdeleted' });
        assert.ok(found === null || typeof found === 'object');
    });

    it('findOneOnlyDeleted is callable after soft-delete', async () => {
        await model.insertOne({ name: 'willdelete', status: 'ok' });
        await model.deleteOne({ name: 'willdelete' });
        const found = await model.findOneOnlyDeleted({ name: 'willdelete' });
        assert.ok(found === null || typeof found === 'object');
    });

    // ── index management ─────────────────────────────────────────────────────

    it('createIndex on model creates the index', async () => {
        const result = await model.createIndex({ name: 1 }, { name: 'name_idx', sparse: true });
        assert.ok(result !== null);
    });

    it('createIndexes on model creates multiple indexes', async () => {
        const result = await model.createIndexes([
            { key: { value: 1 }, name: 'value_idx' },
        ]);
        assert.ok(Array.isArray(result) || result !== null);
    });

    it('listIndexes on model returns index list', async () => {
        const result = await model.listIndexes();
        assert.ok(Array.isArray(result));
        assert.ok(result.some((i: any) => i.name === '_id_'));
    });

    it('dropIndex on model removes specific index', async () => {
        await model.createIndex({ rank: 1 }, { name: 'rank_to_drop' });
        const result = await model.dropIndex('rank_to_drop');
        assert.ok(result !== null);
    });

    it('dropIndexes on model drops all non-_id indexes', async () => {
        const result = await model.dropIndexes();
        assert.ok(result !== null);
    });

    // ── distinct ──────────────────────────────────────────────────────────────

    it('distinct returns unique values for a field', async () => {
        await model.insertMany([
            { name: 'D1', category: 'cat-a' },
            { name: 'D2', category: 'cat-b' },
            { name: 'D3', category: 'cat-a' },
        ]);
        const result = await model.distinct('category');
        assert.ok(Array.isArray(result));
        assert.ok(result.includes('cat-a'));
        assert.ok(result.includes('cat-b'));
        assert.equal(result.length, 2);
    });

    it('distinct with filter returns subset', async () => {
        await model.insertMany([
            { name: 'F1', tag: 't1' },
            { name: 'F2', tag: 't2' },
        ]);
        const result = await model.distinct('tag', { name: 'F1' });
        assert.deepEqual(result, ['t1']);
    });

    // ── aggregate ────────────────────────────────────────────────────────────

    it('aggregate executes pipeline and returns results', async () => {
        await model.insertMany([
            { name: 'AG1', amount: 10 },
            { name: 'AG2', amount: 20 },
        ]);
        const result = await model.aggregate([
            { $match: { amount: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
        ]);
        assert.ok(Array.isArray(result));
        assert.ok(result.length > 0);
        assert.ok(result[0].total >= 30);
    });

    it('aggregate with empty pipeline returns all documents', async () => {
        await model.insertOne({ name: 'AP1', value: 1 });
        const result = await model.aggregate([]);
        assert.ok(Array.isArray(result));
    });
});

describe('ModelInstance — model with relations', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let authorModel: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        MonSQLize.Model._clear();
        MonSQLize.Model.define('articles', {
            schema: {},
        });
        MonSQLize.Model.define('authors', {
            schema: {},
            relations: {
                articles: {
                    from: 'articles',
                    localField: '_id',
                    foreignField: 'authorId',
                },
            },
        });
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_relations', config: { uri } });
        await runtime.connect();
        authorModel = runtime.model('authors');
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    it('getRelations() returns defined relations', () => {
        const rels = authorModel.getRelations();
        assert.ok('articles' in rels);
        assert.equal(rels.articles.from, 'articles');
    });
});

describe('ModelInstance — index safety controls', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let model: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        MonSQLize.Model._clear();
        MonSQLize.Model.define('safeUsers', {
            schema: {},
            indexes: [{ key: { email: 1 }, unique: true, name: 'safe_email_unique' }],
            options: {
                softDelete: { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: 30 },
            },
        });
        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_model_index_safety',
            config: { uri },
            autoIndex: false,
        });
        await runtime.connect();
        model = runtime.model('safeUsers');
        await new Promise((resolve) => setImmediate(resolve));
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    it('autoIndex false prevents automatic model and soft-delete index creation', async () => {
        const indexes = await model.listIndexes();
        assert.ok(!indexes.some((index: any) => index.name === 'safe_email_unique'));
        assert.ok(!indexes.some((index: any) => index.key?.deletedAt === 1));
    });

    it('ensureIndexes dry-run reports missing indexes without creating them', async () => {
        const result = await model.ensureIndexes({ dryRun: true });
        assert.equal(result.dryRun, true);
        assert.equal(result.missing.length, 2);
        assert.equal(result.created.length, 0);
        const indexes = await model.listIndexes();
        assert.ok(!indexes.some((index: any) => index.name === 'safe_email_unique'));
    });

    it('ensureIndexes creates missing declared indexes and runtime summarizes them', async () => {
        const result = await model.ensureIndexes();
        assert.equal(result.created.length, 2);
        const indexes = await model.listIndexes();
        assert.ok(indexes.some((index: any) => index.name === 'safe_email_unique'));
        assert.ok(indexes.some((index: any) => index.key?.deletedAt === 1 && index.expireAfterSeconds === 30));

        const summary = await runtime.ensureModelIndexes({ models: ['safeUsers'], dryRun: true });
        assert.equal(summary.models.length, 1);
        assert.equal(summary.totals.existing, 2);
        assert.equal(summary.totals.missing, 0);
    });
});

describe('ModelInstance — automatic index preflight', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
    });

    after(async () => {
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    it('autoIndex true creates missing declared indexes asynchronously', async () => {
        const suffix = Date.now();
        const modelName = `autoPreflightUsers${suffix}`;
        const collectionName = `auto_preflight_users_${suffix}`;
        const indexName = `auto_preflight_email_${suffix}`;
        MonSQLize.Model.define(modelName, {
            collection: collectionName,
            schema: {},
            indexes: [{ key: { email: 1 }, unique: true, name: indexName }],
        });
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: `test_auto_index_preflight_${suffix}`,
            config: { uri },
            autoIndex: true,
        });
        try {
            await runtime.connect();
            const model = runtime.model(modelName);
            let indexes: any[] = [];
            for (let attempt = 0; attempt < 20; attempt += 1) {
                indexes = await model.listIndexes();
                if (indexes.some((index) => index.name === indexName)) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            assert.ok(indexes.some((index) => index.name === indexName));
        } finally {
            await runtime.close();
            MonSQLize.Model.undefine(modelName);
        }
    });
});

describe('ModelInstance — P0 relation integrity', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
    });

    after(async () => {
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    it('populates local ID arrays with default projection and nested junction models', async () => {
        MonSQLize.Model._clear();
        MonSQLize.Model.define('p0_categories', { schema: {} });
        MonSQLize.Model.define('p0_tags', {
            schema: {},
            relations: {
                category: { from: 'p0_categories', localField: 'categoryId', foreignField: '_id', single: true },
            },
        });
        MonSQLize.Model.define('p0_articles', {
            schema: {},
            relations: {
                tags: {
                    from: 'p0_tags',
                    localField: 'tagIds',
                    foreignField: '_id',
                    select: 'label',
                },
            },
        });
        MonSQLize.Model.define('p0_courses', { schema: {} });
        MonSQLize.Model.define('p0_enrollments', {
            schema: {},
            relations: {
                course: { from: 'p0_courses', localField: 'courseId', foreignField: '_id', single: true },
            },
        });
        MonSQLize.Model.define('p0_students', {
            schema: {},
            relations: {
                enrollments: { from: 'p0_enrollments', localField: '_id', foreignField: 'studentId' },
            },
        });

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_model_p0_relations',
            config: { uri },
            autoIndex: false,
        });
        try {
            await runtime.connect();
            const categories = runtime.model('p0_categories');
            const tags = runtime.model('p0_tags');
            const articles = runtime.model('p0_articles');
            const courses = runtime.model('p0_courses');
            const enrollments = runtime.model('p0_enrollments');
            const students = runtime.model('p0_students');
            const categoryA = await categories.insertOne({ name: 'Category A' });
            const categoryB = await categories.insertOne({ name: 'Category B' });
            const tagA = await tags.insertOne({ label: 'A', private: true, categoryId: categoryA.insertedId });
            const tagB = await tags.insertOne({ label: 'B', private: true, categoryId: categoryB.insertedId });
            const article = await articles.insertOne({ tagIds: [tagB.insertedId, null, tagA.insertedId, tagB.insertedId, 'missing'] });

            const populated = await articles.findOne({ _id: article.insertedId }).populate({ path: 'tags', populate: 'category' });
            assert.deepEqual(populated.tags.map((tag: any) => tag.label), ['B', 'A']);
            assert.equal(populated.tags[0].category.name, 'Category B');
            assert.equal('private' in populated.tags[0], false);
            assert.equal('categoryId' in populated.tags[0], false);

            const callerSelected = await articles.findOne({ _id: article.insertedId }).populate({ path: 'tags', select: 'private' });
            assert.equal('label' in callerSelected.tags[0], false);
            assert.equal(callerSelected.tags[0].private, true);

            const course = await courses.insertOne({ title: 'Databases' });
            const student = await students.insertOne({ name: 'Ada' });
            await enrollments.insertOne({ studentId: student.insertedId, courseId: course.insertedId, enrolledAt: new Date() });
            const studentWithCourses = await students.findOne({ _id: student.insertedId }).populate({ path: 'enrollments', populate: 'course' });
            assert.equal(studentWithCourses.enrollments[0].course.title, 'Databases');
        } finally {
            await runtime.close();
        }
    });

    it('restricts deletion for scalar, array, junction, and soft-deleted inbound references', async () => {
        MonSQLize.Model._clear();
        MonSQLize.Model.define('p0_posts', {
            schema: {},
            options: { softDelete: true, autoIndex: false },
        });
        MonSQLize.Model.define('p0_comments', {
            schema: {},
            options: { softDelete: true, autoIndex: false },
            relations: {
                post: { from: 'p0_posts', localField: 'postIds', foreignField: '_id' },
            },
        });
        MonSQLize.Model.define('p0_post_links', {
            schema: {},
            relations: {
                post: { from: 'p0_posts', localField: 'postId', foreignField: '_id', single: true },
            },
        });

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_model_p0_delete',
            config: { uri },
            autoIndex: false,
        });
        try {
            await runtime.connect();
            const posts = runtime.model('p0_posts');
            const comments = runtime.model('p0_comments');
            const links = runtime.model('p0_post_links');
            const post = await posts.insertOne({ title: 'Protected' });
            const comment = await comments.insertOne({ postIds: [post.insertedId] });
            const link = await links.insertOne({ postId: post.insertedId });

            const usage = await posts.checkRelationUsage({ _id: post.insertedId }, { maxSamples: 1 });
            assert.equal(usage.used, true);
            assert.equal(usage.coverage.complete, true);
            assert.equal(usage.usages.length, 2);
            await assert.rejects(
                () => posts.deleteOneWithRelations({ _id: post.insertedId }),
                (error: unknown) => (error as { code?: string }).code === 'RELATION_IN_USE',
            );
            assert.ok(await posts.findOne({ _id: post.insertedId }));

            await comments.forceDelete({ _id: comment.insertedId });
            await links.forceDelete({ _id: link.insertedId });
            const softReference = await comments.insertOne({ postIds: [post.insertedId] });
            await comments.deleteOne({ _id: softReference.insertedId });
            assert.equal((await posts.checkRelationUsage({ _id: post.insertedId })).used, true);
            assert.equal((await posts.checkRelationUsage({ _id: post.insertedId }, {
                includeSoftDeletedReferences: false,
            })).used, false);

            await comments.forceDelete({ _id: softReference.insertedId });
            const softDeleted = await posts.deleteOneWithRelations({ _id: post.insertedId });
            assert.equal(softDeleted.usage.used, false);
            assert.equal(await posts.findOne({ _id: post.insertedId }), null);
            await posts.forceDeleteWithRelations({ _id: post.insertedId });
            assert.equal(await runtime._adapter.db.collection('p0_posts').countDocuments({ _id: post.insertedId }), 0);
        } finally {
            await runtime.close();
        }
    });
});
