/**
 * ModelInstance helper functions.
 *
 * Pure functions for populate execution, populate config resolution, and
 * relation utilities — decoupled from the ModelInstance class to simplify testing.
 */
import { ErrorCodes, createError } from '../../core/errors';
import type {
    ModelDefinition,
    PopulateConfig,
    RelationConfig,
    ValidationResult,
} from '../../../types/model';
import { PopulatePromise, type ModelCollectionLike, type ModelRuntimeLike, type PopulatePath } from './populate-promise';
import { normalizePopulateConfig, normalizeRelationSelect } from './definition-validator';
import { Model } from './model-registry';
import { applySort, getByPath, groupBy, pickFields, serializeDocument, toKey, unique } from './model-utils';
import {
    applyModelInsertTimestamps,
    applyModelInsertVersion,
    applyModelReplaceTimestamps,
    applyModelReplaceVersion,
    assertModelOptimisticLockMatched,
    assertNumericExpectedVersion,
    mapModelSchemaValidationErrors,
    preserveModelReplaceCreatedAt,
    validateModelSchemaPayload,
    type ModelSchemaValidateFn,
    type ModelSchemaValidationContext,
    type ModelTimestampConfig,
    type ModelVersionConfig,
} from './model-write-helpers';

type PopulateContext<TDocument> = {
    relations: Map<string, RelationConfig>;
    runtime: ModelRuntimeLike;
    dbName: string;
    poolName?: string;
};

export type PopulateTraversalState = {
    depth: number;
    maxDepth: number;
    activeConfigs: WeakSet<object>;
};

const DEFAULT_POPULATE_MAX_DEPTH = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function cloneModelDefaultValue(value: unknown): unknown {
    if (value instanceof Date) {
        return new Date(value.getTime());
    }
    if (Array.isArray(value)) {
        return value.map((item) => cloneModelDefaultValue(item));
    }
    if (isPlainObject(value)) {
        const cloned: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            cloned[key] = cloneModelDefaultValue(item);
        }
        return cloned;
    }
    return value;
}

function resolvePopulateState(config: PopulateConfig, state?: PopulateTraversalState): PopulateTraversalState {
    const maxDepth = typeof config.maxDepth === 'number' && config.maxDepth >= 0
        ? config.maxDepth
        : state?.maxDepth ?? DEFAULT_POPULATE_MAX_DEPTH;
    const depth = state?.depth ?? 0;
    if (depth > maxDepth) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `populate maxDepth exceeded: ${maxDepth}`);
    }
    return {
        depth,
        maxDepth,
        activeConfigs: state?.activeConfigs ?? new WeakSet<object>(),
    };
}

function resolveRegisteredCollectionName<TDocument>(
    registered: { collectionName: string; definition: ModelDefinition<TDocument> } | undefined,
    fallback: string,
): string {
    if (!registered) {
        return fallback;
    }
    const definition = registered.definition as ModelDefinition<TDocument> & {
        collection?: string;
        name?: string;
    };
    return definition.collection ?? definition.name ?? registered.collectionName;
}

function flattenComparableValues(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => flattenComparableValues(entry));
    }
    return value === undefined || value === null ? [] : [value];
}

function resolveNestedPopulatePaths(value: PopulateConfig['populate']): PopulatePath[] {
    if (value === undefined) {
        return [];
    }
    const paths = Array.isArray(value) ? value : [value];
    for (const path of paths) {
        const valid = typeof path === 'string'
            || (typeof path === 'object' && path !== null && !Array.isArray(path) && Boolean((path as PopulateConfig).path));
        if (!valid) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'nested populate must be a string, array, or object');
        }
    }
    return paths as PopulatePath[];
}

function collectNestedLocalFields(
    relatedModel: { getRelations(): Record<string, RelationConfig> } | null,
    nestedPaths: PopulatePath[],
): string[] {
    if (!relatedModel) {
        return [];
    }
    const relations = relatedModel.getRelations();
    return unique(
        nestedPaths
            .map((path) => relations[normalizePopulateConfig(path).path]?.localField)
            .filter((field): field is string => Boolean(field)),
    ) as string[];
}

function dedupeDocuments<TDocument extends Record<string, unknown>>(documents: TDocument[]): TDocument[] {
    const seen = new Set<TDocument>();
    return documents.filter((document) => {
        if (seen.has(document)) {
            return false;
        }
        seen.add(document);
        return true;
    });
}

