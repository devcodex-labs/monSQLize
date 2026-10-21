/**
 * Slow query log configuration management.
 *
 * Defines default config constants and config-merging logic for use by
 * SlowQueryLogManager and external callers.
 */
import { ErrorCodes, createError } from '../../core/errors';
import type {
    SlowQueryLogConfig,
    SlowQueryLogConfigInput,
    SlowQueryLogStorageConfig,
} from '../../../types/slow-query-log';

export type NormalizedSlowQueryLogStorageConfig = SlowQueryLogStorageConfig & {
    database: string;
    collection: string;
    ttl: number;
};

export const DEFAULT_SLOW_QUERY_LOG_CONFIG: SlowQueryLogConfig = {
    enabled: false,
    storage: {
        type: 'mongodb',
        useBusinessConnection: true,
        uri: null,
        database: 'admin',
        collection: 'slow_query_logs',
        ttl: 7 * 24 * 3600,
    },
    batch: {
        enabled: true,
        size: 10,
        interval: 5000,
        maxBufferSize: 100,
    },
    filter: {
        excludeDatabases: [],
        excludeCollections: [],
        excludeOperations: [],
        minExecutionTimeMs: 0,
    },
    advanced: {
        errorHandling: 'log',
        autoCreateIndexes: true,
    },
};

export function deepClone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value, (_key, current) => current instanceof Date ? current.toISOString() : current));
}

export function mergeSlowQueryLogConfig(target: SlowQueryLogConfig, source: Exclude<SlowQueryLogConfigInput, boolean>): SlowQueryLogConfig {
    return {
        ...target,
        ...source,
        storage: {
            ...target.storage,
            ...(source.storage ?? {}),
        },
        batch: {
            ...target.batch,
            ...(source.batch ?? {}),
        },
        filter: {
            ...target.filter,
            ...(source.filter ?? {}),
        },
        advanced: {
            ...target.advanced,
            ...(source.advanced ?? {}),
        },
    };
}

export class SlowQueryLogConfigManager {
    static mergeConfig(userConfig?: SlowQueryLogConfigInput, businessType = 'mongodb'): SlowQueryLogConfig {
        if (userConfig === undefined || userConfig === null) {
            return deepClone(DEFAULT_SLOW_QUERY_LOG_CONFIG);
        }
        if (typeof userConfig === 'boolean') {
            const config = deepClone(DEFAULT_SLOW_QUERY_LOG_CONFIG);
            config.enabled = userConfig;
            config.storage.type = businessType === 'mongodb' ? 'mongodb' : 'memory';
            return config;
        }
        const merged = mergeSlowQueryLogConfig(deepClone(DEFAULT_SLOW_QUERY_LOG_CONFIG), userConfig);
        if (merged.storage.type === undefined) {
            merged.storage.type = businessType === 'mongodb' ? 'mongodb' : 'memory';
        }
        if (userConfig.storage && merged.enabled === false) {
            merged.enabled = true;
        }
        return merged;
    }

    static validate(config: SlowQueryLogConfig, businessType = 'mongodb'): boolean {
        if (!config || typeof config !== 'object') {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] config must be an object.');
        }
        if (!config.enabled) {
            return true;
        }
        if (!['memory', 'mongodb'].includes(config.storage.type ?? 'memory')) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] storage.type must be memory or mongodb.');
        }
        if (config.storage.type === 'mongodb' && config.storage.useBusinessConnection === false && !config.storage.uri) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] storage.uri is required when mongodb storage does not reuse business connection.');
        }
        if (config.storage.type === 'memory' && businessType !== 'mongodb') {
            return true;
        }
        if (!Number.isInteger(config.batch.size) || config.batch.size < 1) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] batch.size must be >= 1.');
        }
        if (!Number.isInteger(config.batch.interval) || config.batch.interval < 50) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] batch.interval must be >= 50ms.');
        }
        if (!Number.isInteger(config.batch.maxBufferSize) || config.batch.maxBufferSize < config.batch.size) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] batch.maxBufferSize must be >= batch.size.');
        }
        if (config.filter.minExecutionTimeMs < 0) {
            throw createError(ErrorCodes.INVALID_CONFIG, '[SlowQueryLog] filter.minExecutionTimeMs must be >= 0.');
        }
        return true;
    }
}
