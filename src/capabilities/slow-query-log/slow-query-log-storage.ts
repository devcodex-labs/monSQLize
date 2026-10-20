/**
 * Slow query log storage backend implementations.
 *
 * Provides two backends: in-memory storage (SlowQueryLogMemoryStorage)
 * and MongoDB persistent storage (MongoDBSlowQueryLogStorage).
 */
import type { Collection, Document, MongoClient, MongoClientOptions } from 'mongodb';
import { MongoClient as MongoDriverClient } from 'mongodb';
import { ErrorCodes, createError } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type {
    SlowQueryLogEntry,
    SlowQueryLogFilter,
    SlowQueryLogQueryOptions,
    SlowQueryLogRecord,
    SlowQueryLogStorage,
    SlowQueryLogStorageConfig,
} from '../../../types/slow-query-log';
import { DEFAULT_SLOW_QUERY_LOG_CONFIG, type NormalizedSlowQueryLogStorageConfig } from './slow-query-log-config';
import {
    cloneSlowQueryLogRecord,
    matchesSlowQueryLogFilter,
    mergeSlowQueryLogRecord,
    normalizeSlowQueryLogEntry,
    recordKey,
    sortSlowQueryLogRecords,
    toMongoFilter,
} from './slow-query-log-records';

async function defaultClientFactory(uri: string, options?: MongoClientOptions): Promise<MongoClient> {
    const client = new MongoDriverClient(uri, options);
    await client.connect();
    return client;
}

/** Event timestamps may arrive out of order across queues or manager instances. */
function buildSlowQueryLogUpdate(record: SlowQueryLogRecord): Document {
    return {
        $setOnInsert: {
            queryHash: record.queryHash, database: record.database,
            collection: record.collection, operation: record.operation,
        },
        $set: { sampleQuery: record.sampleQuery, metadata: record.metadata },
        $inc: { count: 1, totalTimeMs: record.totalTimeMs },
        $min: { firstSeen: record.firstSeen, minTimeMs: record.minTimeMs },
        $max: { lastSeen: record.lastSeen, maxTimeMs: record.maxTimeMs },
    };
}

export class SlowQueryLogMemoryStorage implements SlowQueryLogStorage {
    private readonly records = new Map<string, SlowQueryLogRecord>();

    async initialize(): Promise<void> {
        return undefined;
    }

    async save(log: SlowQueryLogEntry): Promise<void> {
        this.upsertRecord(log);
    }

    async saveBatch(logs: SlowQueryLogEntry[]): Promise<void> {
        for (const log of logs) {
            this.upsertRecord(log);
        }
    }

    async query(filter: SlowQueryLogFilter = {}, options: SlowQueryLogQueryOptions = {}): Promise<SlowQueryLogRecord[]> {
        let records = [...this.records.values()].filter((record) => matchesSlowQueryLogFilter(record, filter));
        records = sortSlowQueryLogRecords(records, options.sort);
        if (options.skip) {
            records = records.slice(options.skip);
        }
        if (options.limit) {
            records = records.slice(0, options.limit);
        }
        return records.map(cloneSlowQueryLogRecord);
    }

    async close(): Promise<void> {
        return undefined;
    }

    private upsertRecord(log: SlowQueryLogEntry): void {
        const normalized = normalizeSlowQueryLogEntry(log);
        const key = recordKey(normalized);
        const existing = this.records.get(key);
        this.records.set(key, mergeSlowQueryLogRecord(existing, normalized));
    }
}

export class MongoDBSlowQueryLogStorage implements SlowQueryLogStorage {
    private readonly logger: LoggerLike | null;
    private readonly businessClient: MongoClient | null;
    private readonly config: NormalizedSlowQueryLogStorageConfig;
    private readonly clientFactory: (uri: string, options?: MongoClientOptions) => Promise<MongoClient>;
    private readonly autoCreateIndexes: boolean;
    private client: MongoClient | null = null;
    private collectionRef: Collection | null = null;
    private _initializingPromise: Promise<void> | null = null;
    private closingPromise: Promise<void> | null = null;
    private generation = 0;
    private closePending = false;

    constructor(
        config: SlowQueryLogStorageConfig = {},
        businessClient: MongoClient | null = null,
        logger: LoggerLike | null = null,
        clientFactory: (uri: string, options?: MongoClientOptions) => Promise<MongoClient> = defaultClientFactory,
        options: { autoCreateIndexes?: boolean } = {},
    ) {
        this.logger = logger;
        this.businessClient = businessClient;
        this.clientFactory = clientFactory;
        this.autoCreateIndexes = options.autoCreateIndexes !== false;
        this.config = {
            ...config,
            database: config.database ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.storage.database ?? 'admin',
            collection: config.collection ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.storage.collection ?? 'slow_query_logs',
            ttl: config.ttl ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.storage.ttl ?? 7 * 24 * 3600,
        };
    }

