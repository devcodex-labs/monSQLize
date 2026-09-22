/**
 * Model write operation helpers.
 *
 * Encapsulates pre/post-processing logic related to model semantics for
 * insertOne, updateOne, replaceOne, deleteOne, and other write paths.
 */
import { ErrorCodes, createError } from '../../core/errors';
import type { Readable } from 'node:stream';
import type { ModelMutationContext } from './model-mutation-orchestrator';

export async function* iterateModelCandidateBatches<TDocument>(
    context: ModelMutationContext<TDocument>, filter: unknown, options: unknown, batchSize: number,
): AsyncGenerator<Array<Record<string, unknown>>> {
    const lookupOptions = buildModelVersionLookupOptions(options, {
        _id: 1, [context.versionConfig?.field ?? '__v']: 1,
    });
    const stream = context.collection.stream(filter, {
        ...lookupOptions, sort: { _id: 1 }, batchSize,
    }) as Readable & AsyncIterable<Record<string, unknown>>;
    let batch: Array<Record<string, unknown>> = [];
    try {
        for await (const document of stream) {
            batch.push(document);
            if (batch.length === batchSize) {
                yield batch;
                batch = [];
            }
        }
        if (batch.length > 0) yield batch;
    } finally {
        stream.destroy();
    }
}

export function buildStrictCandidateFilter(filter: unknown, id: unknown, versionField: string, expectedVersion: number): Record<string, unknown> {
    return { $and: [filter ?? {}, { _id: id }, { [versionField]: expectedVersion }] };
}

export async function isModelVersionConflict<TDocument>(
    context: ModelMutationContext<TDocument>, id: unknown, versionField: string, expectedVersion: number, options: unknown,
): Promise<boolean> {
    const current = await context.collection.findOne(
        { _id: id }, buildModelVersionLookupOptions(options, { [versionField]: 1 }),
    ) as Record<string, unknown> | null;
    return current !== null && current !== undefined && current[versionField] !== expectedVersion;
}

export type ModelTimestampConfig = {
    createdAt: string | false;
    updatedAt: string | false;
} | null;

export type ModelSoftDeleteConfig = {
    enabled: boolean;
    field: string;
    type: string;
    ttl: number | null;
} | null;

export type ModelVersionConfig = {
    enabled: boolean;
    field: string;
    updateMany: ModelVersionUpdateManyMode;
} | null;

export type ModelVersionUpdateManyMode = 'counter' | 'strict' | 'off';

export type ModelHookOperation = 'find' | 'insert' | 'update' | 'delete';
export type ModelHookPhase = 'before' | 'after';

type ModelV1HookHandler = (...args: unknown[]) => unknown;

export type ModelV1HooksFactory = ((
    model: unknown,
) => Record<ModelHookOperation, { before?: ModelV1HookHandler; after?: ModelV1HookHandler } | undefined>) | null;

export type ModelSchemaValidationIssue = {
    path?: string;
    message?: string;
    keyword?: string;
};

type ModelSchemaValidationResult = {
    valid: boolean;
    data?: unknown;
    errors?: ModelSchemaValidationIssue[];
};

export type ModelSchemaValidateFn = ((schema: unknown, document: unknown) => ModelSchemaValidationResult) | null;

export type ModelSchemaValidationContext = {
    validateEnabled: boolean;
    schemaCache: unknown;
    schemaValidateFn: ModelSchemaValidateFn;
    schemaError?: Error | null;
};

type UpdatePipelineStage = Record<string, unknown>;

type VersionLookupCollection = {
    findOne(query?: unknown, options?: unknown): Promise<unknown>;
};

const VERSION_LOOKUP_OPTION_KEYS = [
    'session',
    'readConcern',
    'readPreference',
    'maxTimeMS',
    'collation',
    'hint',
    'comment',
    'let',
    'timeoutMS',
    'signal',
] as const;

