/**
 * capability-wiring.ts — pure-function capability initialisation layer
 *
 * Notes:
 * - Standalone initialisation helpers extracted from runtime-core.ts
 * - All functions accept parameters and return values with no `this` dependency,
 *   making them easy to test and reuse in isolation
 * - Covers: autoConvert config building, runtime defaults, pool creation, and Model file auto-loading
 */

import type { MonSQLizeOptions } from '../../types/monsqlize';
import type { RuntimeDefaults } from '../types/internal/query';
import type { LoggerLike } from '../core/logger';
import { ErrorCodes } from '../core/errors';
import type { ModelDefinition } from '../capabilities/model';
import { Model } from '../capabilities/model';
import { CountQueue } from '../capabilities/count-queue';
import { ConnectionPoolManager } from '../capabilities/pool';
import { DistributedCacheInvalidator } from '../capabilities/cache';
import type { CacheLike, RedisPubSubLike } from '../capabilities/cache';
import { normalizeWritePathPolicy } from '../capabilities/write-path-policy';

// ────────────────────────────────────────────────────────
// AutoConvert config
// ────────────────────────────────────────────────────────

/**
 * Initialise the ObjectId auto-convert configuration.
 * Only enabled for the `mongodb` type; all other types always return disabled.
 */
export function initAutoConvertConfig(
    config: boolean | { enabled?: boolean; excludeFields?: string[]; customFieldPatterns?: string[]; maxDepth?: number; logLevel?: string; } | Record<string, boolean> | undefined,
    type: string | undefined,
): { enabled: boolean; excludeFields?: string[]; customFieldPatterns?: string[]; maxDepth?: number; logLevel?: string; [field: string]: unknown; } {
    if (type !== 'mongodb') {
        return { enabled: false };
    }
    if (config === false) {
        return { enabled: false };
    }
    const defaults = { enabled: true, excludeFields: [], customFieldPatterns: [], maxDepth: 10, logLevel: 'warn' };
    if (config === true || config === undefined) {
        return defaults;
    }
    if (typeof config === 'object' && config !== null) {
        if (config.enabled === false) {
            return { enabled: false };
        }
        const fieldMap = Object.fromEntries(
            Object.entries(config).filter(([key, value]) =>
                typeof value === 'boolean' && key !== 'enabled',
            ),
        );
        return {
            enabled: true,
            excludeFields: Array.isArray(config.excludeFields) ? config.excludeFields : defaults.excludeFields,
            customFieldPatterns: Array.isArray(config.customFieldPatterns) ? config.customFieldPatterns : defaults.customFieldPatterns,
            maxDepth: typeof config.maxDepth === 'number' ? config.maxDepth : defaults.maxDepth,
            logLevel: typeof config.logLevel === 'string' ? config.logLevel : defaults.logLevel,
            ...fieldMap,
        };
    }
    return defaults;
}

// ────────────────────────────────────────────────────────
// Runtime defaults
// ────────────────────────────────────────────────────────

/**
 * Build the runtime defaults object from options.
 * Includes maxTimeMS, findLimit, find bounds, autoConvertObjectId, countQueue, and related fields.
 */
