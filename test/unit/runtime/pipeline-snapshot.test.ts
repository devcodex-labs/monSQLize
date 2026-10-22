import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { BSON, ObjectId, Timestamp, Binary, ReadPreference, ReadConcern } from 'mongodb';
import { snapshotResultOptions, snapshotReadInputs, snapshotFindPageOptions, buildResultCacheKeyOptions, stableCacheKeyString } from '../../../src/adapters/mongodb/queries/query-helpers';
import { captureBsonOptions, canCacheBsonResult, hasStableBsonFields } from '../../../src/adapters/mongodb/queries/bson-read-options';
import { computeTotals } from '../../../src/adapters/mongodb/queries/find-page-totals';
import { findByIdsDocuments } from '../../../src/adapters/mongodb/queries/find-by-id';
import { snapshotPipelineValue } from '../../../src/adapters/mongodb/queries/pipeline-snapshot';
import { createAggregateChain, createFindChain } from '../../../src/adapters/mongodb/queries';
import { isStandardAggregateBsonMode, prepareAggregateExecution, prepareAggregatePipeline } from '../../../src/adapters/mongodb/queries/aggregate-pipeline';
import { buildAggregateCacheKey, buildPreparedAggregateCacheKey } from '../../../src/adapters/mongodb/queries/query-cache-keys';

function wire(pipeline: unknown): unknown {
    return BSON.deserialize(BSON.serialize({ pipeline })).pipeline;
}

