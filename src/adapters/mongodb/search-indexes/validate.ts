/**
 * Local validation for Search index lifecycle inputs.
 * Every invalid input raises INVALID_SEARCH_INDEX_DEFINITION (Usage Contract §5).
 */
import { ErrorCodes, createError } from '../../../core/errors';
import type { SearchIndexSpec, SearchIndexType, WaitForSearchIndexOptions } from './types';

const TYPES: ReadonlySet<string> = new Set(['search', 'vectorSearch']);
const VECTOR_FIELD_TYPES: ReadonlySet<string> = new Set(['vector', 'filter']);
const SIMILARITIES: ReadonlySet<string> = new Set(['euclidean', 'cosine', 'dotProduct']);

function invalid(operation: string, namespace: object, indexName: unknown, field: string, reason: string): never {
    throw createError(
        ErrorCodes.INVALID_SEARCH_INDEX_DEFINITION,
        `${operation}: invalid ${field} (${reason})`,
        [{ operation, namespace, indexName: typeof indexName === 'string' ? indexName : undefined, field, reason }],
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function assertIndexName(operation: string, namespace: object, name: unknown): asserts name is string {
    if (typeof name !== 'string' || name.length === 0 || name.trim() !== name) {
        invalid(operation, namespace, name, 'name', 'non-empty string without leading or trailing whitespace required');
    }
}

export function assertDefinition(
    operation: string,
    namespace: object,
    name: string,
    definition: unknown,
    type?: SearchIndexType,
): asserts definition is Record<string, unknown> {
    if (!isPlainObject(definition)) invalid(operation, namespace, name, 'definition', 'plain object required');
    if (type !== 'vectorSearch') return;
    const fields = definition.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
        invalid(operation, namespace, name, 'definition.fields', 'non-empty array required for vectorSearch');
    }
    fields.forEach((field, index) => {
        const path = `definition.fields[${index}]`;
        if (!isPlainObject(field)) invalid(operation, namespace, name, path, 'object required');
        if (typeof field.type !== 'string' || !VECTOR_FIELD_TYPES.has(field.type)) {
            invalid(operation, namespace, name, `${path}.type`, 'must be "vector" or "filter"');
        }
        if (typeof field.path !== 'string' || field.path.length === 0) {
            invalid(operation, namespace, name, `${path}.path`, 'non-empty string required');
        }
        if (field.type === 'vector') {
            const dims = field.numDimensions;
            if (typeof dims !== 'number' || !Number.isInteger(dims) || dims <= 0) {
                invalid(operation, namespace, name, `${path}.numDimensions`, 'positive integer required');
            }
            if (typeof field.similarity !== 'string' || !SIMILARITIES.has(field.similarity)) {
                invalid(operation, namespace, name, `${path}.similarity`, 'must be "euclidean", "cosine", or "dotProduct"');
            }
        }
    });
}

export function assertSpec(operation: string, namespace: object, spec: unknown): asserts spec is SearchIndexSpec {
    if (!isPlainObject(spec)) invalid(operation, namespace, undefined, 'spec', 'object required');
    assertIndexName(operation, namespace, spec.name);
    if (typeof spec.type !== 'string' || !TYPES.has(spec.type)) {
        invalid(operation, namespace, spec.name, 'type', 'must be "search" or "vectorSearch"');
    }
    assertDefinition(operation, namespace, spec.name, spec.definition, spec.type as SearchIndexType);
}

export function assertOptionsObject(operation: string, namespace: object, name: unknown, options: unknown): void {
    if (options !== undefined && !isPlainObject(options)) invalid(operation, namespace, name, 'options', 'object required');
}

export function assertEnumOption(
    operation: string,
    namespace: object,
    name: unknown,
    field: string,
    value: unknown,
    allowed: readonly string[],
): void {
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
        invalid(operation, namespace, name, field, `must be one of ${allowed.map((v) => `"${v}"`).join(', ')}`);
    }
}

export function assertBooleanOption(operation: string, namespace: object, name: unknown, field: string, value: unknown): void {
    if (value !== undefined && typeof value !== 'boolean') invalid(operation, namespace, name, field, 'boolean required');
}

export interface ResolvedWaitOptions {
    until: 'queryable' | 'ready' | 'dropped';
    timeoutMs: number;
    intervalMs: number;
    signal?: AbortSignal;
}

export function resolveWaitOptions(namespace: object, name: string, options: WaitForSearchIndexOptions | undefined): ResolvedWaitOptions {
    const operation = 'waitForSearchIndex';
    assertOptionsObject(operation, namespace, name, options);
    const opts = options ?? {};
    assertEnumOption(operation, namespace, name, 'options.until', opts.until, ['queryable', 'ready', 'dropped']);
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        invalid(operation, namespace, name, 'options.timeoutMs', 'positive integer required');
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 100) {
        invalid(operation, namespace, name, 'options.intervalMs', 'integer >= 100 required');
    }
    const signal = opts.signal;
    if (signal !== undefined && (signal === null || typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function')) {
        invalid(operation, namespace, name, 'options.signal', 'AbortSignal required');
    }
    return { until: opts.until ?? 'queryable', timeoutMs, intervalMs, signal };
}
