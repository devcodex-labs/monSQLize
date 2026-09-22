/**
 * Model soft-delete helper functions.
 *
 * Provides filter injection for soft-delete (appending a deletedAt: null constraint),
 * soft-delete marking, and document restore operations.
 */
import { PopulatePromise } from './populate-promise';
import type { PopulatePath, ModelCollectionLike } from './populate-promise';
import type { UpdateResult } from '../../../types/collection';
import { applyModelSoftDeleteFilter } from './model-write-helpers';

type SoftDeleteConfig = { enabled: boolean; field: string; type: string; ttl: number | null } | null;
type RestoreResult = Pick<UpdateResult, 'modifiedCount'> & Partial<UpdateResult>;

type SoftDeleteContext<TDocument> = {
    collection: ModelCollectionLike<TDocument>;
    softDeleteConfig: SoftDeleteConfig;
    hydrateDocuments: (docs: Array<TDocument | null | undefined>) => Array<TDocument & Record<string, unknown>>;
    hydrateDocument: (doc: TDocument | null | undefined) => (TDocument & Record<string, unknown>) | null;
    populateDocuments: (docs: Array<TDocument & Record<string, unknown>>, paths: PopulatePath[]) => Promise<Array<TDocument & Record<string, unknown>>>;
    populateSingle: (doc: (TDocument & Record<string, unknown>) | null, paths: PopulatePath[]) => Promise<(TDocument & Record<string, unknown>) | null>;
};

function deletedFilter(filter: unknown, softDeleteConfig: SoftDeleteConfig): unknown {
    if (!softDeleteConfig) {
        return filter ?? {};
    }
    return applyModelSoftDeleteFilter(filter, { onlyDeleted: true }, softDeleteConfig);
}

export function filterVisibleBySoftDelete<TDocument>(
    docs: Array<TDocument | null | undefined>, options: unknown, config: SoftDeleteConfig,
): TDocument[] {
    if (!config?.enabled) return docs.filter((doc): doc is TDocument => Boolean(doc));
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    applyModelSoftDeleteFilter({}, rawOptions, config);
    if (rawOptions.withDeleted) return docs.filter((doc): doc is TDocument => Boolean(doc));
    return docs.filter((doc): doc is TDocument => {
        if (!doc) return false;
        const value = (doc as Record<string, unknown>)[config.field];
        const deleted = config.type === 'boolean' ? value === true : value !== undefined && value !== null;
        return rawOptions.onlyDeleted ? deleted : !deleted;
    });
}

export function withSoftDeleteProjection(options: unknown, config: SoftDeleteConfig): { options: unknown; stripField: boolean } {
    if (!config?.enabled) return { options, stripField: false };
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const field = config.field;
    const projection = rawOptions.projection ?? rawOptions.project;
    if (Array.isArray(projection)) {
        if (projection.includes(field)) return { options, stripField: false };
        return { options: { ...rawOptions, projection: [...projection, field] }, stripField: true };
    }
    if (!projection || typeof projection !== 'object') return { options, stripField: false };
    const projectionRecord = projection as Record<string, unknown>;
    if (projectionRecord[field] === 1 || projectionRecord[field] === true) return { options, stripField: false };
    const inclusion = Object.entries(projectionRecord).some(([key, value]) => key !== '_id' && (value === 1 || value === true));
    const nextProjection = { ...projectionRecord };
    if (inclusion) nextProjection[field] = 1;
    else delete nextProjection[field];
    return { options: { ...rawOptions, projection: nextProjection }, stripField: true };
}

export function applySoftDeleteFindPageOptions(options: unknown, config: SoftDeleteConfig): unknown {
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    return { ...rawOptions, query: applyModelSoftDeleteFilter(rawOptions.query, rawOptions, config) };
}

export function applySoftDeleteAggregatePipeline(pipeline: unknown[] | undefined, options: unknown, config: SoftDeleteConfig): unknown[] {
    if (!config?.enabled) return pipeline ?? [];
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    if (rawOptions.withDeleted) return pipeline ?? [];
    const softDeleteMatch = applyModelSoftDeleteFilter({}, rawOptions, config) as Record<string, unknown>;
    const matchStage = { $match: softDeleteMatch };
    const stages = [...(pipeline ?? [])];
    if (stages.length > 0 && stages[0] && typeof stages[0] === 'object' && '$geoNear' in (stages[0] as Record<string, unknown>)) {
        return [stages[0], matchStage, ...stages.slice(1)];
    }
    return [matchStage, ...stages];
}

export function findWithDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
) {
    return new PopulatePromise(async (paths) => {
        const opts = { ...(options as Record<string, unknown> ?? {}), withDeleted: true };
        const docs = await context.collection.find(query, opts) as Array<TDocument | null | undefined>;
        return context.populateDocuments(context.hydrateDocuments(docs), paths);
    });
}

export function findOnlyDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
) {
    return new PopulatePromise(async (paths) => {
        const docs = await context.collection.find(deletedFilter(query, context.softDeleteConfig), options) as Array<TDocument | null | undefined>;
        return context.populateDocuments(context.hydrateDocuments(docs), paths);
    });
}

export function findOneWithDeletedDocument<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
) {
    return new PopulatePromise(async (paths) => {
        const opts = { ...(options as Record<string, unknown> ?? {}), withDeleted: true };
        const doc = await context.collection.findOne(query, opts) as TDocument | null | undefined;
        return context.populateSingle(context.hydrateDocument(doc), paths);
    });
}

export function findOneOnlyDeletedDocument<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
) {
    return new PopulatePromise(async (paths) => {
        const doc = await context.collection.findOne(deletedFilter(query, context.softDeleteConfig), options) as TDocument | null | undefined;
        return context.populateSingle(context.hydrateDocument(doc), paths);
    });
}

export function countWithDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
): Promise<number> {
    return context.collection.count(query, { ...(options as Record<string, unknown> ?? {}), withDeleted: true });
}

export function countOnlyDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    query?: unknown,
    options?: unknown,
): Promise<number> {
    return context.collection.count(
        deletedFilter(query, context.softDeleteConfig),
        { ...(options as Record<string, unknown> ?? {}), withDeleted: true },
    );
}

export function restoreSoftDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<RestoreResult> {
    const softDeleteConfig = context.softDeleteConfig;
    if (!softDeleteConfig?.enabled) {
        return Promise.resolve({ modifiedCount: 0 });
    }
    return context.collection.updateOne(
        deletedFilter(filter, softDeleteConfig),
        { $unset: { [softDeleteConfig.field]: 1 } },
        options,
    );
}

export function restoreManySoftDeletedDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<RestoreResult> {
    const softDeleteConfig = context.softDeleteConfig;
    if (!softDeleteConfig?.enabled) {
        return Promise.resolve({ modifiedCount: 0 });
    }
    return context.collection.updateMany(
        deletedFilter(filter, softDeleteConfig),
        { $unset: { [softDeleteConfig.field]: 1 } },
        options,
    );
}

export function forceDeleteDocument<TDocument>(
    context: SoftDeleteContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    return context.collection.deleteOne(filter, options);
}

export function forceDeleteManyDocuments<TDocument>(
    context: SoftDeleteContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    return context.collection.deleteMany(filter, options);
}