function rebuildPopulateMatches<TDocument extends Record<string, unknown>>(
    localValue: unknown,
    grouped: Map<string, TDocument[]>,
    sort?: Record<string, 1 | -1>,
): TDocument[] {
    const matches = flattenComparableValues(localValue)
        .flatMap((value) => grouped.get(toKey(value)) ?? []);
    const deduped = dedupeDocuments(matches);
    return sort ? applySort(deduped, sort) : deduped;
}

function projectPopulatedDocument(
    document: Record<string, unknown>,
    select: string[] | undefined,
    nestedPaths: PopulatePath[],
): Record<string, unknown> {
    if (!select) {
        return document;
    }
    const nestedRelationFields = nestedPaths.map((path) => normalizePopulateConfig(path).path);
    return pickFields(document, [...new Set([...select, ...nestedRelationFields])]);
}

export async function populateModelPath<TDocument>(
    context: PopulateContext<TDocument>,
    docs: Array<TDocument & Record<string, unknown>>,
    path: PopulatePath,
    traversalState?: PopulateTraversalState,
): Promise<Array<TDocument & Record<string, unknown>>> {
    const config = normalizePopulateConfig(path);
    const state = resolvePopulateState(config, traversalState);
    const configObject = typeof path === 'object' && path !== null ? path as object : null;
    if (configObject) {
        if (state.activeConfigs.has(configObject)) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, `populate cycle detected: ${config.path}`);
        }
        state.activeConfigs.add(configObject);
    }
    try {
    if (docs.length === 0) {
        return docs;
    }
    const relation = context.relations.get(config.path);
    if (!relation) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `Undefined relation: ${config.path}`);
    }

    const localValues = docs.map((doc) => getByPath(doc, relation.localField));
    const keys = unique(localValues.flatMap((value) => flattenComparableValues(value)));

    if (keys.length === 0) {
        for (const doc of docs) {
            (doc as Record<string, unknown>)[config.path] = relation.single ? null : [];
        }
        return docs;
    }

    const registered = Model.get(relation.from);
    const scope = {
        database: registered?.definition.connection?.database ?? context.dbName,
        pool: registered?.definition.connection?.pool ?? context.poolName,
    };
    const relatedCollectionName = resolveRegisteredCollectionName(registered, relation.from);
    const relatedCollection = context.runtime.scopedCollection(relatedCollectionName, scope);
    const relatedModel = Model.has(relation.from) ? context.runtime.scopedModel(relation.from, scope) : null;
    const nestedPaths = resolveNestedPopulatePaths(config.populate);
    const effectiveSelect = normalizeRelationSelect(config.select, { path: config.path })
        ?? normalizeRelationSelect(relation.select, { relation: config.path });
    const projectionFields = effectiveSelect
        ? [...new Set([
            ...effectiveSelect,
            relation.foreignField,
            '_id',
            ...collectNestedLocalFields(relatedModel, nestedPaths),
        ])]
        : [];
    const relatedDocs = await relatedCollection.find({
        [relation.foreignField]: { $in: keys },
        ...(config.match ?? {}),
    }, effectiveSelect ? {
        projection: Object.fromEntries(projectionFields.map((field) => [field, 1])),
    } : undefined);

    let hydrated: Array<Record<string, unknown>> = relatedModel
        ? relatedModel.hydrateDocuments(relatedDocs as Array<Record<string, unknown>>)
        : (relatedDocs as Array<Record<string, unknown>>).map((item) => ({ ...item }));

    if (nestedPaths.length > 0 && relatedModel) {
        if (state.depth + 1 > state.maxDepth) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, `populate maxDepth exceeded: ${state.maxDepth}`);
        }
        hydrated = await relatedModel.populateDocuments(hydrated, nestedPaths, {
            depth: state.depth + 1,
            maxDepth: state.maxDepth,
            activeConfigs: state.activeConfigs,
        });
    }

    const grouped = groupBy(hydrated, (item) => getByPath(item as Record<string, unknown>, relation.foreignField));
    for (const [index, doc] of docs.entries()) {
        let matches = rebuildPopulateMatches(localValues[index], grouped, config.sort);
        if (config.skip) {
            matches = matches.slice(config.skip);
        }
        if (config.limit !== undefined) {
            matches = matches.slice(0, config.limit);
        }
        const projectedMatches = matches.map((item) => projectPopulatedDocument(item, effectiveSelect, nestedPaths));
        (doc as Record<string, unknown>)[config.path] = relation.single ? (projectedMatches[0] ?? null) : projectedMatches;
    }

    return docs;
    } finally {
        if (configObject) {
            state.activeConfigs.delete(configObject);
        }
    }
}

