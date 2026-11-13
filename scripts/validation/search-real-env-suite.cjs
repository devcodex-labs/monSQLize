'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { MongoClient, Binary } = require('mongodb');

const DIMENSIONS = 64;
const SIZE = 1024;
const SCORE = '__search_real_score__';
const root = path.resolve(__dirname, '../..');

function errorInfo(error, seen = new Set()) {
    if (!error || typeof error !== 'object') return { message: String(error) };
    if (seen.has(error)) return { message: '[circular error]' };
    seen.add(error);
    const info = { name: error.name, message: error.message, code: error.code, codeName: error.codeName, stack: error.stack };
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === 'cause') info.cause = errorInfo(error.cause, seen);
        else if (!['stack', 'message'].includes(key)) info[key] = error[key];
    }
    return info;
}

function vector(i) {
    let state = i + 1;
    return Array.from({ length: DIMENSIONS }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 2147483648 - 1;
    });
}

function document(i) {
    const embedding = vector(i);
    // Keep the nearest packed-bit documents at unique Hamming distances 0..4.
    const bits = i < 5 ? Array.from({ length: DIMENSIONS }, (_, k) => k < i ? 1 : 0)
        : Array.from({ length: DIMENSIONS }, (_, k) => k < 8 ? 1 : (embedding[k] >= 0 ? 1 : 0));
    return {
        _id: i, score: 'application-score', title: `article ${i}`,
        text: i < 16 ? `${'banana '.repeat(20 - i)}mongodb article ${i}` : `ordinary record ${i}`,
        embedding, embeddingInt8: Binary.fromInt8Array(Int8Array.from(embedding.map(v => Math.round(v * 127)))),
        embeddingInt1: Binary.fromBits(bits), deleted: i % 2 === 1,
        deletedAt: i % 2 === 1 ? new Date('2026-01-01T00:00:00Z') : null,
    };
}

function slim(hits) {
    return hits.map(hit => ({ id: hit.document._id, sourceScore: hit.document.score, score: hit.score }));
}

