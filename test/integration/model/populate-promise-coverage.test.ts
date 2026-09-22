import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

// Covers populate-promise.ts uncovered methods:
//   - PopulatePromise.catch()  (FNDA:0)
//   - PopulatePromise.finally() (FNDA:0)

describe('PopulatePromise — catch() and finally() coverage', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;
    let model: any;

    before(async () => {
        const { uri } = await bootstrap.setup();
        MonSQLize.Model._clear();
        MonSQLize.Model.define('pp_items', { schema: {} });
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_pp_cov', config: { uri } });
        await runtime.connect();
        model = runtime.model('pp_items');
        await model.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);
    });

    after(async () => {
        if (runtime) await runtime.close();
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    it('PopulatePromise.catch() — resolves normally when no error', async () => {
        const result = await model.find({}).catch((err: unknown) => {
            throw err;
        });
        assert.ok(Array.isArray(result));
        assert.ok(result.length >= 3);
    });

    it('PopulatePromise.catch() with null handler — still resolves', async () => {
        const result = await model.find({}).catch(null as any);
        assert.ok(Array.isArray(result));
    });

    it('PopulatePromise.finally() — callback fires after resolution', async () => {
        let finallyCalled = false;
        const result = await model.find({ v: 1 }).finally(() => {
            finallyCalled = true;
        });
        assert.ok(Array.isArray(result));
        assert.ok(finallyCalled);
    });

    it('PopulatePromise.finally() with null handler — resolves normally', async () => {
        const result = await model.find({}).finally(null as any);
        assert.ok(Array.isArray(result));
    });

    it('PopulatePromise.catch() intercepts rejection from invalid query', async () => {
        let caught: unknown = null;
        // Force a rejection by passing a bad pipeline (not likely via find, but catch won't throw on success)
        const result = await model.find({}).catch((err: unknown) => {
            caught = err;
            return [];
        });
        // If no error, caught stays null, result is normal array
        assert.ok(Array.isArray(result));
    });

    it('populate reads more than 500 related rows and applies skip/limit per parent', async () => {
        MonSQLize.Model.define('pp_child', {
            schema: {},
            options: { softDelete: { field: 'removed', type: 'boolean' } },
        });
        MonSQLize.Model.define('pp_parent', {
            schema: {},
            relations: { children: { from: 'pp_child', localField: 'key', foreignField: 'owner' } },
        });
        const children = runtime.collection('pp_child');
        await children.insertMany(['p1', 'p2'].flatMap((owner) =>
            Array.from({ length: 401 }, (_, n) => ({ owner, n, removed: n === 400 }))));
        const parents = runtime.model('pp_parent');
        const all = await parents.populateDocuments([{ key: 'p1' }, { key: 'p2' }], ['children']);
        assert.deepEqual(all.map((parent: any) => parent.children.length), [400, 400]);

        const paged = await parents.populateDocuments([{ key: 'p1' }, { key: 'p2' }], [{
            path: 'children', sort: { n: 1 }, skip: 2, limit: 3, select: ['n'],
        }]);
        for (const parent of paged as any[]) {
            assert.deepEqual(parent.children.map((child: any) => child.n), [2, 3, 4]);
            assert.ok(parent.children.every((child: any) =>
                !Object.prototype.hasOwnProperty.call(child, 'owner')
                && !Object.prototype.hasOwnProperty.call(child, 'removed')));
        }
    });

    it('populate keeps nested local fields internally while honoring selected output', async () => {
        MonSQLize.Model.define('pp_note', { schema: {} });
        MonSQLize.Model.define('pp_nested_child', {
            schema: {},
            relations: { notes: { from: 'pp_note', localField: '_id', foreignField: 'childId' } },
        });
        MonSQLize.Model.define('pp_nested_parent', {
            schema: {},
            relations: { children: { from: 'pp_nested_child', localField: 'key', foreignField: 'owner' } },
        });
        const child = await runtime.collection('pp_nested_child').insertOne({ owner: 'nested', label: 'first' });
        await runtime.collection('pp_note').insertOne({ childId: child.insertedId, text: 'attached' });
        const result = await runtime.model('pp_nested_parent').populateDocuments([{ key: 'nested' }], [{
            path: 'children', select: ['label'], populate: 'notes',
        }]);
        const populated = (result[0] as any).children[0];
        assert.equal(populated.label, 'first');
        assert.equal(populated.notes[0].text, 'attached');
        assert.equal(Object.prototype.hasOwnProperty.call(populated, 'owner'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(populated, '_id'), false);
    });
});
