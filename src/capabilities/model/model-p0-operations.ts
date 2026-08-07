/**
 * Model P0 vector-search and relation-protection operations.
 *
 * This module keeps the public ModelInstance focused on lifecycle and existing
 * CRUD orchestration while making the cross-collection read/preflight behavior
 * independently testable.
 */
import { ErrorCodes, createError } from '../../core/errors';
import type {
    ModelVectorSearchOptions,
    RelationProtectedDeleteOptions,
    RelationProtectedDeleteResult,
    RelationUsageOptions,
    RelationUsageReport,
} from '../../../types/model';
import type { VectorSearchHit, VectorSearchOptions } from '../../../types/collection';
import type { ModelCollectionLike, ModelRuntimeLike } from './populate-promise';
import type { ModelSoftDeleteConfig } from './model-instance-config';
import { applyModelSoftDeleteFilter } from './model-write-helpers';
import {
    buildRelationUsageTargetProjection,
    createUnavailableRelationUsageReport,
    inspectDeclaredRelationUsage,
    normalizeRelationUsageOptions,
    stripRelationUsageOptions,
    type RelationUsageScanContext,
} from './relation-usage';

export type ModelP0OperationsHost<TDocument> = {
    collection: Pick<ModelCollectionLike<TDocument>, 'find' | 'findOne' | 'vectorSearch'>;
    softDeleteConfig: ModelSoftDeleteConfig | null;
    modelName: string;
    runtime: ModelRuntimeLike;
    dbName: string;
    poolName?: string;
    hydrateDocument: (doc: TDocument | null | undefined) => (TDocument & Record<string, unknown>) | null;
    deleteOne: (filter?: unknown, options?: unknown) => Promise<unknown>;
    forceDelete: (filter?: unknown, options?: unknown) => Promise<unknown>;
};

function relationUsageContext<TDocument>(host: ModelP0OperationsHost<TDocument>): RelationUsageScanContext {
    return {
        modelName: host.modelName,
        runtime: host.runtime,
        dbName: host.dbName,
        poolName: host.poolName,
    };
}

function isNonEmptyFilter(filter: unknown): filter is Record<string, unknown> {
    return typeof filter === 'object' && filter !== null && !Array.isArray(filter) && Object.keys(filter).length > 0;
}

function relationTargetReadOptions(
    options: unknown,
    projection: Record<string, 1>,
): Record<string, unknown> {
    const source = (options ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = { projection };
    for (const key of ['session', 'collation', 'hint', 'comment', 'let', 'maxTimeMS', 'readConcern', 'readPreference'] as const) {
        if (source[key] !== undefined) {
            result[key] = source[key];
        }
    }
    return result;
}

function hydrateVectorSearchHits<TDocument>(
    host: ModelP0OperationsHost<TDocument>,
    hits: Array<VectorSearchHit<TDocument>>,
): Array<VectorSearchHit<TDocument & Record<string, unknown>>> {
    return hits.map((hit) => {
        const document = host.hydrateDocument(hit.document);
        if (!document) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Vector Search returned a non-document result');
        }
        return { document, score: hit.score };
    });
}

/** Executes Model vector search while preserving the Collection contract. */
export async function executeModelVectorSearch<TDocument>(
    host: ModelP0OperationsHost<TDocument>,
    options: ModelVectorSearchOptions,
): Promise<Array<VectorSearchHit<TDocument & Record<string, unknown>>>> {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
        const hits = await host.collection.vectorSearch<TDocument>(options as unknown as VectorSearchOptions);
        return hydrateVectorSearchHits(host, hits);
    }
    const { withDeleted, onlyDeleted, ...collectionOptions } = options;
    if (withDeleted !== undefined && typeof withDeleted !== 'boolean') {
        throw createError(
            ErrorCodes.INVALID_VECTOR_SEARCH,
            'withDeleted must be a boolean',
            [{ field: 'withDeleted', reason: 'boolean required' }],
        );
    }
    if (onlyDeleted !== undefined && typeof onlyDeleted !== 'boolean') {
        throw createError(
            ErrorCodes.INVALID_VECTOR_SEARCH,
            'onlyDeleted must be a boolean',
            [{ field: 'onlyDeleted', reason: 'boolean required' }],
        );
    }
    const filter = host.softDeleteConfig?.enabled && !withDeleted
        ? applyModelSoftDeleteFilter(
            collectionOptions.filter,
            { withDeleted, onlyDeleted },
            host.softDeleteConfig,
        ) as Record<string, unknown>
        : collectionOptions.filter;
    const hits = await host.collection.vectorSearch<TDocument>({
        ...collectionOptions,
        ...(filter === undefined ? {} : { filter }),
    });
    return hydrateVectorSearchHits(host, hits);
}

