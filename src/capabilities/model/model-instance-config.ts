/**
 * ModelInstance configuration resolution helpers.
 *
 * Responsible for deriving collection name, database name, connection pool config,
 * and other ModelInstance initialization parameters from the registered model definition
 * and runtime options.
 */
import type {
    ModelAutoIndexOptions,
    ModelDeclaredIndex,
    ModelDefinition,
    ModelEnsureIndexesOptions,
    ModelIndexEnsureResult,
    ModelIndexEnsureSummary,
} from '../../../types/model';
import type { ModelCollectionLike } from './populate-promise';
import { ErrorCodes, createError } from '../../core/errors';
import { _makeValidatingDslFn, type SchemaDslEngine } from './schema-dsl';
import { runWithModelWriteSource } from '../write-path-policy';

type ModelHooksFactory = (
    model: unknown,
) => Record<string, { before?: (...args: unknown[]) => unknown; after?: (...args: unknown[]) => unknown }>;

type ModelMethodsFactory = (
    instance: unknown,
) => {
    instance?: Record<string, (...args: unknown[]) => unknown>;
    static?: Record<string, (...args: unknown[]) => unknown>;
};

type ModelWarningLogger = { warn?: (...args: unknown[]) => void };

export type ModelTimestampsConfig = { createdAt: string | false; updatedAt: string | false };
export type ModelSoftDeleteConfig = { enabled: boolean; field: string; type: string; ttl: number | null };
export type ModelVersionUpdateManyMode = 'counter' | 'strict' | 'off';
export type ModelVersionConfig = { enabled: boolean; field: string; updateMany: ModelVersionUpdateManyMode };

type ModelDefinitionCompat<TDocument> = ModelDefinition<TDocument> & {
    enums?: Record<string, string>;
    statics?: Record<string, (...args: unknown[]) => unknown>;
    schema?: ((dslFn: unknown) => unknown) | Record<string, unknown>;
    hooks?: ModelHooksFactory;
    methods?: ModelMethodsFactory;
    indexes?: Array<{ key: unknown } & Record<string, unknown>>;
    options?: {
        validate?: boolean;
        timestamps?: true | false | {
            createdAt?: string | false;
            updatedAt?: string | false;
        };
        softDelete?: true | {
            enabled?: boolean;
            field?: string;
            type?: string;
            ttl?: number | null;
        };
        version?: true | {
            enabled?: boolean;
            field?: string;
            updateMany?: ModelVersionUpdateManyMode;
        };
        autoIndex?: ModelAutoIndexOptions;
    };
};

type ModelIndexTask = {
    status: 'pending' | 'fulfilled' | 'failed';
    promise: Promise<void>;
    error?: unknown;
};

type ModelIndexScheduleOptions = {
    runtime?: object;
    dbName?: string;
    poolName?: string;
    collectionName?: string;
    autoIndex?: ModelAutoIndexOptions;
};

type ModelIndexTaskScope = {
    dbName: string;
    poolName: string;
    collectionName: string;
};

type ResolvedModelAutoIndexOptions = {
    enabled: boolean;
    emitEvents: boolean;
};

type ModelIndexEnsureOptions = ModelEnsureIndexesOptions & ModelIndexScheduleOptions;

const runtimeModelIndexTasks = new WeakMap<object, Map<string, ModelIndexTask>>();
const fallbackModelIndexTasks = new Map<string, ModelIndexTask>();

function toCompatDefinition<TDocument>(definition: ModelDefinition<TDocument>): ModelDefinitionCompat<TDocument> {
    return definition as ModelDefinitionCompat<TDocument>;
}

