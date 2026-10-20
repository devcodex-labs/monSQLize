import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
    expr,
    createExpression,
    isExpressionObject,
    hasExpressionInObject,
    hasExpressionInPipeline,
    compilePipelineExpressions,
} = require('../../../dist/cjs/index.cjs');

type PipelineStage = Record<string, any>;

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function compile(expression: string): any {
    const exprObj = expr(expression);
    const pipeline: PipelineStage[] = compilePipelineExpressions([{ $project: { _result: exprObj } }]);
    return pipeline[0].$project._result;
}

function matchCompile(expression: string): any {
    const exprObj = expr(expression);
    const pipeline: PipelineStage[] = compilePipelineExpressions([{ $match: exprObj }]);
    return pipeline[0].$match;
}

function groupCompile(expression: string): any {
    const exprObj = expr(expression);
    const pipeline: PipelineStage[] = compilePipelineExpressions([{ $group: { _result: exprObj } }]);
    return pipeline[0].$group._result;
}

describe('Expression: factory & type guards', () => {
    it('expr() and createExpression() produce identical shape', () => {
        const a = expr('amount + 1');
        const b = createExpression('amount + 1');
        assert.deepEqual(a, b);
        assert.equal(a.__compiled__, false);
        assert.equal(typeof a.__expr__, 'string');
    });

    it('isExpressionObject() correctly identifies expression objects', () => {
        assert.equal(isExpressionObject(expr('x + 1')), true);
        assert.equal(isExpressionObject({ __expr__: 'x', __compiled__: false }), true);
        assert.equal(isExpressionObject({ __expr__: 'x' }), false);
        assert.equal(isExpressionObject(null), false);
        assert.equal(isExpressionObject('string'), false);
        assert.equal(isExpressionObject(42), false);
    });

    it('hasExpressionInObject() recurses into nested structures', () => {
        assert.equal(hasExpressionInObject(expr('x')), true);
        assert.equal(hasExpressionInObject({ a: { b: expr('y') } }), true);
        assert.equal(hasExpressionInObject([{ a: expr('z') }]), true);
        assert.equal(hasExpressionInObject({ a: 1, b: 'string' }), false);
        assert.equal(hasExpressionInObject(null), false);
    });

    it('hasExpressionInPipeline() checks pipeline arrays', () => {
        assert.equal(hasExpressionInPipeline([{ $project: { v: expr('x') } }]), true);
        assert.equal(hasExpressionInPipeline([{ $match: { a: 1 } }]), false);
        assert.equal(hasExpressionInPipeline('not-an-array'), false);
    });

    it('throws INVALID_EXPRESSION for empty string', () => {
        assert.throws(() => expr(''), (error: unknown) => hasErrorCode(error, 'INVALID_EXPRESSION'));
        assert.throws(() => expr('   '), (error: unknown) => hasErrorCode(error, 'INVALID_EXPRESSION'));
    });

    it('throws TypeError for non-string input', () => {
        assert.throws(() => createExpression(42), TypeError);
        assert.throws(() => createExpression(null), TypeError);
        assert.throws(() => createExpression({}), TypeError);
    });

    it('throws INVALID_EXPRESSION for unsupported function names', () => {
        assert.throws(() => compile('UNKNOWN_FUNC(x)'), (error: unknown) => hasErrorCode(error, 'INVALID_EXPRESSION'));
    });
});

