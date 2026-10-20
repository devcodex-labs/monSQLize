/**
 * Expression compiler.
 *
 * Compiles custom string DSL expressions into MongoDB Aggregation Pipeline
 * nested objects, supporting function calls, logical operators,
 * comparison operators, and field references.
 */
import { createError, ErrorCodes } from '../errors/index';

const FUNCTION_NAMES = 'CONCAT|UPPER|LOWER|TRIM|SUBSTR|LENGTH|ABS|CEIL|FLOOR|ROUND|SQRT|POW|SIZE|IN|SLICE|FIRST|LAST|ARRAY_ELEM_AT|FILTER|MAP|INDEX_OF|CONCAT_ARRAYS|TYPE|NOT|EXISTS|IS_NUMBER|IS_ARRAY|SUM|AVG|MAX|MIN|COUNT|PUSH|ADD_TO_SET|YEAR|MONTH|DAY_OF_MONTH|HOUR|MINUTE|SECOND|SPLIT|REPLACE|INDEX_OF_STR|LTRIM|RTRIM|SUBSTR_CP|REGEX|MERGE_OBJECTS|TO_INT|TO_STRING|OBJECT_TO_ARRAY|ARRAY_TO_OBJECT|SET_UNION|SWITCH|DATE_ADD|DATE_SUBTRACT|DATE_DIFF|DATE_TO_STRING|DATE_FROM_STRING|TO_BOOL|TO_DATE|TO_DOUBLE|CONVERT|TO_DECIMAL|TO_LONG|TO_OBJECT_ID|REDUCE|ZIP|REVERSE_ARRAY|RANGE|DATE_FROM_PARTS|DATE_TO_PARTS|ISO_WEEK|ISO_WEEK_YEAR|ISO_DAY_OF_WEEK|DAY_OF_WEEK|DAY_OF_YEAR|WEEK|STR_LEN_BYTES|STR_LEN_CP|SUBSTR_BYTES|LOG|LOG10|ALL_ELEMENTS_TRUE|ANY_ELEMENT_TRUE|COND|IF_NULL|SET_FIELD|UNSET_FIELD|GET_FIELD|SET_DIFFERENCE|SET_EQUALS|SET_INTERSECTION|SET_IS_SUBSET|LET|LITERAL|RAND|SAMPLE_RATE';
const FUNC_REGEX = new RegExp('^(' + FUNCTION_NAMES + ')\\s*\\((.+)?\\)$', 'i');
const IS_FUNC_CALL_RE = new RegExp('^(' + FUNCTION_NAMES.slice(0, 391) + ')\\s*\\(', 'i');

const UNARY_FUNCTIONS: Readonly<Record<string, string>> = {
    UPPER: '$toUpper',
    LOWER: '$toLower',
    LENGTH: '$strLenCP',
    STR_LEN_BYTES: '$strLenBytes',
    STR_LEN_CP: '$strLenCP',
    ABS: '$abs',
    CEIL: '$ceil',
    FLOOR: '$floor',
    SQRT: '$sqrt',
    LOG10: '$log10',
    SIZE: '$size',
    FIRST: '$first',
    LAST: '$last',
    REVERSE_ARRAY: '$reverseArray',
    TYPE: '$type',
    IS_NUMBER: '$isNumber',
    IS_ARRAY: '$isArray',
    TO_INT: '$toInt',
    TO_STRING: '$toString',
    OBJECT_TO_ARRAY: '$objectToArray',
    ARRAY_TO_OBJECT: '$arrayToObject',
    TO_BOOL: '$toBool',
    TO_DATE: '$toDate',
    TO_DOUBLE: '$toDouble',
    TO_DECIMAL: '$toDecimal',
    TO_LONG: '$toLong',
    TO_OBJECT_ID: '$toObjectId',
    SUM: '$sum',
    AVG: '$avg',
    MAX: '$max',
    MIN: '$min',
    PUSH: '$push',
    ADD_TO_SET: '$addToSet',
    YEAR: '$year',
    MONTH: '$month',
    DAY_OF_MONTH: '$dayOfMonth',
    HOUR: '$hour',
    MINUTE: '$minute',
    SECOND: '$second',
    ISO_WEEK: '$isoWeek',
    ISO_WEEK_YEAR: '$isoWeekYear',
    ISO_DAY_OF_WEEK: '$isoDayOfWeek',
    DAY_OF_WEEK: '$dayOfWeek',
    DAY_OF_YEAR: '$dayOfYear',
    WEEK: '$week',
    LITERAL: '$literal',
    SAMPLE_RATE: '$sampleRate',
};

