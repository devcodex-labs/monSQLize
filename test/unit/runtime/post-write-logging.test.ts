import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { insertManyForAccessor } from '../../../src/adapters/mongodb/common/collection-accessor-write-helpers';

describe('insertMany successful-write logging', () => {
    for (const slow of [false, true]) for (const throws of [false, true]) {
        it(`preserves successful results and invalidation (slow=${slow}, logger throws=${throws})`, async () => {
            let writes = 0, warnings = 0, invalidations = 0;
            const result = { acknowledged: true, insertedCount: 2, insertedIds: { 0: 'a', 1: 'b' } };
            const context = {
                dbName: 'db', collectionName: 'items',
                collectionRef: { insertMany: async () => { writes++; return result; } },
                defaults: { slowQueryMs: slow ? 0 : Number.MAX_SAFE_INTEGER },
                logger: { warn: () => { warnings++; if (throws) throw new Error('logger failed'); } },
                cvDoc: <T>(value: T) => value,
                invalidateAll: async () => { invalidations++; return 1; },
            };
            const actual = await insertManyForAccessor(context as never, [{ name: 'A' }, { name: 'B' }]);
            assert.deepEqual(actual, result); assert.equal(writes, 1);
            assert.equal(warnings, slow ? 1 : 0); assert.equal(invalidations, 1);
        });
    }

    it('also protects payload construction after the database has succeeded', async () => {
        let written = false, invalidations = 0;
        const result = { acknowledged: true, insertedCount: 1, insertedIds: { 0: 'a' } };
        const options = { get comment() { if (written) throw new Error('late comment getter'); return 'note'; } };
        const context = {
            dbName: 'db', collectionName: 'items', defaults: { slowQueryMs: 0 },
            collectionRef: { insertMany: async () => { written = true; return result; } },
            logger: { warn: () => assert.fail('payload construction must fail before dispatch') },
            cvDoc: <T>(value: T) => value,
            invalidateAll: async () => { invalidations++; return 1; },
        };
        assert.deepEqual(await insertManyForAccessor(context as never, [{ name: 'A' }], options), result);
        assert.equal(invalidations, 1);
    });

    it('retains the duplicate-key error and post-dispatch invalidation', async () => {
        let invalidations = 0;
        const failure = Object.assign(new Error('duplicate'), { code: 11000 });
        const context = {
            dbName: 'db', collectionName: 'items',
            collectionRef: { insertMany: async () => { throw failure; } },
            cvDoc: <T>(value: T) => value,
            invalidateAll: async () => { invalidations++; return 1; },
        };
        await assert.rejects(insertManyForAccessor(context as never, [{ name: 'A' }]), { code: 'DUPLICATE_KEY' });
        assert.equal(invalidations, 1);
    });
});