describe('Expression: arithmetic operators', () => {
    it('+ compiles to $add', () => {
        const result = compile('price + tax');
        assert.deepEqual(result, { $add: ['$price', '$tax'] });
    });

    it('- compiles to $subtract', () => {
        const result = compile('total - discount');
        assert.deepEqual(result, { $subtract: ['$total', '$discount'] });
    });

    it('* compiles to $multiply', () => {
        const result = compile('quantity * unitPrice');
        assert.deepEqual(result, { $multiply: ['$quantity', '$unitPrice'] });
    });

    it('/ compiles to $divide', () => {
        const result = compile('revenue / count');
        assert.deepEqual(result, { $divide: ['$revenue', '$count'] });
    });

    it('% compiles to $mod', () => {
        const result = compile('index % 2');
        assert.deepEqual(result, { $mod: ['$index', 2] });
    });

    it('ABS() compiles to $abs', () => {
        assert.deepEqual(compile('ABS(delta)'), { $abs: '$delta' });
    });

    it('CEIL() compiles to $ceil', () => {
        assert.deepEqual(compile('CEIL(value)'), { $ceil: '$value' });
    });

    it('FLOOR() compiles to $floor', () => {
        assert.deepEqual(compile('FLOOR(price)'), { $floor: '$price' });
    });

    it('ROUND() compiles to $round', () => {
        assert.deepEqual(compile('ROUND(score, 2)'), { $round: ['$score', 2] });
    });

    it('SQRT() compiles to $sqrt', () => {
        assert.deepEqual(compile('SQRT(area)'), { $sqrt: '$area' });
    });

    it('POW() compiles to $pow', () => {
        assert.deepEqual(compile('POW(base, exp)'), { $pow: ['$base', '$exp'] });
    });

    it('LOG() compiles to $log', () => {
        assert.deepEqual(compile('LOG(number, base)'), { $log: ['$number', '$base'] });
    });

    it('LOG10() compiles to $log10', () => {
        assert.deepEqual(compile('LOG10(number)'), { $log10: '$number' });
    });
});

describe('Expression: string operators', () => {
    it('CONCAT() compiles to $concat', () => {
        const result = compile("CONCAT(firstName, ' ', lastName)");
        assert.deepEqual(result, { $concat: ['$firstName', ' ', '$lastName'] });
    });

    it('UPPER() compiles to $toUpper', () => {
        assert.deepEqual(compile('UPPER(name)'), { $toUpper: '$name' });
    });

    it('LOWER() compiles to $toLower', () => {
        assert.deepEqual(compile('LOWER(email)'), { $toLower: '$email' });
    });

    it('TRIM() compiles to $trim', () => {
        assert.deepEqual(compile('TRIM(text)'), { $trim: { input: '$text' } });
    });

    it('LTRIM() compiles to $ltrim', () => {
        assert.deepEqual(compile('LTRIM(text)'), { $ltrim: { input: '$text' } });
    });

    it('RTRIM() compiles to $rtrim', () => {
        assert.deepEqual(compile('RTRIM(text)'), { $rtrim: { input: '$text' } });
    });

    it('LENGTH() compiles to $strLenCP', () => {
        assert.deepEqual(compile('LENGTH(name)'), { $strLenCP: '$name' });
    });

    it('SUBSTR() compiles to $substr', () => {
        assert.deepEqual(compile('SUBSTR(str, 0, 5)'), { $substr: ['$str', 0, 5] });
    });

    it('SPLIT() compiles to $split', () => {
        assert.deepEqual(compile("SPLIT(path, '/')"), { $split: ['$path', '/'] });
    });

    it('REPLACE() compiles to $replaceOne', () => {
        assert.deepEqual(compile("REPLACE(text, 'old', 'new')"), {
            $replaceOne: { input: '$text', find: 'old', replacement: 'new' },
        });
    });

    it('INDEX_OF_STR() compiles to $indexOfCP', () => {
        assert.deepEqual(compile("INDEX_OF_STR(str, 'term')"), { $indexOfCP: ['$str', 'term'] });
    });

    it('REGEX() compiles to $regexMatch', () => {
        assert.deepEqual(compile("REGEX(email, '^[a-z]+@')"), {
            $regexMatch: { input: '$email', regex: '^[a-z]+@' },
        });
    });
});

