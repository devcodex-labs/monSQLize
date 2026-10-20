import type { MongoClientOptions } from 'mongodb';

import type { LoggerLike } from './base';

export type PoolRole = 'primary' | 'secondary' | 'analytics' | 'custom';
export type PoolStrategy = 'auto' | 'roundRobin' | 'weighted' | 'leastConnections' | 'manual';
export type FallbackStrategy = 'error' | 'readonly' | 'primary' | 'secondary';

export interface PoolConfig {
    name: string;
    uri: string;
    role?: PoolRole;
    weight?: number;
    tags?: string[];
    options?: MongoClientOptions;
    healthCheck?: {
        enabled?: boolean;
        interval?: number;
        /** Logical deadline; a timed-out underlying ping still occupies its in-flight slot. */
        timeout?: number;
        /** Completed failures required before the pool is marked down. */
        retries?: number;
    };
}

export interface ConnectionPoolManagerOptions {
    pools?: PoolConfig[];
    maxPoolsCount?: number;
    poolStrategy?: PoolStrategy;
    poolFallback?: boolean | {
        enabled?: boolean;
        fallbackStrategy?: FallbackStrategy;
        retryDelay?: number;
        maxRetries?: number;
    };
    logger?: LoggerLike | null;
}

export interface PoolHealthStatus {
    status: 'up' | 'down' | 'degraded';
    consecutiveFailures: number;
    lastCheckTime: Date | null;
    lastError: Error | null;
    uptime: number;
}

export interface PoolStats {
    name: string;
    /** Current active connections (reported by MongoDB driver). v2 extension — v1 fixtures may omit. */
    connections?: number;
    /** Available (idle) connections in the pool. v2 extension — v1 fixtures may omit. */
    available?: number;
    /** Requests currently waiting for a connection. v2 extension — v1 fixtures may omit. */
    waiting?: number;
    /** Health status from the last health check. v2 extension — v1 fixtures may omit. */
    status?: 'up' | 'down' | 'degraded' | 'unknown';
    totalRequests: number;
    successCount: number;
    errorCount: number;
    avgResponseTime: number;
    minResponseTime: number;
    maxResponseTime: number;
    errorRate: number;
    lastRequestTime: Date | null;
}

export declare class ConnectionPoolManager {
    constructor(options?: ConnectionPoolManagerOptions);
    addPool(config: PoolConfig): Promise<void>;
    removePool(name: string): Promise<void>;
    getPool(name: string): unknown | null;
    getPoolNames(): string[];
    selectPool(operation: string, options?: { pool?: string; tags?: string[]; databaseName?: string; poolPreference?: { role?: string; tags?: string[]; }; }): {
        name: string;
        client: unknown;
        db: (name?: string) => unknown;
        collection: (databaseName: string | undefined, collectionName: string) => unknown;
    };
    startHealthCheck(name?: string): void;
    stopHealthCheck(name?: string): void;
    getPoolHealth(): Map<string, PoolHealthStatus>;
    getHealthStatus(): Record<string, PoolHealthStatus>;
    getPoolStats(): Record<string, PoolStats>;
    /** Attempt all closes; retain failed clients for retry. Concurrent calls share the in-flight close. */
    close(): Promise<void>;
}