    async initialize(): Promise<void> {
        if (this.closingPromise) {
            await this.closingPromise;
            throw createError(ErrorCodes.CONNECTION_CLOSED, 'Slow query log storage was closed during initialization.');
        }
        this.assertGeneration(this.generation);
        if (this.collectionRef) {
            return;
        }
        if (this._initializingPromise) {
            return this._initializingPromise;
        }
        const generation = this.generation;
        this._initializingPromise = (async () => {
            const client = await this.resolveClient();
            this.assertGeneration(generation);
            const collection = client.db(this.config.database).collection(this.config.collection);
            if (this.autoCreateIndexes) {
            if (this.config.ttl && this.config.ttl > 0) {
                await collection.createIndex({ lastSeen: 1 }, { expireAfterSeconds: this.config.ttl, name: 'slow_query_lastSeen_ttl' });
            }
            await collection.createIndex(
                { queryHash: 1, database: 1, collection: 1, operation: 1 },
                { unique: true, name: 'slow_query_log_unique' },
            );
            }
            this.assertGeneration(generation);
            this.collectionRef = collection;
        })().finally(() => {
            this._initializingPromise = null;
        });
        return this._initializingPromise;
    }

    async save(log: SlowQueryLogEntry): Promise<void> {
        const collection = await this.getCollection();
        const record = normalizeSlowQueryLogEntry(log);
        await collection.updateOne(
            {
                queryHash: record.queryHash,
                database: record.database,
                collection: record.collection,
                operation: record.operation,
            },
            buildSlowQueryLogUpdate(record),
            { upsert: true },
        );
    }

    async saveBatch(logs: SlowQueryLogEntry[]): Promise<void> {
        if (logs.length === 0) return;
        if (logs.length === 1) {
            await this.save(logs[0]);
            return;
        }
        const collection = await this.getCollection();
        const operations = logs.map((log) => {
            const record = normalizeSlowQueryLogEntry(log);
            return {
                updateOne: {
                    filter: {
                        queryHash: record.queryHash,
                        database: record.database,
                        collection: record.collection,
                        operation: record.operation,
                    },
                    update: buildSlowQueryLogUpdate(record),
                    upsert: true,
                },
            };
        });
        await collection.bulkWrite(operations, { ordered: false });
    }

    async query(filter: SlowQueryLogFilter = {}, options: SlowQueryLogQueryOptions = {}): Promise<SlowQueryLogRecord[]> {
        const collection = await this.getCollection();
        const sort = options.sort ?? { lastSeen: -1 as const };
        let rows: Document[];
        if (Object.prototype.hasOwnProperty.call(sort, 'avgTimeMs')) {
            // Compute the virtual field before sorting and selecting the page.
            const pipeline: Document[] = [
                { $match: toMongoFilter(filter) },
                { $set: { avgTimeMs: { $cond: [
                    { $gt: [{ $ifNull: ['$count', 0] }, 0] },
                    { $divide: [{ $ifNull: ['$totalTimeMs', 0] }, '$count'] },
                    0,
                ] } } },
                { $sort: sort },
            ];
            if (options.skip) pipeline.push({ $skip: options.skip });
            if (options.limit) pipeline.push({ $limit: Math.abs(options.limit) });
            rows = await collection.aggregate(pipeline).toArray();
        } else {
            const cursor = collection.find(toMongoFilter(filter)).sort(sort);
            if (options.skip) cursor.skip(options.skip);
            if (options.limit) cursor.limit(options.limit);
            rows = await cursor.toArray();
        }
        return rows.map((row) => ({
            queryHash: String(row.queryHash),
            database: String(row.database),
            collection: String(row.collection),
            operation: String(row.operation),
            count: Number(row.count ?? 0),
            totalTimeMs: Number(row.totalTimeMs ?? 0),
            avgTimeMs: Number(row.count ?? 0) > 0 ? Number(row.totalTimeMs ?? 0) / Number(row.count ?? 1) : 0,
            maxTimeMs: Number(row.maxTimeMs ?? 0),
            minTimeMs: Number(row.minTimeMs ?? 0),
            firstSeen: new Date(row.firstSeen),
            lastSeen: new Date(row.lastSeen),
            sampleQuery: row.sampleQuery,
            metadata: row.metadata,
        }));
    }

    async close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        this.generation++;
        this.closePending = true;
        this.collectionRef = null;
        const closing = (async () => {
            await this._initializingPromise?.catch(() => undefined);
            if (this.client && this.client !== this.businessClient) await this.client.close();
            this.client = null;
            this.collectionRef = null;
            this.closePending = false;
        })();
        this.closingPromise = closing;
        try {
            await closing;
        } finally {
            if (this.closingPromise === closing) this.closingPromise = null;
        }
    }

    private assertGeneration(generation: number): void {
        if (generation !== this.generation || this.closePending) {
            throw createError(ErrorCodes.CONNECTION_CLOSED, 'Slow query log storage initialization was superseded by close; retry after cleanup.');
        }
    }

    private async getCollection(): Promise<Collection> {
        const generation = this.generation;
        await this.initialize();
        this.assertGeneration(generation);
        return this.collectionRef!;
    }

    private async resolveClient(): Promise<MongoClient> {
        if (this.client) {
            return this.client;
        }
        if (this.config.useBusinessConnection !== false && this.businessClient) {
            this.client = this.businessClient;
            return this.client;
        }
        if (!this.config.uri) {
            throw createError(ErrorCodes.INVALID_CONFIG, 'slowQueryLog.storage.uri is required when useBusinessConnection is false.');
        }
        this.client = await this.clientFactory(this.config.uri, this.config.options);
        return this.client;
    }
}
