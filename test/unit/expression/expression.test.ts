import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Long, ObjectId } from 'mongodb';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P2-B expression helpers', () => {
    const compile = (source: string): unknown => {
        const pipeline = MonSQLize.compilePipelineExpressions([{ $project: { value: MonSQLize.expr(source) } }]);
        return pipeline[0].$project.value;
    };

    it('B16 restores stage context in nested pipelines and preserves literal data', () => {
        const literal = { $match: { value: MonSQLize.expr('price > 1') } };
        const result = MonSQLize.compilePipelineExpressions([
            { $facet: { items: [{ $match: MonSQLize.expr('price > 1') }, { $project: { value: MonSQLize.expr('price * 2') } }] } },
            { $lookup: { from: 'items', let: { price: MonSQLize.expr('price + 1') }, pipeline: [{ $group: { _id: null, total: MonSQLize.expr('SUM(price)') } }], as: 'joined' } },
            { $project: { literal: { $literal: literal } } },
        ]);
        assert.deepEqual(result[0].$facet.items[0], { $match: { $expr: { $gt: ['$price', 1] } } });
        assert.deepEqual(result[0].$facet.items[1].$project.value, { $multiply: ['$price', 2] });
        assert.deepEqual(result[1].$lookup.let.price, { $add: ['$price', 1] });
        assert.deepEqual(result[1].$lookup.pipeline[0].$group.total, { $sum: '$price' });
        assert.strictEqual(result[2].$project.literal.$literal, literal);
    });

    it('B17 parses numeric function arguments recursively without truncation', () => {
        assert.deepEqual(compile('SUBSTR(name, start + 1, LENGTH(name))'), { $substr: ['$name', { $add: ['$start', 1] }, { $strLenCP: '$name' }] });
        assert.deepEqual(compile('SUBSTR_CP(name, start, count)'), { $substrCP: ['$name', '$start', '$count'] });
        assert.deepEqual(compile('SLICE(items, start, count)'), { $slice: ['$items', '$start', '$count'] });
        assert.deepEqual(compile('SLICE(items, count)'), { $slice: ['$items', '$count'] });
        assert.deepEqual(compile('ARRAY_ELEM_AT(items, -1)'), { $arrayElemAt: ['$items', -1] });
        assert.deepEqual(compile('SUBSTR(name, 2.9, 3)'), { $substr: ['$name', 2.9, 3] });
    });

    it('B18 resolves lexical MAP FILTER and REDUCE variables without changing quoted text', () => {
        assert.deepEqual(compile('MAP([1,2], n, n * 2)'), { $map: { input: [1, 2], as: 'n', in: { $multiply: ['$$n', 2] } } });
        assert.deepEqual(compile('FILTER([1,2], n, n > 1)'), { $filter: { input: [1, 2], as: 'n', cond: { $gt: ['$$n', 1] } } });
        assert.deepEqual(compile("MAP(items, n, CONCAT('n.name', n.name))"), { $map: { input: '$items', as: 'n', in: { $concat: ['n.name', '$$n.name'] } } });
        assert.deepEqual(compile('MAP(items, item, MAP(item.children, item, item.value))'), {
            $map: { input: '$items', as: 'item', in: { $map: { input: '$$item.children', as: 'item', in: '$$item.value' } } },
        });
        assert.deepEqual(compile('MAP(items, n, MAP(n.values, m, n.base + m))'), {
            $map: { input: '$items', as: 'n', in: { $map: { input: '$$n.values', as: 'm', in: { $add: ['$$n.base', '$$m'] } } } },
        });
    });

    it('AR02 separates renamed DSL bindings from native variables and literal payloads', () => {
        const seed: any = compile('REDUCE([10],0,(acc,item)=>SUM(MAP([1,2],value,$$value)))');
        const mapped = seed.$reduce.in.$sum.$map;
        assert.notEqual(mapped.as, 'value');
        assert.equal(mapped.in, '$$' + mapped.as);
        const reverse: any = compile('MAP([10],value,REDUCE([1,2],0,(acc,item)=>$$value + $$this))');
        const reduced = reverse.$map.in.$let.in.$reduce;
        assert.deepEqual(reduced.in, { $add: ['$$value', '$$this'] });
        const literal: any = compile('REDUCE([10],0,(acc,item)=>MAP([1],value,LITERAL({"name":"$$value","$map":{"as":"value","in":"$$value"}})))');
        assert.deepEqual(literal.$reduce.in.$map.in, { $literal: { name: '$$value', $map: { as: 'value', in: '$$value' } } });
        const text: any = compile("REDUCE([10],0,(acc,item)=>MAP([1],value,CONCAT('$$value', TO_STRING($$value))))");
        assert.equal(text.$reduce.in.$map.in.$concat[0], '$$value');
        const dotted: any = compile('REDUCE([10],0,(acc,item)=>MAP(items,value,$$value.name))');
        assert.equal(dotted.$reduce.in.$map.in, '$$' + dotted.$reduce.in.$map.as + '.name');
    });

    it('AR02 binds native JSON operators structurally and keeps LET initializers in the outer scope', () => {
        const tree: any = compile('REDUCE([10],0,(acc,item)=>MAP([1,2],value,{"$let":{"vars":{"value":100,"copy":"$$value"},"in":{"$add":["$$value","$$copy"]}}}))');
        const mapped = tree.$reduce.in.$map;
        assert.equal(mapped.in.$let.vars.copy, '$$' + mapped.as);
        assert.equal(mapped.in.$let.in.$add[1], '$$copy');
        const native: any = compile('REDUCE([10],0,(acc,item)=>{"$map":{"input":[1,2],"as":"value","in":"$$value"}})');
        assert.equal(native.$reduce.in.$map.in, '$$' + native.$reduce.in.$map.as);
        const conflicting: any = compile('REDUCE([10],0,(acc,item)=>MAP([1],value,monsqlizeVariable0 + $$value))');
        assert.notEqual(conflicting.$reduce.in.$map.as, 'monsqlizeVariable0');
        assert.equal(conflicting.$reduce.in.$map.in.$add[0], '$monsqlizeVariable0');
    });

    it('AR02 keeps native JSON FILTER bindings separate from the reducer accumulator', () => {
        const tree: any = compile('REDUCE([10],0,(acc,item)=>SUM({"$filter":{"input":[1,2],"as":"value","cond":{"$gt":["$$value",1]},"limit":1}}))');
        const filtered = tree.$reduce.in.$sum.$filter;
        assert.notEqual(filtered.as, 'value');
        assert.deepEqual(filtered.cond, { $gt: ['$$' + filtered.as, 1] });
        assert.equal(filtered.limit, 1);
    });

    it('AR02 preserves native JSON FILTER literal payloads during alpha renaming', () => {
        const tree: any = compile('REDUCE([10],0,(acc,item)=>{"$filter":{"input":[1,2],"as":"value","cond":{"$eq":[{"$literal":"$$value"},"$$value"]}}})');
        const filtered = tree.$reduce.in.$filter;
        assert.deepEqual(filtered.cond.$eq, [{ $literal: '$$value' }, '$$' + filtered.as]);
    });

    it('AR02 resolves dotted native JSON FILTER references to the renamed binding', () => {
        const tree: any = compile('REDUCE([10],0,(acc,item)=>{"$filter":{"input":[{"n":1},{"n":2}],"as":"value","cond":{"$gt":["$$value.n",1]}}})');
        const filtered = tree.$reduce.in.$filter;
        assert.deepEqual(filtered.cond, { $gt: ['$$' + filtered.as + '.n', 1] });
    });

    it('AR02 evaluates native JSON FILTER input and limit in the outer scope', () => {
        const tree: any = compile('REDUCE([2],0,(acc,item)=>MAP([[1,2,3]],value,{"$filter":{"input":"$$value","as":"this","cond":{"$gt":["$$this",0]},"limit":"$$this"}}))');
        const mapped = tree.$reduce.in.$map;
        const filtered = mapped.in.$filter;
        assert.notEqual(mapped.as, 'value');
        assert.notEqual(filtered.as, 'this');
        assert.equal(filtered.input, '$$' + mapped.as);
        assert.equal(filtered.limit, '$$this');
        assert.deepEqual(filtered.cond, { $gt: ['$$' + filtered.as, 0] });
    });

    it('B19 splits LET bindings only at balanced delimiters and retains explicit variable syntax', () => {
        assert.deepEqual(compile('LET({a:POW(2,3)}, $$a)'), { $let: { vars: { a: { $pow: [2, 3] } }, in: '$$a' } });
        assert.deepEqual(compile("LET({a:CONCAT('x,y', ':z'), b:COND(true,1,2)}, $$a)"), { $let: { vars: { a: { $concat: ['x,y', ':z'] }, b: { $cond: { if: true, then: 1, else: 2 } } }, in: '$$a' } });
        assert.deepEqual(compile('LET({a:8}, a)'), { $let: { vars: { a: 8 }, in: '$a' } });
    });

    it('B29 distinguishes an explicit falsy SWITCH default from no default', () => {
        for (const [source, expected] of [['null', null], ['false', false], ['0', 0], ["''", '']]) {
            const compiled: any = compile('SWITCH(false, 1, ' + source + ')');
            assert.equal(Object.prototype.hasOwnProperty.call(compiled.$switch, 'default'), true);
            assert.equal(compiled.$switch.default, expected);
        }
        assert.equal(Object.prototype.hasOwnProperty.call((compile('SWITCH(false, 1)') as any).$switch, 'default'), false);
    });

    it('B30 recognizes signed exponents while preserving arithmetic and strings', () => {
        assert.deepEqual(compile('price * 1e-3'), { $multiply: ['$price', 0.001] });
        assert.deepEqual(compile('price * 1E+3'), { $multiply: ['$price', 1000] });
        assert.deepEqual(compile('1e-3 + 1E+3'), { $add: [0.001, 1000] });
        assert.deepEqual(compile('-price * 1e-3'), { $multiply: [{ $multiply: [-1, '$price'] }, 0.001] });
        assert.deepEqual(compile('price * -1e-3'), { $multiply: ['$price', -0.001] });
        assert.deepEqual(compile('fee - 3'), { $subtract: ['$fee', 3] });
        assert.deepEqual(compile("CONCAT('1e-3', name)"), { $concat: ['1e-3', '$name'] });
        for (const source of ['1e', '1e+', '1e--3']) assert.throws(() => compile(source), (error: any) => error.code === 'INVALID_EXPRESSION');
    });

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
