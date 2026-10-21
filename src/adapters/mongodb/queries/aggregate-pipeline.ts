import type { Document } from 'mongodb';
import { types as utilTypes } from 'node:util';
import type { RuntimeDefaults } from '../../../types/internal/query';
import { compilePipelineExpressions, hasExpressionInPipeline } from '../../../core/expression';
import { convertObjectIdStrings } from '../utils/objectid-converter';
import { snapshotPipelineValue } from './pipeline-snapshot';
import { snapshotResultOptions } from './query-helpers';

// Defaults match the pinned driver's resolveBSONOptions; live resources remain untouched.
const standardBsonOptions: Record<string, unknown> = {
    raw: false, useBigInt64: false, promoteLongs: true, promoteValues: true, promoteBuffers: false,
    ignoreUndefined: false, bsonRegExp: false, serializeFunctions: false, enableUtf8Validation: true,
};
function captureRawFields(value: Record<string, unknown>): Record<string, boolean> {
    const names = new Set<string>();
    for (let level = value; level; level = Object.getPrototypeOf(level)) {
        for (const name of Object.getOwnPropertyNames(level)) names.add(name);
    }
    return Object.setPrototypeOf(Object.fromEntries([...names].map((name) => [name, Boolean(value[name])])), null);
}
const standardRawFields = captureRawFields({});

function hasDynamicRawFields(value: Record<string, unknown>): boolean {
    for (let level = value; level; level = Object.getPrototypeOf(level)) {
        if (utilTypes.isProxy(level)) return true;
    }
    return false;
}

/** Nonstandard BSON result modes retain native execution and bypass the result cache. */
export function isStandardAggregateBsonMode(options: Record<string, unknown>): boolean {
    if (Object.entries(standardBsonOptions).some(([key, value]) => options[key] !== value)) return false;
    const fields = options.fieldsAsRaw as Record<string, boolean>;
    if (hasDynamicRawFields(fields)) return false;
    return [...new Set([...Object.keys(fields), ...Object.keys(standardRawFields)])]
        .every((key) => Boolean(fields[key]) === Boolean(standardRawFields[key]));
}

/** Captures a raw aggregate pipeline and applies the execution transforms exactly once. */
export function prepareAggregatePipeline(pipeline: readonly unknown[] = [], defaults: RuntimeDefaults = {}): Document[] {
    const snapshot = snapshotPipelineValue(pipeline) as Document[];
    const normalized = defaults.autoConvertObjectId
        ? snapshot.map((stage) => convertObjectIdStrings(stage, '', 0, new WeakSet(), defaults.autoConvertObjectId) as Document)
        : snapshot;
    return hasExpressionInPipeline(normalized) ? compilePipelineExpressions(normalized) : normalized;
}

/** Materialize the driver's out alias before policy checks and cache classification. */
export function prepareAggregateExecution(
    pipeline: readonly unknown[] = [],
    options: Record<string, unknown> = {},
    defaults: RuntimeDefaults = {},
    inheritedBsonOptions: Record<string, unknown> = {},
): { pipeline: Document[]; options: Record<string, unknown> } {
    const captured = snapshotResultOptions(options);
    for (const [key, value] of Object.entries(standardBsonOptions)) {
        captured[key] = captured[key] ?? inheritedBsonOptions[key] ?? value;
    }
    const fields = (captured.fieldsAsRaw ?? inheritedBsonOptions.fieldsAsRaw ?? {}) as Record<string, unknown>;
    captured.fieldsAsRaw = hasDynamicRawFields(fields) ? fields : captureRawFields(fields);
    const prepared = prepareAggregatePipeline(pipeline, defaults);
    if (typeof captured.out === 'string') {
        prepared.push({ $out: captured.out });
        delete captured.out;
    }
    return { pipeline: prepared, options: captured };
}