function stableIndexStringify(value: unknown, mode: 'options' | 'key' = 'options'): string {
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableIndexStringify(item, mode)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, current]) => current !== undefined);
        if (mode === 'options') entries.sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, current]) => `${JSON.stringify(key)}:${stableIndexStringify(current, key === 'key' ? 'key' : mode)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

function getIndexOptionName(options: Record<string, unknown>): string | undefined {
    return typeof options.name === 'string' && options.name.length > 0 ? options.name : undefined;
}

function summarizeIndexError(error: unknown): { name?: string; message: string; code?: unknown } {
    if (error instanceof Error) {
        const record = error as Error & { code?: unknown; codeName?: unknown };
        return {
            name: error.name,
            message: error.message,
            code: record.code ?? record.codeName,
        };
    }
    return {
        message: String(error),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getExistingIndexKey(index: Record<string, unknown>): unknown {
    return index.key;
}

function declaredOptionEntries(options: Record<string, unknown>): Array<[string, unknown]> {
    return Object.entries(options).filter(([name, value]) => {
        if (value === undefined) return false;
        if (name === 'background') return false;
        return true;
    });
}

function indexOptionsMatch(existing: Record<string, unknown>, declared: ModelDeclaredIndex): boolean {
    if (stableIndexStringify(getExistingIndexKey(existing), 'key') !== stableIndexStringify(declared.key, 'key')) {
        return false;
    }
    for (const [name, value] of declaredOptionEntries(declared.options)) {
        const existingValue = existing[name];
        if (value === false && existingValue === undefined) {
            continue;
        }
        if (stableIndexStringify(existingValue) !== stableIndexStringify(value)) {
            return false;
        }
    }
    return true;
}

function findExistingIndexByName(
    existingIndexes: Record<string, unknown>[],
    name: string | undefined,
): Record<string, unknown> | undefined {
    if (!name) return undefined;
    return existingIndexes.find((index) => index.name === name);
}

function findExistingIndexByKey(
    existingIndexes: Record<string, unknown>[],
    key: unknown,
): Record<string, unknown> | undefined {
    const fingerprint = stableIndexStringify(key, 'key');
    return existingIndexes.find((index) => stableIndexStringify(getExistingIndexKey(index), 'key') === fingerprint);
}

function createIndexEnsureError(
    message: string,
    result: Pick<ModelIndexEnsureResult, 'namespace' | 'conflicts' | 'failed'>,
    cause?: Error,
): Error {
    return createError(ErrorCodes.MONGODB_ERROR, message, [result], cause);
}

export function resolveModelAutoIndexOptions<TDocument>(
    definition: ModelDefinition<TDocument>,
    runtimeAutoIndex?: ModelAutoIndexOptions,
): ResolvedModelAutoIndexOptions {
    const modelAutoIndex = toCompatDefinition(definition).options?.autoIndex;
    const value = modelAutoIndex ?? runtimeAutoIndex;
    if (value === false) {
        return { enabled: false, emitEvents: true };
    }
    if (value && typeof value === 'object') {
        return {
            enabled: value.enabled !== false,
            emitEvents: value.emitEvents !== false,
        };
    }
    return { enabled: true, emitEvents: true };
}

function getIndexTaskRegistry(runtime: object | undefined): Map<string, ModelIndexTask> {
    if (!runtime) {
        return fallbackModelIndexTasks;
    }
    let registry = runtimeModelIndexTasks.get(runtime);
    if (!registry) {
        registry = new Map<string, ModelIndexTask>();
        runtimeModelIndexTasks.set(runtime, registry);
    }
    return registry;
}

function resolveIndexTaskScope<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    options: ModelIndexScheduleOptions | undefined,
): ModelIndexTaskScope {
    try {
        const namespace = collection.getNamespace();
        return {
            dbName: options?.dbName ?? namespace.db,
            poolName: options?.poolName ?? 'default',
            collectionName: options?.collectionName ?? namespace.collection,
        };
    } catch {
        return {
            dbName: options?.dbName ?? 'default',
            poolName: options?.poolName ?? 'default',
            collectionName: options?.collectionName ?? 'unknown',
        };
    }
}

function toIndexNamespace(scope: ModelIndexTaskScope): ModelIndexEnsureResult['namespace'] {
    return {
        db: scope.dbName,
        collection: scope.collectionName,
        poolName: scope.poolName,
    };
}

function emitIndexFailure(
    runtime: object | undefined,
    payload: Record<string, unknown>,
    emitEvents: boolean,
): void {
    if (!emitEvents) {
        return;
    }
    const emitter = runtime as { emit?: (event: string, payload: unknown) => void } | undefined;
    emitter?.emit?.('model-index-error', payload);
}

function warnIndexFailure(runtime: object | undefined, taskKey: string, error: unknown): void {
    const logger = runtime as { logger?: { warn?: (...args: unknown[]) => void } } | undefined;
    logger?.logger?.warn?.('[MonSQLize] model index creation failed', {
        taskKey,
        error: error instanceof Error ? error.message : String(error),
    });
}

function getIndexEnsureTaskKey(scope: ModelIndexTaskScope, declaredIndexes: ModelDeclaredIndex[]): string {
    // The declared-set fingerprint lets a redefined model schedule a fresh preflight.
    const declaredSetFingerprint = stableIndexStringify(declaredIndexes.map((declaredIndex) => declaredIndex.fingerprint));
    return `${scope.poolName}:${scope.dbName}:${scope.collectionName}:ensure:${declaredSetFingerprint}`;
}

function hasIndexEnsureIssues(result: ModelIndexEnsureResult): boolean {
    return result.conflicts.length > 0 || result.failed.length > 0;
}

function warnIndexEnsureIssues(
    runtime: object | undefined,
    taskKey: string,
    result: ModelIndexEnsureResult,
): void {
    const logger = runtime as { logger?: { warn?: (...args: unknown[]) => void } } | undefined;
    const message = result.failed.length > 0
        ? '[MonSQLize] model index creation failed'
        : '[MonSQLize] model index ensure conflicts detected';
    logger?.logger?.warn?.(message, {
        taskKey,
        namespace: result.namespace,
        conflicts: result.conflicts,
        failed: result.failed,
        counts: {
            declared: result.declared.length,
            existing: result.existing.length,
            missing: result.missing.length,
            created: result.created.length,
            conflicts: result.conflicts.length,
            failed: result.failed.length,
            skipped: result.skipped.length,
        },
    });
}

function emitIndexEnsureIssues(
    runtime: object | undefined,
    taskKey: string,
    result: ModelIndexEnsureResult,
    emitEvents: boolean,
): void {
    if (!hasIndexEnsureIssues(result)) {
        return;
    }
    const firstFailure = result.failed[0];
    const firstConflict = result.conflicts[0];
    const firstDeclared = firstFailure?.declared ?? firstConflict?.declared;
    emitIndexFailure(runtime, {
        namespace: result.namespace,
        taskKey,
        source: firstDeclared?.source,
        key: firstDeclared?.key,
        options: firstDeclared?.options,
        conflicts: result.conflicts,
        failed: result.failed,
        result,
        error: firstFailure?.error ?? { message: 'Model index conflicts detected.' },
    }, emitEvents);
}

function scheduleModelIndexEnsureTask<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    definition: ModelDefinition<TDocument>,
    softDeleteConfig: ModelSoftDeleteConfig | null,
    declaredIndexes: ModelDeclaredIndex[],
    emitEvents: boolean,
    options?: ModelIndexScheduleOptions,
): void {
    const scope = resolveIndexTaskScope(collection, options);
    const taskKey = getIndexEnsureTaskKey(scope, declaredIndexes);
    const registry = getIndexTaskRegistry(options?.runtime);
    const existing = registry.get(taskKey);
    if (existing && existing.status !== 'failed') {
        return;
    }

    const task: ModelIndexTask = {
        status: 'pending',
        promise: new Promise((resolve) => {
            setImmediate(() => {
                Promise.resolve()
                    .then(() => ensureModelIndexesForCollection(collection, definition, softDeleteConfig, {
                        ...options,
                        dryRun: false,
                        throwOnError: false,
                    }))
                    .then((result) => {
                        if (hasIndexEnsureIssues(result)) {
                            warnIndexEnsureIssues(options?.runtime, taskKey, result);
                            emitIndexEnsureIssues(options?.runtime, taskKey, result, emitEvents);
                        }
                        if (result.failed.length > 0) {
                            task.status = 'failed';
                            task.error = result.failed;
                        } else {
                            task.status = 'fulfilled';
                            task.error = undefined;
                        }
                        resolve();
                    })
                    .catch((error: unknown) => {
                        task.status = 'failed';
                        task.error = error;
                        warnIndexFailure(options?.runtime, taskKey, error);
                        emitIndexFailure(options?.runtime, {
                            namespace: toIndexNamespace(scope),
                            taskKey,
                            error: summarizeIndexError(error),
                        }, emitEvents);
                        resolve();
                    });
            });
        }),
    };
    registry.set(taskKey, task);
}

export function getModelEnums<TDocument>(definition: ModelDefinition<TDocument>): Record<string, string> {
    return toCompatDefinition(definition).enums ?? {};
}

export function attachModelStatics<TDocument>(target: object, definition: ModelDefinition<TDocument>): void {
    const compat = toCompatDefinition(definition);
    if (typeof compat.methods === 'function') {
        return;
    }
    for (const [name, handler] of Object.entries(compat.statics ?? {})) {
        if (typeof handler === 'function' && !(name in target)) {
            Object.defineProperty(target, name, {
                configurable: true,
                enumerable: false,
                writable: false,
                value: (...args: unknown[]) => handler.apply(target, args),
            });
        }
    }
}

export function buildModelSchemaState<TDocument>(
    definition: ModelDefinition<TDocument>,
    schemaEngine?: Pick<SchemaDslEngine, 'dsl'> | null,
): {
    schemaCache: unknown;
    schemaError: Error | null;
} {
    const compat = toCompatDefinition(definition);
    if (typeof compat.schema !== 'function') {
        return {
            schemaCache: compat.schema ?? null,
            schemaError: null,
        };
    }

    if (!schemaEngine?.dsl) {
        return {
            schemaCache: null,
            schemaError: null,
        };
    }

    const validatingDsl = _makeValidatingDslFn(schemaEngine.dsl);
    const schemaFactory = compat.schema as (this: ModelDefinition<TDocument>, dsl: typeof validatingDsl) => unknown;
    try {
        return {
            schemaCache: schemaFactory.call(definition, validatingDsl),
            schemaError: null,
        };
    } catch (error) {
        const schemaError = error instanceof Error ? error : new Error(String(error));
        if (schemaError instanceof TypeError && schemaError.message.includes('[schema] Invalid type')) {
            throw schemaError;
        }
        return {
            schemaCache: null,
            schemaError,
        };
    }
}

export function isModelValidationEnabled<TDocument>(definition: ModelDefinition<TDocument>): boolean {
    return toCompatDefinition(definition).options?.validate !== false;
}

export function resolveModelTimestampsConfig<TDocument>(
    definition: ModelDefinition<TDocument>,
): ModelTimestampsConfig | null {
    const timestamps = toCompatDefinition(definition).options?.timestamps as
        | true
        | false
        | {
            createdAt?: string | false;
            updatedAt?: string | false;
        }
        | undefined;
    if (timestamps == null || timestamps === false) {
        return null;
    }
    if (timestamps === true) {
        return {
            createdAt: 'createdAt',
            updatedAt: 'updatedAt',
        };
    }
    return {
        createdAt: timestamps.createdAt === false ? false : (typeof timestamps.createdAt === 'string' ? timestamps.createdAt : 'createdAt'),
        updatedAt: timestamps.updatedAt === false ? false : (typeof timestamps.updatedAt === 'string' ? timestamps.updatedAt : 'updatedAt'),
    };
}

export function resolveModelSoftDeleteConfig<TDocument>(
    definition: ModelDefinition<TDocument>,
): ModelSoftDeleteConfig | null {
    const softDelete = toCompatDefinition(definition).options?.softDelete;
    if (!softDelete) {
        return null;
    }
    if (softDelete === true) {
        return {
            enabled: true,
            field: 'deletedAt',
            type: 'timestamp',
            ttl: null,
        };
    }
    return {
        enabled: softDelete.enabled !== false,
        field: softDelete.field ?? 'deletedAt',
        type: softDelete.type ?? 'timestamp',
        ttl: softDelete.ttl ?? null,
    };
}

export function resolveModelVersionConfig<TDocument>(
    definition: ModelDefinition<TDocument>,
): ModelVersionConfig | null {
    const version = toCompatDefinition(definition).options?.version;
    if (!version) {
        return null;
    }
    if (version === true) {
        return {
            enabled: true,
            field: 'version',
            updateMany: 'counter',
        };
    }
    const updateMany = version.updateMany;
    if (
        updateMany !== undefined
        && updateMany !== 'counter'
        && updateMany !== 'strict'
        && updateMany !== 'off'
    ) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'version.updateMany must be "counter", "strict", or "off".');
    }
    return {
        enabled: version.enabled !== false,
        field: version.field ?? 'version',
        updateMany: updateMany ?? 'counter',
    };
}

export function resolveModelHooksFactory<TDocument>(
    definition: ModelDefinition<TDocument>,
): ModelHooksFactory | null {
    const hooks = toCompatDefinition(definition).hooks;
    return typeof hooks === 'function' ? hooks : null;
}

export function collectModelIndexDefinitions<TDocument>(
    definition: ModelDefinition<TDocument>,
    softDeleteConfig: ModelSoftDeleteConfig | null,
): ModelDeclaredIndex[] {
    const declared: ModelDeclaredIndex[] = [];
    if (softDeleteConfig?.enabled && softDeleteConfig.type === 'timestamp' && softDeleteConfig.ttl) {
        const key = { [softDeleteConfig.field]: 1 };
        const options = { expireAfterSeconds: softDeleteConfig.ttl };
        declared.push({
            source: 'softDelete',
            key,
            options,
            name: getIndexOptionName(options),
            fingerprint: stableIndexStringify({ key, options }),
        });
    }

    const indexes = toCompatDefinition(definition).indexes;
    if (!Array.isArray(indexes) || indexes.length === 0) {
        return declared;
    }
    for (const indexSpec of indexes) {
        if (!isRecord(indexSpec) || !indexSpec.key) {
            continue;
        }
        const { key, ...indexOptions } = indexSpec;
        declared.push({
            source: 'definition',
            key,
            options: indexOptions,
            name: getIndexOptionName(indexOptions),
            fingerprint: stableIndexStringify({ key, options: indexOptions }),
        });
    }
    return declared;
}

export async function ensureModelIndexesForCollection<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    definition: ModelDefinition<TDocument>,
    softDeleteConfig: ModelSoftDeleteConfig | null,
    options: ModelIndexEnsureOptions = {},
): Promise<ModelIndexEnsureResult> {
    const namespace = toIndexNamespace(resolveIndexTaskScope(collection, options));
    const declared = collectModelIndexDefinitions(definition, softDeleteConfig);
    const existingIndexes = await collection.listIndexes();
    const existing: ModelIndexEnsureResult['existing'] = [];
    const missing: ModelIndexEnsureResult['missing'] = [];
    const conflicts: ModelIndexEnsureResult['conflicts'] = [];

    for (const declaredIndex of declared) {
        const existingByName = findExistingIndexByName(existingIndexes, declaredIndex.name);
        if (existingByName) {
            if (indexOptionsMatch(existingByName, declaredIndex)) {
                existing.push({ declared: declaredIndex, existing: existingByName });
            } else {
                conflicts.push({
                    declared: declaredIndex,
                    existing: existingByName,
                    reason: 'name-conflict',
                });
            }
            continue;
        }

        const existingByKey = findExistingIndexByKey(existingIndexes, declaredIndex.key);
        if (existingByKey) {
            if (indexOptionsMatch(existingByKey, declaredIndex)) {
                existing.push({ declared: declaredIndex, existing: existingByKey });
            } else {
                conflicts.push({
                    declared: declaredIndex,
                    existing: existingByKey,
                    reason: 'options-conflict',
                });
            }
            continue;
        }

        missing.push(declaredIndex);
    }

    const result: ModelIndexEnsureResult = {
        dryRun: options.dryRun === true,
        namespace,
        declared,
        existing,
        missing,
        created: [],
        conflicts,
        failed: [],
        skipped: options.dryRun === true
            ? missing.map((declaredIndex) => ({ declared: declaredIndex, reason: 'dry-run' }))
            : conflicts.map((conflict) => ({ declared: conflict.declared, reason: conflict.reason })),
    };

    if (conflicts.length > 0 && options.throwOnError) {
        throw createIndexEnsureError('Model index conflicts detected.', result);
    }
    if (options.dryRun === true) {
        return result;
    }

    for (const declaredIndex of missing) {
        try {
            const createdName = await runWithModelWriteSource(() => collection.createIndex(declaredIndex.key, declaredIndex.options));
            result.created.push({
                declared: declaredIndex,
                name: typeof createdName === 'string' ? createdName : undefined,
                result: createdName,
            });
        } catch (error: unknown) {
            result.failed.push({
                declared: declaredIndex,
                error: summarizeIndexError(error),
            });
            if (options.throwOnError) {
                throw createIndexEnsureError(
                    'Model index creation failed.',
                    result,
                    error instanceof Error ? error : undefined,
                );
            }
        }
    }

    return result;
}

export function summarizeModelIndexEnsureResults(
    results: ModelIndexEnsureResult[],
): ModelIndexEnsureSummary['totals'] {
    return results.reduce<ModelIndexEnsureSummary['totals']>((totals, result) => ({
        declared: totals.declared + result.declared.length,
        existing: totals.existing + result.existing.length,
        missing: totals.missing + result.missing.length,
        created: totals.created + result.created.length,
        conflicts: totals.conflicts + result.conflicts.length,
        failed: totals.failed + result.failed.length,
        skipped: totals.skipped + result.skipped.length,
    }), {
        declared: 0,
        existing: 0,
        missing: 0,
        created: 0,
        conflicts: 0,
        failed: 0,
        skipped: 0,
    });
}

export function initializeModelV1Methods<TDocument>(
    target: object,
    definition: ModelDefinition<TDocument>,
    logger?: ModelWarningLogger | null,
): Record<string, (...args: unknown[]) => unknown> {
    const methods = toCompatDefinition(definition).methods;
    if (typeof methods !== 'function') {
        return {};
    }
    try {
        const customMethods = methods(target);
        for (const [name, fn] of Object.entries(customMethods.static ?? {})) {
            if (typeof fn === 'function' && !(name in target)) {
                Object.defineProperty(target, name, {
                    configurable: true,
                    enumerable: false,
                    writable: false,
                    value: (...args: unknown[]) => fn.apply(target, args),
                });
            }
        }
        return customMethods.instance ?? {};
    } catch (error) {
        logger?.warn?.('[MonSQLize] initializeModelV1Methods: methods() factory threw an error', error);
        return {};
    }
}

export function scheduleModelIndexes<TDocument>(
    collection: ModelCollectionLike<TDocument>,
    definition: ModelDefinition<TDocument>,
    softDeleteConfig: ModelSoftDeleteConfig | null,
    options?: ModelIndexScheduleOptions,
): void {
    const autoIndex = resolveModelAutoIndexOptions(definition, options?.autoIndex);
    if (!autoIndex.enabled) {
        return;
    }
    const declaredIndexes = collectModelIndexDefinitions(definition, softDeleteConfig);
    if (declaredIndexes.length === 0) {
        return;
    }
    scheduleModelIndexEnsureTask(collection, definition, softDeleteConfig, declaredIndexes, autoIndex.emitEvents, options);
}