describe('Expression: array operators', () => {
    it('SIZE() compiles to $size', () => {
        assert.deepEqual(compile('SIZE(tags)'), { $size: '$tags' });
    });

    it('FIRST() compiles to $first', () => {
        assert.deepEqual(compile('FIRST(items)'), { $first: '$items' });
    });

    it('LAST() compiles to $last', () => {
        assert.deepEqual(compile('LAST(items)'), { $last: '$items' });
    });

    it('SLICE() compiles to $slice', () => {
        assert.deepEqual(compile('SLICE(arr, 2)'), { $slice: ['$arr', 2] });
    });

    it('ARRAY_ELEM_AT() compiles to $arrayElemAt', () => {
        assert.deepEqual(compile('ARRAY_ELEM_AT(arr, 0)'), { $arrayElemAt: ['$arr', 0] });
    });

    it('INDEX_OF() compiles to $indexOfArray', () => {
        assert.deepEqual(compile("INDEX_OF(tags, 'js')"), { $indexOfArray: ['$tags', 'js'] });
    });

    it('CONCAT_ARRAYS() compiles to $concatArrays', () => {
        assert.deepEqual(compile('CONCAT_ARRAYS(a, b)'), { $concatArrays: ['$a', '$b'] });
    });

    it('REVERSE_ARRAY() compiles to $reverseArray', () => {
        assert.deepEqual(compile('REVERSE_ARRAY(items)'), { $reverseArray: '$items' });
    });

    it('IN() compiles to $in', () => {
        assert.deepEqual(compile('IN(role, roles)'), { $in: ['$role', '$roles'] });
    });

    it('RANGE() compiles to $range', () => {
        assert.deepEqual(compile('RANGE(0, 10, 2)'), { $range: [0, 10, 2] });
    });
});

describe('Expression: date operators', () => {
    it('YEAR() compiles to $year', () => {
        assert.deepEqual(compile('YEAR(createdAt)'), { $year: '$createdAt' });
    });

    it('MONTH() compiles to $month', () => {
        assert.deepEqual(compile('MONTH(createdAt)'), { $month: '$createdAt' });
    });

    it('DAY_OF_MONTH() compiles to $dayOfMonth', () => {
        assert.deepEqual(compile('DAY_OF_MONTH(createdAt)'), { $dayOfMonth: '$createdAt' });
    });

    it('HOUR() compiles to $hour', () => {
        assert.deepEqual(compile('HOUR(ts)'), { $hour: '$ts' });
    });

    it('MINUTE() compiles to $minute', () => {
        assert.deepEqual(compile('MINUTE(ts)'), { $minute: '$ts' });
    });

    it('SECOND() compiles to $second', () => {
        assert.deepEqual(compile('SECOND(ts)'), { $second: '$ts' });
    });

    it('WEEK() compiles to $week', () => {
        assert.deepEqual(compile('WEEK(createdAt)'), { $week: '$createdAt' });
    });

    it('DAY_OF_WEEK() compiles to $dayOfWeek', () => {
        assert.deepEqual(compile('DAY_OF_WEEK(createdAt)'), { $dayOfWeek: '$createdAt' });
    });

    it('DAY_OF_YEAR() compiles to $dayOfYear', () => {
        assert.deepEqual(compile('DAY_OF_YEAR(createdAt)'), { $dayOfYear: '$createdAt' });
    });

    it('ISO_WEEK() compiles to $isoWeek', () => {
        assert.deepEqual(compile('ISO_WEEK(createdAt)'), { $isoWeek: '$createdAt' });
    });

    it('ISO_WEEK_YEAR() compiles to $isoWeekYear', () => {
        assert.deepEqual(compile('ISO_WEEK_YEAR(createdAt)'), { $isoWeekYear: '$createdAt' });
    });

    it('ISO_DAY_OF_WEEK() compiles to $isoDayOfWeek', () => {
        assert.deepEqual(compile('ISO_DAY_OF_WEEK(createdAt)'), { $isoDayOfWeek: '$createdAt' });
    });
});

