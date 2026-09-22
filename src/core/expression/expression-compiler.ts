/**
 * Expression compiler.
 *
 * Compiles custom string DSL expressions into MongoDB Aggregation Pipeline
 * nested objects, supporting function calls, logical operators,
 * comparison operators, and field references.
 */
import { createError, ErrorCodes } from '../errors/index';

const FUNC_REGEX =
    /^(CONCAT|UPPER|LOWER|TRIM|SUBSTR|LENGTH|ABS|CEIL|FLOOR|ROUND|SQRT|POW|SIZE|IN|SLICE|FIRST|LAST|ARRAY_ELEM_AT|FILTER|MAP|INDEX_OF|CONCAT_ARRAYS|TYPE|NOT|EXISTS|IS_NUMBER|IS_ARRAY|SUM|AVG|MAX|MIN|COUNT|PUSH|ADD_TO_SET|YEAR|MONTH|DAY_OF_MONTH|HOUR|MINUTE|SECOND|SPLIT|REPLACE|INDEX_OF_STR|LTRIM|RTRIM|SUBSTR_CP|REGEX|MERGE_OBJECTS|TO_INT|TO_STRING|OBJECT_TO_ARRAY|ARRAY_TO_OBJECT|SET_UNION|SWITCH|DATE_ADD|DATE_SUBTRACT|DATE_DIFF|DATE_TO_STRING|DATE_FROM_STRING|TO_BOOL|TO_DATE|TO_DOUBLE|CONVERT|TO_DECIMAL|TO_LONG|TO_OBJECT_ID|REDUCE|ZIP|REVERSE_ARRAY|RANGE|DATE_FROM_PARTS|DATE_TO_PARTS|ISO_WEEK|ISO_WEEK_YEAR|ISO_DAY_OF_WEEK|DAY_OF_WEEK|DAY_OF_YEAR|WEEK|STR_LEN_BYTES|STR_LEN_CP|SUBSTR_BYTES|LOG|LOG10|ALL_ELEMENTS_TRUE|ANY_ELEMENT_TRUE|COND|IF_NULL|SET_FIELD|UNSET_FIELD|GET_FIELD|SET_DIFFERENCE|SET_EQUALS|SET_INTERSECTION|SET_IS_SUBSET|LET|LITERAL|RAND|SAMPLE_RATE)\s*\((.+)?\)$/i;