const BINARY_FUNCTIONS: Readonly<Record<string, string>> = {
    SPLIT: '$split',
    POW: '$pow',
    LOG: '$log',
    IN: '$in',
    ARRAY_ELEM_AT: '$arrayElemAt',
    INDEX_OF: '$indexOfArray',
    SET_DIFFERENCE: '$setDifference',
    SET_IS_SUBSET: '$setIsSubset',
};

const VARIADIC_FUNCTIONS: Readonly<Record<string, string>> = {
    CONCAT: '$concat',
    CONCAT_ARRAYS: '$concatArrays',
    MERGE_OBJECTS: '$mergeObjects',
    SET_UNION: '$setUnion',
    SET_EQUALS: '$setEquals',
    SET_INTERSECTION: '$setIntersection',
};

type ExpressionScope = {
    dsl: ReadonlyMap<string, string>;
    native: ReadonlyMap<string, string>;
};

function cloneScope(scope: ExpressionScope) {
    return { dsl: new Map(scope.dsl), native: new Map(scope.native) };
}

function bindVariable(scope: ExpressionScope, name: string, source: string, bindDsl: boolean) {
    const bodyScope = cloneScope(scope);
    let mongoName = name;
    if ([...scope.dsl].some(([key, target]) => (!bindDsl || key !== name) && target === name)) {
        const used = new Set([...scope.dsl.keys(), ...scope.dsl.values(), ...scope.native.values(), ...(source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]);
        for (let index = 0; used.has(mongoName); index++) mongoName = 'monsqlizeVariable' + index;
    }
    if (bindDsl) bodyScope.dsl.set(name, mongoName);
    bodyScope.native.set(name, mongoName);
    return { bodyScope, mongoName };
}

function resolveNativeVariable(value: string, scope: ExpressionScope): string {
    const [name, ...path] = value.slice(2).split('.');
    return '$$' + [scope.native.get(name) ?? name, ...path].join('.');
}

function compileNativeValue(value: unknown, scope: ExpressionScope): unknown {
    if (typeof value === 'string') return value.startsWith('$$') ? resolveNativeVariable(value, scope) : value;
    if (Array.isArray(value)) return value.map(item => compileNativeValue(item, scope));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([operator, payload]) => {
        if (operator === '$literal') return [operator, payload];
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [operator, compileNativeValue(payload, scope)];
        const definition = payload as Record<string, unknown>;
        if (operator === '$map' || operator === '$filter') {
            const name = typeof definition.as === 'string' ? definition.as : 'this';
            const { bodyScope, mongoName } = bindVariable(scope, name, JSON.stringify(payload), false);
            const bodyKey = operator === '$map' ? 'in' : 'cond';
            return [operator, {
                ...definition, input: compileNativeValue(definition.input, scope), as: mongoName,
                [bodyKey]: compileNativeValue(definition[bodyKey], bodyScope),
                ...(definition.limit !== undefined ? { limit: compileNativeValue(definition.limit, scope) } : {}),
            }];
        }
        if (operator === '$reduce') {
            const bodyScope = cloneScope(scope);
            bodyScope.native.set('value', 'value');
            bodyScope.native.set('this', 'this');
            return [operator, {
                ...definition, input: compileNativeValue(definition.input, scope),
                initialValue: compileNativeValue(definition.initialValue, scope),
                in: compileNativeValue(definition.in, bodyScope),
            }];
        }
        if (operator === '$let') {
            let bodyScope = scope;
            const vars: Record<string, unknown> = {};
            for (const [name, initial] of Object.entries(definition.vars as Record<string, unknown> ?? {})) {
                const binding = bindVariable(bodyScope, name, JSON.stringify(payload), false);
                bodyScope = binding.bodyScope;
                vars[binding.mongoName] = compileNativeValue(initial, scope);
            }
            return [operator, { ...definition, vars, in: compileNativeValue(definition.in, bodyScope) }];
        }
        return [operator, compileNativeValue(payload, scope)];
    }));
}

