/**
 * Read-only relation usage inspection for protected Model deletion.
 *
 * MongoDB has no foreign-key catalogue, so this module deliberately limits
 * itself to relations that are both registered and declared in this runtime.
 */
import { ErrorCodes, createError } from '../../core/errors';
import type {
    ModelDefinition,
    RelationUsageOptions,
    RelationUsageReport,
} from '../../../types/model';
import { resolveModelSoftDeleteConfig } from './model-instance-config';
import { Model } from './model-registry';
import type { ModelRuntimeLike } from './populate-promise';
import { getByPath, unique } from './model-utils';

const DEFAULT_MAX_TARGETS = 100;
const DEFAULT_MAX_SAMPLES = 20;

type NormalizedRelationUsageOptions = {
    session?: unknown;
    maxTargets: number;
    maxSamples: number;
    includeRelations?: string[];
    excludeRelations?: string[];
    includeSoftDeletedReferences: boolean;
};

type InboundRelation = {
    sourceModel: string;
    sourceCollection: string;
    relation: string;
    definition: ModelDefinition<Record<string, unknown>>;
    localField: string;
    foreignField: string;
};

export type RelationUsageScanContext = {
    modelName: string;
    runtime: ModelRuntimeLike;
    dbName: string;
    poolName?: string;
};

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePositiveInteger(value: unknown, field: string, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `${field} must be a positive integer`, [{ field, value }]);
    }
    return value as number;
}

function normalizeRelationNames(value: unknown, field: string): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `${field} must be an array of non-empty strings`, [{ field, value }]);
    }
    return [...new Set(value.map((entry) => entry.trim()))];
}

export function normalizeRelationUsageOptions(options?: RelationUsageOptions): NormalizedRelationUsageOptions {
    if (options !== undefined && !isNonArrayObject(options)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'relation usage options must be a non-array object', [{ field: 'options', value: options }]);
    }
    const value = (options ?? {}) as RelationUsageOptions;
    if (value.includeSoftDeletedReferences !== undefined && typeof value.includeSoftDeletedReferences !== 'boolean') {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'includeSoftDeletedReferences must be a boolean',
            [{ field: 'includeSoftDeletedReferences', value: value.includeSoftDeletedReferences }],
        );
    }
    return {
        session: value.session,
        maxTargets: normalizePositiveInteger(value.maxTargets, 'maxTargets', DEFAULT_MAX_TARGETS),
        maxSamples: normalizePositiveInteger(value.maxSamples, 'maxSamples', DEFAULT_MAX_SAMPLES),
        includeRelations: normalizeRelationNames(value.includeRelations, 'includeRelations'),
        excludeRelations: normalizeRelationNames(value.excludeRelations, 'excludeRelations'),
        includeSoftDeletedReferences: value.includeSoftDeletedReferences !== false,
    };
}

