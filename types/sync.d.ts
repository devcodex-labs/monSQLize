import type { ChangeStreamDocument, Document, MongoClientOptions } from 'mongodb';

import type { LoggerLike } from './base';

export type SyncChangeEvent<TDocument extends Document = Document> = ChangeStreamDocument<TDocument> & {
    _id?: unknown;
    operationType: 'insert' | 'update' | 'replace' | 'delete';
    ns: {
        db: string;
        coll: string;
    };
    documentKey?: Record<string, unknown>;
    fullDocument?: TDocument;
};

export interface SyncTargetHealthCheckConfig {
    /** Whether to enable health checks; defaults to true. */
    enabled?: boolean;
    /** Health check interval in milliseconds; defaults to 30000. */
    interval?: number;
    /** Timeout for a single health check in milliseconds; defaults to 5000. */
    timeout?: number;
    /** Number of retries after failure; defaults to 3. */
    retries?: number;
}

export interface SyncTargetConfig {
    name: string;
    uri?: string;
    pool?: string;
    databaseName?: string;
    /** Collections handled by this target; omit or pass ['*'] to handle all collections. */
    collections?: string[];
    options?: MongoClientOptions;
    apply?: (event: SyncChangeEvent, document: Record<string, unknown> | undefined, context?: SyncTargetApplyContext) => Promise<void>;
    /** Target node health check configuration. @since v1.0.8 */
    healthCheck?: SyncTargetHealthCheckConfig;
}

export interface SyncTargetApplyContext {
    targetName: string;
    /** Versioned JSON tuple ["v2", keyPrefix, targetName, rawKey]; treat as opaque. */
    idempotencyKey?: string;
}

export interface SyncIdempotencyStoreLike {
    get(key: string): Promise<unknown> | unknown;
    set(key: string, value: unknown, ttl?: number): Promise<unknown> | unknown;
    del?(key: string): Promise<unknown> | unknown;
}

export type SyncIdempotencyMarkMode = 'success' | 'start';

export interface SyncIdempotencyConfig {
    /** Enable runtime per-target idempotency checks. Defaults to false. */
    enabled?: boolean;
    /** Optional durable store; when omitted, an in-memory store is used. */
    store?: SyncIdempotencyStoreLike;
    /** Logical prefix inside the versioned tuple. Defaults to monsqlize:sync:idempotency. */
    keyPrefix?: string;
    /** Marker TTL in milliseconds. Store implementations may ignore it. */
    ttl?: number;
    /** Mark after target success by default; start mode requires target-owned recovery for post-mark failures. */
    markMode?: SyncIdempotencyMarkMode;
    /** Builds the raw event key; null/undefined/empty disables it. Inputs and raw return values are unchanged. */
    keyBuilder?: (event: SyncChangeEvent, targetName: string) => string | null | undefined;
}

export interface ResumeTokenRedisLike {
    get(key: string): Promise<string | null> | string | null;
    set(key: string, value: string): Promise<unknown> | unknown;
    del?(key: string): Promise<unknown> | unknown;
}

/** Stores opaque raw event tokens or a versioned initial EJSON operation-time checkpoint. */
export interface ResumeTokenConfig {
    storage?: 'file' | 'redis';
    path?: string;
    redis?: ResumeTokenRedisLike;
    key?: string;
    /** Throw when a stored resume token cannot be loaded or parsed. Defaults to strictSave. */
    strictLoad?: boolean;
    /** Throw when resume-token persistence fails. Defaults to true for reliable CDC. */
    strictSave?: boolean;
    /** Number of retry attempts after a failed token save. Defaults to 0. */
    saveRetries?: number;
    /** Delay between token-save retries in milliseconds. Defaults to 100. */
    saveRetryDelayMs?: number;
}

export interface SyncConfig {
    enabled: boolean;
    targets: SyncTargetConfig[];
    /** Source collections watched by the manager; omit or pass ['*'] to watch all collections. */
    collections?: string[];
    resumeToken?: ResumeTokenConfig;
    filter?: (event: SyncChangeEvent) => boolean;
    /** Optional per-target idempotency gate for replay protection. */
    idempotency?: SyncIdempotencyConfig;
    /**
     * Transform a change-stream document before forwarding to sync targets.
     * v1 form took a single argument (`doc => ...`); v2 added a second `event` argument.
     * Signature is permissive (`any`) to accept both forms — v1 was never typed.
     */
    transform?: (document: any, event?: SyncChangeEvent) => any;
}

export interface SyncStats {
    isRunning: boolean;
    eventCount: number;
    syncedCount: number;
    errorCount: number;
    startTime: Date | null;
    lastEventTime: Date | null;
    lastError: Error | null;
    tokenSaveErrorCount: number;
    lastTokenSaveError: Error | null;
    duplicateEventCount: number;
    duplicateTargetCount: number;
    targets: Array<{
        name: string;
        syncCount: number;
        errorCount: number;
        duplicateCount: number;
        lastSyncTime: Date | null;
        lastError: Error | null;
        successRate: string;
    }>;
}

export declare function validateSyncConfig(config: SyncConfig): void;

export declare class ResumeTokenStore {
    constructor(options?: ResumeTokenConfig & { logger?: LoggerLike | null; });
    load(): Promise<unknown | null>;
    save(token: unknown): Promise<void>;
    clear(): Promise<void>;
}

export declare class ChangeStreamSyncManager {
    constructor(options: {
        db: unknown;
        poolManager?: unknown;
        config: SyncConfig;
        logger?: LoggerLike | null;
    });
    start(): Promise<void>;
    stop(): Promise<void>;
    getStats(): SyncStats;
}

