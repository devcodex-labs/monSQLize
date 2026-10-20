import type { LoggerLike } from './base';

export interface SlowQueryLogEntry {
    database: string;
    collection: string;
    operation: string;
    durationMs: number;
    query?: unknown;
    timestamp?: Date;
    queryHash?: string;
    metadata?: Record<string, unknown>;
}

export interface SlowQueryLogRecord {
    queryHash: string;
    database: string;
    collection: string;
    operation: string;
    count: number;
    totalTimeMs: number;
    avgTimeMs: number;
    maxTimeMs: number;
    minTimeMs: number;
    firstSeen: Date;
    lastSeen: Date;
    sampleQuery?: unknown;
    metadata?: Record<string, unknown>;
}

export interface SlowQueryLogFilter {
    database?: string;
    collection?: string;
    operation?: string;
    queryHash?: string;
}

export interface SlowQueryLogQueryOptions {
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
}

export interface SlowQueryLogStorageConfig {
    type?: 'memory' | 'mongodb';
    useBusinessConnection?: boolean;
    uri?: string | null;
    database?: string;
    collection?: string;
    ttl?: number;
    options?: Record<string, unknown>;
}

export interface SlowQueryLogConfig {
    enabled: boolean;
    storage: SlowQueryLogStorageConfig;
    batch: {
        enabled: boolean;
        size: number;
        interval: number;
        maxBufferSize: number;
    };
    filter: {
        excludeDatabases: string[];
        excludeCollections: string[];
        excludeOperations: string[];
        minExecutionTimeMs: number;
    };
    advanced: {
        /** Includes initialization failures; throw waits for direct storage even when batching is enabled. */
        errorHandling: 'log' | 'throw' | 'silent';
        /** False skips both TTL and unique-index creation without removing existing indexes. */
        autoCreateIndexes: boolean;
    };
}

export type SlowQueryLogConfigInput = boolean | Partial<SlowQueryLogConfig>;

export interface SlowQueryLogStorage {
    initialize(): Promise<void>;
    save(log: SlowQueryLogEntry): Promise<void>;
    saveBatch(logs: SlowQueryLogEntry[]): Promise<void>;
    query(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    close(): Promise<void>;
}

export declare const DEFAULT_SLOW_QUERY_LOG_CONFIG: SlowQueryLogConfig;
export declare function generateQueryHash(input: unknown): string;

export declare class BatchQueue {
    constructor(storage: Pick<SlowQueryLogStorage, 'saveBatch'>, options?: Partial<SlowQueryLogConfig['batch']>, logger?: LoggerLike | null);
    add(log: SlowQueryLogEntry): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
}

export declare class SlowQueryLogMemoryStorage implements SlowQueryLogStorage {
    initialize(): Promise<void>;
    save(log: SlowQueryLogEntry): Promise<void>;
    saveBatch(logs: SlowQueryLogEntry[]): Promise<void>;
    query(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    close(): Promise<void>;
}

export declare class MongoDBSlowQueryLogStorage implements SlowQueryLogStorage {
    constructor(config?: SlowQueryLogStorageConfig, businessClient?: unknown, logger?: LoggerLike | null);
    initialize(): Promise<void>;
    save(log: SlowQueryLogEntry): Promise<void>;
    saveBatch(logs: SlowQueryLogEntry[]): Promise<void>;
    query(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    close(): Promise<void>;
}

export declare class SlowQueryLogConfigManager {
    static mergeConfig(userConfig?: SlowQueryLogConfigInput, businessType?: string): SlowQueryLogConfig;
    static validate(config: SlowQueryLogConfig, businessType?: string): boolean;
}

export declare class SlowQueryLogManager {
    readonly config: SlowQueryLogConfig;
    readonly storage: SlowQueryLogStorage;
    readonly queue: BatchQueue | null;
    constructor(userConfig?: SlowQueryLogConfigInput, businessClient?: unknown, businessType?: string, logger?: LoggerLike | null);
    initialize(): Promise<void>;
    save(log: SlowQueryLogEntry): Promise<void>;
    query(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    close(): Promise<void>;
}

