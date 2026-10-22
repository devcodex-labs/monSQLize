import type { Document } from 'mongodb';
import type { RuntimeDefaults } from '../../../types/internal/query';
import { compilePipelineExpressions, hasExpressionInPipeline } from '../../../core/expression';
import { convertObjectIdStrings } from '../utils/objectid-converter';
import { snapshotPipelineValue } from './pipeline-snapshot';
import { snapshotResultOptions } from './query-helpers';
import { canCacheBsonResult, captureBsonOptions } from './bson-read-options';

/** Nonstandard BSON result modes retain native execution and bypass the result cache. */
export function isStandardAggregateBsonMode(options: Record<string, unknown>): boolean {
    return canCacheBsonResult(options, true);
}

/** Captures a raw aggregate pipeline and applies the execution transforms exactly once. */
export function prepareAggregatePipeline(pipeline: readonly unknown[] = [], defaults: RuntimeDefaults = {}, serializeFunctions = false): Document[] {
    const snapshot = snapshotPipelineValue(pipeline, undefined, serializeFunctions) as Document[];
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
    inheritedBsonOptions: object = {},
): { pipeline: Document[]; options: Record<string, unknown> } {
    const native = captureBsonOptions(options, inheritedBsonOptions);
    const prepared = prepareAggregatePipeline(pipeline, defaults, native.serializeFunctions === true);
    const captured = snapshotResultOptions(native);
    if (typeof captured.out === 'string') {
        prepared.push({ $out: captured.out });
        delete captured.out;
    }
    return { pipeline: prepared, options: captured };
}