type HydrateContext<TDocument> = {
    definition: ModelDefinition<TDocument>;
    v1InstanceMethods: Record<string, (...args: unknown[]) => unknown>;
    saveDocument: (document: TDocument & Record<string, unknown>) => Promise<TDocument & Record<string, unknown>>;
    removeDocument: (document: TDocument & Record<string, unknown>) => Promise<boolean>;
    validateDocument: (document?: unknown) => ValidationResult;
    populateDocument: (
        document: TDocument & Record<string, unknown>,
        paths: PopulatePath[],
    ) => Promise<(TDocument & Record<string, unknown>) | null>;
};

export function hydrateModelDocument<TDocument>(
    context: HydrateContext<TDocument>,
    doc: TDocument | null | undefined,
): (TDocument & Record<string, unknown>) | null {
    if (!doc || typeof doc !== 'object') {
        return null;
    }
    const hydrated = { ...(doc as Record<string, unknown>) } as TDocument & Record<string, unknown>;

    for (const [name, virtual] of Object.entries(context.definition.virtuals ?? {})) {
        Object.defineProperty(hydrated, name, {
            configurable: true,
            enumerable: true,
            get: () => virtual.get.call(hydrated),
            set: virtual.set ? (value) => virtual.set?.call(hydrated, value) : undefined,
        });
    }

    if (typeof (context.definition as Record<string, unknown>).methods === 'function') {
        for (const [name, method] of Object.entries(context.v1InstanceMethods)) {
            Object.defineProperty(hydrated, name, {
                configurable: true,
                enumerable: false,
                writable: false,
                value: (...args: unknown[]) => method.apply(hydrated, args),
            });
        }
    } else {
        for (const [name, method] of Object.entries(context.definition.methods ?? {})) {
            Object.defineProperty(hydrated, name, {
                configurable: true,
                enumerable: false,
                writable: false,
                value: (...args: unknown[]) => method.apply(hydrated, args),
            });
        }
    }

    Object.defineProperties(hydrated, {
        save: {
            configurable: true,
            enumerable: false,
            value: async () => context.saveDocument(hydrated),
        },
        remove: {
            configurable: true,
            enumerable: false,
            value: async () => context.removeDocument(hydrated),
        },
        validate: {
            configurable: true,
            enumerable: false,
            value: async () => context.validateDocument(hydrated),
        },
        populate: {
            configurable: true,
            enumerable: false,
            value: (path: PopulatePath | PopulatePath[]) => {
                const paths = Array.isArray(path) ? path : [path];
                return new PopulatePromise(
                    (resolvedPaths) => context.populateDocument(hydrated, resolvedPaths),
                    paths,
                );
            },
        },
        toObject: {
            configurable: true,
            enumerable: false,
            value: () => serializeDocument(hydrated),
        },
        toJSON: {
            configurable: true,
            enumerable: false,
            value: () => serializeDocument(hydrated),
        },
    });
    return hydrated;
}

type ModelValidationRuntime = {
    schemaError: Error | null;
    schemaCache: unknown;
    schemaValidateFn: ModelSchemaValidateFn;
};

export function validateModelDocument(
    runtime: ModelValidationRuntime,
    document?: unknown,
): ValidationResult {
    try {
        if (runtime.schemaError) {
            return {
                valid: false,
                errors: [{ field: '_schema', message: `Schema validation failed: ${runtime.schemaError.message}` }],
                data: document,
            };
        }
        if (!runtime.schemaCache || !runtime.schemaValidateFn) {
            return { valid: true, errors: [], data: document };
        }
        const result = runtime.schemaValidateFn(runtime.schemaCache, document ?? {});
        return {
            valid: result.valid,
            errors: mapModelSchemaValidationErrors(result.errors),
            data: result.data === undefined ? document : result.data,
        };
    } catch (error) {
        return {
            valid: false,
            errors: [{ field: '_schema', message: `Schema validation failed: ${error instanceof Error ? error.message : String(error)}` }],
            data: document,
        };
    }
}