async function runSearchSuite(config, dependencies = {}) {
    const NativeClient = dependencies.MongoClient || MongoClient;
    const library = dependencies.library || require(path.join(root, 'dist/cjs/index.cjs'));
    const Runtime = library.default || library;
    const Model = library.Model;
    const database = `msq_search_real_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
    const report = { status: 'failed', startedAt: new Date().toISOString(), database, environment: {}, steps: [], cleanup: [] };
    const client = new NativeClient(config.uri, { monitorCommands: true, serverSelectionTimeoutMS: 10000 });
    let runtime;
    let ownsDatabase = false;
    const registrations = [];
    let active = 'setup';
    const counts = { native: 0, monsqlize: 0 };
    const monitor = (c, surface) => c.on('commandStarted', event => {
        if (event.commandName === 'aggregate' || event.commandName === 'createSearchIndexes') {
            counts[surface]++;
        }
    });
    monitor(client, 'native');
    async function step(name, input, action) {
        active = name;
        const before = { ...counts };
        const item = { name, input, startedAt: new Date().toISOString() };
        try { item.result = await action(); item.ok = true; }
        catch (error) { item.ok = false; item.error = errorInfo(error); }
        item.commandsSent = { native: counts.native - before.native, monsqlize: counts.monsqlize - before.monsqlize };
        report.steps.push(item);
        return item;
    }
    const requireSuccess = (item) => {
        if (!item.ok) throw Object.assign(new Error(`Required step failed: ${item.name}`), { cause: item.error });
        return item.result;
    };
    try {
        await client.connect();
        runtime = new Runtime({ type: 'mongodb', databaseName: database, config: { uri: config.uri, options: { monitorCommands: true, serverSelectionTimeoutMS: 10000 } } });
        await runtime.connect();
        const native = client.db(database).collection('documents');
        const acc = runtime.collection('documents');
        monitor(acc.raw().client, 'monsqlize');
        report.environment = {
            node: process.version, driver: require('mongodb/package.json').version,
            bson: JSON.parse(require('node:fs').readFileSync(path.join(path.dirname(require.resolve('bson')), '../package.json'), 'utf8')).version,
            buildInfo: await client.db('admin').command({ buildInfo: 1 }),
            fcv: await client.db('admin').command({ getParameter: 1, featureCompatibilityVersion: 1 }),
            mongot: { source: 'Capture version/image digest from the deployment and associate it with this report.' },
        };
        ownsDatabase = true; // This generated name is never taken from the URI or caller configuration.
        requireSuccess(await step('seed', { count: SIZE, dimensions: DIMENSIONS }, async () => {
            const result = await native.insertMany(Array.from({ length: SIZE }, (_, i) => document(i)));
            return { insertedCount: result.insertedCount };
        }));
        const specs = [
            ['baseline', 'embedding', 'cosine'], ['scalar', 'embedding', 'cosine', 'scalar'],
            ['binary', 'embedding', 'cosine', 'binary'], ['int8', 'embeddingInt8', 'cosine'],
            ['int1', 'embeddingInt1', 'euclidean'],
        ];
        for (const [name, field, similarity, quantization] of specs) {
            const spec = { name: `vec_${name}`, type: 'vectorSearch', definition: { fields: [
                { type: 'vector', path: field, numDimensions: DIMENSIONS, similarity, ...(quantization ? { quantization } : {}) },
                { type: 'filter', path: 'deleted' }, { type: 'filter', path: 'deletedAt' },
            ] } };
            const created = await step(`index.${name}.create`, spec, () => acc.createSearchIndex(spec));
            if (!created.ok) await step(`index.${name}.native-control`, spec, () => native.createSearchIndex(spec));
            requireSuccess(created);
        }
        requireSuccess(await step('index.text.create', {}, () => acc.createSearchIndex({ name: 'text_idx', type: 'search', definition: { mappings: { dynamic: false, fields: { text: { type: 'string' } } } } })));
        for (const name of [...specs.map(s => `vec_${s[0]}`), 'text_idx']) {
            requireSuccess(await step(`index.${name}.ready`, { timeoutMs: config.timeoutMs }, async () => {
                const result = await acc.waitForSearchIndex(name, { until: 'ready', timeoutMs: config.timeoutMs, intervalMs: 500 });
                assert.equal(result.status, 'READY'); assert.equal(result.queryable, true);
                return result;
            }));
        }
        const first = document(0);
        const models = {};
        for (const [key, softDelete] of [['plain', false], ['boolean', { field: 'deleted', type: 'boolean' }], ['date', true]]) {
            const name = `${database}_${key}`;
            Model.define(name, { collection: 'documents', schema: {}, options: { autoIndex: false, softDelete } });
            registrations.push(name); models[key] = runtime.model(name);
        }
        async function compare(name, index, field, queryVector, extra = {}, model) {
            const opts = { index, path: field, queryVector, limit: 5, ...extra };
            const projection = { _id: 1, score: 1 };
            const pipeline = [{ $vectorSearch: opts }, { $project: { ...projection, [SCORE]: { $meta: 'vectorSearchScore' } } }];
            const raw = await step(`${name}.native`, pipeline, async () => {
                const rows = await native.aggregate(pipeline, { maxTimeMS: 30000 }).toArray();
                assert.equal(rows.length, 5);
                assert.ok(rows.every(row => Number.isFinite(row[SCORE])));
                return rows.map(row => ({ id: row._id, sourceScore: row.score, score: row[SCORE] }));
            });
            await step(`${name}.${model ? 'model' : 'collection'}`, opts, async () => {
                const hits = await (model || acc).vectorSearch({ ...opts, projection, aggregateOptions: { maxTimeMS: 30000 } });
                assert.ok(hits.every(hit => hit.document.score === 'application-score'));
                if (model) assert.ok(hits.every(hit => typeof hit.document.populate === 'function'));
                assert.equal(raw.ok, true, 'native control must succeed');
                assert.deepEqual(slim(hits), raw.result);
                return slim(hits);
            });
        }
        for (const name of ['baseline', 'scalar', 'binary', 'int8', 'int1']) {
            const field = name === 'int8' ? 'embeddingInt8' : name === 'int1' ? 'embeddingInt1' : 'embedding';
            for (const mode of ['ann', 'enn']) {
                const extra = mode === 'ann' ? { numCandidates: 100 } : { exact: true };
                await compare(`${name}.${mode}`, `vec_${name}`, field, first[field], extra);
                if (name === 'int8' || name === 'int1') await compare(`${name}.${mode}.model`, `vec_${name}`, field, first[field], extra, models.plain);
            }
        }
        for (const [kind, field, model] of [['boolean', 'deleted', models.boolean], ['date', 'deletedAt', models.date]]) {
            for (const [label, flags, filter] of [
                ['visible', {}, { [field]: kind === 'boolean' ? { $ne: true } : null }],
                ['all', { withDeleted: true }, undefined],
                ['deleted', { onlyDeleted: true }, { [field]: kind === 'boolean' ? true : { $ne: null } }],
            ]) {
                const opts = { index: 'vec_int8', path: 'embeddingInt8', queryVector: first.embeddingInt8, limit: 5, numCandidates: 100 };
                const pipeline = [{ $vectorSearch: { ...opts, ...(filter ? { filter } : {}) } }, { $project: { _id: 1, [SCORE]: { $meta: 'vectorSearchScore' } } }];
                const raw = await step(`model.${kind}.${label}.native`, pipeline, () => native.aggregate(pipeline).toArray());
                await step(`model.${kind}.${label}`, flags, async () => {
                    const hits = await model.vectorSearch({ ...opts, ...flags, projection: ['_id'] });
                    assert.equal(raw.ok, true); assert.equal(hits.length, 5);
                    assert.deepEqual(hits.map(h => ({ _id: h.document._id, score: h.score })), raw.result.map(row => ({ _id: row._id, score: row[SCORE] })));
                    return hits.map(h => ({ _id: h.document._id, score: h.score }));
                });
            }
        }
        for (const [name, field] of [['int8', 'embeddingInt8'], ['int1', 'embeddingInt1']]) {
            const queryVector = name === 'int8' ? Array.from(first[field].toInt8Array()) : first.embedding;
            const opts = { index: `vec_${name}`, path: field, queryVector, limit: 5, numCandidates: 100 };
            const pipeline = [{ $vectorSearch: opts }];
            const raw = await step(`${name}.wrong-representation.native`, pipeline, () => native.aggregate(pipeline).toArray());
            await step(`${name}.wrong-representation.collection`, opts, async () => {
                const result = await acc.vectorSearch(opts);
                assert.equal(raw.ok, true); assert.deepEqual(raw.result, []); assert.deepEqual(result, []);
                return result;
            });
        }
        await step('local-invalid.no-query', {}, async () => {
            const before = counts.monsqlize;
            await assert.rejects(acc.vectorSearch({ index: 'vec_int8', path: 'embeddingInt8', queryVector: new Binary(Uint8Array.of(1)), limit: 1, exact: true }), e => e.code === 'INVALID_VECTOR_SEARCH');
            assert.equal(counts.monsqlize, before);
            return { queryCommandsSent: 0 };
        });
        const bad = { index: 'vec_scalar', path: 'embedding', queryVector: first.embedding.slice(1), numCandidates: 100, limit: 5 };
        const failures = [];
        for (const [surface, action] of [
            ['native', () => native.aggregate([{ $vectorSearch: bad }]).toArray()],
            ['aggregate', () => acc.aggregate([{ $vectorSearch: bad }]).toArray()],
            ['collection', () => acc.vectorSearch(bad)],
        ]) {
            await step(`dimension-error.${surface}`, bad, async () => {
                try { await action(); assert.fail('expected a server dimension error'); }
                catch (error) { assert.equal(error.name, 'MongoServerError'); failures.push(error); return errorInfo(error); }
            });
        }
        await step('dimension-error.parity', {}, () => {
            assert.equal(failures.length, 3);
            for (const error of failures) { assert.equal(error.code, failures[0].code); assert.equal(error.message, failures[0].message); }
            return { code: failures[0].code, message: failures[0].message };
        });
        const search = { $search: { index: 'text_idx', text: { query: 'banana', path: 'text' } } };
        async function aggregates(name, pipeline, verify) {
            const raw = await step(`${name}.native`, pipeline, async () => { const rows = await native.aggregate(pipeline).toArray(); verify(rows); return rows; });
            await step(`${name}.aggregate`, pipeline, async () => {
                const rows = await acc.aggregate(pipeline).toArray(); verify(rows);
                assert.equal(raw.ok, true); assert.deepEqual(rows, raw.result); return rows;
            });
        }
        await aggregates('search', [search, { $project: { _id: 1, score: { $meta: 'searchScore' } } }, { $sort: { score: -1, _id: 1 } }, { $limit: 5 }], rows => {
            assert.equal(rows.length, 5); assert.ok(rows.every(row => Number.isFinite(row.score) && row.score > 0));
        });
        for (const type of ['total', 'lowerBound']) {
            await aggregates(`searchMeta.${type}`, [{ $searchMeta: { ...search.$search, count: { type } } }], rows => assert.equal(Number(rows[0].count[type]), 16));
        }
        const pipelines = { lexical: [search, { $limit: 20 }], semantic: [{ $vectorSearch: { index: 'vec_baseline', path: 'embedding', queryVector: first.embedding, numCandidates: 100, limit: 20 } }] };
        for (const stage of ['$rankFusion', '$scoreFusion']) {
            const pipeline = [{ [stage]: { input: { pipelines, ...(stage === '$scoreFusion' ? { normalization: 'sigmoid' } : {}) }, combination: { weights: { lexical: 0.5, semantic: 0.5 } }, scoreDetails: true } },
                { $project: { _id: 1, score: { $meta: 'score' }, details: { $meta: 'scoreDetails' } } }, { $sort: { score: -1, _id: 1 } }, { $limit: 5 }];
            await aggregates(stage, pipeline, rows => { assert.equal(rows.length, 5); assert.ok(rows.every(row => Number.isFinite(row.score) && row.details)); });
        }
    } catch (error) { report.fatal = { step: active, ...errorInfo(error) }; }
    finally {
        const cleanup = async (name, action) => {
            try { await action(); report.cleanup.push({ name, ok: true }); }
            catch (error) { report.cleanup.push({ name, ok: false, error: errorInfo(error) }); }
        };
        if (ownsDatabase) await cleanup('drop-owned-database', () => client.db(database).dropDatabase());
        for (const name of registrations) await cleanup(`undefine:${name}`, () => Model.undefine(name));
        if (runtime) await cleanup('runtime.close', () => runtime.close());
        await cleanup('client.close', () => client.close());
        report.finishedAt = new Date().toISOString();
        report.status = !report.fatal && report.steps.length > 0 && report.steps.every(s => s.ok) && report.cleanup.every(s => s.ok) ? 'passed' : 'failed';
    }
    return report;
}

module.exports = { runSearchSuite, errorInfo };
