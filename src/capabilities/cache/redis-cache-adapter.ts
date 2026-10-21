import { createRedisCacheAdapter as createHubRedisCacheAdapter } from 'cache-hub/redis';
import type { RedisCacheAdapterOptions } from 'cache-hub/redis';
import { createError, ErrorCodes } from '../../core/errors';

const LEGACY_INVALID_REDIS_ARG_ERROR = 'redisUrlOrInstance must be a Redis URL string or an ioredis instance';
const LEGACY_IOREDIS_MISSING_ERROR = 'Unable to load ioredis. monsqlize installs ioredis by default; check package installation completeness or pass an existing ioredis instance';

function isMissingIoredisError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }

    return error.message.includes('ioredis')
        && (error.message.includes('Cannot find module') || error.message.includes('not installed'));
}

function createLegacyRedisError(message: string, code: string = ErrorCodes.INVALID_ARGUMENT) {
    return createError(code, message);
}

function preservePrototypeKeys(adapter: ReturnType<typeof createHubRedisCacheAdapter>) {
    const readMany = adapter.getMany.bind(adapter);
    const readTtls = adapter.getRemainingTtlMany?.bind(adapter);
    adapter.getMany = async (keys) => {
        if (!keys.includes('__proto__')) return readMany(keys);
        const result = await readMany(keys.filter((key) => key !== '__proto__'));
        if (keys.includes('__proto__')) {
            const value = await adapter.get('__proto__');
            if (value !== undefined) Object.defineProperty(result, '__proto__', { value, enumerable: true, configurable: true, writable: true });
        }
        return result;
    };
    if (readTtls && adapter.getRemainingTtl) adapter.getRemainingTtlMany = async (keys) => {
        if (!keys.includes('__proto__')) return readTtls(keys);
        const result = await readTtls(keys.filter((key) => key !== '__proto__'));
        const value = await adapter.getRemainingTtl?.('__proto__');
        if (value !== undefined) Object.defineProperty(result, '__proto__', { value, enumerable: true, configurable: true, writable: true });
        return result;
    };
    return adapter;
}

/**
 * v1-compatible Redis cache adapter factory.
 *
 * The v2 runtime is backed by `cache-hub`, while this wrapper keeps the legacy
 * argument validation and error semantics for existing startup paths.
 */
export function createRedisCacheAdapter(
    redisUrlOrInstance: string | object | undefined,
    options?: RedisCacheAdapterOptions,
) {
    if (typeof redisUrlOrInstance === 'string') {
        const redisUrl = redisUrlOrInstance.trim();
        if (!redisUrl) {
            throw createLegacyRedisError(LEGACY_INVALID_REDIS_ARG_ERROR);
        }

        try {
            return preservePrototypeKeys(createHubRedisCacheAdapter(redisUrl, options));
        } catch (error) {
            if (isMissingIoredisError(error)) {
                throw createLegacyRedisError(LEGACY_IOREDIS_MISSING_ERROR, ErrorCodes.CACHE_UNAVAILABLE);
            }
            throw error;
        }
    }

    if (redisUrlOrInstance && typeof redisUrlOrInstance === 'object') {
        return preservePrototypeKeys(createHubRedisCacheAdapter(redisUrlOrInstance, options));
    }

    throw createLegacyRedisError(LEGACY_INVALID_REDIS_ARG_ERROR);
}
