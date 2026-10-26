import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifySearchIndexError,
    createSearchIndexOp,
    createSearchIndexesOp,
    dropSearchIndexOp,
    getSearchIndexOp,
    listSearchIndexesOp,
    normalizeSearchIndexInfo,
    updateSearchIndexOp,
    waitForSearchIndexOp,
} from '../../../src/adapters/mongodb/search-indexes';
import type { SearchIndexContext } from '../../../src/adapters/mongodb/search-indexes';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type Doc = Record<string, unknown>;

function serverError(code: number, codeName: string, message = codeName): Error {
    return Object.assign(new Error(message), { code, codeName });
}

const VECTOR_DEF = { fields: [{ type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' }] };
const SEARCH_DEF = { mappings: { dynamic: true } };

function fakeCollection(options: {
    lists?: Array<Doc[] | Error>;
    createError?: Error;
    updateError?: Error;
    dropError?: Error;
} = {}) {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const lists = [...(options.lists ?? [])];
    let lastList: Doc[] | Error = [];
    const collection = {
        listSearchIndexes: (...args: unknown[]) => {
            calls.push({ op: 'list', args });
            const next = lists.length > 0 ? lists.shift() as Doc[] | Error : lastList;
            lastList = next;
            return {
                toArray: async () => {
                    if (next instanceof Error) throw next;
                    const name = typeof args[0] === 'string' ? args[0] : undefined;
                    return name ? next.filter((doc) => doc.name === name) : next;
                },
            };
        },
        createSearchIndex: async (desc: Doc) => {
            calls.push({ op: 'create', args: [desc] });
            if (options.createError) throw options.createError;
            return desc.name as string;
        },
        createSearchIndexes: async (descs: Doc[]) => {
            calls.push({ op: 'createMany', args: [descs] });
            if (options.createError) throw options.createError;
            return descs.map((d) => d.name as string);
        },
        updateSearchIndex: async (name: string, def: Doc) => {
            calls.push({ op: 'update', args: [name, def] });
            if (options.updateError) throw options.updateError;
        },
        dropSearchIndex: async (name: string) => {
            calls.push({ op: 'drop', args: [name] });
            if (options.dropError) throw options.dropError;
        },
    };
    const ctx: SearchIndexContext = { collection: collection as never, namespace: { db: 'd', collection: 'c' } };
    return { ctx, calls };
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<Error> {
    let caught: unknown;
    await assert.rejects(promise, (error: unknown) => { caught = error; return (error as { code?: string }).code === code; });
    return caught as Error;
}

describe('search indexes: type resolution (A02 v1.1 §1.1)', () => {
    it('uses server-reported type', () => {
        const info = normalizeSearchIndexInfo({ name: 'a', type: 'vectorSearch', status: 'READY', queryable: true });
        assert.equal(info.type, 'vectorSearch');
        assert.equal(info.typeSource, 'server');
    });
    it('infers vectorSearch from fields with a vector entry', () => {
        const info = normalizeSearchIndexInfo({ name: 'a', status: 'READY', latestDefinition: VECTOR_DEF });
        assert.equal(info.type, 'vectorSearch');
        assert.equal(info.typeSource, 'inferred');
    });
    it('infers search from mappings', () => {
        const info = normalizeSearchIndexInfo({ name: 'a', status: 'READY', latestDefinition: SEARCH_DEF });
        assert.equal(info.type, 'search');
        assert.equal(info.typeSource, 'inferred');
    });
    it('falls back to unknown without type', () => {
        const info = normalizeSearchIndexInfo({ name: 'a', status: 'PENDING', latestDefinition: { fields: [{ type: 'filter', path: 'x' }] } });
        assert.equal(info.type, undefined);
        assert.equal(info.typeSource, 'unknown');
        assert.equal(info.queryable, false);
    });
    it('list filters by resolved type and excludes unknown', async () => {
        const { ctx } = fakeCollection({ lists: [[
            { name: 's', type: 'search', status: 'READY' },
            { name: 'v', status: 'READY', latestDefinition: VECTOR_DEF },
            { name: 'u', status: 'READY' },
        ]] });
        const res = await listSearchIndexesOp(ctx, { type: 'vectorSearch' });
        assert.deepEqual(res.map((i) => i.name), ['v']);
    });
});

describe('search indexes: get/list', () => {
    it('get returns DOES_NOT_EXIST for missing index', async () => {
        const { ctx } = fakeCollection({ lists: [[]] });
        const info = await getSearchIndexOp(ctx, 'x');
        assert.deepEqual(info, { name: 'x', status: 'DOES_NOT_EXIST', queryable: false, typeSource: 'unknown', raw: {} });
    });
    it('get ignores entries with a different name', async () => {
        const collection = { listSearchIndexes: () => ({ toArray: async () => [{ name: 'other', status: 'READY', queryable: true }] }) };
        const info = await getSearchIndexOp({ collection: collection as never, namespace: {} }, 'x');
        assert.equal(info.status, 'DOES_NOT_EXIST');
    });
    it('get maps NamespaceNotFound to DOES_NOT_EXIST', async () => {
        const { ctx } = fakeCollection({ lists: [serverError(26, 'NamespaceNotFound')] });
        assert.equal((await getSearchIndexOp(ctx, 'x')).status, 'DOES_NOT_EXIST');
    });
    it('list maps unsupported deployments', async () => {
        const { ctx } = fakeCollection({ lists: [serverError(59, 'CommandNotFound', 'no such command')] });
        await rejectsCode(listSearchIndexesOp(ctx), 'SEARCH_INDEX_UNSUPPORTED');
    });
    it('rejects invalid list options', async () => {
        const { ctx } = fakeCollection();
        await rejectsCode(listSearchIndexesOp(ctx, { type: 'bad' as never }), 'INVALID_SEARCH_INDEX_DEFINITION');
    });
});

describe('search indexes: create', () => {
    it('creates and returns action created', async () => {
        const { ctx, calls } = fakeCollection({ lists: [[]] });
        const res = await createSearchIndexOp(ctx, { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF });
        assert.deepEqual(res, { name: 'v', action: 'created', created: true });
        assert.deepEqual(calls[calls.length - 1]?.args[0], { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF });
    });
    it('default ifExists error throws SEARCH_INDEX_EXISTS', async () => {
        const { ctx, calls } = fakeCollection({ lists: [[{ name: 'v', type: 'vectorSearch', status: 'READY' }]] });
        await rejectsCode(createSearchIndexOp(ctx, { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF }), 'SEARCH_INDEX_EXISTS');
        assert.equal(calls.some((c) => c.op === 'create'), false);
    });
    it('skip returns skipped', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'READY' }]] });
        assert.deepEqual(await createSearchIndexOp(ctx, { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF }, { ifExists: 'skip' }),
            { name: 'v', action: 'skipped', created: false });
    });
    it('update calls updateSearchIndex', async () => {
        const { ctx, calls } = fakeCollection({ lists: [[{ name: 'v', type: 'vectorSearch', status: 'READY' }]] });
        assert.deepEqual(await createSearchIndexOp(ctx, { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF }, { ifExists: 'update' }),
            { name: 'v', action: 'updated', created: false });
        assert.equal(calls[calls.length - 1]?.op, 'update');
    });
    it('update rejects a type change (inferred type counts)', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'READY', latestDefinition: SEARCH_DEF }]] });
        await rejectsCode(createSearchIndexOp(ctx, { name: 'v', type: 'vectorSearch', definition: VECTOR_DEF }, { ifExists: 'update' }),
            'INVALID_SEARCH_INDEX_DEFINITION');
    });
    it('race: server duplicate maps to EXISTS, or skipped under skip', async () => {
        const dup = serverError(68, 'IndexAlreadyExists');
        const a = fakeCollection({ lists: [[]], createError: dup });
        const err = await rejectsCode(createSearchIndexOp(a.ctx, { name: 's', type: 'search', definition: SEARCH_DEF }), 'SEARCH_INDEX_EXISTS');
        assert.equal((err as Error & { cause?: unknown }).cause, dup);
        const b = fakeCollection({ lists: [[]], createError: dup });
        assert.equal((await createSearchIndexOp(b.ctx, { name: 's', type: 'search', definition: SEARCH_DEF }, { ifExists: 'skip' })).action, 'skipped');
    });
    it('validates spec locally before any driver call', async () => {
        const bad: unknown[] = [
            null,
            { name: '', type: 'search', definition: {} },
            { name: ' x', type: 'search', definition: {} },
            { name: 'x', type: 'other', definition: {} },
            { name: 'x', type: 'search', definition: [] },
            { name: 'x', type: 'vectorSearch', definition: { fields: [] } },
            { name: 'x', type: 'vectorSearch', definition: { fields: [{ type: 'vector', path: 'e', numDimensions: 0, similarity: 'cosine' }] } },
            { name: 'x', type: 'vectorSearch', definition: { fields: [{ type: 'vector', path: 'e', numDimensions: 3, similarity: 'l2' }] } },
            { name: 'x', type: 'vectorSearch', definition: { fields: [{ type: 'text', path: 'e' }] } },
        ];
        for (const spec of bad) {
            const { ctx, calls } = fakeCollection();
            await rejectsCode(createSearchIndexOp(ctx, spec as never), 'INVALID_SEARCH_INDEX_DEFINITION');
            assert.equal(calls.length, 0);
        }
        const { ctx } = fakeCollection();
        await rejectsCode(createSearchIndexOp(ctx, { name: 'x', type: 'search', definition: SEARCH_DEF }, { ifExists: 'replace' as never }),
            'INVALID_SEARCH_INDEX_DEFINITION');
    });
    it('createSearchIndexes validates all and rejects duplicates', async () => {
        const { ctx, calls } = fakeCollection();
        await rejectsCode(createSearchIndexesOp(ctx, [
            { name: 'a', type: 'search', definition: SEARCH_DEF },
            { name: 'a', type: 'search', definition: SEARCH_DEF },
        ]), 'SEARCH_INDEX_EXISTS');
        await rejectsCode(createSearchIndexesOp(ctx, []), 'INVALID_SEARCH_INDEX_DEFINITION');
        assert.equal(calls.length, 0);
        assert.deepEqual(await createSearchIndexesOp(ctx, [{ name: 'a', type: 'search', definition: SEARCH_DEF }]), ['a']);
    });
});