function resolveRegisteredCollectionName(
    registered: { collectionName: string; definition: ModelDefinition<Record<string, unknown>> },
): string {
    const definition = registered.definition as ModelDefinition<Record<string, unknown>> & {
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

function isRelationSelected(
    options: NormalizedRelationUsageOptions,
    sourceModel: string,
    relation: string,
): boolean {
    const qualified = `${sourceModel}.${relation}`;
    const matches = (names: string[] | undefined): boolean => Boolean(names?.includes(qualified) || names?.includes(relation));
    if (options.includeRelations && !matches(options.includeRelations)) {
        return false;
    }
    return !matches(options.excludeRelations);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function findDeclaredInboundRelations(targetModelName: string): InboundRelation[] {
    const relations: InboundRelation[] = [];
    for (const sourceModel of Model.list()) {
        const registered = Model.get<Record<string, unknown>>(sourceModel);
        if (!registered) {
            continue;
        }
        for (const [relation, config] of Object.entries(registered.definition.relations ?? {})) {
            if (config.from !== targetModelName) {
                continue;
            }
            relations.push({
                sourceModel,
                sourceCollection: resolveRegisteredCollectionName(registered),
                relation,
                definition: registered.definition,
                localField: config.localField,
                foreignField: config.foreignField,
            });
        }
    }
    return relations;
}

/** Builds the minimum target projection required to evaluate reverse relation values. */
export function buildRelationUsageTargetProjection(targetModelName: string): Record<string, 1> {
    const fields = new Set<string>(['_id']);
    for (const relation of findDeclaredInboundRelations(targetModelName)) {
        fields.add(relation.foreignField);
    }
    return Object.fromEntries([...fields].map((field) => [field, 1])) as Record<string, 1>;
}

/** Produces an incomplete report when target resolution itself is unavailable. */
export function createUnavailableRelationUsageReport(
    context: RelationUsageScanContext,
    reason: string,
): RelationUsageReport {
    return {
        used: false,
        target: {
            matchedCount: 0,
            truncated: false,
            sampleIds: [],
        },
        checkedRelations: 0,
        usages: [],
        coverage: {
            mode: 'registered-declared',
            complete: false,
            registryModels: Model.list(),
            checkedModels: [],
            skipped: [{ sourceModel: context.modelName, reason }],
        },
    };
}

/**
 * Scans declared inbound relations for a bounded set of already-resolved target
 * documents. This function performs reads only and never invokes Model filters
 * on source documents unless explicitly requested by the caller.
 */
export async function inspectDeclaredRelationUsage(
    context: RelationUsageScanContext,
    targets: Array<Record<string, unknown>>,
    inputOptions?: RelationUsageOptions,
    targetTruncated = false,
): Promise<RelationUsageReport> {
    const options = normalizeRelationUsageOptions(inputOptions);
    const registryModels = Model.list();
    const checkedModels = new Set<string>();
    const skipped: RelationUsageReport['coverage']['skipped'] = [];
    const usages: RelationUsageReport['usages'] = [];
    let checkedRelations = 0;

    for (const inbound of findDeclaredInboundRelations(context.modelName)) {
        if (!isRelationSelected(options, inbound.sourceModel, inbound.relation)) {
            skipped.push({
                sourceModel: inbound.sourceModel,
                reason: `relation '${inbound.sourceModel}.${inbound.relation}' was excluded by relation selection`,
            });
            continue;
        }
        checkedRelations += 1;
        const targetValues = unique(
            targets.flatMap((target) => flattenComparableValues(getByPath(target, inbound.foreignField))),
        );
        if (targetValues.length === 0) {
            checkedModels.add(inbound.sourceModel);
            continue;
        }

        const scope = {
            database: inbound.definition.connection?.database ?? context.dbName,
            pool: inbound.definition.connection?.pool ?? context.poolName,
        };
        const baseQuery: Record<string, unknown> = {
            [inbound.localField]: { $in: targetValues },
        };
        const sourceSoftDelete = resolveModelSoftDeleteConfig(inbound.definition);
        const query = !options.includeSoftDeletedReferences && sourceSoftDelete?.enabled
            ? { $and: [baseQuery, { [sourceSoftDelete.field]: null }] }
            : baseQuery;

        try {
            const collection = context.runtime.scopedCollection(inbound.sourceCollection, scope);
            if (!collection) {
                throw new Error('scopedCollection returned no collection');
            }
            checkedModels.add(inbound.sourceModel);
            const count = await collection.count(query, { session: options.session });
            if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
                throw new Error('relation usage count did not return a non-negative number');
            }
            if (count === 0) {
                continue;
            }
            const samples = await collection.find(query, {
                session: options.session,
                projection: { _id: 1 },
                limit: options.maxSamples,
            });
            usages.push({
                sourceModel: inbound.sourceModel,
                sourceCollection: inbound.sourceCollection,
                relation: inbound.relation,
                localField: inbound.localField,
                foreignField: inbound.foreignField,
                count,
                sampleIds: samples
                    .filter((sample): sample is Record<string, unknown> => isNonArrayObject(sample))
                    .map((sample) => sample._id)
                    .filter((id) => id !== undefined)
                    .slice(0, options.maxSamples),
            });
        } catch (error) {
            skipped.push({
                sourceModel: inbound.sourceModel,
                reason: describeError(error),
            });
        }
    }

    const targetSampleIds = targets
        .map((target) => target._id)
        .filter((id) => id !== undefined)
        .slice(0, options.maxSamples);
    return {
        used: usages.length > 0,
        target: {
            matchedCount: targets.length,
            truncated: targetTruncated,
            sampleIds: targetSampleIds,
        },
        checkedRelations,
        usages,
        coverage: {
            mode: 'registered-declared',
            complete: !targetTruncated && skipped.length === 0,
            registryModels,
            checkedModels: [...checkedModels],
            skipped,
        },
    };
}

/** Removes relation-preflight-only options before forwarding the rest to a delete operation. */
export function stripRelationUsageOptions(options?: unknown): unknown {
    if (!isNonArrayObject(options)) {
        return options;
    }
    const {
        maxTargets: _maxTargets,
        maxSamples: _maxSamples,
        includeRelations: _includeRelations,
        excludeRelations: _excludeRelations,
        includeSoftDeletedReferences: _includeSoftDeletedReferences,
        ...deleteOptions
    } = options;
    void _maxTargets;
    void _maxSamples;
    void _includeRelations;
    void _excludeRelations;
    void _includeSoftDeletedReferences;
    return deleteOptions;
}