/** Runs the read-only, bounded relation usage check for a Model target filter. */
export async function executeRelationUsageCheck<TDocument>(
    host: ModelP0OperationsHost<TDocument>,
    filter?: unknown,
    options?: RelationUsageOptions,
): Promise<RelationUsageReport> {
    const normalizedOptions = normalizeRelationUsageOptions(options);
    const context = relationUsageContext(host);
    try {
        const rawTargets = await host.collection.find(
            applyModelSoftDeleteFilter(filter, undefined, host.softDeleteConfig),
            {
                session: normalizedOptions.session,
                projection: buildRelationUsageTargetProjection(host.modelName),
                limit: normalizedOptions.maxTargets + 1,
            },
        );
        const targets = rawTargets.filter((target): target is Record<string, unknown> =>
            typeof target === 'object' && target !== null && !Array.isArray(target),
        );
        return inspectDeclaredRelationUsage(
            context,
            targets.slice(0, normalizedOptions.maxTargets),
            normalizedOptions,
            targets.length > normalizedOptions.maxTargets,
        );
    } catch (error) {
        return createUnavailableRelationUsageReport(context, error instanceof Error ? error.message : String(error));
    }
}

/** Performs a fail-closed protected single-document delete. */
export async function executeProtectedRelationDelete<TDocument>(
    host: ModelP0OperationsHost<TDocument>,
    filter: unknown,
    options: RelationProtectedDeleteOptions | undefined,
    force: boolean,
): Promise<RelationProtectedDeleteResult> {
    if (!isNonEmptyFilter(filter)) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'protected relation deletion requires a non-empty filter',
            [{ field: 'filter', reason: 'non-empty object required' }],
        );
    }

    const rawOptions = (options ?? {}) as Record<string, unknown>;
    if (rawOptions.includeRelations !== undefined || rawOptions.excludeRelations !== undefined) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'protected relation deletion cannot narrow the declared relation scan',
            [{ field: 'includeRelations/excludeRelations', reason: 'protected deletion always scans all declared relations' }],
        );
    }
    const usageOptions = normalizeRelationUsageOptions(options);
    const context = relationUsageContext(host);
    const deleteOptions = stripRelationUsageOptions(options);
    let target: Record<string, unknown> | null;
    try {
        const targetFilter = force || !host.softDeleteConfig?.enabled
            ? filter
            : { ...filter, [host.softDeleteConfig.field]: null };
        const rawTarget = await host.collection.findOne(
            targetFilter,
            relationTargetReadOptions(options, buildRelationUsageTargetProjection(host.modelName)),
        );
        target = typeof rawTarget === 'object' && rawTarget !== null && !Array.isArray(rawTarget)
            ? rawTarget as Record<string, unknown>
            : null;
    } catch (error) {
        const usage = createUnavailableRelationUsageReport(
            context,
            error instanceof Error ? error.message : String(error),
        );
        throw createError(
            ErrorCodes.RELATION_USAGE_UNAVAILABLE,
            'Unable to resolve a target for protected relation deletion',
            [{ coverage: usage.coverage, reason: usage.coverage.skipped[0]?.reason, skipped: usage.coverage.skipped }],
        );
    }

    const usage = await inspectDeclaredRelationUsage(context, target ? [target] : [], usageOptions);
    if (!usage.coverage.complete) {
        throw createError(
            ErrorCodes.RELATION_USAGE_UNAVAILABLE,
            'Declared relation usage coverage is incomplete; protected deletion was not performed',
            [{ coverage: usage.coverage, reason: 'incomplete relation usage coverage', skipped: usage.coverage.skipped }],
        );
    }
    if (usage.used) {
        throw createError(
            ErrorCodes.RELATION_IN_USE,
            'Protected deletion was blocked because declared relations still reference the target',
            [{ used: usage.used, usages: usage.usages, coverage: usage.coverage }],
        );
    }
    if (target && target._id === undefined) {
        throw createError(
            ErrorCodes.RELATION_USAGE_UNAVAILABLE,
            'Protected deletion target did not include an _id',
            [{ coverage: usage.coverage, reason: 'target _id missing', skipped: usage.coverage.skipped }],
        );
    }

    const deleteFilter = target ? { _id: target._id } : { _id: { $in: [] } };
    const result = force
        ? await host.forceDelete(deleteFilter, deleteOptions)
        : await host.deleteOne(deleteFilter, deleteOptions);
    return { result, usage };
}
