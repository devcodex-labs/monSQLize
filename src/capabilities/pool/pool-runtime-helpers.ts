/**
 * Runtime helper functions for ConnectionPoolManager.
 *
 * Provides pool config validation (strict and lenient modes), an empty stats factory,
 * a default MongoClient factory, and a default health-check function,
 * keeping initialization details out of the pool core files.
 */

import { MongoClient as MongoDriverClient } from 'mongodb';
import type { MongoClient } from 'mongodb';
import { createError, ErrorCodes } from '../../core/errors';
import type { PoolConfig, PoolStats } from '../../../types/pool';

const DEFAULT_POOL_CONNECT_OPTIONS = {
    connectTimeoutMS: 5000,
    serverSelectionTimeoutMS: 5000,
} as const;

/**
 * Strictly validates a pool config, throwing immediately on any invalid field.
 * Intended for the initialization path to ensure the config is fully valid before proceeding.
 */
export function validatePoolConfig(config: Record<string, unknown>): void {
    if (!config || typeof config !== 'object') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config must be an object');
    if (!config.name || typeof config.name !== 'string') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.name is required and must be a string');
    if (!config.uri || typeof config.uri !== 'string') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.uri is required and must be a string');
    if (!(config.uri as string).startsWith('mongodb://') && !(config.uri as string).startsWith('mongodb+srv://')) {
        throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.uri must start with mongodb:// or mongodb+srv://');
    }
    if (config.role) {
        const validRoles = ['primary', 'secondary', 'analytics', 'custom'];
        if (!validRoles.includes(config.role as string)) throw createError(ErrorCodes.INVALID_CONFIG, `Pool config.role must be one of: ${validRoles.join(', ')}`);
    }
    if (config.weight !== undefined) {
        if (typeof config.weight !== 'number') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.weight must be a number');
        if ((config.weight as number) < 0) throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.weight must be a non-negative number');
    }
    if (config.options !== undefined) {
        if (typeof config.options !== 'object' || Array.isArray(config.options)) throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.options must be an object');
        const opts = config.options as Record<string, unknown>;
        for (const key of ['maxPoolSize', 'minPoolSize', 'maxIdleTimeMS', 'waitQueueTimeoutMS', 'connectTimeoutMS', 'serverSelectionTimeoutMS']) {
            if (opts[key] !== undefined && (typeof opts[key] !== 'number' || (opts[key] as number) < 0)) {
                throw createError(ErrorCodes.INVALID_CONFIG, `Pool config.options.${key} must be a non-negative number`);
            }
        }
    }
    if (config.healthCheck !== undefined) {
        if (typeof config.healthCheck !== 'object' || Array.isArray(config.healthCheck)) throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.healthCheck must be an object');
        const hc = config.healthCheck as Record<string, unknown>;
        if (hc.enabled !== undefined && typeof hc.enabled !== 'boolean') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.healthCheck.enabled must be a boolean');
        for (const key of ['interval', 'timeout', 'retries']) {
            if (hc[key] !== undefined && (typeof hc[key] !== 'number' || (hc[key] as number) < 0)) {
                throw createError(ErrorCodes.INVALID_CONFIG, `Pool config.healthCheck.${key} must be a non-negative number`);
            }
        }
    }
    if (config.tags !== undefined) {
        if (!Array.isArray(config.tags)) throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.tags must be an array');
        for (const tag of config.tags as unknown[]) {
            if (typeof tag !== 'string') throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config.tags must be an array of strings');
        }
    }
}

/**
 * Leniently validates a pool config, collecting all errors into a string array without throwing.
 * Useful for bulk-error reporting scenarios such as CLI tools or pre-flight config checks.
 */
