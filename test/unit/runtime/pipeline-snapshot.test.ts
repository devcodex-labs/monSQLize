import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BSON, ObjectId, Timestamp, Binary } from 'mongodb';
import { snapshotPipelineValue } from '../../../src/adapters/mongodb/queries/pipeline-snapshot';
import { createAggregateChain } from '../../../src/adapters/mongodb/queries';

function wire(pipeline: unknown): unknown {
    return BSON.deserialize(BSON.serialize({ pipeline })).pipeline;
}

describe('pipeline capture at the driver document boundary', () => {
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