export function compileInnerExpression(expression: string): unknown {
    return compileScopedExpression(expression, { dsl: new Map(), native: new Map() });
}

function compileScopedExpression(expression: string, scope: ExpressionScope): unknown {
    const compileInnerExpression = (source: string) => compileScopedExpression(source, scope);
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

    for (const [separator, operator] of [['||', '$or'], ['&&', '$and']]) {
        const parts = splitTopLevel(expr, separator, positions);
        if (parts.length > 1) return { [operator]: parts.map((part) => compileInnerExpression(part)) };
    }

    const binary = findBinaryOperator(expr, positions, ['===', '!==', '>=', '<=', '>', '<'])
        ?? findBinaryOperator(expr, positions, ['+', '-'], true)
        ?? findBinaryOperator(expr, positions, ['*', '/', '%'], true);
    if (binary) {
        const operators: Record<string, string> = {
            '===': '$eq', '!==': '$ne', '>=': '$gte', '<=': '$lte', '>': '$gt', '<': '$lt',
            '+': '$add', '-': '$subtract', '*': '$multiply', '/': '$divide', '%': '$mod',
        };
        return { [operators[binary.operator]]: [
            compileInnerExpression(expr.slice(0, binary.index)),
            compileInnerExpression(expr.slice(binary.index + binary.operator.length)),
        ] };
    }

    if (expr.startsWith('-')) {
        return { $multiply: [-1, compileInnerExpression(expr.slice(1))] };
    }

    const funcMatch = expr.match(FUNC_REGEX);
    if (funcMatch) {
        try {
            return dispatchFunction(funcMatch[1].toUpperCase(), funcMatch[2] ?? '', scope);
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

    return parseScopedValue(expr, scope);
}

function readQuotedString(source: string): string | undefined {
    const quote = source[0];
    return (quote === "'" || quote === '"') && source[source.length - 1] === quote
        ? source.slice(1, -1) : undefined;
}

function parseScopedValue(value: string, scope: ExpressionScope): unknown {
    const compileInnerExpression = (source: string) => compileScopedExpression(source, scope);
    const normalized = stripOuterParentheses(value.trim());

    const quoted = readQuotedString(normalized);
    if (quoted !== undefined) return quoted.startsWith('$') ? { $literal: quoted } : quoted;
    if (normalized === 'null') return null;
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    if (!isNaN(Number(normalized)) && normalized !== '') return Number(normalized);
    if (normalized !== value.trim() || IS_FUNC_CALL_RE.test(normalized) || FUNC_REGEX.test(normalized)) {
        return compileInnerExpression(normalized);
    }
    if (normalized.startsWith('[') || normalized.startsWith('{')) {
        try { return compileNativeValue(JSON.parse(normalized), scope); } catch {
            throw createError(ErrorCodes.INVALID_EXPRESSION, 'Invalid array or object literal');
        }
    }
    const positions = topLevelPositions(normalized);
    if (positions.some((index) => /[?+\-*/%><&|]/.test(normalized[index]))) {
        return compileInnerExpression(normalized);
    }
    if (normalized.startsWith('$$')) return resolveNativeVariable(normalized, scope);
    if (normalized.startsWith('$')) return normalized;
    const [root, ...path] = normalized.split('.');
    const variable = scope.dsl.get(root);
    return variable === undefined ? `$${normalized}` : `$$${[variable, ...path].join('.')}`;
}

function dispatchFunction(name: string, argsStr: string, scope: ExpressionScope): unknown {
    const parseValue = (source: string) => parseScopedValue(source, scope);
    const compileInnerExpression = (source: string) => compileScopedExpression(source, scope);
    const args = splitArgsStr(argsStr);
    if (name === 'LITERAL') {
        const source = stripOuterParentheses(args[0].trim());
        const quoted = readQuotedString(source);
        const literal = quoted !== undefined ? quoted
            : source.startsWith('{') || source.startsWith('[') ? JSON.parse(source)
                : parseScopedValue(source, { dsl: new Map(), native: new Map() });
        return { $literal: literal };
    }
    if (UNARY_FUNCTIONS[name]) return { [UNARY_FUNCTIONS[name]]: parseValue(args[0]) };
    if (BINARY_FUNCTIONS[name]) return { [BINARY_FUNCTIONS[name]]: [parseValue(args[0]), parseValue(args[1])] };
    if (VARIADIC_FUNCTIONS[name]) return { [VARIADIC_FUNCTIONS[name]]: args.map((arg) => parseValue(arg)) };

    switch (name) {
        case 'TRIM':
        case 'LTRIM':
        case 'RTRIM': return { [name === 'TRIM' ? '$trim' : name === 'LTRIM' ? '$ltrim' : '$rtrim']: { input: parseValue(args[0]) } };
        case 'SUBSTR':
        case 'SUBSTR_CP':
        case 'SUBSTR_BYTES': return { [name === 'SUBSTR' ? '$substr' : name === 'SUBSTR_CP' ? '$substrCP' : '$substrBytes']: [parseValue(args[0]), parseValue(args[1]), parseValue(args[2])] };
        case 'REPLACE': return { $replaceOne: { input: parseValue(args[0]), find: parseValue(args[1]), replacement: parseValue(args[2]) } };
        case 'INDEX_OF_STR': {
            const base = [parseValue(args[0]), parseValue(args[1])];
            if (args[2]) return { $indexOfCP: [...base, parseValue(args[2])] };
            return { $indexOfCP: base };
        }
        case 'ROUND': return args[1] ? { $round: [parseValue(args[0]), parseValue(args[1])] } : { $round: [parseValue(args[0])] };
        case 'SLICE': return args.length === 3
            ? { $slice: [parseValue(args[0]), parseValue(args[1]), parseValue(args[2])] }
            : { $slice: [parseValue(args[0]), parseValue(args[1])] };
        case 'FILTER':
        case 'MAP': {
            const input = parseValue(args[0]);
            const varName = args[1].replace(/['"]/g, '').trim();
            const { bodyScope, mongoName } = bindVariable(scope, varName, argsStr, true);
            const body = compileScopedExpression(args[2], bodyScope);
            return name === 'FILTER'
                ? { $filter: { input, as: mongoName, cond: body } }
                : { $map: { input, as: mongoName, in: body } };
        }
        case 'REDUCE': {
            const lambdaMatch = /\((\w+),\s*(\w+)\)\s*=>\s*(.+)/.exec(args[2]);
            if (!lambdaMatch) throw createError(ErrorCodes.INVALID_EXPRESSION, 'REDUCE requires a lambda: (acc, item) => expr');
            const [, accVar, itemVar, lambdaExpr] = lambdaMatch;
            const bodyScope = cloneScope(scope);
            const captures: Record<string, unknown> = {};
            const usedNames = new Set([...scope.dsl.keys(), ...scope.dsl.values(), ...scope.native.values(), ...(argsStr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])]);
            for (const [name, target] of scope.dsl) {
                if (name === accVar || name === itemVar || (target !== 'value' && target !== 'this')) continue;
                let alias = 'monsqlizeCapture0';
                for (let index = 1; usedNames.has(alias); index++) alias = 'monsqlizeCapture' + index;
                usedNames.add(alias);
                captures[alias] = '$$' + target;
                bodyScope.dsl.set(name, alias);
            }
            bodyScope.dsl.set(accVar, 'value');
            bodyScope.dsl.set(itemVar, 'this');
            bodyScope.native.set('value', 'value');
            bodyScope.native.set('this', 'this');
            const reduced = { $reduce: { input: parseValue(args[0]), initialValue: parseValue(args[1]), in: compileScopedExpression(lambdaExpr, bodyScope) } };
            return Object.keys(captures).length ? { $let: { vars: captures, in: reduced } } : reduced;
        }
        case 'ZIP': return { $zip: { inputs: args.map((arg) => parseValue(arg)) } };
        case 'RANGE': {
            const rangeArgs: unknown[] = [parseValue(args[0]), parseValue(args[1])];
            if (args[2]) rangeArgs.push(parseValue(args[2]));
            return { $range: rangeArgs };
        }
        case 'NOT': return { $not: [compileInnerExpression(args[0])] };
        case 'EXISTS': return { $ne: [parseValue(args[0]), null] };
        case 'CONVERT': {
            const result: Record<string, unknown> = { $convert: { input: parseValue(args[0]), to: args[1].replace(/['"]/g, '') } };
            if (args[2]) (result.$convert as Record<string, unknown>).onError = parseValue(args[2]);
            if (args[3]) (result.$convert as Record<string, unknown>).onNull = parseValue(args[3]);
            return result;
        }
        case 'COUNT': return { $sum: 1 };
        case 'DATE_ADD':
        case 'DATE_SUBTRACT':
        case 'DATE_DIFF': return { [name === 'DATE_ADD' ? '$dateAdd' : name === 'DATE_SUBTRACT' ? '$dateSubtract' : '$dateDiff']: {
            startDate: parseValue(args[0]), [name === 'DATE_DIFF' ? 'endDate' : 'amount']: parseValue(args[1]), unit: args[2].replace(/['"]/g, ''),
        } };
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
        case 'REGEX': return { $regexMatch: { input: parseValue(args[0]), regex: args[1].replace(/['"]/g, '') } };
        case 'SWITCH': {
            if (args.length < 2) throw createError(ErrorCodes.INVALID_EXPRESSION, 'SWITCH requires at least 2 arguments');
            const branches: Array<{ case: unknown; then: unknown }> = [];
            for (let index = 0; index < args.length - 1; index += 2) {
                if (index + 1 < args.length) {
                    branches.push({ case: compileInnerExpression(args[index]), then: parseValue(args[index + 1]) });
                }
            }
            const result: { $switch: { branches: unknown[]; default?: unknown } } = { $switch: { branches } };
            if (args.length % 2 === 1) result.$switch.default = parseValue(args[args.length - 1]);
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
        case 'LET': {
            const source = args[0].trim();
            if (!source.startsWith('{') || !source.endsWith('}')) throw createError(ErrorCodes.INVALID_EXPRESSION, 'LET requires an object literal for variables');
            const vars: Record<string, unknown> = {};
            let bodyScope = scope;
            for (const pair of splitArgsStr(source.slice(1, -1))) {
                const colon = topLevelPositions(pair).find((index) => pair[index] === ':');
                if (colon === undefined) throw createError(ErrorCodes.INVALID_EXPRESSION, 'LET variable requires a value');
                const key = pair.slice(0, colon).trim();
                const value = pair.slice(colon + 1).trim();
                if (!key || !value) throw createError(ErrorCodes.INVALID_EXPRESSION, 'LET variable requires a name and value');
                const binding = bindVariable(bodyScope, key, argsStr, false);
                bodyScope = binding.bodyScope;
                vars[binding.mongoName] = parseValue(value);
            }
            return { $let: { vars, in: compileScopedExpression(args[1], bodyScope) } };
        }
        case 'RAND': return { $rand: {} };
        default:
            throw createError(ErrorCodes.INVALID_EXPRESSION, `Unsupported function: ${name}`);
    }
}

function splitArgsStr(argsStr: string): string[] {
    if (!argsStr.trim()) return [];
    return splitTopLevel(argsStr, ',');
}

/** A quote is escaped only after an odd-length run of backslashes. */
function isEscaped(source: string, index: number): boolean {
    let count = 0;
    for (let at = index - 1; at >= 0 && source[at] === '\\'; at--) count++;
    return count % 2 === 1;
}

function topLevelPositions(source: string): number[] {
    const positions: number[] = [];
    const stack: string[] = [];
    let quote: string | null = null;
    for (let index = 0; index < source.length; index++) {
        const ch = source[index];
        if (quote) {
            if (ch === quote && !isEscaped(source, index)) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (stack.length === 0 && /[\d.]/.test(ch)) {
            const prefix = source.slice(0, index).trimEnd();
            const previous = prefix.length === 0 ? undefined : prefix.charAt(prefix.length - 1);
            if (previous === undefined || /[+\-*/%<>=!?&|:,]/.test(previous)) {
                const token = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(index));
                if (token) {
                    const next = source[index + token[0].length];
                    if (next && /[a-z_.]/i.test(next)) throw createError(ErrorCodes.INVALID_EXPRESSION, 'Invalid numeric expression');
                    index += token[0].length - 1;
                    continue;
                }
            }
        }
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
        if ((ch === '"' || ch === "'") && !isEscaped(source, index)) {
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
