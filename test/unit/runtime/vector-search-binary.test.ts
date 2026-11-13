import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Binary, BSON } from 'mongodb';
import { runInNewContext } from 'node:vm';
import { MongoCollectionAccessor } from '../../../src/adapters/mongodb/common/collection-accessor';
import { MemoryCache } from '../../../src/capabilities/cache/memory-cache';
import { buildVectorSearchPipeline, VECTOR_SEARCH_SCORE_FIELD } from '../../../src/adapters/mongodb/queries/vector-search';

const options = { index: 'vec', path: 'embedding', limit: 1, numCandidates: 10 };
const vectorFrom = (pipeline: Record<string, any>[]) => pipeline[0].$vectorSearch.queryVector as Binary;

describe('BSON vectorSearch inputs and consumers', () => {
    it('preserves int8/int1 BSON on the wire and snapshots the visible effective bytes', () => {
        for (const input of [Binary.fromInt8Array(Int8Array.of(-128, 0, 127)), Binary.fromPackedBits(Uint8Array.of(0xa5), 3)]) {
            const storage = Buffer.alloc(24, 0xee);
            storage.set(input.value(), 4);
            input.buffer = storage.subarray(4, 20);
            input.position = 3 + (input.buffer[0] === 3 ? 2 : 0);
            const expected = Buffer.from(input.value());
            const built = buildVectorSearchPipeline({ ...options, queryVector: input });
            const captured = vectorFrom(built.pipeline);
            assert.ok(captured instanceof Binary);
            assert.notStrictEqual(captured, input);
            assert.equal(captured.sub_type, 9);
            assert.equal(captured.position, expected.length);
            assert.equal(captured.buffer.length, expected.length);
            assert.deepEqual(Buffer.from(captured.value()), expected);
            assert.ok(BSON.deserialize(BSON.serialize({ vector: captured })).vector instanceof Binary);
            input.buffer.fill(0);
            input.position = 0;
            input.sub_type = 0;
            assert.deepEqual(Buffer.from(captured.value()), expected);
        }
    });

    it('accepts compatible Binary shapes and foreign byte views without invoking toBSON', () => {
        const original = Binary.fromInt8Array(Int8Array.of(-1, 2));
        const foreign = runInNewContext('new Uint8Array([3, 0, 255, 2])');
        const input = Object.create(Object.getPrototypeOf(original));
        Object.assign(input, { buffer: foreign, position: 4, sub_type: 9, toBSON() { throw new Error('must not run'); } });
        const captured = vectorFrom(buildVectorSearchPipeline({ ...options, queryVector: input }).pipeline);
        assert.deepEqual(captured.toInt8Array(), Int8Array.of(-1, 2));
    });

    it('rejects malformed/unsupported inputs before the native collection is called', async () => {
        let calls = 0;
        const accessor = new MongoCollectionAccessor('unit', 'docs', { aggregate() { calls++; throw new Error('unexpected request'); } } as never);
        const binary = (bytes: number[], position?: number) => {
            const value = new Binary(Uint8Array.from(bytes), 9);
            if (position !== undefined) value.position = position;
            return value;
        };
        const invalid: unknown[] = [null, undefined, 'vector', [], [NaN], [Infinity], [undefined], Array(1),
            Buffer.from([3, 0, 1]), Int8Array.of(1), { $binary: { base64: 'AwAB', subType: '09' } },
            new Binary(Uint8Array.of(1)), Binary.fromFloat32Array(Float32Array.of(0.1)),
            binary([3, 0]), binary([3, 1, 1]), binary([16, 8, 0]), binary([99, 0, 1]),
            binary([3, 0, 1], -1), binary([3, 0, 1], 4), binary([3, 0, 1], 2.5)];
        for (const queryVector of invalid) {
            await assert.rejects(accessor.vectorSearch({ ...options, queryVector: queryVector as never }), (error: any) => {
                assert.equal(error.code, 'INVALID_VECTOR_SEARCH');
                assert.equal(error.details[0].field, 'queryVector');
                return true;
            });
        }
        assert.equal(calls, 0);
    });

    it('keeps an in-flight request stable after the caller mutates Binary and array inputs', async () => {
        for (const input of [Binary.fromInt8Array(Int8Array.of(-2, 3)), [0.1, 0.2]]) {
            let finish!: () => void;
            const barrier = new Promise<void>((resolve) => { finish = resolve; });
            let dispatched!: () => void;
            const didDispatch = new Promise<void>((resolve) => { dispatched = resolve; });
            let sent: Record<string, any>[] = [];
            const accessor = new MongoCollectionAccessor('unit', 'docs', {
                aggregate(pipeline: Record<string, any>[]) {
                    sent = pipeline;
                    dispatched();
                    return { toArray: async () => { await barrier; return [{ _id: 1, [VECTOR_SEARCH_SCORE_FIELD]: 0.75 }]; } };
                },
            } as never);
            const pending = accessor.vectorSearch({ ...options, queryVector: input });
            if (input instanceof Binary) {
                input.buffer.fill(99); input.position = 0; input.sub_type = 0;
            } else {
                input.fill(99);
            }
            await didDispatch;
            if (input instanceof Binary) assert.deepEqual(vectorFrom(sent).toInt8Array(), Int8Array.of(-2, 3));
            else assert.deepEqual(sent[0].$vectorSearch.queryVector, [0.1, 0.2]);
            finish();
            assert.deepEqual(await pending, [{ document: { _id: 1 }, score: 0.75 }]);
        }
    });

    it('separates cached vectors by effective bytes and representation while ignoring unused capacity', async () => {
        let calls = 0;
        const cache = new MemoryCache();
        const accessor = new MongoCollectionAccessor('unit', 'docs', {
            dbName: 'unit', collectionName: 'docs', bsonOptions: {},
            aggregate() { const id = ++calls; return { toArray: async () => [{ _id: id, [VECTOR_SEARCH_SCORE_FIELD]: 0.5 }] }; },
        } as never, { queryCache: cache });
        const query = (queryVector: Binary) => accessor.vectorSearch({ ...options, queryVector, aggregateOptions: { cache: 1000 } });
        const a = Binary.fromInt8Array(Int8Array.of(1, 2));
        const b = Binary.fromInt8Array(Int8Array.of(1, 3));
        const padded = new Binary(Uint8Array.of(3, 0, 1, 2, 99, 99), 9); padded.position = 4;
        const bit = Binary.fromPackedBits(Uint8Array.of(1, 2));
        assert.equal((await query(a))[0].document._id, 1);
        assert.equal((await query(b))[0].document._id, 2);
        assert.equal((await query(padded))[0].document._id, 1);
        assert.equal((await query(bit))[0].document._id, 3);
        assert.equal(calls, 3);
    });
});
