import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';

const { expr, compilePipelineExpressions } = require('../../../dist/cjs/index.cjs');
const compile = (source: string) => compilePipelineExpressions([{ $project: { value: expr(source) } }])[0].$project.value;

describe('expression quoting and predicate roles', () => {
    it('distinguishes quoted dollars, references, and explicit literal payloads', () => {
        assert.deepEqual(compile("CONCAT('$price', '$$ROOT', name)"), { $concat: [{ $literal: '$price' }, { $literal: '$$ROOT' }, '$name'] });
        assert.deepEqual(compile('LITERAL(("$price"))'), { $literal: '$price' });
        assert.deepEqual(compile('LITERAL({"value":"$price"})'), { $literal: { value: '$price' } });
        assert.deepEqual(compile('{"value":"$price"}'), { value: '$price' });
        assert.equal(compile('$$ROOT'), '$$ROOT');
        assert.equal(compile("''"), '');
    });

    it('handles zero through four backslashes consistently in both scanners', () => {
        for (let count = 0; count <= 4; count++) {
            const value = 'tail' + '\\'.repeat(count) + (count % 2 ? '"inside' : '');
            const source = `CONCAT("${value}", name)`;
            const expected = { $concat: [value, '$name'] };
            assert.deepEqual(compile(source), expected, `backslashes=${count}`);
            assert.deepEqual(compile(`(${source})`), expected, `wrapped backslashes=${count}`);
        }
        for (const value of ['tail', 'tail\\', 'tail\\\\', 'quote"inside', 'tail\\"inside']) {
            assert.deepEqual(compile(JSON.stringify({ value })), { value });
        }
        assert.throws(() => compile('CONCAT("unterminated\\", name)'), { code: 'INVALID_EXPRESSION' });
    });

    it('compiles exactly one expr wrapper at predicate positions and preserves query values', () => {
        const date = new Date(1234), id = new ObjectId();
        const literal = { nested: expr('age > 1') };
        const pipeline = [{ $match: {
            status: 'active', createdAt: { $gte: date }, _id: id,
            $and: [expr('age > 18'), { $expr: expr('score > 2') }, { role: 'member' }],
            $or: [{ $expr: { $and: [expr('age > 1'), { $lt: ['$age', 100] }] } }],
            $nor: [expr('age < 0')], payload: { $literal: literal },
        } }];
        const result = compilePipelineExpressions(pipeline)[0].$match;
        assert.deepEqual(result.$and, [{ $expr: { $gt: ['$age', 18] } }, { $expr: { $gt: ['$score', 2] } }, { role: 'member' }]);
        assert.deepEqual(result.$or[0].$expr, { $and: [{ $gt: ['$age', 1] }, { $lt: ['$age', 100] }] });
        assert.deepEqual(result.$nor, [{ $expr: { $lt: ['$age', 0] } }]);
        assert.equal(result.createdAt.$gte, date); assert.equal(result._id, id);
        assert.equal(result.payload.$literal, literal);
        assert.equal(pipeline[0].$match.$and[0].__expr__, 'age > 18');
        const nested = compilePipelineExpressions([{ $facet: { results: [{ $match: { $expr: expr('age > 18') } }] } }]);
        assert.deepEqual(nested[0].$facet.results[0].$match, { $expr: { $gt: ['$age', 18] } });
    });
});
