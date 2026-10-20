/**
 * Slow query log manager.
 *
 * Manages the slow query log lifecycle: initializing the storage backend,
 * delegating record writes, and exposing query and cleanup interfaces.
 */
import type { MongoClient } from 'mongodb';
import type { LoggerLike } from '../../core/logger';
import { createError, ErrorCodes } from '../../core/errors';
import type {
    SlowQueryLogConfig,
    SlowQueryLogConfigInput,
    SlowQueryLogEntry,
    SlowQueryLogFilter,
    SlowQueryLogQueryOptions,
    SlowQueryLogRecord,
    SlowQueryLogStorage,
} from '../../../types/slow-query-log';
import { BatchQueue } from './slow-query-log-batch-queue';
import { SlowQueryLogConfigManager } from './slow-query-log-config';
import { handleSlowQueryLogError } from './slow-query-log-records';
import { MongoDBSlowQueryLogStorage, SlowQueryLogMemoryStorage } from './slow-query-log-storage';

export class SlowQueryLogManager {
    readonly config: SlowQueryLogConfig;
    readonly storage: SlowQueryLogStorage;
    readonly queue: BatchQueue | null;
    private readonly logger: LoggerLike | null;
    private initialized = false;
    private _initializingPromise: Promise<void> | null = null;
    private readonly accepted = new Set<Promise<unknown>>();
    private closingPromise: Promise<void> | null = null;
    private cleanupPending = false;

    constructor(
        userConfig?: SlowQueryLogConfigInput,
        businessClient: MongoClient | null = null,
        businessType = 'mongodb',
        logger: LoggerLike | null = null,
        options: { storage?: SlowQueryLogStorage } = {},
    ) {
        this.logger = logger;
        this.config = SlowQueryLogConfigManager.mergeConfig(userConfig, businessType);
        SlowQueryLogConfigManager.validate(this.config, businessType);
        this.storage = options.storage
            ?? (this.config.storage.type === 'memory'
                ? new SlowQueryLogMemoryStorage()
                : new MongoDBSlowQueryLogStorage(this.config.storage, businessClient, logger, undefined, { autoCreateIndexes: this.config.advanced.autoCreateIndexes }));
        this.queue = this.config.batch.enabled && this.config.advanced.errorHandling !== 'throw' ? new BatchQueue(this.storage, this.config.batch, logger, this.config.advanced.errorHandling) : null;
    }

    async initialize(): Promise<void> {
        return this.acceptOperation(() => this.initializeAccepted());
    }

    private async initializeAccepted(): Promise<void> {
        if (this.initialized || !this.config.enabled) {
            return;
        }
        if (this._initializingPromise) {
            return this._initializingPromise;
        }
        this._initializingPromise = this.storage.initialize().then(() => {
            this.initialized = true;
        }).finally(() => {
            this._initializingPromise = null;
        });
        return this._initializingPromise;
    }

    async save(log: SlowQueryLogEntry): Promise<void> {
        if (!this.config.enabled || this.shouldFilter(log)) {
            return;
        }
        try {
            await this.acceptOperation(async () => {
                await this.initializeAccepted();
                if (this.queue) await this.queue.add(log);
                else await this.storage.save(log);
            });
        } catch (error) {
            handleSlowQueryLogError(this.logger, this.config.advanced.errorHandling, error);
        }
    }

    async query(filter: SlowQueryLogFilter = {}, options: SlowQueryLogQueryOptions = {}): Promise<SlowQueryLogRecord[]> {
        return this.acceptOperation(async () => {
            await this.initializeAccepted();
            return this.storage.query(filter, options);
        });
    }

    close(): Promise<void> {
        if (this.closingPromise) return this.closingPromise;
        // Seal synchronously so calls arriving during close cannot reopen this lifecycle.
        this.cleanupPending = true;
        const accepted = [...this.accepted];
        const closing = Promise.resolve().then(async () => {
            await Promise.allSettled(accepted);
            const errors: unknown[] = [];
            try { await this.queue?.close(); } catch (error) { errors.push(error); }
            try { await this.storage.close(); } catch (error) { errors.push(error); }
            this.initialized = false;
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Slow query log cleanup failed.');
            this.cleanupPending = false;
        });
        const result = closing.finally(() => {
            if (this.closingPromise === result) this.closingPromise = null;
        });
        this.closingPromise = result;
        return result;
    }

    /** Registers the complete operation before dispatch, including lazy initialization. */
    private acceptOperation<T>(operation: () => Promise<T>): Promise<T> {
        if (this.cleanupPending || this.closingPromise) {
            return Promise.reject(createError(ErrorCodes.CONNECTION_CLOSED, 'Slow query log manager is closing; retry after cleanup.'));
        }
        const task = Promise.resolve().then(operation);
        this.accepted.add(task);
        return task.finally(() => { this.accepted.delete(task); });
    }

    private shouldFilter(log: SlowQueryLogEntry): boolean {
        const { filter } = this.config;
        if (filter.excludeDatabases.includes(log.database)) {
            return true;
        }
        if (filter.excludeCollections.includes(log.collection)) {
            return true;
        }
        if (filter.excludeOperations.includes(log.operation)) {
            return true;
        }
        if (log.durationMs < filter.minExecutionTimeMs) {
            return true;
        }
        return false;
    }
}
