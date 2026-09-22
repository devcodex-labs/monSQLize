/**
 * Change Stream sync capability.
 *
 * Description:
 * - Responsible for sync config validation, resume token persistence, and manager lifecycle.
 * - Public and shared types are managed by `types/sync.d.ts`; only runtime implementation and internal helper types are kept here.
 */

import type { ChangeStream, Db, Document, MongoClient, MongoClientOptions } from 'mongodb';
import { MongoClient as MongoDriverClient } from 'mongodb';
import { ErrorCodes, createError } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type { ConnectionPoolManager } from '../pool';
import type {
    SyncChangeEvent,
    SyncConfig,
    SyncIdempotencyConfig,
    SyncIdempotencyMarkMode,
    SyncIdempotencyStoreLike,
    SyncTargetApplyContext,
    SyncStats,
    SyncTargetConfig,
} from '../../../types/sync';
import {
    defaultSyncEventIdentity,
    normalizeSyncKeyValue,
    resolveSyncIdempotencyRuntime,
    stableSyncKeyString,
    type SyncIdempotencyRuntime,
    validateSyncIdempotencyConfig,
} from './idempotency';
import { normalizeError, ResumeTokenStore, validateResumeTokenConfig, type ResumeTokenStoreLike } from './resume-token-store';
export { ResumeTokenStore, validateResumeTokenConfig } from './resume-token-store';

export type {
    ResumeTokenConfig,
    ResumeTokenRedisLike,
    SyncChangeEvent,
    SyncConfig,
    SyncIdempotencyConfig,
    SyncIdempotencyMarkMode,
    SyncIdempotencyStoreLike,
    SyncTargetApplyContext,
    SyncStats,
    SyncTargetConfig,
} from '../../../types/sync';

interface ResolvedTarget {
    name: string;
    apply(event: SyncChangeEvent, document: Document | undefined, context?: SyncTargetApplyContext): Promise<void>;
    close(): Promise<void>;
    collections: Set<string> | null;
    stats: {
        syncCount: number;
        errorCount: number;
        duplicateCount: number;
        lastSyncTime: Date | null;
        lastError: Error | null;
    };
}

interface ChangeStreamSyncManagerOptions {
    db: Db;
    poolManager?: ConnectionPoolManager | null;
    config: SyncConfig;
    logger?: LoggerLike | null;
    tokenStore?: ResumeTokenStoreLike;
    clientFactory?: (uri: string, options?: MongoClientOptions) => Promise<MongoClient>;
}

function normalizeCollectionFilter(collections: string[] | undefined): Set<string> | null {
    if (!collections?.length || collections.includes('*')) {
        return null;
    }
    return new Set(collections);
}

/**
 * Validates a single sync target configuration entry.
 * @param target - Target config to validate.
 * @param index  - Position in the targets array (used in error messages).
 * @throws {MonSQLizeError} When the target configuration is invalid.
 * @since v1.7.0
 */