const IS_FUNC_CALL_RE =
    /^(CONCAT|UPPER|LOWER|TRIM|SUBSTR|LENGTH|ABS|CEIL|FLOOR|ROUND|SQRT|POW|SIZE|IN|SLICE|FIRST|LAST|ARRAY_ELEM_AT|FILTER|MAP|INDEX_OF|CONCAT_ARRAYS|TYPE|NOT|EXISTS|IS_NUMBER|IS_ARRAY|SUM|AVG|MAX|MIN|COUNT|PUSH|ADD_TO_SET|YEAR|MONTH|DAY_OF_MONTH|HOUR|MINUTE|SECOND|SPLIT|REPLACE|INDEX_OF_STR|LTRIM|RTRIM|SUBSTR_CP|REGEX|MERGE_OBJECTS|TO_INT|TO_STRING|OBJECT_TO_ARRAY|ARRAY_TO_OBJECT|SET_UNION|SWITCH)\s*\(/i;

export function compileInnerExpression(expression: string): unknown {
    const expr = expression.trim();
    if (!expr) throw createError(ErrorCodes.INVALID_EXPRESSION, 'Expression cannot be empty');
    const positions = topLevelPositions(expr);
    const unwrapped = stripOuterParentheses(expr);
    if (unwrapped !== expr) return compileInnerExpression(unwrapped);
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(expr)) return Number(expr);

    const conditional = findConditional(expr, positions);
    if (conditional) {
        return { $cond: {
            if: compileInnerExpression(expr.slice(0, conditional.question)),
            then: compileInnerExpression(expr.slice(conditional.question + 1, conditional.colon)),
            else: compileInnerExpression(expr.slice(conditional.colon + 1)),
        } };
    }

    const nullCoalParts = splitTopLevel(expr, '??', positions);
    if (nullCoalParts.length > 1) {
        return nullCoalParts.slice(1).reduce<unknown>(
            (left, right) => ({ $ifNull: [left, compileInnerExpression(right)] }),
            compileInnerExpression(nullCoalParts[0]),
        );
    }

    const orParts = splitTopLevel(expr, '||', positions);
    if (orParts.length > 1) {
        return { $or: orParts.map((part) => compileInnerExpression(part)) };
    }

    const andParts = splitTopLevel(expr, '&&', positions);
    if (andParts.length > 1) {
        return { $and: andParts.map((part) => compileInnerExpression(part)) };
    }

    const comparison = findBinaryOperator(expr, positions, ['===', '!==', '>=', '<=', '>', '<']);
    if (comparison) {
        const operatorMap: Record<string, string> = {
            '===': '$eq', '!==': '$ne', '>=': '$gte', '<=': '$lte', '>': '$gt', '<': '$lt',
        };
        return { [operatorMap[comparison.operator]]: [
            compileInnerExpression(expr.slice(0, comparison.index)),
            compileInnerExpression(expr.slice(comparison.index + comparison.operator.length)),
        ] };
    }

    const additive = findBinaryOperator(expr, positions, ['+', '-'], true);
    if (additive) {
        return { [additive.operator === '+' ? '$add' : '$subtract']: [
            compileInnerExpression(expr.slice(0, additive.index)),
            compileInnerExpression(expr.slice(additive.index + 1)),
        ] };
    }

    const multiplicative = findBinaryOperator(expr, positions, ['*', '/', '%'], true);
    if (multiplicative) {
        const operatorMap: Record<string, string> = { '*': '$multiply', '/': '$divide', '%': '$mod' };
        return { [operatorMap[multiplicative.operator]]: [
            compileInnerExpression(expr.slice(0, multiplicative.index)),
            compileInnerExpression(expr.slice(multiplicative.index + 1)),
        ] };
    }

    if (expr.startsWith('-')) {
        return { $multiply: [-1, compileInnerExpression(expr.slice(1))] };
    }

    const funcMatch = expr.match(FUNC_REGEX);
    if (funcMatch) {
        try {
            return dispatchFunction(funcMatch[1].toUpperCase(), funcMatch[2] ?? '');
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === ErrorCodes.INVALID_EXPRESSION) {
                throw error;
            }
            throw createError(ErrorCodes.INVALID_EXPRESSION, `Invalid arguments for ${funcMatch[1].toUpperCase()}`);
        }
    }

    const genericFuncCallRe = /^[A-Za-z_][A-Za-z0-9_]*\s*\(.+\)$/;
    if (genericFuncCallRe.test(expr)) {
        const funcName = expr.slice(0, expr.indexOf('(')).trim();
        throw createError(ErrorCodes.INVALID_EXPRESSION, `Unsupported expression function: ${funcName}`);
    }

    return parseValue(expr);
}

function parseValue(value: string): unknown {
    const normalized = stripOuterParentheses(value.trim());

    if ((normalized.startsWith("'") && normalized.endsWith("'")) || (normalized.startsWith('"') && normalized.endsWith('"'))) {
        return normalized.slice(1, -1);
    }
    if (normalized === 'null') return null;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (!isNaN(Number(normalized)) && normalized !== '') return Number(normalized);
    if (normalized !== value.trim() || IS_FUNC_CALL_RE.test(normalized) || FUNC_REGEX.test(normalized)) {
        return compileInnerExpression(normalized);
    }
    if (normalized.startsWith('[') || normalized.startsWith('{')) {
        try { return JSON.parse(normalized); } catch {
            throw createError(ErrorCodes.INVALID_EXPRESSION, 'Invalid array or object literal');
        }
    }
    const positions = topLevelPositions(normalized);
    if (positions.some((index) => /[?+\-*/%><&|]/.test(normalized[index]))) {
        return compileInnerExpression(normalized);
    }
    if (normalized.startsWith('$')) return normalized;
    return `$${normalized}`;
}