export function applyModelDefaults<TDocument>(
    definition: ModelDefinition<TDocument>,
    document?: Record<string, unknown>,
): Record<string, unknown> {
    const payload = { ...(document ?? {}) };
    for (const [key, value] of Object.entries(definition.defaults ?? {})) {
        if (payload[key] === undefined) {
            const resolved = typeof value === 'function'
                ? (value as (context?: unknown, doc?: Record<string, unknown>) => unknown)(undefined, payload)
                : value;
            payload[key] = cloneModelDefaultValue(resolved);
        }
    }
    return payload;
}

/**
 * Build the complete-document write payload without materializing virtual accessors.
 * Virtuals remain available on hydrated documents but are not schema input or stored fields.
 */
function serializeModelWriteDocument(document: Record<string, unknown>): Record<string, unknown> {
    const payload = serializeDocument(document);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(document))) {
        if (descriptor.get || descriptor.set) {
            delete payload[key];
        }
    }
    return payload;
}

/**
 * Replace mutable document data with the normalized payload while preserving accessors and methods.
 */
function replaceModelDocumentData(
    document: Record<string, unknown>,
    payload: Record<string, unknown>,
): void {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(document))) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set || typeof descriptor.value === 'function') {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(payload, key) && descriptor.configurable !== false) {
            delete document[key];
        }
    }

    for (const [key, value] of Object.entries(payload)) {
        const descriptor = Object.getOwnPropertyDescriptor(document, key);
        if (descriptor?.get || descriptor?.set || descriptor?.writable === false) {
            continue;
        }
        document[key] = value;
    }
}

export async function saveModelDocument<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    document: TDocument & Record<string, unknown>,
    options: {
        timestampsConfig?: ModelTimestampConfig;
        versionConfig?: ModelVersionConfig;
        schemaValidationContext?: ModelSchemaValidationContext;
        nowFactory?: () => Date;
    } = {},
): Promise<TDocument & Record<string, unknown>> {
    const nowFactory = options.nowFactory ?? (() => new Date());
    let payload = serializeModelWriteDocument(document);
    if (payload._id !== undefined) {
        const documentId = payload._id;
        if (options.versionConfig?.enabled) {
            const expectedVersion = assertNumericExpectedVersion(payload[options.versionConfig.field], 'save');
            if (options.schemaValidationContext) {
                payload = preserveModelReplaceCreatedAt(
                    serializeModelWriteDocument(document),
                    validateModelSchemaPayload(options.schemaValidationContext, payload),
                    options.timestampsConfig ?? null,
                );
            }
            const replacement = applyModelReplaceVersion(
                applyModelReplaceTimestamps(payload, options.timestampsConfig ?? null, nowFactory),
                options.versionConfig,
                expectedVersion,
            ) as Record<string, unknown>;
            const result = await collection.replaceOne(
                { _id: documentId, [options.versionConfig.field]: expectedVersion },
                replacement,
                { upsert: false },
            );
            assertModelOptimisticLockMatched(result, options.versionConfig);
            replaceModelDocumentData(document, replacement);
            (document as Record<string, unknown>)._id = documentId;
            return document;
        }
        if (options.schemaValidationContext) {
            payload = preserveModelReplaceCreatedAt(
                serializeModelWriteDocument(document),
                validateModelSchemaPayload(options.schemaValidationContext, payload),
                options.timestampsConfig ?? null,
            );
        }
        const replacement = applyModelReplaceTimestamps(
            payload,
            options.timestampsConfig ?? null,
            nowFactory,
        ) as Record<string, unknown>;
        await collection.replaceOne({ _id: documentId }, replacement, { upsert: true });
        replaceModelDocumentData(document, replacement);
        (document as Record<string, unknown>)._id = documentId;
        return document;
    }
    if (options.schemaValidationContext) {
        payload = validateModelSchemaPayload(options.schemaValidationContext, payload);
    }
    payload = applyModelInsertVersion(
        applyModelInsertTimestamps(payload, options.timestampsConfig ?? null, nowFactory),
        options.versionConfig ?? null,
    );
    const result = await collection.insertOne(payload);
    replaceModelDocumentData(document, payload);
    (document as Record<string, unknown>)._id = result.insertedId;
    return document;
}

export async function removeModelDocument<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    document: TDocument & Record<string, unknown>,
): Promise<boolean> {
    if (document._id === undefined) {
        return false;
    }
    const result = await collection.deleteOne({ _id: document._id });
    return Boolean((result as { deletedCount?: number; }).deletedCount ?? (result as { acknowledged?: boolean; }).acknowledged);
}