describe('search indexes: update/drop', () => {
    it('update missing throws NOT_FOUND', async () => {
        const { ctx, calls } = fakeCollection({ lists: [[]] });
        await rejectsCode(updateSearchIndexOp(ctx, 'v', VECTOR_DEF), 'SEARCH_INDEX_NOT_FOUND');
        assert.equal(calls.some((c) => c.op === 'update'), false);
    });
    it('generic BadValue stays MONGODB_ERROR until OA5 confirms definition codes', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 's', type: 'search', status: 'READY' }]], updateError: serverError(2, 'BadValue') });
        const err = await rejectsCode(updateSearchIndexOp(ctx, 's', SEARCH_DEF), 'MONGODB_ERROR');
        assert.equal((err as { details?: Array<{ serverCode?: number }> }).details?.[0]?.serverCode, 2);
    });
    it('drop missing throws NOT_FOUND unless ignoreMissing', async () => {
        const a = fakeCollection({ lists: [[]] });
        await rejectsCode(dropSearchIndexOp(a.ctx, 'x'), 'SEARCH_INDEX_NOT_FOUND');
        const b = fakeCollection({ lists: [[]] });
        await dropSearchIndexOp(b.ctx, 'x', { ignoreMissing: true });
        assert.equal(b.calls.some((c) => c.op === 'drop'), false);
    });
    it('drop race IndexNotFound honours ignoreMissing', async () => {
        const a = fakeCollection({ lists: [[{ name: 'x', status: 'READY' }]], dropError: serverError(27, 'IndexNotFound') });
        await dropSearchIndexOp(a.ctx, 'x', { ignoreMissing: true });
        const b = fakeCollection({ lists: [[{ name: 'x', status: 'READY' }]], dropError: serverError(27, 'IndexNotFound') });
        await rejectsCode(dropSearchIndexOp(b.ctx, 'x'), 'SEARCH_INDEX_NOT_FOUND');
    });
    it('other driver errors keep identity and gain context', async () => {
        const original = serverError(13, 'Unauthorized');
        const { ctx } = fakeCollection({ lists: [[{ name: 'x', status: 'READY' }]], dropError: original });
        await assert.rejects(dropSearchIndexOp(ctx, 'x'), (error: unknown) => {
            const e = error as { code?: string; cause?: unknown; monsqlize?: unknown; details?: Array<{ serverCode?: number }> };
            assert.equal(e.code, 'MONGODB_ERROR');
            assert.equal(e.cause, original);
            assert.equal(e.details?.[0]?.serverCode, 13);
            assert.deepEqual(e.monsqlize, { operation: 'dropSearchIndex', namespace: { db: 'd', collection: 'c' }, indexName: 'x' });
            return true;
        });
    });
    it('classifies message fallback only for search-specific text', () => {
        assert.equal(classifySearchIndexError(new Error('command not found')), 'other');
        assert.equal(classifySearchIndexError(new Error('Search index commands are only supported with Atlas')), 'unsupported');
        assert.equal(classifySearchIndexError(new Error('Atlas Search index already exists')), 'exists');
        assert.equal(classifySearchIndexError(new Error('mongot failed to build')), 'other');
        assert.equal(classifySearchIndexError(serverError(6047401, 'Location6047401')), 'unsupported');
    });
});

