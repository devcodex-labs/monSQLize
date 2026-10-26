import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('Search index lifecycle on a deployment without mongot', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;

    before(async () => {
        const context = await bootstrap.setup();
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'si_unsupported', config: { uri: context.uri } });
        await runtime.connect();
        await runtime.collection('docs').insertOne({ a: 1 });
    });

    after(async () => {
        await runtime?.close();
        await bootstrap.teardown();
    });

    it('reports SEARCH_INDEX_UNSUPPORTED with the original server error as cause', async () => {
        const docs = runtime.collection('docs');
        for (const call of [
            () => docs.listSearchIndexes(),
            () => docs.getSearchIndex('x'),
            () => docs.createSearchIndex({ name: 'x', type: 'search', definition: { mappings: { dynamic: true } } }),
        ]) {
            await assert.rejects(call(), (error: { code?: string; cause?: unknown; details?: Array<Record<string, unknown>> }) => {
                assert.equal(error.code, 'SEARCH_INDEX_UNSUPPORTED', JSON.stringify(error.details));
                assert.ok(error.cause instanceof Error);
                return true;
            });
        }
    });
});