function dispatchFunction(name: string, argsStr: string): unknown {
    const args = splitArgsStr(argsStr);

    switch (name) {
        case 'CONCAT': return { $concat: args.map((arg) => parseValue(arg)) };
        case 'UPPER': return { $toUpper: parseValue(args[0]) };
        case 'LOWER': return { $toLower: parseValue(args[0]) };
        case 'TRIM': return { $trim: { input: parseValue(args[0]) } };
        case 'LENGTH': return { $strLenCP: parseValue(args[0]) };
        case 'SUBSTR': return { $substr: [parseValue(args[0]), parseInt(args[1], 10), parseInt(args[2], 10)] };
        case 'SPLIT': return { $split: [parseValue(args[0]), parseValue(args[1])] };
        case 'REPLACE': return { $replaceOne: { input: parseValue(args[0]), find: parseValue(args[1]), replacement: parseValue(args[2]) } };
        case 'INDEX_OF_STR': {
            const base = [parseValue(args[0]), parseValue(args[1])];
            if (args[2]) return { $indexOfCP: [...base, parseValue(args[2])] };
            return { $indexOfCP: base };
        }
        case 'LTRIM': return { $ltrim: { input: parseValue(args[0]) } };
        case 'RTRIM': return { $rtrim: { input: parseValue(args[0]) } };
        case 'SUBSTR_CP': return { $substrCP: [parseValue(args[0]), parseInt(args[1], 10), parseInt(args[2], 10)] };
        case 'STR_LEN_BYTES': return { $strLenBytes: parseValue(args[0]) };
        case 'STR_LEN_CP': return { $strLenCP: parseValue(args[0]) };
        case 'SUBSTR_BYTES': return { $substrBytes: [parseValue(args[0]), parseValue(args[1]), parseValue(args[2])] };
        case 'ABS': return { $abs: parseValue(args[0]) };
        case 'CEIL': return { $ceil: parseValue(args[0]) };
        case 'FLOOR': return { $floor: parseValue(args[0]) };
        case 'ROUND': return args[1] ? { $round: [parseValue(args[0]), parseValue(args[1])] } : { $round: [parseValue(args[0])] };
        case 'SQRT': return { $sqrt: parseValue(args[0]) };
        case 'POW': return { $pow: [parseValue(args[0]), parseValue(args[1])] };
        case 'LOG': return { $log: [parseValue(args[0]), parseValue(args[1])] };
        case 'LOG10': return { $log10: parseValue(args[0]) };
        case 'SIZE': return { $size: parseValue(args[0]) };
        case 'IN': return { $in: [parseValue(args[0]), parseValue(args[1])] };
        case 'SLICE': return args.length === 3
            ? { $slice: [parseValue(args[0]), parseInt(args[1], 10), parseInt(args[2], 10)] }
            : { $slice: [parseValue(args[0]), parseInt(args[1], 10)] };
        case 'FIRST': return { $first: parseValue(args[0]) };
        case 'LAST': return { $last: parseValue(args[0]) };
        case 'ARRAY_ELEM_AT': return { $arrayElemAt: [parseValue(args[0]), parseInt(args[1], 10)] };
        case 'INDEX_OF': return { $indexOfArray: [parseValue(args[0]), parseValue(args[1])] };
        case 'CONCAT_ARRAYS': return { $concatArrays: args.map((arg) => parseValue(arg)) };
        case 'FILTER': {
            const filterArray = parseValue(args[0]);
            const varName = args[1].replace(/['"]/g, '').trim();
            const filterCondition = compileFilterCondition(args[2], varName);
            return { $filter: { input: filterArray, as: varName, cond: filterCondition } };
        }
        case 'MAP': {
            const mapArray = parseValue(args[0]);
            const varName = args[1].replace(/['"]/g, '').trim();
            const mapExpr = compileMapExpression(args[2], varName);
            return { $map: { input: mapArray, as: varName, in: mapExpr } };
        }
        case 'REDUCE': {
            const lambdaMatch = /\((\w+),\s*(\w+)\)\s*=>\s*(.+)/.exec(args[2]);
            if (!lambdaMatch) throw createError(ErrorCodes.INVALID_EXPRESSION, 'REDUCE requires a lambda: (acc, item) => expr');
            const [, accVar, itemVar, lambdaExpr] = lambdaMatch;
            const compiledExpr = lambdaExpr
                .replace(new RegExp(`\\b${accVar}\\b`, 'g'), () => '$$value')
                .replace(new RegExp(`\\b${itemVar}\\b`, 'g'), () => '$$this');
            return { $reduce: { input: parseValue(args[0]), initialValue: parseValue(args[1]), in: compileInnerExpression(compiledExpr) } };
        }
        case 'ZIP': return { $zip: { inputs: args.map((arg) => parseValue(arg)) } };
        case 'REVERSE_ARRAY': return { $reverseArray: parseValue(args[0]) };
        case 'RANGE': {
            const rangeArgs: unknown[] = [parseValue(args[0]), parseValue(args[1])];
            if (args[2]) rangeArgs.push(parseValue(args[2]));
            return { $range: rangeArgs };
        }
        case 'TYPE': return { $type: parseValue(args[0]) };
        case 'NOT': return { $not: [compileInnerExpression(args[0])] };
        case 'EXISTS': return { $ne: [parseValue(args[0]), null] };
        case 'IS_NUMBER': return { $isNumber: parseValue(args[0]) };
        case 'IS_ARRAY': return { $isArray: parseValue(args[0]) };
        case 'TO_INT': return { $toInt: parseValue(args[0]) };
        case 'TO_STRING': return { $toString: parseValue(args[0]) };
        case 'OBJECT_TO_ARRAY': return { $objectToArray: parseValue(args[0]) };
        case 'ARRAY_TO_OBJECT': return { $arrayToObject: parseValue(args[0]) };
        case 'TO_BOOL': return { $toBool: parseValue(args[0]) };
        case 'TO_DATE': return { $toDate: parseValue(args[0]) };
        case 'TO_DOUBLE': return { $toDouble: parseValue(args[0]) };
        case 'TO_DECIMAL': return { $toDecimal: parseValue(args[0]) };
        case 'TO_LONG': return { $toLong: parseValue(args[0]) };
        case 'TO_OBJECT_ID': return { $toObjectId: parseValue(args[0]) };
        case 'CONVERT': {
            const result: Record<string, unknown> = { $convert: { input: parseValue(args[0]), to: args[1].replace(/['"]/g, '') } };
            if (args[2]) (result.$convert as Record<string, unknown>).onError = parseValue(args[2]);
            if (args[3]) (result.$convert as Record<string, unknown>).onNull = parseValue(args[3]);
            return result;
        }
        case 'SUM': return { $sum: parseValue(args[0]) };
        case 'AVG': return { $avg: parseValue(args[0]) };
        case 'MAX': return { $max: parseValue(args[0]) };
        case 'MIN': return { $min: parseValue(args[0]) };
        case 'COUNT': return { $sum: 1 };
        case 'PUSH': return { $push: parseValue(args[0]) };
        case 'ADD_TO_SET': return { $addToSet: parseValue(args[0]) };
        case 'YEAR': return { $year: parseValue(args[0]) };
        case 'MONTH': return { $month: parseValue(args[0]) };
        case 'DAY_OF_MONTH': return { $dayOfMonth: parseValue(args[0]) };
        case 'HOUR': return { $hour: parseValue(args[0]) };
        case 'MINUTE': return { $minute: parseValue(args[0]) };
        case 'SECOND': return { $second: parseValue(args[0]) };
        case 'DATE_ADD': return { $dateAdd: { startDate: parseValue(args[0]), amount: parseValue(args[1]), unit: args[2].replace(/['"]/g, '') } };
        case 'DATE_SUBTRACT': return { $dateSubtract: { startDate: parseValue(args[0]), amount: parseValue(args[1]), unit: args[2].replace(/['"]/g, '') } };
        case 'DATE_DIFF': return { $dateDiff: { startDate: parseValue(args[0]), endDate: parseValue(args[1]), unit: args[2].replace(/['"]/g, '') } };
        case 'DATE_TO_STRING': {
            const result: Record<string, unknown> = { $dateToString: { format: args[1].replace(/['"]/g, ''), date: parseValue(args[0]) } };
            if (args[2]) (result.$dateToString as Record<string, unknown>).timezone = args[2].replace(/['"]/g, '');
            return result;
        }
        case 'DATE_FROM_STRING': return { $dateFromString: { dateString: parseValue(args[0]) } };
        case 'DATE_FROM_PARTS': {
            const parts: Record<string, unknown> = {};
            const partNames = ['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'];
            args.forEach((arg, index) => {
                if (partNames[index]) {
                    parts[partNames[index]] = parseValue(arg);
                }
            });
            return { $dateFromParts: parts };
        }
        case 'DATE_TO_PARTS': {
            const result: Record<string, unknown> = { $dateToParts: { date: parseValue(args[0]) } };
            if (args[1]) (result.$dateToParts as Record<string, unknown>).timezone = args[1].replace(/['"]/g, '');
            return result;
        }
        case 'ISO_WEEK': return { $isoWeek: parseValue(args[0]) };
        case 'ISO_WEEK_YEAR': return { $isoWeekYear: parseValue(args[0]) };
        case 'ISO_DAY_OF_WEEK': return { $isoDayOfWeek: parseValue(args[0]) };
        case 'DAY_OF_WEEK': return { $dayOfWeek: parseValue(args[0]) };
        case 'DAY_OF_YEAR': return { $dayOfYear: parseValue(args[0]) };
        case 'WEEK': return { $week: parseValue(args[0]) };
        case 'REGEX': return { $regexMatch: { input: parseValue(args[0]), regex: args[1].replace(/['"]/g, '') } };
        case 'MERGE_OBJECTS': {
            const mergeArgs = args.map((arg) => {
                if (arg.trim().startsWith('{')) {
                    try { return JSON.parse(arg.trim()); } catch { return parseValue(arg); }
                }
                return parseValue(arg);
            });
            return { $mergeObjects: mergeArgs };
        }
        case 'SET_UNION': {
            const unionArgs = args.map((arg) => {
                if (arg.trim().startsWith('[')) {
                    try { return JSON.parse(arg.trim()); } catch { return parseValue(arg); }
                }
                return parseValue(arg);
            });
            return { $setUnion: unionArgs };
        }
        case 'SWITCH': {
            if (args.length < 2) throw createError(ErrorCodes.INVALID_EXPRESSION, 'SWITCH requires at least 2 arguments');
            const branches: Array<{ case: unknown; then: unknown }> = [];
            let defaultValue: unknown = null;
            for (let index = 0; index < args.length - 1; index += 2) {
                if (index + 1 < args.length) {
                    branches.push({ case: compileInnerExpression(args[index]), then: parseValue(args[index + 1]) });
                }
            }
            if (args.length % 2 === 1) defaultValue = parseValue(args[args.length - 1]);
            const result: { $switch: { branches: unknown[]; default?: unknown } } = { $switch: { branches } };
            if (defaultValue !== null) result.$switch.default = defaultValue;
            return result;
        }
        case 'ALL_ELEMENTS_TRUE': return { $allElementsTrue: [parseValue(args[0])] };
        case 'ANY_ELEMENT_TRUE': return { $anyElementTrue: [parseValue(args[0])] };
        case 'COND': {
            if (args.length !== 3) throw createError(ErrorCodes.INVALID_EXPRESSION, 'COND requires 3 arguments');
            return { $cond: { if: compileInnerExpression(args[0]), then: parseValue(args[1]), else: parseValue(args[2]) } };
        }
        case 'IF_NULL': {
            if (args.length !== 2) throw createError(ErrorCodes.INVALID_EXPRESSION, 'IF_NULL requires 2 arguments');
            return { $ifNull: [parseValue(args[0]), parseValue(args[1])] };
        }
        case 'SET_FIELD': {
            if (args.length !== 3) throw createError(ErrorCodes.INVALID_EXPRESSION, 'SET_FIELD requires 3 arguments: (field, value, input)');
            return { $setField: { field: parseValue(args[0]), input: parseValue(args[2]), value: parseValue(args[1]) } };
        }
        case 'UNSET_FIELD': return { $unsetField: { field: parseValue(args[0]), input: parseValue(args[1]) } };
        case 'GET_FIELD': return args.length === 1
            ? { $getField: parseValue(args[0]) }
            : { $getField: { field: parseValue(args[0]), input: parseValue(args[1]) } };
        case 'SET_DIFFERENCE': return { $setDifference: [parseValue(args[0]), parseValue(args[1])] };
        case 'SET_EQUALS': return { $setEquals: args.map((arg) => parseValue(arg)) };
        case 'SET_INTERSECTION': return { $setIntersection: args.map((arg) => parseValue(arg)) };
        case 'SET_IS_SUBSET': return { $setIsSubset: [parseValue(args[0]), parseValue(args[1])] };
        case 'LET': {
            const varsMatch = /\{(.+)\}/.exec(args[0]);
            if (!varsMatch) throw createError(ErrorCodes.INVALID_EXPRESSION, 'LET requires an object literal for variables');
            const varPairs = varsMatch[1].split(',').map((pair) => {
                const [key, ...rest] = pair.split(':');
                return [key.trim(), rest.join(':').trim()] as [string, string];
            });
            const vars: Record<string, unknown> = {};
            for (const [key, value] of varPairs) {
                vars[key] = parseValue(value);
            }
            return { $let: { vars, in: compileInnerExpression(args[1]) } };
        }
        case 'LITERAL': return { $literal: parseValue(args[0]) };
        case 'RAND': return { $rand: {} };
        case 'SAMPLE_RATE': return { $sampleRate: parseValue(args[0]) };
        default:
            throw createError(ErrorCodes.INVALID_EXPRESSION, `Unsupported function: ${name}`);
    }
}

function compileFilterCondition(condition: string, varName: string): unknown {
    const replaced = condition.replace(new RegExp(`\\b${varName}\\.`, 'g'), () => `$$${varName}.`);
    return compileInnerExpression(replaced);
}

function compileMapExpression(exprStr: string, varName: string): unknown {
    const replaced = exprStr.replace(new RegExp(`\\b${varName}\\.`, 'g'), () => `$$${varName}.`);
    return compileInnerExpression(replaced);
}

function splitArgsStr(argsStr: string): string[] {
    if (!argsStr.trim()) return [];
    return splitTopLevel(argsStr, ',');
}

function topLevelPositions(source: string): number[] {
    const positions: number[] = [];
    const stack: string[] = [];
    let quote: string | null = null;
    for (let index = 0; index < source.length; index++) {
        const ch = source[index];
        if (quote) {
            if (ch === quote && source[index - 1] !== '\\') quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { stack.push(ch); continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            const opening = stack.pop();
            if ((ch === ')' && opening !== '(') || (ch === ']' && opening !== '[') || (ch === '}' && opening !== '{')) {
                throw createError(ErrorCodes.INVALID_EXPRESSION, 'Unbalanced expression delimiters');
            }
            continue;
        }
        if (stack.length === 0) positions.push(index);
    }
    if (quote || stack.length > 0) {
        throw createError(ErrorCodes.INVALID_EXPRESSION, 'Unbalanced expression delimiters');
    }
    return positions;
}

function splitTopLevel(source: string, separator: string, positions = topLevelPositions(source)): string[] {
    const parts: string[] = [];
    let start = 0;
    for (const index of positions) {
        if (index < start || !source.startsWith(separator, index)) continue;
        parts.push(source.slice(start, index).trim());
        start = index + separator.length;
    }
    if (parts.length === 0) return [source];
    parts.push(source.slice(start).trim());
    if (parts.some((part) => !part)) {
        throw createError(ErrorCodes.INVALID_EXPRESSION, `Missing operand around ${separator}`);
    }
    return parts;
}

function findConditional(source: string, positions: number[]): { question: number; colon: number } | null {
    const question = positions.find((index) => source[index] === '?'
        && source[index - 1] !== '?' && source[index + 1] !== '?');
    if (question === undefined) return null;
    let nested = 0;
    for (const index of positions) {
        if (index <= question) continue;
        if (source[index] === '?' && source[index - 1] !== '?' && source[index + 1] !== '?') nested++;
        if (source[index] === ':') {
            if (nested === 0) return { question, colon: index };
            nested--;
        }
    }
    throw createError(ErrorCodes.INVALID_EXPRESSION, 'Conditional expression is missing a branch');
}

function findBinaryOperator(
    source: string,
    positions: number[],
    operators: string[],
    rightmost = false,
): { index: number; operator: string } | null {
    let match: { index: number; operator: string } | null = null;
    for (const index of positions) {
        const operator = operators.find((candidate) => source.startsWith(candidate, index));
        if (!operator) continue;
        if ((operator === '+' || operator === '-') && !source.slice(0, index).trim()) continue;
        if ((operator === '+' || operator === '-') && /[+\-*/%<>=!?&|:,]$/.test(source.slice(0, index).trimEnd())) continue;
        match = { index, operator };
        if (!rightmost) break;
    }
    return match;
}

function stripOuterParentheses(source: string): string {
    let normalized = source.trim();
    while (normalized.startsWith('(') && normalized.endsWith(')') && isWrappedByOuterParentheses(normalized)) {
        normalized = normalized.slice(1, -1).trim();
    }
    return normalized;
}

function isWrappedByOuterParentheses(source: string): boolean {
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < source.length; index++) {
        const ch = source[index];
        const prev = source[index - 1];
        if ((ch === '"' || ch === "'") && prev !== '\\') {
            if (quote === ch) quote = null;
            else if (!quote) quote = ch;
            continue;
        }
        if (quote) continue;
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0 && index < source.length - 1) return false;
        }
    }
    return true;
}