function isOperatorObject(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stripModelVersionOptions(options: unknown): unknown {
    if (options === undefined) {
        return undefined;
    }
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const {
        expectedVersion: _expectedVersion,
        version: _version,
        versionMode: _versionMode,
        ...driverOptions
    } = rawOptions;
    void _expectedVersion;
    void _version;
    void _versionMode;
    return driverOptions;
}

export function buildModelVersionLookupOptions(
    options: unknown,
    projection: Record<string, unknown>,
): Record<string, unknown> {
    const rawOptions = stripModelVersionOptions(options) as Record<string, unknown> | undefined;
    const lookupOptions: Record<string, unknown> = {};
    if (rawOptions) {
        for (const key of VERSION_LOOKUP_OPTION_KEYS) {
            if (rawOptions[key] !== undefined) {
                lookupOptions[key] = rawOptions[key];
            }
        }
    }
    return {
        ...lookupOptions,
        projection,
    };
}

export function assertNumericExpectedVersion(expectedVersion: unknown, operation = 'write'): number {
    if (typeof expectedVersion !== 'number' || !Number.isFinite(expectedVersion)) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            `Model optimistic locking requires a numeric expectedVersion for ${operation}.`,
        );
    }
    return expectedVersion;
}

function withModelErrorMetadata<TError extends Error>(
    error: TError,
    metadata: Record<string, unknown>,
): TError & Record<string, unknown> {
    return Object.assign(error, metadata);
}

export async function runModelV1Hook(
    hooksFactory: ModelV1HooksFactory,
    model: unknown,
    operation: ModelHookOperation,
    phase: ModelHookPhase,
    context: Record<string, unknown>,
    ...args: unknown[]
): Promise<unknown> {
    if (!hooksFactory) {
        return undefined;
    }
    const hooks = hooksFactory(model);
    const operationHooks = hooks[operation];
    if (!operationHooks) {
        return undefined;
    }
    const hook = operationHooks[phase];
    if (typeof hook !== 'function') {
        return undefined;
    }
    return hook(context, ...args);
}

export function mapModelSchemaValidationErrors(
    errors: ModelSchemaValidationIssue[] = [],
): Array<{ field: string; message: string }> {
    return errors.map((error) => ({
        field: error.path ?? '',
        message: error.message ?? '',
    }));
}

export function validateModelSchemaPayload(
    context: ModelSchemaValidationContext,
    document: Record<string, unknown>,
    options?: Record<string, unknown>,
    metadata: Record<string, unknown> = {},
): Record<string, unknown> {
    if (context.schemaError) {
        throw withModelErrorMetadata(
            createError(ErrorCodes.VALIDATION_ERROR, `Schema initialization failed: ${context.schemaError.message}`),
            { errors: [{ field: '_schema', message: context.schemaError.message }], ...metadata },
        );
    }
    const shouldValidate = context.validateEnabled || options?.validate === true;
    if (!shouldValidate) {
        return document;
    }
    if (options?.skipValidation) {
        return document;
    }
    if (!context.schemaCache || !context.schemaValidateFn) {
        return document;
    }
    const result = context.schemaValidateFn(context.schemaCache, document);
    if (!result.valid) {
        const errors = mapModelSchemaValidationErrors(result.errors);
        const fields = [...new Set(errors.map((item) => item.field).filter(Boolean))];
        const summary = fields.length > 0 ? ` (${fields.join(', ')})` : '';
        throw withModelErrorMetadata(
            createError(ErrorCodes.VALIDATION_ERROR, `Schema validation failed${summary}`),
            {
                errors,
                ...metadata,
            },
        );
    }

    const normalized = result.data === undefined ? document : result.data;
    if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized)) {
        const errors = [{
            field: '_schema',
            message: 'Schema validation returned non-object data for a complete-document write.',
        }];
        throw withModelErrorMetadata(
            createError(ErrorCodes.VALIDATION_ERROR, errors[0].message),
            {
                errors,
                ...metadata,
            },
        );
    }
    return normalized as Record<string, unknown>;
}