describe('Expression: aggregation operators', () => {
    it('SUM() compiles to $sum', () => {
        assert.deepEqual(groupCompile('SUM(amount)'), { $sum: '$amount' });
    });

    it('AVG() compiles to $avg', () => {
        assert.deepEqual(groupCompile('AVG(score)'), { $avg: '$score' });
    });

    it('MAX() compiles to $max', () => {
        assert.deepEqual(groupCompile('MAX(price)'), { $max: '$price' });
    });

    it('MIN() compiles to $min', () => {
        assert.deepEqual(groupCompile('MIN(price)'), { $min: '$price' });
    });

    it('COUNT() compiles to $sum: 1', () => {
        assert.deepEqual(groupCompile('COUNT()'), { $sum: 1 });
    });

    it('PUSH() compiles to $push', () => {
        assert.deepEqual(groupCompile('PUSH(name)'), { $push: '$name' });
    });

    it('ADD_TO_SET() compiles to $addToSet', () => {
        assert.deepEqual(groupCompile('ADD_TO_SET(tag)'), { $addToSet: '$tag' });
    });
});

describe('Expression: comparison operators', () => {
    it('=== compiles to $eq', () => {
        const result = compile('status === 1');
        assert.deepEqual(result, { $eq: ['$status', 1] });
    });

    it('!== compiles to $ne', () => {
        const result = compile('role !== 0');
        assert.deepEqual(result, { $ne: ['$role', 0] });
    });

    it('>= compiles to $gte', () => {
        const result = compile('score >= 60');
        assert.deepEqual(result, { $gte: ['$score', 60] });
    });

    it('<= compiles to $lte', () => {
        const result = compile('price <= 100');
        assert.deepEqual(result, { $lte: ['$price', 100] });
    });

    it('> compiles to $gt', () => {
        const result = compile('age > 18');
        assert.deepEqual(result, { $gt: ['$age', 18] });
    });

    it('< compiles to $lt', () => {
        const result = compile('qty < 5');
        assert.deepEqual(result, { $lt: ['$qty', 5] });
    });

    it('field reference in comparison (no leading $)', () => {
        const result = compile('age >= 18');
        assert.deepEqual(result, { $gte: ['$age', 18] });
    });

    it('comparison in $match context wraps in $expr', () => {
        const result = matchCompile('age > 18');
        assert.deepEqual(result, { $expr: { $gt: ['$age', 18] } });
    });
});

describe('Expression: logical operators', () => {
    it('&& compiles to $and', () => {
        const result = compile('active === 1 && score >= 60');
        assert.deepEqual(result, {
            $and: [
                { $eq: ['$active', 1] },
                { $gte: ['$score', 60] },
            ],
        });
    });

    it('|| compiles to $or', () => {
        const result = compile('role === 1 || role === 2');
        assert.deepEqual(result, {
            $or: [
                { $eq: ['$role', 1] },
                { $eq: ['$role', 2] },
            ],
        });
    });

    it('ternary ? : compiles to $cond', () => {
        const result = compile('active === 1 ? score : 0');
        assert.deepEqual(result, {
            $cond: {
                if: { $eq: ['$active', 1] },
                then: '$score',
                else: 0,
            },
        });
    });

    it('?? compiles to $ifNull', () => {
        const result = compile("name ?? 'Anonymous'");
        assert.deepEqual(result, { $ifNull: ['$name', 'Anonymous'] });
    });
});

describe('Expression: type conversion operators', () => {
    it('TYPE() compiles to $type', () => {
        assert.deepEqual(compile('TYPE(value)'), { $type: '$value' });
    });

    it('IS_NUMBER() compiles to $isNumber', () => {
        assert.deepEqual(compile('IS_NUMBER(x)'), { $isNumber: '$x' });
    });

    it('IS_ARRAY() compiles to $isArray', () => {
        assert.deepEqual(compile('IS_ARRAY(tags)'), { $isArray: '$tags' });
    });

    it('TO_INT() compiles to $toInt', () => {
        assert.deepEqual(compile('TO_INT(str)'), { $toInt: '$str' });
    });

    it('TO_STRING() compiles to $toString', () => {
        assert.deepEqual(compile('TO_STRING(id)'), { $toString: '$id' });
    });

    it('TO_BOOL() compiles to $toBool', () => {
        assert.deepEqual(compile('TO_BOOL(flag)'), { $toBool: '$flag' });
    });

    it('TO_DOUBLE() compiles to $toDouble', () => {
        assert.deepEqual(compile('TO_DOUBLE(val)'), { $toDouble: '$val' });
    });

    it('TO_DATE() compiles to $toDate', () => {
        assert.deepEqual(compile('TO_DATE(str)'), { $toDate: '$str' });
    });

    it('TO_OBJECT_ID() compiles to $toObjectId', () => {
        assert.deepEqual(compile('TO_OBJECT_ID(str)'), { $toObjectId: '$str' });
    });
});

