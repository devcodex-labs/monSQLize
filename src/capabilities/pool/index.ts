/**
 * Connection pool management capability.
 *
 * Design notes:
 * - Handles pool configuration contracts, lifecycle management, selection strategies, and health checks.
 * - Public types and shared interfaces are managed by `types/pool.d.ts`;
 *   this file contains only runtime implementation and internal helper logic.
 * - Internal data structures (PoolStatsData / PoolBufferItem) are extracted into
 *   `types/internal/pool.ts` for cross-module reuse without polluting the public API.
 *
 * Core subsystems:
 * 1. PoolStatsManager — aggregates stats per poolName using a batch-buffer strategy
 *    to reduce Map write frequency, merged via periodic flush.
 * 2. PoolSelector — implements five selection strategies: auto / roundRobin /
 *    leastConnections / weighted / manual, with dynamic routing based on role + tags + weight.
 * 3. HealthChecker — periodically pings pools and maintains status / latency / lastCheck,
 *    providing demotion and exclusion signals for the auto strategy.
 * 4. ConnectionPoolManager — public entry point that wires the three subsystems above
 *    and manages multi-pool lifecycle (start / shutdown / getPoolStats, etc.).
 */

import type { MongoClient } from 'mongodb';
import { createError, ErrorCodes } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type {
    ConnectionPoolManagerOptions,
    FallbackStrategy,
    PoolConfig,
    PoolHealthStatus,
    PoolRole,
    PoolStats,
    PoolStrategy,
} from '../../../types/pool';
import { HealthChecker } from './pool-health-checker';
import { PoolSelector } from './pool-selector';
import { PoolStatsManager } from './pool-stats-manager';
import {
    createEmptyPoolStats,
    defaultClientFactory,
    defaultHealthCheckFn,
    validatePoolConfig,
    validatePoolConfigSafe,
} from './pool-runtime-helpers';

export type {
    ConnectionPoolManagerOptions,
    FallbackStrategy,
    PoolConfig,
    PoolHealthStatus,
    PoolRole,
    PoolStats,
    PoolStrategy,
} from '../../../types/pool';
export { HealthChecker } from './pool-health-checker';
export { PoolSelector } from './pool-selector';
export { PoolStatsManager } from './pool-stats-manager';
export { validatePoolConfig, validatePoolConfigSafe } from './pool-runtime-helpers';

// ─── ConnectionPoolManager ────────────────────────────────────────────────────

interface ManagedPool {
    client: MongoClient;
    config: PoolConfig;
    createdAt: number;
}

interface InternalPoolManagerOptions extends ConnectionPoolManagerOptions {
    clientFactory?: (config: PoolConfig) => Promise<MongoClient>;
    healthCheckFn?: (poolName: string, client: MongoClient, config: PoolConfig) => Promise<boolean>;
    fallback?: boolean | {
        enabled?: boolean;
        fallbackStrategy?: FallbackStrategy;
        retryDelay?: number;
        maxRetries?: number;
    };
}

const DEFAULT_HEALTH_CHECK = {
    enabled: true,
    interval: 5000,
    timeout: 3000,
    retries: 3,
};

/**
 * Manages a set of named MongoDB connection pools with health checks,
 * statistics collection, and automatic failover.
 *
 * Design notes:
 * - Three independent subsystems (health checker / stats / selector) are held internally,
 *   accessed via _healthChecker / _statsManager / _selector to enforce separation of concerns
 *   and allow independent replacement.
 * - The fallback strategy is configured in the constructor; when the preferred pool
 *   is unavailable, requests are re-routed according to fallbackStrategy.
 * - Supports test injection: replace the real MongoClient and ping logic via
 *   the clientFactory / healthCheckFn constructor options for unit-test mocking.
 * @since v1.5.0
 */
export class ConnectionPoolManager {
    private readonly pools = new Map<string, ManagedPool>();
    private readonly healthStatus = new Map<string, PoolHealthStatus>();
    private readonly stats = new Map<string, PoolStats>();
    private readonly intervals = new Map<string, NodeJS.Timeout>();
    private readonly logger: LoggerLike | null;
    private readonly maxPoolsCount: number;
    // allow _selector to modify strategy, cannot be readonly
    private strategy: PoolStrategy;
    private readonly fallback: { enabled: boolean; fallbackStrategy: FallbackStrategy; retryDelay: number; maxRetries: number; };
    private readonly clientFactory: (config: PoolConfig) => Promise<MongoClient>;
    private readonly healthCheckFn: (poolName: string, client: MongoClient, config: PoolConfig) => Promise<boolean>;

