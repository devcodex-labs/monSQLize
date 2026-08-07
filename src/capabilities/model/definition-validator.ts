/**
 * definition-validator.ts
 *
 * Validation functions for model definitions and relation configs.
 *
 * Design notes:
 * - All functions are pure (or throw only); no I/O or side effects.
 * - validateDefinition / validateRelationConfig are called during Model.define().
 * - validateCollectionName is called in the ModelInstance constructor and at collection operation entry points.
 * - processTimestamps parses options.timestamps and writes the result to _internalHooks.
 * - normalizePopulateConfig normalizes populate path formats.
 */

import { ErrorCodes, createError } from '../../core/errors';
import type { ModelDefinition, RelationConfig, PopulateConfig } from '../../../types/model';
import type { PopulatePath } from './populate-promise';

/**
 * Validate and normalize a collection name.
 * The name must be a non-empty string and must not contain `$`, `.`, whitespace, or null bytes.
 * Returns the original name on success; throws INVALID_COLLECTION_NAME otherwise.
 */
export function validateCollectionName(collectionName: string): string {
    if (!collectionName || typeof collectionName !== 'string' || collectionName.trim() === '') {
        throw createError(ErrorCodes.INVALID_COLLECTION_NAME, 'Collection name must be a non-empty string.');
    }
    if (/[$.\s\x00]/.test(collectionName)) {
        throw createError(ErrorCodes.INVALID_COLLECTION_NAME, 'Invalid collection name: contains special characters ($, ., space, or null character).');
    }
    return collectionName;
}

/**
 * Parse options.timestamps and write the result to definition._internalHooks.timestamps.
 *
 * Resolution rules (v1-compatible):
 *  - true              → { createdAt: 'createdAt', updatedAt: 'updatedAt' }
 *  - false / undefined → _internalHooks.timestamps = undefined
 *  - { createdAt }     → when createdAt is specified, updatedAt defaults to 'updatedAt' (asymmetric)
 *  - { updatedAt }     → only updatedAt is set; createdAt has no default
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function processTimestamps<TDocument>(definition: ModelDefinition<TDocument>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tsOpt = (definition as any).options?.timestamps as
        | boolean
        | { createdAt?: string | boolean; updatedAt?: string | boolean }
        | undefined;

    // v1-compat: null is treated the same as false (no timestamps added)
    if (tsOpt === null) return;
    // Validate type (consistent with v1 behavior)
    if (tsOpt !== undefined && typeof tsOpt !== 'boolean' && typeof tsOpt !== 'object') {
        throw createError(ErrorCodes.INVALID_MODEL_DEFINITION, 'options.timestamps must be boolean or object.');
    }

    if (!tsOpt && tsOpt !== false) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const defAny = definition as any;
    if (!defAny._internalHooks) defAny._internalHooks = {};

    if (tsOpt === false) {
        defAny._internalHooks.timestamps = undefined;
        return;
    }
    if (tsOpt === true) {
        defAny._internalHooks.timestamps = { createdAt: 'createdAt', updatedAt: 'updatedAt' };
        return;
    }

    const result: { createdAt?: string; updatedAt?: string } = {};
    let createdAtAdded = false;

    const ca = tsOpt.createdAt;
    if (ca === false) {
        // omit
    } else if (ca === true) {
        result.createdAt = 'createdAt';
        createdAtAdded = true;
    } else if (typeof ca === 'string') {
        result.createdAt = ca;
        createdAtAdded = true;
    }

    const ua = tsOpt.updatedAt;
    if (ua === false) {
        // omit
    } else if (ua === true) {
        result.updatedAt = 'updatedAt';
    } else if (typeof ua === 'string') {
        result.updatedAt = ua;
    } else if (ua === undefined && createdAtAdded) {
        // Asymmetric rule: when createdAt is specified, updatedAt defaults to 'updatedAt'
        result.updatedAt = 'updatedAt';
    }

    defAny._internalHooks.timestamps = Object.keys(result).length ? result : undefined;
}

/**
 * Validate the integrity of a ModelDefinition object:
 * - definition must be a non-null object
 * - schema must be present and be a function or object
 * - connection.pool / connection.database (if provided) must be non-empty strings
 * - each entry in relations is validated by validateRelationConfig
 */