export function applyModelSoftDeleteFilter(
    query: unknown,
    options: unknown,
    softDeleteConfig: ModelSoftDeleteConfig,
): unknown {
    if (!softDeleteConfig?.enabled) {
        return query ?? {};
    }
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const resolvedQuery = (query ?? {}) as Record<string, unknown>;
    if (resolvedOptions.withDeleted !== undefined && typeof resolvedOptions.withDeleted !== 'boolean') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'withDeleted must be a boolean.');
    }
    if (resolvedOptions.onlyDeleted !== undefined && typeof resolvedOptions.onlyDeleted !== 'boolean') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'onlyDeleted must be a boolean.');
    }
    if (Object.prototype.hasOwnProperty.call(resolvedQuery, softDeleteConfig.field)) {
        return resolvedQuery;
    }
    if (resolvedOptions.withDeleted) {
        return resolvedQuery;
    }
    if (resolvedOptions.onlyDeleted) {
        return { ...resolvedQuery, [softDeleteConfig.field]: softDeleteConfig.type === 'boolean' ? true : { $ne: null } };
    }
    return { ...resolvedQuery, [softDeleteConfig.field]: softDeleteConfig.type === 'boolean' ? { $ne: true } : null };
}

export function applyModelInsertTimestamps(
    document: Record<string, unknown>,
    timestampsConfig: ModelTimestampConfig,
    nowFactory: () => Date,
): Record<string, unknown> {
    if (!timestampsConfig) {
        return document;
    }
    const now = nowFactory();
    const result = { ...document };
    if (timestampsConfig.createdAt !== false && result[timestampsConfig.createdAt] === undefined) {
        result[timestampsConfig.createdAt] = now;
    }
    if (timestampsConfig.updatedAt !== false && result[timestampsConfig.updatedAt] === undefined) {
        result[timestampsConfig.updatedAt] = now;
    }
    return result;
}

export function applyModelInsertVersion(
    document: Record<string, unknown>,
    versionConfig: ModelVersionConfig,
): Record<string, unknown> {
    if (!versionConfig?.enabled || document[versionConfig.field] !== undefined) {
        return document;
    }
    return { ...document, [versionConfig.field]: 0 };
}

export function applyModelUpdateTimestamps(
    update: unknown,
    timestampsConfig: ModelTimestampConfig,
    nowFactory: () => Date,
): unknown {
    if (!timestampsConfig || timestampsConfig.updatedAt === false) {
        return update;
    }
    if (Array.isArray(update)) {
        return [
            ...update,
            { $set: { [timestampsConfig.updatedAt]: nowFactory() } },
        ];
    }
    const resolvedUpdate = (update ?? {}) as Record<string, unknown>;
    const $set = {
        ...((resolvedUpdate.$set ?? {}) as Record<string, unknown>),
        [timestampsConfig.updatedAt]: nowFactory(),
    };
    return { ...resolvedUpdate, $set };
}

export function applyModelVersionIncrement(
    update: unknown,
    versionConfig: ModelVersionConfig,
): unknown {
    if (!versionConfig?.enabled) {
        return update;
    }
    if (Array.isArray(update)) {
        const versionPath = `$${versionConfig.field}`;
        return [
            ...update,
            {
                $set: {
                    [versionConfig.field]: {
                        $add: [
                            { $ifNull: [versionPath, 0] },
                            1,
                        ],
                    },
                },
            },
        ];
    }
    const resolvedUpdate = (update ?? {}) as Record<string, unknown>;
    const $inc = (resolvedUpdate.$inc ?? {}) as Record<string, unknown>;
    if ($inc[versionConfig.field] !== undefined) {
        return update;
    }
    return {
        ...resolvedUpdate,
        $inc: {
            ...$inc,
            [versionConfig.field]: 1,
        },
    };
}