    // v1 compat properties
    _closed = false;
    readonly _configs = new Map<string, PoolConfig>();
    readonly _selector: PoolSelector;
    readonly _healthChecker: HealthChecker;
    readonly _stats: PoolStatsManager;
    readonly _fallbackConfig: { enabled: boolean; fallbackStrategy: FallbackStrategy; retryDelay: number; maxRetries: number; };
    readonly _fallback: { enabled: boolean; fallbackStrategy: FallbackStrategy; retryDelay: number; maxRetries: number; };
    readonly _pools: Map<string, ManagedPool>;
    private readonly _pendingAdds = new Set<string>();

    constructor(options: InternalPoolManagerOptions = {}) {
        this.logger = options.logger ?? null;
        this.maxPoolsCount = options.maxPoolsCount ?? 10;
        this.strategy = options.poolStrategy ?? 'auto';
        const rawFallback = options.fallback ?? options.poolFallback;
        const fallback = typeof rawFallback === 'boolean'
            ? { enabled: rawFallback, fallbackStrategy: 'error' as FallbackStrategy, retryDelay: 1000, maxRetries: 3 }
            : {
                enabled: rawFallback?.enabled ?? false,
                fallbackStrategy: rawFallback?.fallbackStrategy ?? 'error',
                retryDelay: rawFallback?.retryDelay ?? 1000,
                maxRetries: rawFallback?.maxRetries ?? 3,
            };
        this.fallback = fallback;
        this.clientFactory = options.clientFactory ?? defaultClientFactory;
        this.healthCheckFn = options.healthCheckFn ?? defaultHealthCheckFn;

        // v1 compat: initialize adapter properties
        this._fallbackConfig = this.fallback;
        this._fallback = this.fallback;
        this._pools = this.pools;
        this._selector = new PoolSelector({ strategy: this.strategy, logger: this.logger ?? undefined });
        this._healthChecker = new HealthChecker({ poolManager: this, logger: this.logger ?? undefined });
        this._stats = new PoolStatsManager({ logger: this.logger ?? undefined });
    }

    /**
     * Add a connection pool.
     * @since v1.0.8
     */
    async addPool(config: PoolConfig): Promise<void> {
        validatePoolConfig(config as unknown as Record<string, unknown>);
        if (this.pools.has(config.name) || this._pendingAdds.has(config.name)) {
            throw createError(ErrorCodes.INVALID_CONFIG, `Pool '${config.name}' already exists`);
        }
        if (this.maxPoolsCount > 0 && this.pools.size >= this.maxPoolsCount) {
            throw createError(ErrorCodes.INVALID_CONFIG, `Maximum pool count (${this.maxPoolsCount}) reached`);
        }
        this._pendingAdds.add(config.name);
        try {
            const client = await this.clientFactory(config);
            if (this.pools.has(config.name)) {
                await client.close().catch(() => { });
                throw createError(ErrorCodes.INVALID_CONFIG, `Pool '${config.name}' already exists`);
            }
            this.pools.set(config.name, {
                client,
                config,
                createdAt: Date.now(),
            });
            this.healthStatus.set(config.name, {
                status: 'up',
                consecutiveFailures: 0,
                lastCheckTime: null,
                lastError: null,
                uptime: 0,
            });
            this.stats.set(config.name, createEmptyPoolStats(config.name));
            // v1 compat
            this._configs.set(config.name, config);
            this._healthChecker.register(config.name, (config.healthCheck ?? {}) as Record<string, unknown>);
        } catch (err) {
            // v1 compat: ensure connection-level errors include 'connect'/'ETIMEDOUT'/'ECONNREFUSED'
            // so callers can detect network failures. MongoDB driver v6 wraps socket errors in
            // MongoServerSelectionError whose message says "Server selection timed out" without
            // the underlying network error keyword.
            const error = err as Error & { code?: unknown; name?: string };
            const msg = error.message ?? '';
            const hasNetworkKeyword = msg.includes('connect') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED');
            if (!hasNetworkKeyword && error.name && error.name.toLowerCase().includes('mongo')) {
                const enhanced = new Error(`connect ETIMEDOUT: ${msg}`) as Error & { code?: unknown };
                enhanced.name = error.name;
                enhanced.code = error.code;
                throw enhanced;
            }
            throw err;
        } finally {
            this._pendingAdds.delete(config.name);
        }
    }

