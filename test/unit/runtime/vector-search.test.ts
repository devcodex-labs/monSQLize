import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoCollectionAccessor } from '../../../src/adapters/mongodb/common/collection-accessor';
import {
    attachVectorSearchOperationContext,
    buildVectorSearchPipeline,
    mapVectorSearchRows,
    VECTOR_SEARCH_SCORE_FIELD,
} from '../../../src/adapters/mongodb/queries/vector-search';

function expectInvalidVectorSearch(action: () => unknown): void {
    assert.throws(action, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, 'INVALID_VECTOR_SEARCH');
        return true;
    });
}

describe('vectorSearch()', () => {
    it('builds an ANN pipeline with $vectorSearch as its first stage', () => {
        const result = buildVectorSearchPipeline({
            index: '  embeddings_index  ',
            path: ' embedding ',
            queryVector: [0.1, 0.2, 0.3],
            limit: 2,
            numCandidates: 20,
            filter: { status: 'published' },
            projection: ['title', 'slug'],
            aggregateOptions: { allowDiskUse: true, comment: 'related-documents' },
        });

        assert.deepEqual(result.pipeline[0], {
            $vectorSearch: {
                index: 'embeddings_index',
                path: 'embedding',
                queryVector: [0.1, 0.2, 0.3],
                limit: 2,
                numCandidates: 20,
                filter: { status: 'published' },
            },
        });
        assert.deepEqual(result.pipeline[1], {
            $project: {
                title: 1,
                slug: 1,
                [VECTOR_SEARCH_SCORE_FIELD]: { $meta: 'vectorSearchScore' },
            },
        });
        assert.deepEqual(result.aggregateOptions, { allowDiskUse: true, comment: 'related-documents' });
    });

    it('builds an ENN pipeline without numCandidates', () => {
        const result = buildVectorSearchPipeline({
            index: 'embeddings_index',
            path: 'embedding',
            queryVector: [0.1],
            limit: 1,
            exact: true,
        });

        assert.deepEqual(result.pipeline[0], {
            $vectorSearch: {
                index: 'embeddings_index',
                path: 'embedding',
                queryVector: [0.1],
                limit: 1,
                exact: true,
            },
        });
        assert.deepEqual(result.pipeline[1], {
            $set: {
                [VECTOR_SEARCH_SCORE_FIELD]: { $meta: 'vectorSearchScore' },
            },
        });
    });

    it('rejects invalid vector-search option combinations before execution', () => {
        const valid = {
            index: 'embeddings_index',
            path: 'embedding',
            queryVector: [0.1, 0.2],
            limit: 2,
            numCandidates: 20,
        };

        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, queryVector: [] }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, queryVector: [Number.NaN] }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, limit: 0 }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, numCandidates: 1 }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, numCandidates: undefined }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, exact: true, numCandidates: 20 }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, filter: [] as unknown as Record<string, unknown> }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({
            ...valid,
            aggregateOptions: { meta: true } as never,
        }));
    });

    it('validates optional projection and aggregate options', () => {
        const valid = {
            index: 'embeddings_index',
            path: 'embedding',
            queryVector: [0.1, 0.2],
            limit: 2,
            numCandidates: 20,
        };

        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, index: '  ' }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, path: '' }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, exact: 'true' as never }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, projection: ['title', ''] }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, projection: true as never }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, aggregateOptions: [] as never }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, aggregateOptions: { stream: true } as never }));
        expectInvalidVectorSearch(() => buildVectorSearchPipeline({ ...valid, aggregateOptions: { explain: true } as never }));

        const result = buildVectorSearchPipeline({
            ...valid,
            projection: { title: 1, body: 0 },
        });
        assert.deepEqual(result.pipeline[1], {
            $project: {
                title: 1,
                body: 0,
                [VECTOR_SEARCH_SCORE_FIELD]: { $meta: 'vectorSearchScore' },
            },
        });
    });

    it('maps score-bearing aggregate rows without exposing the internal score field', () => {
        const hits = mapVectorSearchRows<{ _id: string; title: string }>([
            { _id: 'doc-1', title: 'Vector search', [VECTOR_SEARCH_SCORE_FIELD]: 0.93 },
        ]);

        assert.deepEqual(hits, [{
            document: { _id: 'doc-1', title: 'Vector search' },
            score: 0.93,
        }]);
    });

    it('rejects vector rows without a finite Vector Search score', () => {
        assert.throws(
            () => mapVectorSearchRows([{ _id: 'missing-score' }]),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_OPERATION',
        );
        assert.throws(
            () => mapVectorSearchRows([{ _id: 'not-finite', [VECTOR_SEARCH_SCORE_FIELD]: Number.NaN }]),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_OPERATION',
        );
    });

    it('preserves existing error metadata and wraps non-Error failures', () => {
        const namespace = { iid: 'unit', type: 'mongodb', db: 'unit', collection: 'documents' };
        const driverError = Object.assign(new Error('Vector index unavailable'), {
            monsqlize: { requestId: 'request-1' },
        });
        const contextualized = attachVectorSearchOperationContext(driverError, namespace);

        assert.strictEqual(contextualized, driverError);
        assert.deepEqual((driverError as { monsqlize?: unknown }).monsqlize, {
            requestId: 'request-1',
            operation: 'vectorSearch',
            namespace,
        });

        const frozenError = Object.freeze(new Error('immutable driver error'));
        assert.strictEqual(attachVectorSearchOperationContext(frozenError, namespace), frozenError);

        const wrapped = attachVectorSearchOperationContext('connection reset', namespace);
        assert.equal((wrapped as { code?: unknown }).code, 'MONGODB_ERROR');
        assert.equal(wrapped.message, 'vectorSearch execution failed');
    });

    it('runs the public collection method through the aggregate path', async () => {
        const calls: Array<{ pipeline: unknown[]; options: unknown }> = [];
        const nativeCollection = {
            aggregate(pipeline: unknown[], options: unknown) {
                calls.push({ pipeline, options });
                return {
                    toArray: async () => [
                        { _id: 'doc-1', title: 'Vector search', [VECTOR_SEARCH_SCORE_FIELD]: 0.93 },
                    ],
                };
            },
        };
        const accessor = new MongoCollectionAccessor(
            'unit_test',
            'documents',
            nativeCollection as never,
        );

        const hits = await accessor.vectorSearch<{ _id: string; title: string }>({
            index: 'embeddings_index',
            path: 'embedding',
            queryVector: [0.1, 0.2],
            limit: 1,
            numCandidates: 10,
            aggregateOptions: { comment: 'unit-vector-search' },
        });

        assert.deepEqual(hits, [{
            document: { _id: 'doc-1', title: 'Vector search' },
            score: 0.93,
        }]);
        assert.equal(calls.length, 1);
        assert.equal((calls[0].pipeline[0] as { $vectorSearch?: unknown }).$vectorSearch !== undefined, true);
        assert.deepEqual(calls[0].options, { comment: 'unit-vector-search' });
    });

    it('keeps a driver failure intact while attaching vector-search context', async () => {
        const driverError = Object.assign(new Error('Vector index not found'), { code: 27 });
        const nativeCollection = {
            aggregate() {
                return {
                    toArray: async () => {
                        throw driverError;
                    },
                };
            },
        };
        const accessor = new MongoCollectionAccessor(
            'unit_test',
            'documents',
            nativeCollection as never,
        );

        await assert.rejects(
            () => accessor.vectorSearch({
                index: 'embeddings_index',
                path: 'embedding',
                queryVector: [0.1],
                limit: 1,
                numCandidates: 10,
            }),
            (error: unknown) => {
                assert.strictEqual(error, driverError);
                assert.equal((error as { code?: unknown }).code, 27);
                assert.equal((error as { monsqlize?: { operation?: string } }).monsqlize?.operation, 'vectorSearch');
                return true;
            },
        );
    });
});