describe('search indexes: waitForSearchIndex', () => {
    function stepClock(step: number) { let t = 0; return () => (t += step); }

    it('resolves when queryable', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'PENDING' }], [{ name: 'v', status: 'BUILDING' }], [{ name: 'v', status: 'READY', queryable: true }]] });
        const info = await waitForSearchIndexOp(ctx, 'v', { intervalMs: 100 });
        assert.equal(info.status, 'READY');
    });
    it('queryable: FAILED but still queryable counts as success (N6)', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'FAILED', queryable: true }]] });
        assert.equal((await waitForSearchIndexOp(ctx, 'v', { intervalMs: 100 })).status, 'FAILED');
    });
    it('queryable: FAILED and not queryable throws BUILD_FAILED', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'FAILED', queryable: false }]] });
        await rejectsCode(waitForSearchIndexOp(ctx, 'v', { intervalMs: 100 }), 'SEARCH_INDEX_BUILD_FAILED');
    });
    it('ready: waits past STALE and throws on FAILED', async () => {
        const a = fakeCollection({ lists: [[{ name: 'v', status: 'STALE', queryable: true }], [{ name: 'v', status: 'READY', queryable: true }]] });
        assert.equal((await waitForSearchIndexOp(a.ctx, 'v', { until: 'ready', intervalMs: 100 })).status, 'READY');
        const b = fakeCollection({ lists: [[{ name: 'v', status: 'FAILED', queryable: true }]] });
        await rejectsCode(waitForSearchIndexOp(b.ctx, 'v', { until: 'ready', intervalMs: 100 }), 'SEARCH_INDEX_BUILD_FAILED');
    });
    it('dropped: resolves on DOES_NOT_EXIST, keeps waiting on FAILED', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'DELETING' }], [{ name: 'v', status: 'FAILED' }], []] });
        assert.equal((await waitForSearchIndexOp(ctx, 'v', { until: 'dropped', intervalMs: 100 })).status, 'DOES_NOT_EXIST');
    });
    it('missing index within grace keeps waiting, then appears', async () => {
        const { ctx } = fakeCollection({ lists: [[], [{ name: 'v', status: 'READY', queryable: true }]] });
        assert.equal((await waitForSearchIndexOp(ctx, 'v', { intervalMs: 100 }, stepClock(10_000))).status, 'READY');
    });
    it('missing index after grace throws NOT_FOUND', async () => {
        const { ctx } = fakeCollection({ lists: [[]] });
        await rejectsCode(waitForSearchIndexOp(ctx, 'v', { intervalMs: 100 }, stepClock(20_000)), 'SEARCH_INDEX_NOT_FOUND');
    });
    it('times out with last info', async () => {
        const { ctx } = fakeCollection({ lists: [[{ name: 'v', status: 'BUILDING' }]] });
        const err = await rejectsCode(waitForSearchIndexOp(ctx, 'v', { intervalMs: 100, timeoutMs: 250 }), 'SEARCH_INDEX_WAIT_TIMEOUT');
        const details = (err as { details?: Array<{ last?: { status?: string } }> }).details;
        assert.equal(details?.[0]?.last?.status, 'BUILDING');
    });
    it('pre-aborted signal rejects with signal.reason without driver calls', async () => {
        const { ctx, calls } = fakeCollection();
        const controller = new AbortController();
        const reason = new Error('stop');
        controller.abort(reason);
        await assert.rejects(waitForSearchIndexOp(ctx, 'v', { signal: controller.signal }), (e: unknown) => e === reason);
        assert.equal(calls.length, 0);
    });
    it('abort during sleep rejects with signal.reason and passes signal to the cursor', async () => {
        const { ctx, calls } = fakeCollection({ lists: [[{ name: 'v', status: 'BUILDING' }]] });
        const controller = new AbortController();
        const reason = new Error('cancelled');
        setTimeout(() => controller.abort(reason), 150);
        await assert.rejects(waitForSearchIndexOp(ctx, 'v', { signal: controller.signal, intervalMs: 1000 }), (e: unknown) => e === reason);
        assert.ok((calls[0].args[1] as { signal?: unknown }).signal instanceof AbortSignal);
    });
    it('abort observed after a successful poll rejects with signal.reason', async () => {
        const controller = new AbortController();
        const reason = new Error('late abort');
        const collection = { listSearchIndexes: () => ({ toArray: async () => { controller.abort(reason); return [{ name: 'v', status: 'READY', queryable: true }]; } }) };
        await assert.rejects(waitForSearchIndexOp({ collection: collection as never, namespace: {} }, 'v', { signal: controller.signal }), (e: unknown) => e === reason);
    });
    it('hanging list respects timeout', async () => {
        const collection = {
            listSearchIndexes: (_name: string, opts: { signal: AbortSignal }) => ({
                toArray: () => new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))),
            }),
        };
        const ctx = { collection: collection as never, namespace: {} };
        await rejectsCode(waitForSearchIndexOp(ctx, 'v', { timeoutMs: 200, intervalMs: 100 }), 'SEARCH_INDEX_WAIT_TIMEOUT');
    });
    it('validates wait options', async () => {
        const { ctx } = fakeCollection();
        for (const opts of [{ until: 'gone' }, { timeoutMs: 0 }, { intervalMs: 50 }, { timeoutMs: 1.5 }, { signal: {} }]) {
            await rejectsCode(waitForSearchIndexOp(ctx, 'v', opts as never), 'INVALID_SEARCH_INDEX_DEFINITION');
        }
    });
});