    /**
     * Remove a connection pool.
     * @since v1.0.8
     */
    async removePool(name: string): Promise<void> {
        const pool = this.pools.get(name);
        if (!pool) {
            throw createError(ErrorCodes.POOL_NOT_FOUND, `Pool '${name}' not found`);
        }
        this.stopHealthCheck(name);
        await pool.client.close();
        this.pools.delete(name);
        this.healthStatus.delete(name);
        this.stats.delete(name);
        // v1 compat
        this._configs.delete(name);
        this._healthChecker.unregister(name);
    }

    /**
     * Get the native MongoClient for a pool.
     * @since v1.0.8
     */
    getPool(name: string): MongoClient | null {
        return this.pools.get(name)?.client ?? null;
    }

    /**
     * Select a connection pool.
     * @since v1.0.8
     */
    selectPool(
        operation: string,
        options: { pool?: string; tags?: string[]; databaseName?: string; poolPreference?: { role?: string; tags?: string[] }; } = {},
    ): {
        name: string;
        client: MongoClient;
        db: (name?: string) => ReturnType<MongoClient['db']>;
        collection: (databaseName: string | undefined, collectionName: string) => ReturnType<ReturnType<MongoClient['db']>['collection']>;
    } {
        // manually specified pool
        if (options.pool) {
            const poolData = this.pools.get(options.pool);
            if (!poolData) throw createError(ErrorCodes.POOL_NOT_FOUND, `Pool '${options.pool}' not found`);
            return this._createPoolResult(options.pool, poolData.client);
        }

        // get healthy pool list (same logic as v1)
        let candidates = this._getHealthyPools();

        // all pools unavailable — use fallback strategy
        if (candidates.length === 0) {
            if (!this.fallback.enabled) {
                throw createError(ErrorCodes.INVALID_OPERATION, 'No available connection pool');
            }
            candidates = this._handleAllPoolsDown(operation);
            if (candidates.length === 0) {
                throw createError(ErrorCodes.INVALID_OPERATION, 'No available connection pool');
            }
        }

        // select pool name via selector
        const poolPreference = options.poolPreference ?? (options.tags?.length ? { tags: options.tags } : undefined);
        const poolName = this._selector.select(candidates, {
            operation,
            stats: this._stats.getAllStats(),
            poolPreference,
        });

        const poolData = this.pools.get(poolName);
        if (!poolData) {
            throw createError(ErrorCodes.INVALID_OPERATION, `Selected pool '${poolName}' not available`);
        }

        this._stats.recordSelection(poolName, operation);
        this.recordSelection(poolName, true);
        return this._createPoolResult(poolName, poolData.client);
    }

    private _createPoolResult(name: string, client: MongoClient): {
        name: string;
        client: MongoClient;
        db: (n?: string) => ReturnType<MongoClient['db']>;
        collection: (databaseName: string | undefined, collectionName: string) => ReturnType<ReturnType<MongoClient['db']>['collection']>;
    } {
        return {
            name,
            client,
            db: (n?: string) => client.db(n),
            collection: (databaseName: string | undefined, collectionName: string) => client.db(databaseName).collection(collectionName),
        };
    }

    /**
     * Start health checks.
     * @since v1.0.8
     */
    startHealthCheck(name?: string): void {
        const targets = name ? [name] : [...this.pools.keys()];
        for (const poolName of targets) {
            const managed = this.pools.get(poolName);
            if (!managed) {
                continue;
            }
            const healthConfig = {
                ...DEFAULT_HEALTH_CHECK,
                ...managed.config.healthCheck,
            };
            if (!healthConfig.enabled) {
                continue;
            }
            this.stopHealthCheck(poolName);
            const timer = setInterval(() => {
                void this.checkPoolHealth(poolName);
            }, healthConfig.interval);
            timer.unref?.();
            this.intervals.set(poolName, timer);
            void this.checkPoolHealth(poolName);
        }
    }

    /**
     * Stop health checks.
     * @since v1.0.8
     */
    stopHealthCheck(name?: string): void {
        const targets = name ? [name] : [...this.intervals.keys()];
        for (const poolName of targets) {
            const timer = this.intervals.get(poolName);
            if (!timer) {
                continue;
            }
            clearInterval(timer);
            this.intervals.delete(poolName);
        }
    }

    /**
     * Get health status.
     * @since v1.0.8
     */
    getHealthStatus(): Record<string, PoolHealthStatus> {
        return Object.fromEntries(this.healthStatus.entries());
    }

    /**
     * Get all pool names.
     * @since v1.3.0
     */
    getPoolNames(): string[] {
        return Array.from(this.pools.keys());
    }