describe('Expression: set operators', () => {
    it('SET_UNION() compiles to $setUnion', () => {
        assert.deepEqual(compile('SET_UNION(setA, setB)'), { $setUnion: ['$setA', '$setB'] });
    });

    it('SET_DIFFERENCE() compiles to $setDifference', () => {
        assert.deepEqual(compile('SET_DIFFERENCE(all, excluded)'), {
            $setDifference: ['$all', '$excluded'],
        });
    });

    it('SET_INTERSECTION() compiles to $setIntersection', () => {
        assert.deepEqual(compile('SET_INTERSECTION(a, b)'), {
            $setIntersection: ['$a', '$b'],
        });
    });

    it('SET_IS_SUBSET() compiles to $setIsSubset', () => {
        assert.deepEqual(compile('SET_IS_SUBSET(sub, full)'), {
            $setIsSubset: ['$sub', '$full'],
        });
    });

    it('SET_EQUALS() compiles to $setEquals', () => {
        assert.deepEqual(compile('SET_EQUALS(a, b)'), { $setEquals: ['$a', '$b'] });
    });

    it('ALL_ELEMENTS_TRUE() compiles to $allElementsTrue', () => {
        assert.deepEqual(compile('ALL_ELEMENTS_TRUE(flags)'), {
            $allElementsTrue: ['$flags'],
        });
    });

    it('ANY_ELEMENT_TRUE() compiles to $anyElementTrue', () => {
        assert.deepEqual(compile('ANY_ELEMENT_TRUE(flags)'), {
            $anyElementTrue: ['$flags'],
        });
    });
});

describe('Expression: conditional operators', () => {
    it('IF_NULL() compiles to $ifNull', () => {
        assert.deepEqual(compile("IF_NULL(name, 'N/A')"), {
            $ifNull: ['$name', 'N/A'],
        });
    });

    it('COND() compiles to $cond', () => {
        assert.deepEqual(compile("COND(active === 1, 'yes', 'no')"), {
            $cond: {
                if: { $eq: ['$active', 1] },
                then: 'yes',
                else: 'no',
            },
        });
    });
});

describe('Expression: object operators', () => {
    it('MERGE_OBJECTS() compiles to $mergeObjects', () => {
        assert.deepEqual(compile('MERGE_OBJECTS(base, extra)'), {
            $mergeObjects: ['$base', '$extra'],
        });
    });

    it('OBJECT_TO_ARRAY() compiles to $objectToArray', () => {
        assert.deepEqual(compile('OBJECT_TO_ARRAY(obj)'), { $objectToArray: '$obj' });
    });

    it('ARRAY_TO_OBJECT() compiles to $arrayToObject', () => {
        assert.deepEqual(compile('ARRAY_TO_OBJECT(arr)'), { $arrayToObject: '$arr' });
    });
});

