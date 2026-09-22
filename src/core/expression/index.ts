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
    return transformExpressions(pipeline, 'project') as TPipeline;
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

function transformStageEntry(stage: unknown): unknown {
    if (!isPlainExpressionRecord(stage)) {
        return transformExpressions(stage, 'project');
    }
    const entries = Object.entries(stage as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, current] of entries) {
        const context = getStageContext(key);
        result[key] = transformStageValue(current, context);
    }
    return result;
}

function getStageContext(key: string): StageContext {
    if (key === '$project' || key === '$addFields' || key === '$set') return 'project';
    if (key === '$group') return 'group';
    return 'match';
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
        result[key] = transformStageValue(current, context);
    }
    return result;
}