export function validatePoolConfigSafe(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    if (!config || typeof config !== 'object') { errors.push('Pool config must be an object'); return errors; }
    if (!config.name || typeof config.name !== 'string') errors.push('Pool config.name is required and must be a string');
    if (!config.uri || typeof config.uri !== 'string') {
        errors.push('Pool config.uri is required and must be a string');
    } else if (!(config.uri as string).startsWith('mongodb://') && !(config.uri as string).startsWith('mongodb+srv://')) {
        errors.push('Pool config.uri must start with mongodb:// or mongodb+srv://');
    }
    if (config.role) {
        const validRoles = ['primary', 'secondary', 'analytics', 'custom'];
        if (!validRoles.includes(config.role as string)) errors.push(`Pool config.role must be one of: ${validRoles.join(', ')}`);
    }
    if (config.weight !== undefined && (typeof config.weight !== 'number' || (config.weight as number) < 0)) {
        errors.push('Pool config.weight must be a non-negative number');
    }
    if (config.options && typeof config.options !== 'object') errors.push('Pool config.options must be an object');
    if (config.options && typeof config.options === 'object') {
        const opts = config.options as Record<string, unknown>;
        if (opts.maxPoolSize !== undefined && (typeof opts.maxPoolSize !== 'number' || (opts.maxPoolSize as number) < 0)) {
            errors.push('Pool config.options.maxPoolSize must be a non-negative number');
        }
    }
    if (config.healthCheck) {
        if (typeof config.healthCheck !== 'object') {
            errors.push('Pool config.healthCheck must be an object');
        } else {
            const hc = config.healthCheck as Record<string, unknown>;
            if (hc.enabled !== undefined && typeof hc.enabled !== 'boolean') errors.push('Pool config.healthCheck.enabled must be a boolean');
            for (const key of ['interval', 'timeout', 'retries']) {
                if (hc[key] !== undefined && (typeof hc[key] !== 'number' || (hc[key] as number) < 0)) {
                    errors.push(`Pool config.healthCheck.${key} must be a non-negative number`);
                }
            }
        }
    }
    if (config.tags) {
        if (!Array.isArray(config.tags)) {
            errors.push('Pool config.tags must be an array');
        } else {
            for (const tag of config.tags as unknown[]) {
                if (typeof tag !== 'string') {
                    errors.push('Pool config.tags must be an array of strings');
                    break;
                }
            }
        }
    }
    return errors;
}

/**
 * Validates the required fields (name / uri) of a `PoolConfig` object, throwing on failure.
 */
export function validatePoolConfigInternal(config: PoolConfig): void {
    if (!config.name?.trim()) {
        throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config requires a non-empty name');
    }
    if (!config.uri?.trim()) {
        throw createError(ErrorCodes.INVALID_CONFIG, 'Pool config requires a non-empty uri');
    }
}

/**
 * Creates an empty stats object for the given pool, with all counters initialized to 0.
 */
export function createEmptyPoolStats(name: string): PoolStats {
    return {
        name,
        connections: 0,
        available: 0,
        waiting: 0,
        status: 'unknown',
        totalRequests: 0,
        successCount: 0,
        errorCount: 0,
        avgResponseTime: 0,
        minResponseTime: 0,
        maxResponseTime: 0,
        errorRate: 0,
        lastRequestTime: null,
    };
}

/**
 * Default MongoClient factory: creates and connects a new MongoClient from the given `PoolConfig`.
 * Can be overridden via the `ConnectionPoolManager` constructor options.
 */
export async function defaultClientFactory(config: PoolConfig, onCreated?: (client: MongoClient) => void): Promise<MongoClient> {
    const client = new MongoDriverClient(config.uri, {
        ...DEFAULT_POOL_CONNECT_OPTIONS,
        ...(config.options ?? {}),
    });
    onCreated?.(client);
    await client.connect();
    return client;
}

/**
 * Default pool health-check function: sends a ping command to the admin database.
 * Returns true on success; any thrown error is left for the caller to handle (retry, mark unhealthy, etc.).
 */
export async function defaultHealthCheckFn(_poolName: string, client: MongoClient): Promise<boolean> {
    await client.db('admin').command({ ping: 1 });
    return true;
}