export function resolveModelOptimisticLock(
    filter: unknown,
    options: unknown,
    versionConfig: ModelVersionConfig,
): { filter: unknown; expectedVersion: unknown; driverOptions: unknown } {
    if (!versionConfig?.enabled) {
        return { filter, expectedVersion: undefined, driverOptions: options };
    }
    const resolvedFilter = { ...((filter as Record<string, unknown>) ?? {}) };
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const expectedVersion = rawOptions.expectedVersion ?? rawOptions.version ?? resolvedFilter[versionConfig.field];
    const { expectedVersion: _expectedVersion, version: _version, ...driverOptions } = rawOptions;
    void _expectedVersion;
    void _version;

    if (expectedVersion === undefined) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            `Model optimistic locking requires expectedVersion or ${versionConfig.field} in the filter.`,
        );
    }
    if (resolvedFilter[versionConfig.field] === undefined) {
        resolvedFilter[versionConfig.field] = expectedVersion;
    }
    return {
        filter: resolvedFilter,
        expectedVersion,
        driverOptions: options === undefined ? undefined : driverOptions,
    };
}

export async function resolveModelOptimisticLockAsync(
    collection: VersionLookupCollection,
    filter: unknown,
    options: unknown,
    versionConfig: ModelVersionConfig,
    operation: string,
): Promise<{ filter: unknown; expectedVersion: number; driverOptions: unknown }> {
    if (!versionConfig?.enabled) {
        return { filter, expectedVersion: 0, driverOptions: options };
    }
    const resolvedFilter = { ...((filter as Record<string, unknown>) ?? {}) };
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    let expectedVersion = rawOptions.expectedVersion ?? rawOptions.version ?? resolvedFilter[versionConfig.field];

    if (expectedVersion === undefined) {
        const id = resolvedFilter._id;
        if (id === undefined || isOperatorObject(id)) {
            throw createError(
                ErrorCodes.INVALID_ARGUMENT,
                `Model optimistic locking requires expectedVersion, ${versionConfig.field} in the filter, or a direct _id filter for automatic version lookup.`,
            );
        }
        const current = await collection.findOne(
            { _id: id },
            buildModelVersionLookupOptions(options, { [versionConfig.field]: 1 }),
        ) as Record<string, unknown> | null | undefined;
        if (!current) {
            throw createError(ErrorCodes.WRITE_CONFLICT, 'Model optimistic lock conflict.');
        }
        expectedVersion = current[versionConfig.field];
    }

    const numericVersion = assertNumericExpectedVersion(expectedVersion, operation);
    if (resolvedFilter[versionConfig.field] === undefined) {
        resolvedFilter[versionConfig.field] = numericVersion;
    }
    return {
        filter: resolvedFilter,
        expectedVersion: numericVersion,
        driverOptions: stripModelVersionOptions(options),
    };
}

export function assertModelOptimisticLockMatched(
    result: { matchedCount?: number } | null | undefined,
    versionConfig: ModelVersionConfig,
): void {
    if (!versionConfig?.enabled) {
        return;
    }
    if ((result?.matchedCount ?? 0) === 0) {
        throw createError(ErrorCodes.WRITE_CONFLICT, 'Model optimistic lock conflict.');
    }
}

export function assertModelOptimisticLockDocument(
    document: unknown,
    versionConfig: ModelVersionConfig,
): void {
    if (!versionConfig?.enabled) {
        return;
    }
    if (document == null) {
        throw createError(ErrorCodes.WRITE_CONFLICT, 'Model optimistic lock conflict.');
    }
}

export function applyModelReplaceVersion(
    replacement: unknown,
    versionConfig: ModelVersionConfig,
    expectedVersion: unknown,
): unknown {
    if (!versionConfig?.enabled) {
        return replacement;
    }
    const numericVersion = assertNumericExpectedVersion(expectedVersion, 'replaceOne');
    const resolvedReplacement = { ...((replacement as Record<string, unknown>) ?? {}) };
    resolvedReplacement[versionConfig.field] = numericVersion + 1;
    return resolvedReplacement;
}