export function validateDefinition<TDocument>(definition: ModelDefinition<TDocument> | undefined): void {
    if (!definition || typeof definition !== 'object') {
        throw createError(ErrorCodes.INVALID_MODEL_DEFINITION, 'Model definition must be an object.');
    }
    if (definition.schema === undefined || definition.schema === null) {
        throw createError(ErrorCodes.MISSING_SCHEMA, 'Model definition must include a schema property.');
    }
    if (typeof definition.schema !== 'function' && (typeof definition.schema !== 'object' || definition.schema === null)) {
        throw createError(ErrorCodes.INVALID_SCHEMA_TYPE, 'Schema must be a function or object.');
    }
    if (definition.connection) {
        if (definition.connection.pool !== undefined && (typeof definition.connection.pool !== 'string' || definition.connection.pool.trim() === '')) {
            throw createError(ErrorCodes.INVALID_MODEL_DEFINITION, 'connection.pool must be a non-empty string.');
        }
        if (definition.connection.database !== undefined && (typeof definition.connection.database !== 'string' || definition.connection.database.trim() === '')) {
            throw createError(ErrorCodes.INVALID_MODEL_DEFINITION, 'connection.database must be a non-empty string.');
        }
    }
    for (const [name, config] of Object.entries(definition.relations ?? {})) {
        validateRelationConfig(name, config);
    }
}

/**
 * Validate a single RelationConfig entry:
 * - from / localField / foreignField must be non-empty strings
 * - single (if provided) must be a boolean
 * - select (if provided) must use the supported top-level inclusion projection form
 */
export function validateRelationConfig(name: string, config: RelationConfig): void {
    if (!name || typeof name !== 'string') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Relation name must be a non-empty string.');
    }
    if (!config || typeof config !== 'object') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `Relation '${name}' must be an object.`);
    }
    for (const field of ['from', 'localField', 'foreignField'] as const) {
        const value = config[field];
        if (value === undefined || value === null) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, `relations config is missing required field: ${field}`);
        }
        if (typeof value !== 'string' || (value as string).trim() === '') {
            throw createError(ErrorCodes.INVALID_ARGUMENT, `relations.${field} must be a string`);
        }
    }
    if (config.single !== undefined && typeof config.single !== 'boolean') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `relations.single must be a boolean`);
    }
    normalizeRelationSelect(config.select, { relation: name });
}

type RelationSelectContext = {
    relation?: string;
    path?: string;
};

/**
 * Normalizes P0 relation selection to unique, top-level inclusion fields.
 * It intentionally does not validate schema fields: Models can use open schemas.
 */
export function normalizeRelationSelect(
    value: unknown,
    context: RelationSelectContext = {},
): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    const invalid = (reason: string): never => {
        throw createError(
            ErrorCodes.INVALID_RELATION_SELECT,
            `Relation select must use non-empty top-level inclusion fields: ${reason}`,
            [{ ...context, value, reason }],
        );
    };

    const rawTokens = typeof value === 'string'
        ? [value]
        : Array.isArray(value)
            ? value
            : invalid('select must be a string or string array');

    const tokens: string[] = [];
    for (const rawToken of rawTokens) {
        if (typeof rawToken !== 'string') {
            invalid('select array entries must be strings');
        }
        const parts = rawToken.trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
            invalid('select must not be empty');
        }
        tokens.push(...parts);
    }

    for (const token of tokens) {
        if (token.startsWith('-') || token.startsWith('+')) {
            invalid('exclusion and prefix tokens are not supported');
        }
        if (token.includes('.')) {
            invalid('dot-path fields are not supported');
        }
    }

    return [...new Set(tokens)];
}

/**
 * Normalize a populate path to a PopulateConfig object.
 * String paths are wrapped as `{ path: ... }`; PopulateConfig objects are returned as-is.
 */
export function normalizePopulateConfig(path: PopulatePath): PopulateConfig {
    return typeof path === 'string' ? { path } : path;
}