    /**
     * Get pool statistics.
     * @since v1.0.8
     */
    getPoolStats(): Record<string, PoolStats> {
        const result: Record<string, PoolStats> = {};
        for (const name of this.pools.keys()) {
            const healthStatus = this.healthStatus.get(name);
            const internalStats = this._stats.getStats(name);
            const poolStats = this.stats.get(name) ?? createEmptyPoolStats(name);
            result[name] = {
                name,
                connections: internalStats.connections,
                available: internalStats.available,
                waiting: internalStats.waiting,
                status: (healthStatus?.status ?? 'unknown') as PoolStats['status'],
                totalRequests: poolStats.totalRequests || internalStats.totalRequests,
                successCount: poolStats.successCount,
                errorCount: poolStats.errorCount,
                avgResponseTime: internalStats.avgResponseTime,
                minResponseTime: poolStats.minResponseTime,
                maxResponseTime: poolStats.maxResponseTime,
                errorRate: poolStats.errorRate || internalStats.errorRate,
                lastRequestTime: poolStats.lastRequestTime,
            };
        }
        return result;
    }

    /**
     * Close all connection pools.
     * @since v1.0.8
     */
    async close(): Promise<void> {
        this.stopHealthCheck();
        this._healthChecker.stop();
        this._stats.close();
        for (const pool of this.pools.values()) {
            await pool.client.close();
        }
        this.pools.clear();
        this.healthStatus.clear();
        this.stats.clear();
        this._closed = true;
    }

    // ─── v1 compat methods ───────────────────────────────────────────────────────────

    /** v1 compat: get pool health Map */
    getPoolHealth(): Map<string, PoolHealthStatus> { return new Map(this.healthStatus); }

    /** v1 compat: get healthy pool config list (iterates _configs, matches v1 logic) */
    _getHealthyPools(): PoolConfig[] {
        const result: PoolConfig[] = [];
        for (const [name, config] of this._configs.entries()) {
            const compatStatus = this._healthChecker.getStatus(name);
            const publicStatus = this.healthStatus.get(name);
            if (compatStatus?.status === 'down' || publicStatus?.status === 'down') {
                continue;
            }
            result.push(config);
        }
        return result;
    }

    /** v1 compat: get raw MongoClient */
    _getPool(name: string): MongoClient | null { return this.pools.get(name)?.client ?? null; }

    /** v1 compat: get pool config list by role */
    _getPoolsByRole(role: PoolRole): PoolConfig[] {
        const result: PoolConfig[] = [];
        for (const [, config] of this._configs.entries()) {
            if (config.role === role) result.push(config);
        }
        return result;
    }

    /** v1 compat: fallback when all pools are down (synchronously returns candidate pool list) */
    _handleAllPoolsDown(operation: string): PoolConfig[] {
        this.logger?.warn?.(`[PoolManager] All pools down, fallback strategy: ${this.fallback.fallbackStrategy}`);
        const { fallbackStrategy } = this.fallback;
        if (fallbackStrategy === 'readonly') {
            if (operation === 'write') return [];
            return this._getPoolsByRole('secondary');
        }
        if (fallbackStrategy === 'secondary') {
            return this._getPoolsByRole('secondary');
        }
        return [];
    }

    private async checkPoolHealth(poolName: string): Promise<void> {
        const managed = this.pools.get(poolName);
        const current = this.healthStatus.get(poolName);
        if (!managed || !current) {
            return;
        }

        try {
            const healthy = await this.healthCheckFn(poolName, managed.client, managed.config);
            current.lastCheckTime = new Date();
            current.uptime = Date.now() - managed.createdAt;
            if (healthy) {
                current.status = 'up';
                current.consecutiveFailures = 0;
                current.lastError = null;
                return;
            }
            current.consecutiveFailures += 1;
            current.status = current.consecutiveFailures > 1 ? 'down' : 'degraded';
        } catch (error) {
            current.lastCheckTime = new Date();
            current.uptime = Date.now() - managed.createdAt;
            current.consecutiveFailures += 1;
            current.lastError = error instanceof Error ? error : new Error(String(error));
            current.status = current.consecutiveFailures > 1 ? 'down' : 'degraded';
            this.logger?.warn?.(`[PoolManager] health check failed for ${poolName}`, current.lastError);
        }
    }

    private recordSelection(poolName: string, success: boolean): void {
        const stats = this.stats.get(poolName);
        if (!stats) {
            return;
        }
        stats.totalRequests += 1;
        if (success) {
            stats.successCount += 1;
        } else {
            stats.errorCount += 1;
        }
        stats.lastRequestTime = new Date();
        stats.errorRate = stats.totalRequests === 0 ? 0 : stats.errorCount / stats.totalRequests;
    }
}

