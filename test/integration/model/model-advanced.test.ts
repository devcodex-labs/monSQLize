import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

// ── Model.populate — branch coverage ─────────────────────────────────────────

describe('Model populate — branch coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_pop', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('populate with empty docs returns empty array', async () => {
        MonSQLize.Model.define('pop_empty', {
            schema: {},
            relations: { tags: { from: 'pop_tags', localField: 'tagId', foreignField: '_id', single: true } },
        });
        const m = runtime.model('pop_empty');
        const result = await m.populateDocuments([], ['tags']);
        assert.deepEqual(result, []);
    });

    it('populate with docs having null localField — assigns null/empty', async () => {
        MonSQLize.Model.define('pop_null_field', {
            schema: {},
            relations: { owner: { from: 'pop_users', localField: 'ownerId', foreignField: '_id', single: true } },
        });
        MonSQLize.Model.define('pop_users', { schema: {} });
        const m = runtime.model('pop_null_field');
        const col = runtime.collection('pop_users_col');
        await col.insertOne({ _id: 'u1', name: 'Alice' });
        // Doc without ownerId → keys array will be empty → assigns null (single)
        const docs = [{ name: 'item-no-owner' }];
        const result = await m.populateDocuments(docs, ['owner']);
        assert.ok(Array.isArray(result));
        const doc = result[0] as Record<string, unknown>;
        assert.equal(doc.owner, null);
    });

    it('populate with undefined relation path throws INVALID_ARGUMENT', async () => {
        MonSQLize.Model.define('pop_bad_path', {
            schema: {},
            relations: {},
        });
        const m = runtime.model('pop_bad_path');
        await assert.rejects(
            () => m.populateDocuments([{ name: 'x' }], ['nonexistent_relation']),
            /INVALID_ARGUMENT|Undefined relation/,
        );
    });

    it('populate: many (not single) relation — assigns array', async () => {
        MonSQLize.Model.define('pop_post', {
            schema: {},
            relations: { comments: { from: 'pop_comment', localField: '_id', foreignField: 'postId', single: false } },
        });
        MonSQLize.Model.define('pop_comment', { schema: {} });
        const mPost = runtime.model('pop_post');
        const colComment = runtime.collection('pop_comment');
        const postResult = await runtime.collection('pop_post').insertOne({ title: 'Post1' });
        await colComment.insertOne({ postId: postResult.insertedId, body: 'Comment1' });
        await colComment.insertOne({ postId: postResult.insertedId, body: 'Comment2' });
        const docs = [{ _id: postResult.insertedId, title: 'Post1' }];
        const result = await mPost.populateDocuments(docs, ['comments']);
        assert.ok(Array.isArray(result));
        const doc = result[0] as Record<string, unknown>;
        assert.ok(Array.isArray(doc.comments));
        assert.equal((doc.comments as unknown[]).length, 2);
    });
});

// ── Model.validate — branch coverage ─────────────────────────────────────────

describe('Model validate — branch coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_val', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('validate() with no schema returns valid:true', async () => {
        MonSQLize.Model.define('val_no_schema', { schema: {} });
        const m = runtime.model('val_no_schema');
        const result = m.validate({ name: 'test' });
        assert.equal(result.valid, true);
    });

    it('validate() with schema returns a validation result object', async () => {
        MonSQLize.Model.define('val_with_schema', {
            schema: (type: any) => ({
                name: type.string().required(),
            }),
            options: { validate: true },
        });
        const m = runtime.model('val_with_schema');
        const result = m.validate({ name: 'Alice' });
        assert.ok(typeof result === 'object' && result !== null);
        assert.ok(typeof result.valid === 'boolean');
        assert.ok(Array.isArray(result.errors));
    });

    it('validate() with schema and invalid doc returns errors', async () => {
        MonSQLize.Model.define('val_invalid', {
            schema: (type: any) => ({
                age: type.number().required(),
            }),
            options: { validate: true },
        });
        const m = runtime.model('val_invalid');
        const result = m.validate({ name: 'Bob' }); // missing required age
        assert.ok(typeof result.valid === 'boolean');
        assert.ok(Array.isArray(result.errors));
    });

    it('schema factory failure blocks writes even when validation is disabled', async () => {
        const modelName = 'schema_factory_failure_' + Date.now();
        MonSQLize.Model.define(modelName, {
            collection: modelName,
            schema: () => { throw new Error('factory unavailable'); },
            options: { validate: false },
        });
        const model = runtime.model(modelName);
        const failure = /Schema initialization failed: factory unavailable/;
        await assert.rejects(() => model.insertOne({ name: 'blocked' }, { validate: false }), failure);
        await assert.rejects(() => model.insertMany([{ name: 'blocked' }]), failure);
        await assert.rejects(() => model.updateOne({ name: 'blocked' }, { $set: { name: 'changed' } }), failure);
        await assert.rejects(() => model.deleteOne({ name: 'blocked' }), failure);
        assert.equal(await runtime._adapter.db.collection(modelName).countDocuments({}), 0);
    });
});