describe('search indexes: accessor, Model and writePathPolicy', () => {
    afterEach(() => MonSQLize.Model._clear());

    function runtimeWith(options: Record<string, unknown>) {
        const calls: string[] = [];
        const collection = {
            collectionName: 'docs',
            listSearchIndexes: () => ({ toArray: async () => { calls.push('list'); return []; } }),
            createSearchIndex: async (d: Doc) => { calls.push('create'); return d.name; },
            createSearchIndexes: async (ds: Doc[]) => { calls.push('createMany'); return ds.map((d) => d.name); },
            updateSearchIndex: async () => { calls.push('update'); },
            dropSearchIndex: async () => { calls.push('drop'); },
        };
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'si_db', ...options });
        runtime._connected = true;
        runtime._client = { db: () => ({ databaseName: 'si_db', collection: () => collection }) };
        return { runtime, calls };
    }
    const spec = { name: 's', type: 'search', definition: SEARCH_DEF };

    it('allow-both: accessor writes work', async () => {
        const { runtime, calls } = runtimeWith({});
        assert.equal((await runtime.collection('docs').createSearchIndex(spec)).action, 'created');
        assert.deepEqual(calls, ['list', 'create']);
    });
    it('model-only: accessor writes blocked before any driver call; reads allowed', async () => {
        const { runtime, calls } = runtimeWith({ writePathPolicy: { default: 'model-only' } });
        const docs = runtime.collection('docs');
        for (const p of [docs.createSearchIndex(spec), docs.createSearchIndexes([spec]), docs.updateSearchIndex('s', SEARCH_DEF), docs.dropSearchIndex('s')]) {
            await assert.rejects(p, (e: { code?: string; details?: Array<{ category?: string }> }) => e.code === 'INVALID_OPERATION' && e.details?.[0]?.category === 'management');
        }
        assert.deepEqual(calls, []);
        assert.equal((await docs.getSearchIndex('s')).status, 'DOES_NOT_EXIST');
        assert.deepEqual(await docs.listSearchIndexes(), []);
    });
    it('model-only: Model writes allowed', async () => {
        const { runtime, calls } = runtimeWith({ writePathPolicy: { default: 'model-only' } });
        MonSQLize.Model.define('docs', { schema: {} });
        const model = runtime.model('docs');
        assert.equal((await model.createSearchIndex(spec)).created, true);
        await model.dropSearchIndex('s', { ignoreMissing: true });
        assert.deepEqual(calls, ['list', 'create', 'list']);
    });
    it('management block blocks Model too; warn only logs', async () => {
        const blocked = runtimeWith({ writePathPolicy: { default: { mode: 'allow-both', management: 'block' } } });
        MonSQLize.Model.define('docs', { schema: {} });
        await assert.rejects(blocked.runtime.model('docs').createSearchIndex(spec), (e: { code?: string }) => e.code === 'INVALID_OPERATION');
        const warned = runtimeWith({ writePathPolicy: { default: { mode: 'model-only', onViolation: 'warn' } } });
        assert.equal((await warned.runtime.collection('docs').createSearchIndex(spec)).created, true);
    });
});
