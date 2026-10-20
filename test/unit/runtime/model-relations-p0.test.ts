import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Model, ModelInstance } from '../../../src/capabilities/model';
import { populateModelPath } from '../../../src/capabilities/model/model-instance-helpers';
import { createCompatModelInstance } from '../../../src/entry/runtime-compat-accessors';

afterEach(() => {
    Model._clear();
});

describe('Model P0 vector, populate, and protected relation deletion', () => {
    it('preserves the registered model name through the compatibility factory for relation scans', async () => {
        const sharedDefinition = { schema: {}, options: { autoIndex: false } };
        Model.define('compat_target_alias_a', sharedDefinition);
        Model.define('compat_target_alias_b', sharedDefinition);
        Model.define('compat_relation_source', {
            schema: {},
            options: { autoIndex: false },
            relations: {
                target: {
                    from: 'compat_target_alias_b',
                    localField: 'targetId',
                    foreignField: '_id',
                },
            },
        });

        const scopedCollections: string[] = [];
        const model = createCompatModelInstance({
            collection: {
                find: async () => [{ _id: 'target-1' }],
            },
            runtime: {
                scopedCollection: (name: string) => {
                    scopedCollections.push(name);
                    return {
                        count: async () => 0,
                        find: async () => [],
                    };
                },
            },
            collectionName: 'compat_target_collection',
            modelName: 'compat_target_alias_b',
            dbName: 'unit',
            definition: sharedDefinition,
        });

        const usage = await model.checkRelationUsage({ _id: 'target-1' });

        assert.equal(usage.checkedRelations, 1);
        assert.equal(usage.coverage.complete, true);
        assert.deepEqual(scopedCollections, ['compat_relation_source']);
    });

    it('hydrates Model vector hits and puts soft-delete visibility inside the Vector Search filter', async () => {
        Model.define('vector_posts', {
            schema: {},
            options: { softDelete: true, autoIndex: false },
        });
        const calls: unknown[] = [];
        const collection = {
            getNamespace: () => ({ iid: 'vector-posts', type: 'mongodb' as const, db: 'unit', collection: 'vector_posts' }),
            raw: () => ({}),
            vectorSearch: async (options: unknown) => {
                calls.push(options);
                return [{ document: { _id: 'post-1', title: 'Vector result' }, score: 0.91 }];
            },
        };
        const runtime = { options: { autoIndex: false } };
        const model = new ModelInstance(collection as never, runtime as never, {
            collectionName: 'vector_posts',
            modelName: 'vector_posts',
            dbName: 'unit',
            definition: Model.get('vector_posts')!.definition,
        });

        const hits = await model.vectorSearch({
            index: 'posts_embedding',
            path: 'embedding',
            queryVector: [0.1, 0.2],
            limit: 1,
            numCandidates: 10,
        });

        assert.deepEqual(calls[0], {
            index: 'posts_embedding',
            path: 'embedding',
            queryVector: [0.1, 0.2],
            limit: 1,
            numCandidates: 10,
            filter: { deletedAt: null },
        });
        assert.equal(hits[0].score, 0.91);
        assert.equal(hits[0].document.title, 'Vector result');
        assert.equal(typeof hits[0].document.populate, 'function');

        await model.vectorSearch({
            index: 'posts_embedding',
            path: 'embedding',
            queryVector: [0.1],
            limit: 1,
            exact: true,
            withDeleted: true,
            filter: { tenantId: 'tenant-a' },
        });
        assert.deepEqual((calls[1] as { filter: unknown }).filter, { tenantId: 'tenant-a' });

        await model.vectorSearch({
            index: 'posts_embedding',
            path: 'embedding',
            queryVector: [0.1],
            limit: 1,
            exact: true,
            onlyDeleted: true,
        });
        assert.deepEqual((calls[2] as { filter: unknown }).filter, { deletedAt: { $ne: null } });

        await assert.rejects(
            () => model.vectorSearch({ withDeleted: 'yes' } as never),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_VECTOR_SEARCH',
        );
        await assert.rejects(
            () => model.vectorSearch({ onlyDeleted: 'yes' } as never),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_VECTOR_SEARCH',
        );
    });

    it('expands local ID arrays, pushes select projection down, preserves nested dependencies, and removes internal keys', async () => {
        Model.define('tags', {
            schema: {},
            relations: {
                category: { from: 'categories', localField: 'categoryId', foreignField: '_id', single: true },
            },
        });
        let query: unknown;
        let options: unknown;
        const runtime = {
            scopedCollection: () => ({
                find: async (nextQuery: unknown, nextOptions: unknown) => {
                    query = nextQuery;
                    options = nextOptions;
                    return [
                        { _id: 'tag-a', label: 'A', categoryId: 'category-a', private: true },
                        { _id: 'tag-b', label: 'B', categoryId: 'category-b', private: true },
                    ];
                },
            }),
            scopedModel: () => ({
                getRelations: () => ({
                    category: { from: 'categories', localField: 'categoryId', foreignField: '_id', single: true },
                }),
                hydrateDocuments: (documents: Array<Record<string, unknown>>) => documents,
                populateDocuments: async (documents: Array<Record<string, unknown>>) => documents.map((document) => ({
                    ...document,
                    category: { _id: `${document.categoryId}`, name: 'Category' },
                })),
            }),
        };
        const documents = [{ tagIds: ['tag-b', null, 'tag-a', 'tag-b', 'missing'] }];
        const result = await populateModelPath({
            relations: new Map([['tags', {
                from: 'tags',
                localField: 'tagIds',
                foreignField: '_id',
                single: false,
                select: 'label',
            }]]),
            runtime,
            dbName: 'unit',
        } as never, documents, { path: 'tags', populate: { path: 'category' } });

        assert.deepEqual(query, { _id: { $in: ['tag-b', 'tag-a', 'missing'] } });
        assert.deepEqual(options, { projection: { label: 1, _id: 1, categoryId: 1 } });
        assert.deepEqual(result[0].tags, [
            { label: 'B', category: { _id: 'category-b', name: 'Category' } },
            { label: 'A', category: { _id: 'category-a', name: 'Category' } },
        ]);
    });

    it('reports inbound references and fail-closes protected deletes when usage is found or coverage is incomplete', async () => {
        Model.define('posts', {
            schema: {},
            options: { softDelete: true, autoIndex: false },
        });
        Model.define('comments', {
            schema: {},
            relations: {
                post: { from: 'posts', localField: 'postId', foreignField: '_id', single: true },
            },
        });
        Model.define('post_tags', {
            schema: {},
            relations: {
                post: { from: 'posts', localField: 'postIds', foreignField: '_id', single: false },
                tag: { from: 'tags', localField: 'tagId', foreignField: '_id', single: true },
            },
        });

        let target = { _id: 'post-1' } as Record<string, unknown>;
        let referenceCount: number | Error = 1;
        let relationReadOptions: unknown;
        const targetCalls: Array<{ method: string; args: unknown[] }> = [];
        const targetCollection = {
            getNamespace: () => ({ iid: 'posts', type: 'mongodb' as const, db: 'unit', collection: 'posts' }),
            raw: () => ({}),
            find: async () => [target],
            findOne: async (...args: unknown[]) => {
                targetCalls.push({ method: 'findOne', args });
                return target;
            },
            updateOne: async (...args: unknown[]) => {
                targetCalls.push({ method: 'updateOne', args });
                return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
            },
            deleteOne: async (...args: unknown[]) => {
                targetCalls.push({ method: 'deleteOne', args });
                return { acknowledged: true, deletedCount: 1 };
            },
        };
        const commentsCollection = {
            count: async (query: unknown, options: unknown) => {
                assert.deepEqual(query, { postId: { $in: [target._id] } });
                relationReadOptions = options;
                if (referenceCount instanceof Error) throw referenceCount;
                return referenceCount;
            },
            find: async () => [{ _id: 'comment-1' }],
        };
        const junctionCollection = {
            count: async () => 0,
            find: async () => [],
        };
        const runtime = {
            options: { autoIndex: false },
            scopedCollection: (name: string) => ({
                comments: commentsCollection,
                post_tags: junctionCollection,
            })[name],
        };
        const model = new ModelInstance(targetCollection as never, runtime as never, {
            collectionName: 'posts',
            modelName: 'posts',
            dbName: 'unit',
            definition: Model.get('posts')!.definition,
        });

        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: 'post-1' }, { session: 'transaction-1', maxSamples: 1 }),
            (error: unknown) => (error as { code?: string }).code === 'RELATION_IN_USE',
        );
        assert.deepEqual(relationReadOptions, { session: 'transaction-1' });
        assert.equal(targetCalls.some((call) => call.method === 'updateOne'), false);

        referenceCount = 0;
        const report = await model.checkRelationUsage({ _id: 'post-1' }, { maxTargets: 1 });
        assert.equal(report.used, false);
        assert.equal(report.coverage.complete, true);
        const narrowedReport = await model.checkRelationUsage({ _id: 'post-1' }, { excludeRelations: ['comments.post'] });
        assert.equal(narrowedReport.coverage.complete, false);
        const deleted = await model.deleteOneWithRelations({ _id: 'post-1' }, { session: 'transaction-1', maxSamples: 1 });
        assert.deepEqual(deleted.result, { acknowledged: true, matchedCount: 1, modifiedCount: 1 });
        assert.equal(targetCalls.some((call) => call.method === 'updateOne'), true);

        referenceCount = new Error('source collection is unavailable');
        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: 'post-1' }),
            (error: unknown) => (error as { code?: string }).code === 'RELATION_USAGE_UNAVAILABLE',
        );

        referenceCount = 0;
        target = { _id: 'post-deleted', deletedAt: new Date() };
        const forceDeleted = await model.forceDeleteWithRelations({ _id: 'post-deleted' });
        assert.deepEqual(forceDeleted.result, { acknowledged: true, deletedCount: 1 });
        assert.equal(targetCalls.some((call) => call.method === 'deleteOne'), true);
    });

    it('fails closed when protected deletion cannot establish a safe target', async () => {
        Model.define('protected_targets', {
            schema: {},
            options: { autoIndex: false },
        });

        let mode: 'missing-id' | 'read-error' | 'missing-target' = 'missing-id';
        const deleteCalls: unknown[][] = [];
        const collection = {
            getNamespace: () => ({ iid: 'protected-targets', type: 'mongodb' as const, db: 'unit', collection: 'protected_targets' }),
            raw: () => ({}),
            findOne: async () => {
                if (mode === 'read-error') {
                    throw new Error('target lookup failed');
                }
                if (mode === 'missing-target') {
                    return null;
                }
                return { title: 'target without identifier' };
            },
            deleteOne: async (...args: unknown[]) => {
                deleteCalls.push(args);
                return { acknowledged: true, deletedCount: 0 };
            },
        };
        const model = new ModelInstance(collection as never, { options: { autoIndex: false } } as never, {
            collectionName: 'protected_targets',
            modelName: 'protected_targets',
            dbName: 'unit',
            definition: Model.get('protected_targets')!.definition,
        });

        await assert.rejects(
            () => model.deleteOneWithRelations({}),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
        );
        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: 'target-1' }, { includeRelations: ['ignored'] } as never),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
        );
        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: 'target-1' }),
            (error: unknown) => (error as { code?: string }).code === 'RELATION_USAGE_UNAVAILABLE',
        );

        mode = 'read-error';
        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: 'target-1' }),
            (error: unknown) => (error as { code?: string }).code === 'RELATION_USAGE_UNAVAILABLE',
        );

        mode = 'missing-target';
        const result = await model.deleteOneWithRelations({ _id: 'target-1' }, { comment: 'no-target' });
        assert.deepEqual(result.result, { acknowledged: true, deletedCount: 0 });
        assert.deepEqual(deleteCalls, [[{ _id: { $in: [] } }, { comment: 'no-target' }]]);
    });

    it('guards final V1 hook arguments, preserves raw after results, and keeps force deletion hook-free', async () => {
        const originalSession = { name: 'original' };
        const finalSession = { name: 'final' };
        let nextFilter: Record<string, unknown> = { _id: 'b' };
        let nextOptions: Record<string, unknown> = { session: finalSession };
        let referenced = true;
        let beforeCalls = 0;
        let afterCalls = 0;
        const targetReads: Array<{ filter: unknown; options: any }> = [];
        const writes: Array<{ filter: unknown; options: unknown }> = [];
        Model.define('guarded_targets', {
            schema: {},
            options: { autoIndex: false },
            hooks: () => ({
                delete: {
                    before(_context: unknown, _filter: unknown, options: any) {
                        beforeCalls++;
                        assert.equal(options.maxSamples, undefined);
                        return [nextFilter, nextOptions];
                    },
                    after(_context: unknown, result: any) {
                        afterCalls++;
                        assert.deepEqual(result, { acknowledged: true, deletedCount: 1 });
                        return { ...result, replaced: true };
                    },
                },
            }),
        });
        Model.define('guarded_refs', {
            schema: {},
            relations: { target: { from: 'guarded_targets', localField: 'targetId', foreignField: '_id' } },
        });
        const collection = {
            getNamespace: () => ({ iid: 'guarded', type: 'mongodb' as const, db: 'unit', collection: 'guarded_targets' }),
            raw: () => ({}),
            findOne: async (filter: any, options: any) => {
                targetReads.push({ filter, options });
                return { _id: filter._id };
            },
            deleteOne: async (filter: unknown, options: unknown) => {
                writes.push({ filter, options });
                return { acknowledged: true, deletedCount: 1 };
            },
        };
        const runtime = {
            options: { autoIndex: false },
            scopedCollection: () => ({
                count: async (query: any, options: any) => {
                    if (query.targetId.$in[0] === 'b') {
                        assert.strictEqual(options.session, finalSession);
                        return referenced ? 1 : 0;
                    }
                    return 0;
                },
                find: async () => [],
            }),
        };
        const model = new ModelInstance(collection as never, runtime as never, {
            collectionName: 'guarded_targets', modelName: 'guarded_targets', dbName: 'unit',
            definition: Model.get('guarded_targets')!.definition,
        });
        const options = { session: originalSession, maxSamples: 1 } as never;
        await assert.rejects(() => model.deleteOneWithRelations({ _id: 'a' }, options), { code: 'RELATION_IN_USE' });
        assert.deepEqual(targetReads[0].filter, { _id: 'b' });
        assert.strictEqual(targetReads[0].options.session, finalSession);
        assert.equal(writes.length, 0);
        assert.equal(beforeCalls, 1);
        assert.equal(afterCalls, 0);

        const countBeforeInvalidInput = beforeCalls;
        await assert.rejects(() => model.deleteOneWithRelations({}), { code: 'INVALID_ARGUMENT' });
        assert.equal(beforeCalls, countBeforeInvalidInput);
        nextFilter = {};
        await assert.rejects(() => model.deleteOneWithRelations({ _id: 'a' }, options), { code: 'INVALID_ARGUMENT' });
        nextFilter = { _id: 'b' };
        nextOptions = { session: finalSession, excludeRelations: ['guarded_refs.target'] };
        await assert.rejects(() => model.deleteOneWithRelations({ _id: 'a' }, options), { code: 'INVALID_ARGUMENT' });
        assert.equal(writes.length, 0);

        referenced = false;
        nextOptions = { session: finalSession };
        const deleted = await model.deleteOneWithRelations({ _id: 'a' }, options);
        assert.deepEqual(deleted.result, { acknowledged: true, deletedCount: 1, replaced: true });
        assert.equal(deleted.usage.used, false);
        assert.deepEqual(writes[0], {
            filter: { $and: [{ _id: 'b' }, { _id: 'b' }] },
            options: { session: finalSession },
        });
        const beforeForce = beforeCalls;
        const afterForce = afterCalls;
        await model.forceDeleteWithRelations({ _id: 'a' });
        assert.equal(beforeCalls, beforeForce);
        assert.equal(afterCalls, afterForce);
        assert.deepEqual(writes[1].filter, { $and: [{ _id: 'a' }, { _id: 'a' }] });
    });

    it('checks standard beforeDelete in-place retargeting before any write', async () => {
        let beforeCalls = 0;
        let writes = 0;
        Model.define('standard_targets', {
            schema: {},
            options: { autoIndex: false },
            hooks: {
                beforeDelete(context) {
                    beforeCalls++;
                    (context.filter as Record<string, unknown>)._id = 'b';
                },
            },
        });
        Model.define('standard_refs', {
            schema: {},
            relations: { target: { from: 'standard_targets', localField: 'targetId', foreignField: '_id' } },
        });
        const collection = {
            getNamespace: () => ({ iid: 'standard', type: 'mongodb' as const, db: 'unit', collection: 'standard_targets' }),
            raw: () => ({}),
            findOne: async (filter: any) => {
                assert.equal(filter._id, 'b');
                return { _id: 'b' };
            },
            deleteOne: async () => { writes++; return { acknowledged: true, deletedCount: 1 }; },
        };
        const model = new ModelInstance(collection as never, {
            options: { autoIndex: false },
            scopedCollection: () => ({ count: async () => 1, find: async () => [] }),
        } as never, {
            collectionName: 'standard_targets', modelName: 'standard_targets', dbName: 'unit',
            definition: Model.get('standard_targets')!.definition,
        });
        await assert.rejects(() => model.deleteOneWithRelations({ _id: 'a' }), { code: 'RELATION_IN_USE' });
        assert.equal(beforeCalls, 1);
        assert.equal(writes, 0);
    });

    it('rejects unsupported default relation select syntax when the Model is defined', () => {
        assert.throws(
            () => Model.define('invalid_select', {
                schema: {},
                relations: {
                    related: {
                        from: 'related',
                        localField: 'relatedId',
                        foreignField: '_id',
                        select: '-privateField',
                    },
                },
            }),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_RELATION_SELECT',
        );
    });
});