describe('pipeline capture at the driver document boundary', () => {
    it('preserves Code scope undefined and separates it from null in document keys', () => {
        const a = new BSON.Code('return x;', { x: undefined, nested: { y: undefined } });
        const b = new BSON.Code('return x;', { x: null, nested: { y: undefined } });
        assert.notEqual(stableCacheKeyString(a), stableCacheKeyString(b));
        const captured = snapshotPipelineValue({ value: a });
        for (const ignoreUndefined of [false, true]) {
            assert.deepEqual(BSON.serialize(captured, { ignoreUndefined }), BSON.serialize({ value: a }, { ignoreUndefined }));
        }
        a.scope!.nested.y = 1;
        assert.equal((captured.value.scope as any).nested.y, undefined);
    });

    it('preserves Code scope short circuits, repeated getters and source-before-document ordering', () => {
        const fn = Object.assign(function () {}, { x: 1 });
        const sequences: unknown[][] = [[null], [false], [{}, 1], [{}, null, { x: 3 }],
            ...[null, undefined, 7, false, 'ab', 2n, Symbol('scope'), fn, new Map([['x', 3]]), [3]]
                .map(value => [{}, {}, value])];
        for (const sequence of sequences) for (const failAt of ['', 'scope2', 'scope3', 'code']) {
            const make = () => {
                let reads = 0; const events: string[] = [], value = new BSON.Code('x');
                Object.defineProperty(value, 'scope', { get() {
                    const event = 'scope' + ++reads; events.push(event);
                    if (event === failAt) throw new Error(event);
                    return sequence[Math.min(reads - 1, sequence.length - 1)];
                } });
                Object.defineProperty(value, 'code', { get() {
                    events.push('code'); if (failAt === 'code') throw new Error('code'); return 'x';
                } });
                return { value, events };
            };
            const native = make(), captured = make();
            let expected: Uint8Array | undefined, failure: Error | undefined;
            try { expected = BSON.serialize({ value: native.value }); } catch (error) { failure = error as Error; }
            if (failure) assert.throws(() => snapshotPipelineValue({ value: captured.value }),
                (error: any) => error.name === failure!.name);
            else assert.deepEqual(BSON.serialize(snapshotPipelineValue({ value: captured.value })), expected);
            assert.deepEqual(captured.events, native.events);
        }
    });

    it('keeps disabled DBRef functions ignored while enabled captured Code remains keyed', () => {
        const oid = new ObjectId('000000000000000000000001');
        const ignored = function () {}; ignored.toString = () => { throw new Error('Unused function source'); };
        const captureRef = (fields: Record<string, unknown>, enabled = false) => snapshotPipelineValue({
            value: new BSON.DBRef('items', oid, undefined, fields),
        }, undefined, enabled);
        assert.equal(stableCacheKeyString(captureRef({ fn: ignored }), 'document'), stableCacheKeyString(captureRef({}), 'document'));
        const a = function () {}; a.toString = () => 'function a(){return 1;}';
        const b = function () {}; b.toString = () => 'function b(){return 2;}';
        assert.notEqual(stableCacheKeyString(captureRef({ fn: a }, true), 'document'), stableCacheKeyString(captureRef({ fn: b }, true), 'document'));
        for (const enabled of [false, true]) assert.deepEqual(BSON.serialize(captureRef({ fn: a }, enabled), { serializeFunctions: enabled }),
            BSON.serialize({ value: new BSON.DBRef('items', oid, undefined, { fn: a }) }, { serializeFunctions: enabled }));
    });

    it('matches Code document conversion without redispatching its returned type', () => {
        for (const result of [new Map([['map', 1]]), Object.assign([1], { extra: 2 }), new Date(1), 42]) {
            const make = () => new BSON.Code('return x;', { toBSON() { return result as any; } });
            if (result === 42) {
                assert.throws(() => BSON.serialize({ value: make() }), BSON.BSONError);
                assert.throws(() => snapshotPipelineValue({ value: make() }), BSON.BSONError);
            } else assert.deepEqual(BSON.serialize(snapshotPipelineValue({ value: make() })), BSON.serialize({ value: make() }));
        }
        for (const scope of [Object.assign(new Map([['x', 1]]), { toBSON() { throw new Error('Unused Map converter'); } }),
            Object.assign([1], { toBSON() { throw new Error('Unused array converter'); } })]) {
            const code = new BSON.Code('return x;', scope);
            assert.deepEqual(BSON.serialize(snapshotPipelineValue({ value: code })), BSON.serialize({ value: code }));
        }
    });

    it('retains native document-converter errors and dispatch after a value conversion', () => {
        for (const result of [42, new Map([['x', 1]]), Object.assign([1], { extra: 2 }), new Date(1)]) {
            const make = () => ({ value: { toBSON() { return { toBSON() { return result; } }; } } });
            if (result === 42) {
                assert.throws(() => BSON.serialize(make()), BSON.BSONError);
                assert.throws(() => snapshotPipelineValue(make()), BSON.BSONError);
            } else assert.deepEqual(BSON.serialize(snapshotPipelineValue(make())), BSON.serialize(make()));
        }
    });

    it('preserves repeated converter lookup and DBRef merged-document serialization', () => {
        const make = () => { let reads = 0; return { value: { get toBSON() { return ++reads === 1 ? () => 99 : () => 42; } } }; };
        assert.deepEqual(BSON.serialize(snapshotPipelineValue(make())), BSON.serialize(make()));
        for (const serializeFunctions of [false, true]) for (const ignoreUndefined of [false, true]) {
            const makeRef = () => {
                const fn = function () {}; fn.toString = () => 'function stable(){return 1;}';
                return { value: new BSON.DBRef('items', new ObjectId('000000000000000000000001'), 'db', {
                    missing: undefined, fn, code: new BSON.Code('return x;', { x: undefined }),
                    toBSON() { return { receiver: this.$ref, missing: this.missing, fn: this.fn, code: this.code }; },
                }) };
            };
            assert.deepEqual(BSON.serialize(snapshotPipelineValue(makeRef(), undefined, serializeFunctions), { serializeFunctions, ignoreUndefined }),
                BSON.serialize(makeRef(), { serializeFunctions, ignoreUndefined }));
        }
        for (const marker of ['Code', 42, false, {}, null, undefined]) {
          const doc = { _bsontype: marker, code: 'data' };
          for (const value of [new BSON.DBRef('items', new ObjectId(), undefined, { $ref: undefined, ...doc }),
            new Map(Object.entries(doc)), new BSON.Code('x', doc),
            new BSON.DBRef('items', new ObjectId(), undefined, { $ref: 'a.b' })]) {
            const input = { value }, captured = snapshotPipelineValue(input);
            assert.deepEqual(BSON.serialize(captured), BSON.serialize(input));
            assert.deepEqual(BSON.serialize(snapshotPipelineValue(captured)), BSON.serialize(input));
            assert.equal(stableCacheKeyString(captured, 'document'), stableCacheKeyString(snapshotPipelineValue(captured), 'document'));
          }
        }
    });

    it('materializes each function occurrence with the native byte and error contract', () => {
        for (const factory of [() => 'function stable(){return 1;}', () => new String('x'),
            () => ({ length: 1, charCodeAt: () => 65, toString: () => 'B' }), () => 7,
            () => { throw new Error('source failure'); }]) {
            const make = () => { const fn = function () {}; fn.toString = factory as any; return { value: fn }; };
            let native: Uint8Array;
            try { native = BSON.serialize(make(), { serializeFunctions: true }); }
            catch (error) {
                assert.throws(() => snapshotPipelineValue(make(), undefined, true), (actual: any) => actual.name === (error as Error).name);
                continue;
            }
            assert.deepEqual(BSON.serialize(snapshotPipelineValue(make(), undefined, true), { serializeFunctions: true }), native);
        }
        let calls = 0;
        const fn = function () {}; fn.toString = () => `function sequence(){return ${++calls};}`;
        const shared = { value: fn }, captured = snapshotPipelineValue({ a: shared, b: shared }, undefined, true);
        assert.equal(calls, 2);
        assert.notEqual((captured.a.value as any).code, (captured.b.value as any).code);
        const cycle: any = {}; cycle.self = cycle;
        assert.throws(() => snapshotPipelineValue(cycle), BSON.BSONError);
    });

    it('interleaves getters with function materialization and ignores function BSON markers', () => {
        const make = () => {
            let state = 0;
            const fn = function () {}; fn.toString = () => String(state);
            Object.defineProperty(fn, '_bsontype', { get() { throw new Error('Unused function marker'); } });
            return { get a() { state = 1; return fn; }, get b() { state = 2; return fn; } };
        };
        for (const serializeFunctions of [false, true]) assert.deepEqual(
            BSON.serialize(snapshotPipelineValue(make(), undefined, serializeFunctions), { serializeFunctions }),
            BSON.serialize(make(), { serializeFunctions }),
        );
        const self = { toBSON() { return this; } };
        assert.deepEqual(BSON.serialize(snapshotPipelineValue({ self }, undefined, true), { serializeFunctions: true }),
            BSON.serialize({ self }, { serializeFunctions: true }));
        const shrinking = () => { const fn = function () {}; const array = [fn, 2]; fn.toString = () => { array.length = 1; return 'x'; }; return { array }; };
        assert.deepEqual(BSON.serialize(snapshotPipelineValue(shrinking(), undefined, true), { serializeFunctions: true }),
            BSON.serialize(shrinking(), { serializeFunctions: true }));
    });

    it('captures filter functions before option documents and resolves page project aliases', () => {
        let calls = 0;
        const fn = function () {}; fn.toString = () => String(++calls);
        const captured = snapshotReadInputs({ payload: fn }, { projection: { v: { $literal: fn } }, serializeFunctions: true });
        assert.equal((captured.query.payload as any).code, '1');
        assert.equal((captured.options.projection as any).v.$literal.code, '2');
        const page: any = snapshotFindPageOptions({ query: { payload: fn }, options: {
            serializeFunctions: true, project: { v: { $literal: fn } },
        } });
        assert.equal(page.options.project, undefined);
        assert.equal(page.query.payload.code, '3');
        assert.equal(page.options.projection.v.$literal.code, '4');
        assert.equal(calls, 4);
    });

    it('captures only BSON count overrides inside pagination controls', () => {
        const unused = () => { throw new Error('Control container is not a BSON document'); };
        const sort = Object.defineProperty({ x: 1 }, 'toBSON', { value: unused });
        const totals = Object.defineProperty({ mode: 'sync', hint: { toBSON: () => ({ x: 1 }) } }, 'toBSON', { value: unused });
        const callback = () => Promise.resolve(null);
        const page: any = snapshotFindPageOptions({ sort, totals, jump: { step: 10, maxHops: 20, getBookmark: callback } });
        assert.deepEqual(page.sort, { x: 1, _id: 1 }); assert.deepEqual(page.totals.hint, { x: 1 });
        assert.equal(page.totals.mode, 'sync'); assert.equal(page.jump.getBookmark, callback);
        assert.equal(Array.isArray(snapshotFindPageOptions({ cursorTypes: Object.assign([], { n: 'number' }) }).cursorTypes), true);
    });

    it('captures data-only raw fields and leaves dynamic accessors lazy', () => {
        const fields = Object.create({ payload: false });
        const captured = captureBsonOptions({ fieldsAsRaw: fields }); fields.payload = true;
        assert.equal((captured.fieldsAsRaw as any).payload, false);
        assert.equal(canCacheBsonResult(captured), true);
        let calls = 0;
        const dynamic = Object.create(null, { neverReturned: { enumerable: true, get() { calls++; throw new Error('Unused getter'); } } });
        const options = captureBsonOptions({ fieldsAsRaw: dynamic });
        assert.equal(options.fieldsAsRaw, dynamic); assert.equal(calls, 0);
        assert.equal(canCacheBsonResult(options), false); assert.equal(hasStableBsonFields(options), false); assert.equal(calls, 0);
        assert.equal(hasStableBsonFields(captureBsonOptions()), true);
    });

    it('rejects dynamic raw maps before rewriting a computed ordered identity', async () => {
        let calls = 0;
        const collection: any = { bsonOptions: {}, find() { throw new Error('Must reject before the driver'); } };
        const fields = [new Proxy({}, { getPrototypeOf() { calls++; throw new Error('Unused trap'); } }),
            Object.create(null, { unused: { get() { calls++; throw new Error('Unused getter'); } } })];
        for (const fieldsAsRaw of fields) await assert.rejects(() => findByIdsDocuments(collection, [new ObjectId()], {
            preserveOrder: true, projection: { _id: { $literal: 'x' } }, fieldsAsRaw,
        } as any), { code: 'INVALID_OPERATION' });
        assert.equal(calls, 0);
    });

    it('preserves native totals through JSON-backed completion storage', async () => {
        for (const total of [BSON.Long.fromNumber(2), BSON.Long.fromString('9007199254740993'), new BSON.Double(2), new BSON.Int32(2), 2n]) {
            const values = new Map<string, unknown>();
            const cache: any = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, JSON.parse(JSON.stringify(value))) };
            const coll: any = { namespace: 'totals.types', collectionName: 'types', countDocuments: async () => total };
            const first = await computeTotals(coll, { x: 1 }, 1, { mode: 'sync' }, {}, cache);
            const second = await computeTotals(coll, { x: 1 }, 1, { mode: 'sync' }, {}, cache);
            assert.equal(typeof second.total, typeof first.total);
            if (typeof total === 'bigint') assert.equal(second.total as any, total);
            else {
                assert.equal((second.total as any)._bsontype, total._bsontype);
                assert.deepEqual(BSON.EJSON.serialize(second.total, { relaxed: false }), BSON.EJSON.serialize(total, { relaxed: false }));
            }
        }
    });

    it('preserves BSON input identity across stable key generations', () => {
        const key = (value: unknown) => stableCacheKeyString(value, 'document');
        assert.ok(key({}).startsWith('v4:'));
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
    it('freezes ordinary filter and projection functions across a cache wait', async () => {
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        let source = 'first', count = 0, paused = false;
        const fn = function () {}; fn.toString = () => { count++; return source; };
        const values = new Map<string, unknown>(), calls: any[] = [];
        const cache: any = { get: async (key: string) => { if (!paused && key.startsWith('find:')) { paused = true; entered(); await gate; } return values.get(key); },
            set: (key: string, value: unknown) => values.set(key, value) };
        const collection: any = { namespace: 'db.snapshot', bsonOptions: {}, find(query: any, options: any) {
            calls.push({ query, options }); return { toArray: async () => [{ source: query.payload.code, projected: options.projection.v.$literal.code }] };
        } };
        const options = { serializeFunctions: true, projection: { v: { $literal: fn } }, cache: 10000 };
        const result = Promise.resolve(createFindChain(collection, { payload: fn }, options, {}, cache));
        await waiting; source = 'changed'; options.projection.v.$literal = (() => {}) as any; release();
        assert.deepEqual(await result, [{ source: 'first', projected: 'first' }]); assert.equal(count, 2);
        source = 'first';
        assert.deepEqual(await createFindChain(collection, { payload: fn }, { ...options, projection: { v: { $literal: fn } } }, {}, cache),
            [{ source: 'first', projected: 'first' }]);
        assert.equal(calls.length, 1, 'the captured tuple also identifies the cache hit');
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
