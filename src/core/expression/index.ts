/**
 * Expression compilation module — fully ported from the v1 ExpressionCompiler + ExpressionCompilerExtensions.
 * Supports 100+ MongoDB operators with 1:1 behavior compatibility with v1.
 */

import type { ExpressionObject } from '../../../types/base';
import { createError, ErrorCodes } from '../errors/index';
import { compileInnerExpression } from './expression-compiler';

export type { ExpressionObject } from '../../../types/base';

export function createExpression(expression: unknown): ExpressionObject {
    if (typeof expression !== 'string') {
        throw new TypeError('Expression must be a string');
    }
    const normalized = expression.trim();
    if (!normalized) {
        throw createError(ErrorCodes.INVALID_EXPRESSION, 'Expression cannot be empty');
    }
    return { __expr__: normalized, __compiled__: false };
}

export const expr = createExpression;

export function isExpressionObject(value: unknown): value is ExpressionObject {
    return Boolean(
        value &&
        typeof value === 'object' &&
        '__expr__' in value &&
        typeof (value as ExpressionObject).__expr__ === 'string' &&
        '__compiled__' in value &&
        typeof (value as ExpressionObject).__compiled__ === 'boolean',
    );
}

function isPlainExpressionRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function hasExpressionInObject(value: unknown): boolean {
    if (isExpressionObject(value)) return true;
    if (Array.isArray(value)) return value.some((item) => hasExpressionInObject(item));
    if (!isPlainExpressionRecord(value)) return false;
    return Object.values(value).some((item) => hasExpressionInObject(item));
}

export function hasExpressionInPipeline(pipeline: unknown): boolean {
    return Array.isArray(pipeline) && pipeline.some((stage) => hasExpressionInObject(stage));
}

export function compilePipelineExpressions<TPipeline>(pipeline: TPipeline): TPipeline {
    return transformPipeline(pipeline) as TPipeline;
}

type StageContext = 'match' | 'project' | 'group';

function transformExpressions(value: unknown, context: StageContext): unknown {
    if (isExpressionObject(value)) {
        const compiled = compileInnerExpression(value.__expr__);
        return context === 'match' ? { $expr: compiled } : compiled;
    }

    if (Array.isArray(value)) {
        return value.map((item) => transformStageEntry(item));
    }

    if (!isPlainExpressionRecord(value)) return value;

    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, current] of entries) {
        result[key] = transformExpressions(current, context);
    }
    return result;
}

function transformPipeline(pipeline: unknown): unknown {
    return Array.isArray(pipeline) ? pipeline.map((stage) => transformStageEntry(stage)) : transformExpressions(pipeline, 'project');
}

function transformStageEntry(stage: unknown): unknown {
    if (!isPlainExpressionRecord(stage)) {
        return transformExpressions(stage, 'project');
    }
    const entries = Object.entries(stage as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, current] of entries) {
        const context = getStageContext(key);
        if (key === '$match') {
            result[key] = transformMatchPredicate(current);
        } else if (key === '$facet' && isPlainExpressionRecord(current)) {
            result[key] = Object.fromEntries(Object.entries(current).map(([name, pipeline]) => [name, transformPipeline(pipeline)]));
        } else if ((key === '$lookup' || key === '$unionWith' || key === '$merge') && isPlainExpressionRecord(current)) {
            const nested = key === '$merge' ? 'whenMatched' : 'pipeline';
            const value = transformStageValue(current, 'project') as Record<string, unknown>;
            if (Array.isArray(current[nested])) value[nested] = transformPipeline(current[nested]);
            result[key] = value;
        } else {
            result[key] = transformStageValue(current, context);
        }
    }
    return result;
}

function getStageContext(key: string): StageContext {
    if (key === '$project' || key === '$addFields' || key === '$set') return 'project';
    if (key === '$group') return 'group';
    return 'match';
}

/** Field query values cannot contain a DSL predicate without an explicit $expr role. */
function transformQueryValue(value: unknown): unknown {
    if (isExpressionObject(value)) {
        throw createError(ErrorCodes.INVALID_EXPRESSION, 'Expressions in $match must be predicates or values of $expr');
    }
    if (Array.isArray(value)) return value.map(transformQueryValue);
    if (!isPlainExpressionRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, current]) =>
        [key, key === '$literal' ? current : transformQueryValue(current)]));
}

/** Keeps query predicate and aggregation expression positions separate. */
function transformMatchPredicate(value: unknown): unknown {
    if (isExpressionObject(value)) return { $expr: compileInnerExpression(value.__expr__) };
    if (!isPlainExpressionRecord(value)) return transformQueryValue(value);
    return Object.fromEntries(Object.entries(value).map(([key, current]) => {
        if (key === '$expr') return [key, transformStageValue(current, 'project')];
        if ((key === '$and' || key === '$or' || key === '$nor') && Array.isArray(current)) {
            return [key, current.map(transformMatchPredicate)];
        }
        return [key, transformQueryValue(current)];
    }));
}

function transformStageValue(value: unknown, context: StageContext): unknown {
    if (isExpressionObject(value)) {
        const compiled = compileInnerExpression(value.__expr__);
        return context === 'match' ? { $expr: compiled } : compiled;
    }
    if (Array.isArray(value)) {
        return value.map((item) => transformStageValue(item, context));
    }
    if (!isPlainExpressionRecord(value)) return value;
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, current] of entries) {
        result[key] = key === '$literal' ? current : transformStageValue(current, context);
    }
    return result;
}
