import type { Document } from 'mongodb';
import type { RuntimeDefaults } from '../../../types/internal/query';
import { compilePipelineExpressions, hasExpressionInPipeline } from '../../../core/expression';
import { convertObjectIdStrings } from '../utils/objectid-converter';
import { snapshotPipelineValue } from './pipeline-snapshot';

/** Captures a raw aggregate pipeline and applies the execution transforms exactly once. */
export function prepareAggregatePipeline(pipeline: readonly unknown[] = [], defaults: RuntimeDefaults = {}): Document[] {
    const snapshot = snapshotPipelineValue(pipeline) as Document[];
    const normalized = defaults.autoConvertObjectId
        ? snapshot.map((stage) => convertObjectIdStrings(stage, '', 0, new WeakSet(), defaults.autoConvertObjectId) as Document)
        : snapshot;
    return hasExpressionInPipeline(normalized) ? compilePipelineExpressions(normalized) : normalized;
}