export function resolveModelUpdateManyVersionMode(
    options: unknown,
    versionConfig: ModelVersionConfig,
): { mode: ModelVersionUpdateManyMode; driverOptions: unknown } {
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const requested = rawOptions.versionMode;
    if (
        requested !== undefined
        && requested !== 'counter'
        && requested !== 'strict'
        && requested !== 'off'
    ) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'versionMode must be "counter", "strict", or "off".');
    }
    return {
        mode: versionConfig?.enabled ? (requested as ModelVersionUpdateManyMode | undefined ?? versionConfig.updateMany) : 'off',
        driverOptions: stripModelVersionOptions(options),
    };
}

export function assertModelVersionedMultiUpdateAllowed(versionConfig: ModelVersionConfig, operation: string): void {
    if (!versionConfig?.enabled) {
        return;
    }
    throw createError(
        ErrorCodes.INVALID_OPERATION,
        `${operation} is not supported for versioned models because optimistic locking is single-document only.`,
    );
}

export function applyModelUpsertTimestamps(
    update: unknown,
    timestampsConfig: ModelTimestampConfig,
    nowFactory: () => Date,
): unknown {
    if (!timestampsConfig) {
        return update;
    }
    const now = nowFactory();
    if (Array.isArray(update)) {
        const $set: UpdatePipelineStage = {};
        if (timestampsConfig.updatedAt !== false) {
            $set[timestampsConfig.updatedAt] = now;
        }
        if (timestampsConfig.createdAt !== false) {
            $set[timestampsConfig.createdAt] = { $ifNull: [`$${timestampsConfig.createdAt}`, now] };
        }
        return Object.keys($set).length > 0
            ? [...update, { $set }]
            : update;
    }
    const resolvedUpdate = (update ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = { ...resolvedUpdate };
    if (timestampsConfig.updatedAt !== false) {
        result.$set = {
            ...((resolvedUpdate.$set ?? {}) as Record<string, unknown>),
            [timestampsConfig.updatedAt]: now,
        };
    }
    if (timestampsConfig.createdAt !== false) {
        const $setOnInsert = {
            ...((resolvedUpdate.$setOnInsert ?? {}) as Record<string, unknown>),
        };
        if ($setOnInsert[timestampsConfig.createdAt] === undefined) {
            $setOnInsert[timestampsConfig.createdAt] = now;
        }
        result.$setOnInsert = $setOnInsert;
    }
    return result;
}

export function applyModelReplaceTimestamps(
    replacement: unknown,
    timestampsConfig: ModelTimestampConfig,
    nowFactory: () => Date,
): unknown {
    if (!timestampsConfig || timestampsConfig.updatedAt === false) {
        return replacement;
    }
    const resolvedReplacement = (replacement ?? {}) as Record<string, unknown>;
    if (resolvedReplacement[timestampsConfig.updatedAt] !== undefined) {
        return resolvedReplacement;
    }
    return {
        ...resolvedReplacement,
        [timestampsConfig.updatedAt]: nowFactory(),
    };
}

/**
 * Preserve an existing caller-provided creation timestamp across schema normalization.
 * The updated timestamp is still generated afterward by applyModelReplaceTimestamps().
 */
export function preserveModelReplaceCreatedAt(
    original: Record<string, unknown>,
    normalized: Record<string, unknown>,
    timestampsConfig: ModelTimestampConfig,
): Record<string, unknown> {
    if (!timestampsConfig || timestampsConfig.createdAt === false) {
        return normalized;
    }
    const field = timestampsConfig.createdAt;
    if (normalized[field] !== undefined || original[field] === undefined) {
        return normalized;
    }
    return {
        ...normalized,
        [field]: original[field],
    };
}