export function buildRuntimeDefaults(options: MonSQLizeOptions): RuntimeDefaults {
    const o = options;
    const cacheOptions = o.cache && typeof o.cache === 'object' && !Array.isArray(o.cache)
        ? o.cache as Record<string, unknown>
        : undefined;
    const cacheAutoInvalidate = typeof cacheOptions?.autoInvalidate === 'boolean'
        ? cacheOptions.autoInvalidate
        : o.cacheAutoInvalidate;
    const autoConvertConfig = initAutoConvertConfig(
        o.autoConvertObjectId,
        o.type ?? 'mongodb',
    );
    const defaults: RuntimeDefaults = {
        maxTimeMS: o.maxTimeMS ?? 2000,
        findLimit: o.findLimit ?? 500,
        findMaxLimit: o.findMaxLimit ?? 10000,
        findMaxSkip: o.findMaxSkip ?? 50000,
        findPageMaxLimit: o.findPageMaxLimit ?? 500,
        slowQueryMs: o.slowQueryMs ?? 500,
        namespace: o.namespace ?? { scope: 'database' },
        writePathPolicy: normalizeWritePathPolicy(o.writePathPolicy),
        cacheAutoInvalidate,
    };
    // v1-compat: autoConvertObjectId defaults to true for MongoDB type (mirrors v1 behaviour)
    defaults.autoConvertObjectId = o.autoConvertObjectId !== undefined
        ? (autoConvertConfig.enabled ? autoConvertConfig : false)
        : (o.type === 'mongodb' || !o.type ? true : false);
    if (o.cursorSecret !== undefined) defaults.cursorSecret = o.cursorSecret;
    if (o.requireCursorSecret !== undefined) defaults.requireCursorSecret = o.requireCursorSecret;
    if (o.cursorTypes !== undefined) defaults.cursorTypes = o.cursorTypes;
    if (typeof o.cursorValueNormalizer === 'function') defaults.cursorValueNormalizer = o.cursorValueNormalizer;
    // v1-compat: countQueue defaults to enabled when not explicitly configured.
    const countQueueCfg = o.countQueue === false
        ? { enabled: false }
        : o.countQueue === true || o.countQueue === undefined
            ? { enabled: true, maxQueueSize: 10000, timeout: 60000 }
            : { enabled: true, ...o.countQueue };
    if (countQueueCfg.enabled) {
        defaults.countQueue = new CountQueue({
            concurrency: countQueueCfg.concurrency,
            maxQueueSize: countQueueCfg.maxQueueSize,
            timeout: countQueueCfg.timeout,
        });
    }
    return defaults;
}

// ────────────────────────────────────────────────────────
// Connection pool manager
// ────────────────────────────────────────────────────────

/**
 * Create and start the connection pool manager.
 * - Returns null when options.pools is not configured
 * - Creates a new instance, registers all pools, starts health checks, then returns
 * - Callers are responsible for checking whether an instance already exists to avoid duplicate initialisation
 */
export async function createAndStartPoolManager(
    options: MonSQLizeOptions,
): Promise<ConnectionPoolManager | null> {
    if (!options.pools?.length) {
        return null;
    }
    const pm = new ConnectionPoolManager({
        pools: options.pools,
        poolStrategy: options.poolStrategy,
        poolFallback: options.poolFallback,
        maxPoolsCount: options.maxPoolsCount,
        logger: options.logger ?? null,
    });
    for (const pool of options.pools) {
        await pm.addPool(pool);
    }
    pm.startHealthCheck();
    return pm;
}

// ────────────────────────────────────────────────────────
// Distributed cache invalidator
// ────────────────────────────────────────────────────────

/**
 * Auto-initialize the DistributedCacheInvalidator from `cache.distributed` config (v1 compat).
 *
 * Called from `connect()` after the cache is available. Returns null when:
 * - `options.cache` is not a plain config object (already a MemoryCache or CacheLike)
 * - No `distributed` field is present
 * - `distributed.enabled === false`
 * - Construction fails (error is logged, not thrown)
 */
export async function initializeDistributedCacheInvalidator(
    options: MonSQLizeOptions,
    cache: CacheLike,
    logger: LoggerLike,
): Promise<DistributedCacheInvalidator | null> {
    const rawCache = options.cache as Record<string, unknown> | undefined;
    if (!rawCache || typeof rawCache !== 'object' || Array.isArray(rawCache)) return null;
    if (typeof rawCache['get'] === 'function') return null; // already a CacheLike instance

    const distConfig = rawCache['distributed'] as Record<string, unknown> | undefined;
    if (!distConfig || typeof distConfig !== 'object' || Array.isArray(distConfig)) return null;
    if (distConfig['enabled'] === false) return null;

    try {
        return new DistributedCacheInvalidator({
            redisUrl: (distConfig['redisUrl'] ?? distConfig['url'] ?? distConfig['uri']) as string | undefined,
            redis: distConfig['redis'] as RedisPubSubLike | undefined,
            channel: distConfig['channel'] as string | undefined,
            instanceId: distConfig['instanceId'] as string | undefined,
            cache,
            logger,
        });
    } catch (err) {
        if ((err as { code?: unknown } | null)?.code === ErrorCodes.INVALID_CONFIG) throw err;
        logger.warn?.('[Cache] Failed to initialize distributed cache invalidator — check Redis config or package installation completeness.', err);
        return null;
    }
}