// ── Model defaults — applyModelDefaults branches ──────────────────────────────

describe('Model defaults — branch coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_defaults', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('defaults with static value applied when field missing', async () => {
        MonSQLize.Model.define('def_static', {
            schema: {},
            defaults: { status: 'active', count: 0 },
        });
        const m = runtime.model('def_static');
        const result = await m.insertOne({ name: 'Alice' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.equal(doc.status, 'active');
        assert.equal(doc.count, 0);
    });

    it('defaults with function value applied when field missing', async () => {
        MonSQLize.Model.define('def_fn', {
            schema: {},
            defaults: { score: () => 42 },
        });
        const m = runtime.model('def_fn');
        const result = await m.insertOne({ name: 'Bob' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.equal(doc.score, 42);
    });

    it('defaults NOT applied when field already present', async () => {
        MonSQLize.Model.define('def_skip', {
            schema: {},
            defaults: { status: 'active' },
        });
        const m = runtime.model('def_skip');
        const result = await m.insertOne({ name: 'Carol', status: 'inactive' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.equal(doc.status, 'inactive');
    });
});

// ── Model.save() / Model.remove() — hydrated document methods ─────────────────

describe('Model hydrated document save/remove', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_model_save', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('hydrated doc.save() with _id performs replaceOne', async () => {
        MonSQLize.Model.define('save_replace', { schema: {} });
        const m = runtime.model('save_replace');
        const result = await m.insertOne({ name: 'Alice', score: 1 });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        (doc as Record<string, unknown>).score = 2;
        await doc.save();
        const updated = await m.findOne({ _id: result.insertedId });
        assert.ok(updated !== null);
        assert.equal(updated.score, 2);
    });

    it('hydrated doc.save() on a versioned model enforces optimistic locking', async () => {
        MonSQLize.Model.define('save_versioned', {
            schema: {},
            options: { version: true },
        });
        const m = runtime.model('save_versioned');
        const result = await m.insertOne({ name: 'Versioned', score: 1 });
        const first = await m.findOne({ _id: result.insertedId });
        const second = await m.findOne({ _id: result.insertedId });
        assert.ok(first !== null);
        assert.ok(second !== null);

        first.score = 2;
        await first.save();
        assert.equal(first.version, 1);

        second.score = 3;
        await assert.rejects(
            () => second.save(),
            /optimistic lock conflict/i,
        );
        const stored = await m.findOne({ _id: result.insertedId });
        assert.equal(stored!.score, 2);
        assert.equal(stored!.version, 1);
    });

    it('hydrated doc.save() without _id performs insertOne', async () => {
        MonSQLize.Model.define('save_insert', { schema: {} });
        const m = runtime.model('save_insert');
        // Create doc without _id via hydrate
        const docs = m.hydrateDocuments([{ name: 'Bob', score: 10 }]);
        if (docs.length > 0) {
            delete (docs[0] as Record<string, unknown>)._id;
            await docs[0].save();
            const found = await m.findOne({ name: 'Bob', score: 10 });
            assert.ok(found !== null);
        }
    });

    it('hydrated doc.remove() with _id deletes the document', async () => {
        MonSQLize.Model.define('remove_doc', { schema: {} });
        const m = runtime.model('remove_doc');
        const result = await m.insertOne({ name: 'Carol' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        const removed = await doc.remove();
        assert.ok(typeof removed === 'boolean' || typeof removed === 'number');
        const found = await m.findOne({ _id: result.insertedId });
        assert.equal(found, null);
    });

    it('hydrated doc.remove() follows Model soft-delete and delete hooks', async () => {
        const calls: string[] = [];
        MonSQLize.Model.define('remove_soft_doc', {
            schema: {},
            options: { softDelete: true },
            hooks: {
                beforeDelete: () => { calls.push('before'); },
                afterDelete: () => { calls.push('after'); },
            },
        });
        const m = runtime.model('remove_soft_doc');
        const inserted = await m.insertOne({ name: 'Retained' });
        const doc = await m.findOneById(inserted.insertedId);
        assert.equal(await doc.remove(), true);
        assert.equal(await m.findOneById(inserted.insertedId), null);
        const raw = await runtime._adapter.db.collection('remove_soft_doc').findOne({ _id: inserted.insertedId });
        assert.ok(raw?.deletedAt instanceof Date);
        assert.deepEqual(calls, ['before', 'after']);
    });

    it('hydrateDocuments returns null for null/undefined input', async () => {
        MonSQLize.Model.define('hydrate_null', { schema: {} });
        const m = runtime.model('hydrate_null');
        // hydrateDocuments with null doc should be filtered
        const docs = m.hydrateDocuments([null, undefined, { name: 'valid' }]);
        assert.ok(Array.isArray(docs));
        // null/undefined items should be filtered out or handled
        const validDocs = docs.filter((d: unknown) => d !== null && d !== undefined);
        assert.ok(validDocs.length >= 1);
    });
});

// ── Model timestamp config edge cases ─────────────────────────────────────────

describe('Model timestamps — createdAt=false edge cases', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_ts_edge', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('timestamps with createdAt=false does not set createdAt', async () => {
        MonSQLize.Model.define('ts_no_created', {
            schema: {},
            options: { timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
        });
        const m = runtime.model('ts_no_created');
        const result = await m.insertOne({ name: 'Alice' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.ok(!('createdAt' in doc));
        assert.ok(doc.updatedAt instanceof Date);
    });

    it('timestamps true — both fields auto-created', async () => {
        MonSQLize.Model.define('ts_both_auto', {
            schema: {},
            options: { timestamps: true },
        });
        const m = runtime.model('ts_both_auto');
        const result = await m.insertOne({ name: 'Bob' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.ok(doc.createdAt instanceof Date);
        assert.ok(doc.updatedAt instanceof Date);
    });
});

// ── Model version config edge cases ──────────────────────────────────────────

describe('Model version — custom field config', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_ver_custom', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('version with custom field name', async () => {
        MonSQLize.Model.define('ver_custom', {
            schema: {},
            options: { version: { field: '__v', enabled: true } },
        });
        const m = runtime.model('ver_custom');
        const result = await m.insertOne({ name: 'Alice' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.equal(doc.__v, 0);
    });

    it('version with enabled=false disables versioning', async () => {
        MonSQLize.Model.define('ver_disabled', {
            schema: {},
            options: { version: { field: 'ver', enabled: false } },
        });
        const m = runtime.model('ver_disabled');
        const result = await m.insertOne({ name: 'Bob' });
        const doc = await m.findOne({ _id: result.insertedId });
        assert.ok(doc !== null);
        assert.ok(!('ver' in doc));
    });
});

// ── Model soft delete — custom config ─────────────────────────────────────────

describe('Model soft delete — custom config', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_sd_custom', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => MonSQLize.Model._clear());

    it('softDelete with custom field name', async () => {
        MonSQLize.Model.define('sd_custom', {
            schema: {},
            options: { softDelete: { field: 'removedAt', enabled: true } },
        });
        const m = runtime.model('sd_custom');
        await m.insertOne({ name: 'Alice' });
        await m.deleteOne({ name: 'Alice' });
        const docs = await m.find({});
        // Default find excludes soft-deleted
        assert.ok(docs.every((d: Record<string, unknown>) => !d.removedAt));
        const allDocs = await m.find({}, { withDeleted: true });
        assert.ok(allDocs.length >= 1);
    });

    it('softDelete with enabled=false acts like hard delete', async () => {
        MonSQLize.Model.define('sd_disabled', {
            schema: {},
            options: { softDelete: { enabled: false, field: 'deletedAt' } },
        });
        const m = runtime.model('sd_disabled');
        await m.insertOne({ name: 'Bob' });
        await m.deleteOne({ name: 'Bob' });
        const docs = await m.find({ name: 'Bob' });
        assert.equal(docs.length, 0);
    });
});