describe('Expression: compilePipelineExpressions pipeline integration', () => {
    it('compiles $project expressions preserving non-expression fields', () => {
        const pipeline = compilePipelineExpressions([
            {
                $project: {
                    _id: 0,
                    fullName: expr("CONCAT(firstName, ' ', lastName)"),
                    year: expr('YEAR(createdAt)'),
                    score: 1,
                },
            },
        ]);
        assert.deepEqual(pipeline[0].$project.fullName, {
            $concat: ['$firstName', ' ', '$lastName'],
        });
        assert.deepEqual(pipeline[0].$project.year, { $year: '$createdAt' });
        assert.equal(pipeline[0].$project.score, 1);
        assert.equal(pipeline[0].$project._id, 0);
    });

    it('compiles $group expressions correctly', () => {
        const pipeline = compilePipelineExpressions([
            {
                $group: {
                    _id: '$category',
                    total: expr('SUM(price)'),
                    count: expr('COUNT()'),
                },
            },
        ]);
        assert.deepEqual(pipeline[0].$group.total, { $sum: '$price' });
        assert.deepEqual(pipeline[0].$group.count, { $sum: 1 });
    });

    it('wraps $match expressions in $expr', () => {
        const pipeline = compilePipelineExpressions([
            { $match: expr('age > 18') },
        ]);
        assert.deepEqual(pipeline[0].$match, { $expr: { $gt: ['$age', 18] } });
        assert.throws(() => compilePipelineExpressions([{ $match: { age: expr('age > 18') } }]), { code: 'INVALID_EXPRESSION' });
        assert.throws(() => compilePipelineExpressions([{ $match: { age: { $eq: expr('age > 18') } } }]), { code: 'INVALID_EXPRESSION' });
    });

    it('passes through pipelines with no expressions unchanged', () => {
        const original = [{ $match: { status: 1 } }, { $limit: 10 }];
        const result = compilePipelineExpressions(original);
        assert.deepEqual(result, original);
    });

    it('handles nested $addFields stage', () => {
        const pipeline = compilePipelineExpressions([
            {
                $addFields: {
                    netPrice: expr('price - discount'),
                },
            },
        ]);
        assert.deepEqual(pipeline[0].$addFields.netPrice, {
            $subtract: ['$price', '$discount'],
        });
    });

    it('handles multi-stage pipeline with mixed expression/non-expression', () => {
        const pipeline = compilePipelineExpressions([
            { $match: { status: 1 } },
            { $project: { total: expr('quantity * unitPrice') } },
            { $group: { _id: '$category', sum: expr('SUM(total)') } },
            { $sort: { sum: -1 } },
        ]);
        assert.equal(pipeline[0].$match.status, 1);
        assert.deepEqual(pipeline[1].$project.total, {
            $multiply: ['$quantity', '$unitPrice'],
        });
        assert.deepEqual(pipeline[2].$group.sum, { $sum: '$total' });
        assert.equal(pipeline[3].$sort.sum, -1);
    });
});

describe('Expression: literal value parsing', () => {
    it('parses string literals (single quotes)', () => {
        const result = compile("CONCAT(name, ' Inc')");
        assert.deepEqual(result, { $concat: ['$name', ' Inc'] });
    });

    it('parses string literals (double quotes)', () => {
        const result = compile('UPPER("test")');
        assert.deepEqual(result, { $toUpper: 'test' });
    });

    it('parses numeric literals (integer)', () => {
        const result = compile('score + 10');
        assert.deepEqual(result, { $add: ['$score', 10] });
    });

    it('parses numeric literals (float)', () => {
        const result = compile('amount * 0.1');
        assert.deepEqual(result, { $multiply: ['$amount', 0.1] });
    });

    it('parses null literal', () => {
        const result = compile('IF_NULL(x, null)');
        assert.deepEqual(result, { $ifNull: ['$x', null] });
    });

    it('parses boolean true/false literals', () => {
        const resultT = compile('COND(active === 1, true, false)');
        assert.deepEqual(resultT.$cond.then, true);
        assert.deepEqual(resultT.$cond.else, false);
    });
});

describe('Expression: NOT operator', () => {
    it('NOT() compiles to $not', () => {
        assert.deepEqual(compile('NOT(active === 1)'), {
            $not: [{ $eq: ['$active', 1] }],
        });
    });
});

describe('Expression: EXISTS operator', () => {
    it('EXISTS() compiles to $ifNull with false default', () => {
        const result = compile('EXISTS(email)');
        assert.ok(result !== undefined);
    });
});
