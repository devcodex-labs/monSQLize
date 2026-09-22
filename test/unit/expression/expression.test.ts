import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Long, ObjectId } from 'mongodb';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P2-B expression helpers', () => {
    const compile = (source: string): unknown => {
        const pipeline = MonSQLize.compilePipelineExpressions([{ $project: { value: MonSQLize.expr(source) } }]);
        return pipeline[0].$project.value;
    };

    it('honors conditional, nullish, logical, comparison, and left-associative arithmetic precedence', () => {
        assert.deepEqual(compile('a || b && c'), { $or: ['$a', { $and: ['$b', '$c'] }] });
        assert.deepEqual(compile('10 - 3 - 2'), { $subtract: [{ $subtract: [10, 3] }, 2] });
        assert.deepEqual(compile('20 / 2 / 2'), { $divide: [{ $divide: [20, 2] }, 2] });
        assert.deepEqual(compile('a + b * 2'), { $add: ['$a', { $multiply: ['$b', 2] }] });
        assert.deepEqual(compile('(a + b) * 2'), { $multiply: [{ $add: ['$a', '$b'] }, 2] });
        assert.deepEqual(compile('a ?? b ? c : d'), { $cond: { if: { $ifNull: ['$a', '$b'] }, then: '$c', else: '$d' } });
        assert.deepEqual(compile('a ? b : c ? d : e'), { $cond: { if: '$a', then: '$b', else: { $cond: { if: '$c', then: '$d', else: '$e' } } } });
    });

    it('keeps delimiters inside strings, functions, arrays, objects, and lambdas', () => {
        assert.deepEqual(compile("CONCAT('a+b', UPPER(name))"), { $concat: ['a+b', { $toUpper: '$name' }] });
        assert.deepEqual(compile('IN(value, [1,2])'), { $in: ['$value', [1, 2]] });
        assert.deepEqual(compile('MERGE_OBJECTS(doc, {"a": 1, "b": 2})'), { $mergeObjects: ['$doc', { a: 1, b: 2 }] });
        assert.deepEqual(compile('REDUCE(nums, 0, (acc, item) => acc + item)'), {
            $reduce: { input: '$nums', initialValue: 0, in: { $add: ['$$value', '$$this'] } },
        });
        assert.throws(() => compile('a &&'), (error: any) => error?.code === 'INVALID_EXPRESSION');
        assert.throws(() => compile('a ? b'), (error: any) => error?.code === 'INVALID_EXPRESSION');
    });

    it('preserves Date, RegExp and BSON values while compiling plain expression records', () => {
        const date = new Date('2026-01-01T00:00:00.000Z');
        const regexp = /alice/i;
        const objectId = new ObjectId();
        const long = Long.fromString('9007199254740993');
        const pipeline = [{ $project: { date, regexp, objectId, long, upper: MonSQLize.expr('UPPER(name)') } }];
        const result = MonSQLize.compilePipelineExpressions(pipeline);
        assert.equal(result[0].$project.date, date);
        assert.equal(result[0].$project.regexp, regexp);
        assert.equal(result[0].$project.objectId, objectId);
        assert.equal(result[0].$project.long, long);
        assert.deepEqual(result[0].$project.upper, { $toUpper: '$name' });
    });
    it('expr() / createExpression() creates standard expression objects', () => {
        assert.deepEqual(MonSQLize.expr('SUM(amount)'), {
            __expr__: 'SUM(amount)',
            __compiled__: false,
        });

        assert.deepEqual(MonSQLize.createExpression("CONCAT(firstName, ' ', lastName)"), {
            __expr__: "CONCAT(firstName, ' ', lastName)",
            __compiled__: false,
        });
    });

    it('empty expression returns INVALID_EXPRESSION', () => {
        assert.throws(
            () => MonSQLize.expr('   '),
            (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_EXPRESSION'),
        );
    });
});