export function validateTargetConfig(target: SyncTargetConfig | null | undefined, index: number): void {
    if (!target || typeof target !== 'object') {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}] must be an object.`);
    }
    if (typeof target.name !== 'string' || target.name.trim() === '') {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].name must be a non-empty string.`);
    }
    if (!target.apply && !target.uri && !target.pool) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}] requires one of apply / uri / pool.`);
    }
    if (target.uri !== undefined && (typeof target.uri !== 'string' || target.uri.trim() === '')) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].uri must be a non-empty string when provided.`);
    }
    if (target.pool !== undefined && (typeof target.pool !== 'string' || target.pool.trim() === '')) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].pool must be a non-empty string when provided.`);
    }
    if (target.databaseName !== undefined && (typeof target.databaseName !== 'string' || target.databaseName.trim() === '')) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].databaseName must be a non-empty string when provided.`);
    }
    if (target.collections !== undefined && (!Array.isArray(target.collections) || target.collections.length === 0)) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].collections must be a non-empty array when provided.`);
    }
    if (target.collections?.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].collections must contain non-empty strings.`);
    }
    if (target.apply !== undefined && typeof target.apply !== 'function') {
        throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] targets[${index}].apply must be a function when provided.`);
    }
}

/**
 * Validates a {@link SyncConfig} object and throws a descriptive error on failure.
 * @param config - Sync configuration to validate.
 * @throws {MonSQLizeError} When the configuration is invalid.
 * @since v1.7.0
 */
export function validateSyncConfig(config: SyncConfig): void {
    if (!config || typeof config !== 'object') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] config must be an object.');
    }
    if (typeof config.enabled !== 'boolean') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] enabled must be a boolean.');
    }
    if (!config.enabled) {
        return;
    }
    if (!Array.isArray(config.targets) || config.targets.length === 0) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] targets must be a non-empty array.');
    }
    if (config.collections !== undefined && (!Array.isArray(config.collections) || config.collections.length === 0)) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] collections must be a non-empty array when provided.');
    }
    if (config.collections?.some((item) => typeof item !== 'string' || item.trim() === '')) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] collections must contain non-empty strings.');
    }
    if (config.filter !== undefined && typeof config.filter !== 'function') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] filter must be a function.');
    }
    if (config.transform !== undefined && typeof config.transform !== 'function') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] transform must be a function.');
    }
    validateSyncIdempotencyConfig(config.idempotency);

    config.targets.forEach((target, index) => {
        validateTargetConfig(target as SyncTargetConfig | null, index);
    });

    if (config.resumeToken) {
        validateResumeTokenConfig(config.resumeToken);
    }
}

/**
 * Watches a MongoDB change stream and fans out change events to configured
 * sync targets (remote MongoDB, Redis pub/sub, or custom callbacks).
 * @since v1.7.0
 */
export class ChangeStreamSyncManager {
    private readonly db: Db;
    private readonly poolManager: ConnectionPoolManager | null;
    private readonly config: SyncConfig;
    private readonly logger: LoggerLike | null;
    private readonly tokenStore: ResumeTokenStoreLike;
    private readonly clientFactory: (uri: string, options?: MongoClientOptions) => Promise<MongoClient>;
    private readonly idempotency: SyncIdempotencyRuntime;
    private readonly targets: ResolvedTarget[] = [];
    private changeStream: ChangeStream | null = null;
    private startPromise: Promise<void> | null = null;
    private closingStreamPromise: Promise<void> | null = null;
    private changeQueue: Promise<void> = Promise.resolve();
    private running = false;
    private stopping = false;
    private stopPromise: Promise<void> | null = null;
    private fatalSyncError: Error | null = null;
    private generation = 0;
    private readonly stats = {
        eventCount: 0,
        syncedCount: 0,
        errorCount: 0,
        startTime: null as Date | null,
        lastEventTime: null as Date | null,
        lastError: null as Error | null,
        tokenSaveErrorCount: 0,
        lastTokenSaveError: null as Error | null,
        duplicateEventCount: 0,
        duplicateTargetCount: 0,
    };

    constructor(options: ChangeStreamSyncManagerOptions) {
        validateSyncConfig(options.config);
        this.db = options.db;
        this.poolManager = options.poolManager ?? null;
        this.config = options.config;
        this.logger = options.logger ?? null;
        this.tokenStore = options.tokenStore ?? new ResumeTokenStore({
            ...options.config.resumeToken,
            logger: options.logger ?? null,
        });
        this.clientFactory = options.clientFactory ?? defaultClientFactory;
        this.idempotency = resolveSyncIdempotencyRuntime(options.config.idempotency);
        if (options.config.idempotency?.enabled === true && options.config.idempotency.store === undefined) {
            this.logger?.warn?.('[Sync] sync.idempotency is enabled without a durable store; the memory fallback only protects replay within the current process.');
        }
    }

    /**
     * Start Change Stream synchronization.
     * @since v1.0.9
     */
    async start(): Promise<void> {
        if (this.stopPromise) await this.stopPromise;
        if (this.running || !this.config.enabled) return;
        if (this.startPromise) return this.startPromise;

        const generation = ++this.generation;
        const startup = (async () => {
            await this.closingStreamPromise;
            await this.changeQueue.catch(() => undefined);
            this.assertCurrentGeneration(generation, true);
            if (this.running) return;
            this.fatalSyncError = null;

            await this.closeTargets();
            let stagedTargets: ResolvedTarget[] = [];
            let stream: ChangeStream | null = null;
            try {
                await this.validateEnvironment();
                this.assertCurrentGeneration(generation);
                stagedTargets = await this.initializeTargets();
                this.assertCurrentGeneration(generation);

                const resumeAfter = await this.tokenStore.load();
                this.assertCurrentGeneration(generation);
                const options: Record<string, unknown> = { fullDocument: 'updateLookup' };
                if (resumeAfter) options.resumeAfter = resumeAfter;

                stream = this.db.watch(this.buildPipeline(), options as Parameters<Db['watch']>[1]);
                const activeStream = stream;
                activeStream.on('change', (event) => this.enqueueChange(event as SyncChangeEvent<Document>, generation));
                activeStream.on('error', (error) => {
                    if (generation !== this.generation) return;
                    const normalized = normalizeError(error);
                    this.stats.errorCount += 1;
                    this.stats.lastError = normalized;
                    this.logger?.error?.('[Sync] change stream error', normalized);
                    this.stopAfterFatalSyncError(normalized, generation);
                });
                activeStream.on('close', () => {
                    if (generation !== this.generation || !this.running || this.changeStream !== activeStream) {
                        this.logger?.debug?.('[Sync] change stream closed');
                        return;
                    }
                    const error = createError(ErrorCodes.CONNECTION_CLOSED, '[Sync] change stream closed unexpectedly');
                    this.stats.errorCount += 1;
                    this.stats.lastError = error;
                    this.logger?.warn?.('[Sync] change stream closed unexpectedly', error);
                    this.stopAfterFatalSyncError(error, generation);
                });

                this.assertCurrentGeneration(generation);
                this.targets.push(...stagedTargets);
                stagedTargets = [];
                this.changeStream = activeStream;
                stream = null;
                this.running = true;
                this.stats.startTime = new Date();
            } catch (error) {
                if (stream) await this.closeChangeStream(stream).catch(() => undefined);
                for (const target of stagedTargets.reverse()) await target.close().catch(() => undefined);
                throw error;
            }
        })();
        this.startPromise = startup;
        try {
            await startup;
        } finally {
            if (this.startPromise === startup) this.startPromise = null;
        }
    }

    /**
     * Stop Change Stream synchronization.
     * @since v1.0.9
     */
    async stop(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.stopping = true;
        const cleanup = (async () => {
            if (this.startPromise && !this.running) this.generation += 1;
            await this.startPromise?.catch(() => undefined);
            await this.changeQueue.catch(() => undefined);
            this.generation += 1;
            this.running = false;
            const stream = this.changeStream;
            this.changeStream = null;
            if (stream) await this.closeChangeStream(stream);
            else await this.closingStreamPromise;
            await this.closeTargets();
        })();
        this.stopPromise = cleanup;
        try {
            await cleanup;
        } finally {
            if (this.stopPromise === cleanup) this.stopPromise = null;
            this.stopping = false;
        }
    }

    private assertCurrentGeneration(generation: number, allowPreviousFatal = false): void {
        if (generation !== this.generation) {
            throw createError(ErrorCodes.CONNECTION_CLOSED, '[Sync] startup was superseded by stop or restart');
        }
        if (!allowPreviousFatal && this.fatalSyncError) throw this.fatalSyncError;
    }

    private async closeTargets(): Promise<void> {
        while (this.targets.length > 0) {
            await this.targets.pop()?.close();
        }
    }

    /**
     * Get current statistics.
     * @since v1.0.9
     */
    getStats(): SyncStats {
        return {
            isRunning: this.running,
            eventCount: this.stats.eventCount,
            syncedCount: this.stats.syncedCount,
            errorCount: this.stats.errorCount,
            startTime: this.stats.startTime,
            lastEventTime: this.stats.lastEventTime,
            lastError: this.stats.lastError,
            tokenSaveErrorCount: this.stats.tokenSaveErrorCount,
            lastTokenSaveError: this.stats.lastTokenSaveError,
            duplicateEventCount: this.stats.duplicateEventCount,
            duplicateTargetCount: this.stats.duplicateTargetCount,
            targets: this.targets.map((target) => ({
                name: target.name,
                syncCount: target.stats.syncCount,
                errorCount: target.stats.errorCount,
                duplicateCount: target.stats.duplicateCount,
                lastSyncTime: target.stats.lastSyncTime,
                lastError: target.stats.lastError,
                successRate: target.stats.syncCount + target.stats.errorCount === 0
                    ? '0%'
                    : `${((target.stats.syncCount / (target.stats.syncCount + target.stats.errorCount)) * 100).toFixed(2)}%`,
            })),
        };
    }

    private async validateEnvironment(): Promise<void> {
        try {
            const probe = this.db.watch([], { maxAwaitTimeMS: 1 });
            await probe.close();
        } catch (error) {
            throw createError(
                ErrorCodes.INVALID_CONFIG,
                'Change Stream requires a MongoDB replica set or sharded cluster.',
                undefined,
                error instanceof Error ? error : undefined,
            );
        }
    }

    private buildPipeline(): Document[] {
        const pipeline: Document[] = [
            {
                $match: {
                    operationType: {
                        $in: ['insert', 'update', 'replace', 'delete'],
                    },
                },
            },
        ];

        const collections = normalizeCollectionFilter(this.config.collections);
        if (collections) {
            pipeline.unshift({
                $match: {
                    'ns.coll': { $in: [...collections] },
                },
            });
        }

        return pipeline;
    }

    private async initializeTargets(): Promise<ResolvedTarget[]> {
        const staged: ResolvedTarget[] = [];
        try {
            for (const target of this.config.targets) staged.push(await this.resolveTarget(target));
            return staged;
        } catch (error) {
            for (const target of staged.reverse()) await target.close().catch(() => undefined);
            throw error;
        }
    }

    private async resolveTarget(target: SyncTargetConfig): Promise<ResolvedTarget> {
        const collections = normalizeCollectionFilter(target.collections);
        if (target.apply) {
            return {
                name: target.name,
                collections,
                apply: target.apply,
                close: async () => {},
                stats: {
                    syncCount: 0,
                    errorCount: 0,
                    duplicateCount: 0,
                    lastSyncTime: null,
                    lastError: null,
                },
            };
        }

        if (target.pool) {
            if (!this.poolManager) {
                throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] target '${target.name}' requires poolManager when pool is provided.`);
            }
            const selected = this.poolManager.selectPool('write', {
                pool: target.pool,
                databaseName: target.databaseName ?? this.db.databaseName,
            });
            return createMongoTarget(target.name, collections, selected.client, target.databaseName ?? this.db.databaseName, false);
        }

        if (!target.uri) {
            throw createError(ErrorCodes.INVALID_CONFIG, `[Sync] target '${target.name}' requires uri when pool/apply are not provided.`);
        }

        const client = await this.clientFactory(target.uri, target.options);
        return createMongoTarget(target.name, collections, client, target.databaseName ?? this.db.databaseName, true);
    }

    private async handleChange(event: SyncChangeEvent<Document>, generation = this.generation): Promise<void> {
        if (generation !== this.generation || !this.running || this.fatalSyncError) {
            this.logger?.warn?.('[Sync] skipping queued change after fatal sync error', this.fatalSyncError);
            return;
        }
        this.stats.eventCount += 1;
        this.stats.lastEventTime = new Date();

        if (this.config.filter && !this.config.filter(event)) {
            await this.saveProcessedToken(event, generation);
            return;
        }

        let document = event.fullDocument as Document | undefined;
        if (this.config.transform) {
            document = this.config.transform(document, event);
        }

        let eligibleTargets = 0;
        let succeeded = 0;
        let duplicateTargets = 0;
        const targetErrors: Error[] = [];
        for (const target of this.targets) {
            if (generation !== this.generation || this.fatalSyncError || !this.running) return;
            if (target.collections && !target.collections.has(event.ns.coll)) {
                continue;
            }
            eligibleTargets += 1;
            try {
                const idempotencyKey = this.buildTargetIdempotencyKey(target.name, event);
                if (idempotencyKey && await this.hasAppliedTargetEvent(idempotencyKey)) {
                    target.stats.duplicateCount += 1;
                    this.stats.duplicateTargetCount += 1;
                    duplicateTargets += 1;
                    succeeded += 1;
                    continue;
                }
                if (idempotencyKey && this.idempotency.markMode === 'start') {
                    await this.markTargetEventApplied(idempotencyKey, event, target.name, 'start');
                }
                if (generation !== this.generation || this.fatalSyncError || !this.running) return;
                await target.apply(event, document, {
                    targetName: target.name,
                    ...(idempotencyKey ? { idempotencyKey } : {}),
                });
                if (idempotencyKey && this.idempotency.markMode === 'success') {
                    if (generation !== this.generation || this.fatalSyncError || !this.running) return;
                    await this.markTargetEventApplied(idempotencyKey, event, target.name, 'success');
                }
                target.stats.syncCount += 1;
                target.stats.lastSyncTime = new Date();
                target.stats.lastError = null;
                succeeded += 1;
            } catch (error) {
                const normalized = error instanceof Error ? error : new Error(String(error));
                target.stats.errorCount += 1;
                target.stats.lastError = normalized;
                this.stats.errorCount += 1;
                this.stats.lastError = normalized;
                this.logger?.error?.('[Sync] target apply failed', {
                    target: target.name,
                    error: normalized,
                });
                targetErrors.push(normalized);
            }
        }

        if (targetErrors.length > 0) {
            this.stopAfterFatalSyncError(targetErrors[0] as Error, generation);
            return;
        }

        if (succeeded === eligibleTargets) {
            await this.saveProcessedToken(event, generation);
            if (duplicateTargets > 0 && duplicateTargets === eligibleTargets) {
                this.stats.duplicateEventCount += 1;
            }
        }
    }

    private async saveProcessedToken(event: SyncChangeEvent<Document>, generation: number): Promise<void> {
        if (generation !== this.generation || this.fatalSyncError || !this.running) return;
        try {
            await this.tokenStore.save(event._id);
        } catch (error) {
            const normalized = normalizeError(error);
            this.stats.tokenSaveErrorCount += 1;
            this.stats.lastTokenSaveError = normalized;
            this.stats.lastError = normalized;
            this.stopAfterFatalSyncError(normalized, generation);
            throw normalized;
        }
        if (generation === this.generation && !this.fatalSyncError && this.running) this.stats.syncedCount += 1;
    }

    private buildTargetIdempotencyKey(targetName: string, event: SyncChangeEvent<Document>): string | null {
        if (!this.idempotency.enabled) {
            return null;
        }
        const rawKey = this.idempotency.keyBuilder
            ? this.idempotency.keyBuilder(event, targetName)
            : stableSyncKeyString(defaultSyncEventIdentity(event));
        if (rawKey === null || rawKey === undefined || rawKey === '') {
            return null;
        }
        return `${this.idempotency.keyPrefix}:${targetName}:${rawKey}`;
    }

    private async hasAppliedTargetEvent(key: string): Promise<boolean> {
        const value = await Promise.resolve(this.idempotency.store.get(key));
        return value !== undefined && value !== null && value !== false;
    }

    private async markTargetEventApplied(
        key: string,
        event: SyncChangeEvent<Document>,
        targetName: string,
        phase: SyncIdempotencyMarkMode,
    ): Promise<void> {
        await Promise.resolve(this.idempotency.store.set(key, {
            phase,
            target: targetName,
            eventId: normalizeSyncKeyValue(defaultSyncEventIdentity(event)),
            ts: Date.now(),
        }, this.idempotency.ttl));
    }

    private stopAfterFatalSyncError(error: Error, generation: number): void {
        if (generation !== this.generation) return;
        this.fatalSyncError = error;
        this.running = false;
        const stream = this.changeStream;
        this.changeStream = null;
        if (stream) {
            void this.closeChangeStream(stream).catch((closeError) => {
                this.logger?.warn?.('[Sync] failed to close change stream after fatal error', closeError);
            });
        }
    }

    private closeChangeStream(stream: ChangeStream): Promise<void> {
        const closing = Promise.resolve(stream.close()).then(() => undefined);
        this.closingStreamPromise = closing;
        return closing.finally(() => {
            if (this.closingStreamPromise === closing) this.closingStreamPromise = null;
        });
    }

    private enqueueChange(event: SyncChangeEvent<Document>, generation: number): void {
        if (generation !== this.generation || !this.running || this.stopping || this.fatalSyncError) return;
        this.changeQueue = this.changeQueue
            .then(() => this.handleChange(event, generation))
            .catch((error) => {
                const normalized = normalizeError(error);
                this.stats.errorCount += 1;
                this.stats.lastError = normalized;
                this.logger?.error?.('[Sync] change handling failed', normalized);
                this.stopAfterFatalSyncError(normalized, generation);
            });
    }
}


function createMongoTarget(
    name: string,
    collections: Set<string> | null,
    client: MongoClient,
    databaseName: string,
    ownsConnection: boolean,
): ResolvedTarget {
    return {
        name,
        collections,
        async apply(event, document) {
            const collection = client.db(databaseName).collection(event.ns.coll);
            if (event.operationType === 'delete') {
                await collection.deleteOne(event.documentKey as Document);
                return;
            }
            if (!document) {
                return;
            }
            const key = event.documentKey as Document | undefined;
            const filter = key && Object.keys(key).length > 0
                ? key
                : { _id: document._id };
            await collection.replaceOne(filter, document, { upsert: true });
        },
        async close() {
            if (ownsConnection) {
                await client.close();
            }
        },
        stats: {
            syncCount: 0,
            errorCount: 0,
            duplicateCount: 0,
            lastSyncTime: null,
            lastError: null,
        },
    };
}

async function defaultClientFactory(uri: string, options?: MongoClientOptions): Promise<MongoClient> {
    const client = new MongoDriverClient(uri, options);
    await client.connect();
    return client;
}

