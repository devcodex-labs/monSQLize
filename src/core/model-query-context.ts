// Shared across separately bundled CJS and ESM entries; never exported publicly.
export const MODEL_QUERY_FILTER = Symbol.for('monsqlize.internal.model-query-filter.v1');

export function getModelQueryFilter(options: unknown): Record<string, unknown> | undefined {
    return (options as { [MODEL_QUERY_FILTER]?: Record<string, unknown> } | undefined)?.[MODEL_QUERY_FILTER];
}