// ────────────────────────────────────────────────────────
// Model file auto-loading
// ────────────────────────────────────────────────────────

/**
 * Auto-load Model definition files from the configured path (mirrors v1 models auto-load behaviour).
 *
 * Supports two formats:
 * - String: `models: './models'` — scans `*.model.{js,mjs,cjs}`, non-recursive
 * - Object: `models: { path, pattern?, recursive? }` — full control
 *
 * Each file must export an object with a `name` field (i.e. the argument to Model.define()).
 */
export async function loadModelFiles(
    options: MonSQLizeOptions,
    logger: LoggerLike,
    opts: { reload?: boolean } = {},
): Promise<void> {
    const modelsConfig = options.models;
    if (!modelsConfig) return;
    if (typeof modelsConfig !== 'string' && typeof modelsConfig !== 'object') return;

    const { readdirSync } = await import('node:fs');
    const { resolve, join, isAbsolute } = await import('node:path');
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');

    let targetPath: string;
    let pattern: string;
    let recursive: boolean;

    if (typeof modelsConfig === 'string') {
        targetPath = isAbsolute(modelsConfig) ? modelsConfig : resolve(process.cwd(), modelsConfig);
        pattern = '*.model.{js,mjs,cjs}';
        recursive = false;
    } else {
        const p = modelsConfig.path;
        targetPath = isAbsolute(p) ? p : resolve(process.cwd(), p);
        pattern = modelsConfig.pattern ?? '*.model.{js,mjs,cjs}';
        recursive = modelsConfig.recursive ?? false;
    }

    // Convert glob pattern to RegExp (supports {a,b} alternatives and * wildcard)
    const globToRegex = (glob: string): RegExp => {
        const escaped = glob
            .replace(/\./g, '\\.')
            .replace(/\{([^}]+)\}/g, (_, inner) => `(?:${inner.split(',').join('|')})`)
            .replace(/\*/g, '[^/\\\\]*');
        return new RegExp(`^${escaped}$`);
    };
    const filePattern = globToRegex(pattern);

    const collectFiles = (dir: string): string[] => {
        let entries: Array<{ name: string | Buffer; isDirectory(): boolean; isFile(): boolean }>;
        try {
            entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string | Buffer; isDirectory(): boolean; isFile(): boolean }>;
        } catch {
            logger.warn?.(`[Models] cannot read directory: ${dir}`);
            return [];
        }
        const files: string[] = [];
        for (const entry of entries) {
            const entryName = typeof entry.name === 'string' ? entry.name : entry.name.toString();
            if (entry.isDirectory() && recursive) {
                files.push(...collectFiles(join(dir, entryName)));
            } else if (entry.isFile() && filePattern.test(entryName)) {
                files.push(join(dir, entryName));
            }
        }
        return files;
    };

    const files = collectFiles(targetPath);
    if (files.length === 0) return;

    const req = createRequire(resolve(process.cwd(), 'package.json'));
    for (const file of files) {
        try {
            if (file.endsWith('.ts')) {
                logger.warn?.(`[Models] skipping TypeScript model file without a registered runtime loader: ${file}`);
                continue;
            }
            const mod = file.endsWith('.mjs')
                ? await import(pathToFileURL(file).href)
                : (() => {
                    delete req.cache[req.resolve(file)];
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    return req(file) as Record<string, unknown>;
                })();
            const definition = (mod.default ?? mod) as { name?: string;[key: string]: unknown };
            if (!definition?.name) {
                logger.warn?.(`[Models] ${file}: exported object must have a 'name' field`);
                continue;
            }
            if (opts.reload && Model.has(definition.name as string)) {
                Model.redefine(definition.name as string, definition as ModelDefinition<unknown>);
            } else {
                Model.define(definition.name as string, definition as ModelDefinition<unknown>);
            }
        } catch (err) {
            logger.warn?.(`[Models] failed to load ${file}`, err);
        }
    }
}
