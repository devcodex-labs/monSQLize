import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { BSON, ObjectId, Timestamp, Binary, ReadPreference, ReadConcern } from 'mongodb';
import { snapshotResultOptions, buildResultCacheKeyOptions, stableCacheKeyString } from '../../../src/adapters/mongodb/queries/query-helpers';
import { snapshotPipelineValue } from '../../../src/adapters/mongodb/queries/pipeline-snapshot';
import { createAggregateChain } from '../../../src/adapters/mongodb/queries';
import { isStandardAggregateBsonMode, prepareAggregateExecution, prepareAggregatePipeline } from '../../../src/adapters/mongodb/queries/aggregate-pipeline';
import { buildAggregateCacheKey, buildPreparedAggregateCacheKey } from '../../../src/adapters/mongodb/queries/query-cache-keys';

function wire(pipeline: unknown): unknown {
    return BSON.deserialize(BSON.serialize({ pipeline })).pipeline;
}

describe('pipeline capture at the driver document boundary', () => {
    it('preserves BSON input identity across stable key generations', () => {
        const key = (value: unknown) => stableCacheKeyString(value, 'document');
        assert.ok(key({}).startsWith('v3:'));
        assert.notEqual(key({ x: undefined }), key({}));
        assert.notEqual(key(-0), key(0));
        assert.notEqual(key({ a: 1, b: 2 }), key({ b: 2, a: 1 }));
        assert.equal(stableCacheKeyString({ a: 1, b: 2 }), stableCacheKeyString({ b: 2, a: 1 }));
        assert.equal(stableCacheKeyString({ absent: undefined }), stableCacheKeyString({}));
        for (const value of [Buffer.alloc(0), Buffer.from([1]), new Uint8Array([1]),
            runInNewContext('new Uint8Array([1])')]) {
            assert.notEqual(key(value), key(Object.fromEntries(Object.entries(value))));
        }
        const bytes = new Uint8Array([9, 1, 8]);
        assert.equal(key(bytes.subarray(1, 2)), key(new BSON.Binary(Buffer.from([1]))));
        assert.equal(key(Buffer.from(bytes).subarray(1, 2)), key(new Uint8Array([1])));
        const empty = new BSON.Binary(), one = new BSON.Binary(); one.put(0);
        assert.notEqual(key(empty), key(one));
        assert.equal(key(empty), key(Buffer.alloc(0)));
        assert.notEqual(key(new BSON.Binary(Buffer.from([1]), 0)), key(new BSON.Binary(Buffer.from([1]), 128)));
        for (const expression of ['new Date(1)', '/a/i', 'new Map([["x", 1]])']) {
            const value = runInNewContext(expression);
            assert.notEqual(key(value), key({}));
            assert.equal(key(value), key(snapshotPipelineValue(value)));
        }
        const map = new Map([['2', 'second'], ['1', 'first']]);
        assert.equal(key(map), key(snapshotPipelineValue(map)));
        assert.notEqual(key(map), key({ '1': 'first', '2': 'second' }));
    });

    it('keys undefined serialization by effective driver inheritance', () => {
        const parent = { ignoreUndefined: true };
        assert.equal(buildResultCacheKeyOptions({}, parent).ignoreUndefined, true);
        assert.equal(buildResultCacheKeyOptions({ ignoreUndefined: undefined }, parent).ignoreUndefined, true);
        assert.equal(buildResultCacheKeyOptions({ ignoreUndefined: null }, parent).ignoreUndefined, true);
        assert.equal(buildResultCacheKeyOptions({ ignoreUndefined: false }, parent).ignoreUndefined, false);
        assert.equal(buildResultCacheKeyOptions().ignoreUndefined, false);
    });

    it('captures cross-realm BSON native leaves without changing wire values', () => {
        const input = runInNewContext('[{ $match: { date: new Date(1), regex: /a/i, bytes: new Uint8Array([9,1,8]).subarray(1,2), map: new Map([["2","b"],["1","a"]]) } }]');
        const snapshot = snapshotPipelineValue(input);
        assert.deepEqual(BSON.serialize({ pipeline: snapshot }), BSON.serialize({ pipeline: input }));
        input[0].$match.bytes[0] = 7; input[0].$match.date.setTime(20);
        assert.equal(snapshot[0].$match.bytes[0], 1); assert.equal(snapshot[0].$match.date.getTime(), 1);
    });
    it('captures native BSON decoding flags and preserves fieldsAsRaw prototype behavior', () => {
        const fields: any = Object.create({ payload: false });
        const captured = prepareAggregateExecution([], { fieldsAsRaw: fields });
        assert.equal(isStandardAggregateBsonMode(captured.options), true);
        fields.payload = true;
        assert.equal((captured.options.fieldsAsRaw as any).payload, false);
        assert.equal(isStandardAggregateBsonMode(prepareAggregateExecution([], { fieldsAsRaw: fields }).options), false);
        for (const [name, value] of Object.entries({ raw: true, useBigInt64: true, promoteLongs: false,
            promoteValues: false, promoteBuffers: true, ignoreUndefined: true, bsonRegExp: true,
            serializeFunctions: true, enableUtf8Validation: false })) {
            const result = prepareAggregateExecution([], {}, {}, { [name]: value });
            assert.equal(result.options[name], value); assert.equal(isStandardAggregateBsonMode(result.options), false);
        }
        const baseline: any = prepareAggregateExecution([]).options.fieldsAsRaw;
        assert.equal(baseline.constructor, true); assert.equal(baseline.toString, true);
        const noPrototype: any = prepareAggregateExecution([], { fieldsAsRaw: Object.create(null) }).options.fieldsAsRaw;
        assert.equal(noPrototype.constructor, undefined);
        assert.equal(isStandardAggregateBsonMode(prepareAggregateExecution([], { fieldsAsRaw: Object.create(null) }).options), false);
        const dynamic = new Proxy({}, { get: (_target, key) => key === 'payload' });
        const native = prepareAggregateExecution([], { fieldsAsRaw: dynamic });
        assert.equal(native.options.fieldsAsRaw, dynamic); assert.equal(isStandardAggregateBsonMode(native.options), false);
    });
    it('captures result options while preserving driver resource identities and native consistency types', async () => {
        const controller = new AbortController(), session = { resource: true };
        const preference = new ReadPreference('secondary', [{ region: 'east' }], { maxStalenessSeconds: 90, hedge: { enabled: true } });
        const concern = new ReadConcern('majority');
        const options: any = { let: { value: 1 }, hint: { score: 1 }, collation: { locale: 'en' },
            readPreference: preference, readConcern: concern, session, signal: controller.signal };
        const captured: any = snapshotResultOptions(options);
        options.let.value = 2; options.hint.score = -1; options.collation.locale = 'fr';
        preference.tags![0].region = 'west'; preference.hedge!.enabled = false;
        assert.equal(captured.let.value, 1); assert.equal(captured.hint.score, 1); assert.equal(captured.collation.locale, 'en');
        assert.ok(captured.readPreference instanceof ReadPreference); assert.ok(captured.readConcern instanceof ReadConcern);
        assert.deepEqual(captured.readPreference.tags, [{ region: 'east' }]); assert.equal(captured.readPreference.hedge.enabled, true);
        assert.equal(captured.readPreference.maxStalenessSeconds, 90); assert.equal(captured.readConcern.level, 'majority');
        assert.equal(captured.session, session); assert.equal(captured.signal, controller.signal);
        controller.abort(); assert.equal(captured.signal.aborted, true);
        const ordinary = snapshotResultOptions({ readPreference: 'secondary', readPreferenceTags: [{ region: 'east' }], maxStalenessSeconds: 90, hedge: { enabled: true } });
        assert.deepEqual(buildResultCacheKeyOptions(ordinary).readPreference, captured.readPreference);
        const configured: any = snapshotResultOptions({ readConcern: { level: 'majority', toBSON() { throw new Error('Not BSON'); } } });
        assert.equal(configured.readConcern.level, 'majority');
        class Concern { get level() { return 'majority'; } }
        class Preference { get mode() { return 'secondary'; } get tags() { return [{ region: 'east' }]; } }
        const inherited: any = snapshotResultOptions({ readConcern: new Concern(), readPreference: new Preference() });
        assert.equal(inherited.readConcern.level, 'majority'); assert.equal(inherited.readPreference.mode, 'secondary');
        assert.deepEqual(inherited.readPreference.tags, [{ region: 'east' }]);
        const original = new ReadPreference('secondary', [{ region: 'original' }]);
        const transactionSession = { transaction: { options: { readPreference: original } } };
        const tags = [{ region: 'captured' }];
        const tagsOnly: any = snapshotResultOptions({ session: transactionSession, readPreferenceTags: tags });
        tags[0].region = 'changed';
        assert.equal(tagsOnly.session, transactionSession); assert.deepEqual(original.tags, [{ region: 'original' }]);
        assert.deepEqual(tagsOnly.readPreferenceTags, [{ region: 'captured' }]);
    });

    it('uses one captured execution tuple across cache waits and later fluent changes', async () => {
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const values = new Map<string, unknown>(), calls: any[] = [];
        let pause = true;
        const cache: any = { get: async (key: string) => { if (pause && key.startsWith('aggregate:')) { pause = false; entered(); await gate; } return values.get(key); },
            set: (key: string, value: unknown) => { values.set(key, value); } };
        const collection: any = { namespace: 'db.snapshot', aggregate: (pipeline: unknown[], options: any) => {
            calls.push({ pipeline, options }); return { toArray: async () => [{ value: options.let.value }] };
        } };
        const options = { let: { value: 1 }, hint: { score: 1 }, collation: { locale: 'en' }, cache: 10000 };
        const chain = createAggregateChain(collection, [{ $project: { value: '$$value' } }], options, {}, cache);
        const first = Promise.resolve(chain); await waiting;
        options.let.value = 2; options.hint.score = -1; options.collation.locale = 'fr';
        chain.hint({ score: -1 }).collation({ locale: 'fr' }); release();
        assert.deepEqual(await first, [{ value: 1 }]);
        assert.equal(calls[0].options.hint.score, 1); assert.equal(calls[0].options.collation.locale, 'en');
        const sameOptions = { let: { value: 1 }, hint: { score: 1 }, collation: { locale: 'en' }, cache: 10000 };
        const same = await createAggregateChain(collection, [{ $project: { value: '$$value' } }], sameOptions, {}, cache);
        assert.deepEqual(same, [{ value: 1 }]);
        assert.equal(calls.length, 1);
    });
    it('uses identical raw descriptor and prepared read keys without repeating serialization', () => {
        const { expr } = require('../../../dist/cjs/index.cjs');
        const collection = { namespace: 'db.items', collectionName: 'items' } as never;
        const hex = new ObjectId().toHexString();
        const marker = { __expr__: 'not valid(', __compiled__: false };
        for (const enabled of [false, true]) {
            let calls = 0;
            const pipeline = [{ toBSON() { calls++; return { $match: { _id: hex } }; } },
                { $project: { value: expr(`LITERAL("${hex}")`), payload: { $literal: marker }, timestamp: { $literal: Timestamp.fromNumber(123) } } }];
            const defaults = { autoConvertObjectId: enabled, maxTimeMS: 1000 };
            const options = { let: { value: 'kept' }, collation: { locale: 'simple' } };
            const prepared = prepareAggregatePipeline(pipeline, defaults);
            assert.equal(calls, 1);
            assert.equal(prepared[0].$match._id instanceof ObjectId, enabled);
            assert.equal(prepared[1].$project.value.$literal, hex);
            assert.deepEqual(prepared[1].$project.payload.$literal, marker);
            const key = buildPreparedAggregateCacheKey(collection, defaults, prepared, options);
            assert.equal(buildPreparedAggregateCacheKey(collection, defaults, prepared, options), key);
            assert.equal(calls, 1);
            assert.equal(buildAggregateCacheKey(collection, defaults, pipeline, options), key);
            assert.equal(calls, 2);
        }
    });

    it('prepares hooks exactly once with the compiled pipeline passed to the driver', async () => {
        let prepared: unknown, executed: unknown, calls = 0;
        const collection = { namespace: 'db.items', collectionName: 'items', aggregate(pipeline: unknown) {
            executed = pipeline; return { toArray: async () => [] };
        } };
        const { expr } = require('../../../dist/cjs/index.cjs');
        await createAggregateChain(collection as never, [{ $merge: { into: expr('"compiled"') } }], {}, {}, null, (pipeline) => {
            prepared = pipeline; calls++;
            assert.equal(pipeline[0].$merge.into, 'compiled'); return undefined;
        }).toArray();
        assert.equal(calls, 1); assert.equal(executed, prepared);
    });
    it('captures class documents, nested targets, getters and Map documents', () => {
        class Target { db = 'audit'; coll = 'allowed'; }
        class Stage { $out = new Target(); }
        const stage = new Stage();
        const map = new Map([['$match', { enabled: true }]]);
        const input = [stage, map];
        const snapshot = snapshotPipelineValue(input);
        stage.$out.coll = 'changed'; map.set('$out', 'changed' as any);
        assert.deepEqual(wire(snapshot), [{ $out: { db: 'audit', coll: 'allowed' } }, { $match: { enabled: true } }]);
    });

    it('materializes serialization functions before later execution', () => {
        let coll = 'allowed', calls = 0;
        const stage = { toBSON() { calls += 1; return { $out: { toBSON: () => ({ db: 'audit', coll }) } }; } };
        const snapshot = snapshotPipelineValue([stage]);
        assert.equal(calls, 1);
        coll = 'changed';
        assert.deepEqual(wire(snapshot), [{ $out: { db: 'audit', coll: 'allowed' } }]);
        assert.equal(calls, 1);
        assert.deepEqual(wire(snapshotPipelineValue(snapshot)), wire(snapshot));
    });

    it('preserves BSON leaves and internal symbols while copying frozen documents', () => {
        const marker = Symbol.for('monsqlize.internal.model-query-filter.v1');
        const id = new ObjectId(), timestamp = Timestamp.fromNumber(123), bytes = new Binary(Buffer.from('value'));
        const stage = Object.freeze({ $match: Object.freeze({ _id: id, timestamp, bytes }), [marker]: { visible: true } });
        const snapshot = snapshotPipelineValue(Object.freeze([stage]));
        assert.notEqual(snapshot[0], stage);
        assert.ok(snapshot[0].$match._id instanceof ObjectId);
        assert.ok(snapshot[0].$match.timestamp instanceof Timestamp);
        assert.ok(snapshot[0].$match.bytes instanceof Binary);
        assert.deepEqual(snapshot[0][marker], { visible: true });
        assert.deepEqual(wire(snapshot), wire([stage]));
    });

    it('copies mutable native leaves without retaining a later caller converter', () => {
        const date = new Date(123), id = new ObjectId();
        const snapshot = snapshotPipelineValue([{ $match: { date, id } }]);
        const expected = wire(snapshot);
        date.setTime(456);
        (id as any).toBSON = () => ({ changed: true });
        assert.deepEqual(wire(snapshot), expected);
    });

    it('preserves native BSON field order for Maps with integer-like keys', () => {
        const input = [{ $match: { payload: new Map([['2', 'second'], ['1', 'first']]) } }];
        const snapshot = snapshotPipelineValue(input);
        assert.deepEqual(BSON.serialize({ pipeline: snapshot }), BSON.serialize({ pipeline: input }));
        assert.deepEqual(BSON.serialize({ pipeline: snapshotPipelineValue(snapshot) }), BSON.serialize({ pipeline: input }));
    });
});
