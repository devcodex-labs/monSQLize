/**
 * Connection pool statistics manager.
 *
 * Aggregates stats per poolName using a batch-buffer strategy to reduce
 * Map write frequency, merging data via periodic flush.
 */
import type { PoolBufferItem, PoolStatsData } from '../../types/internal/pool';

type PoolStatsLogger = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
};

const SILENT_POOL_STATS_LOGGER: PoolStatsLogger = {};

export class PoolStatsManager {
    private readonly _stats = new Map<string, PoolStatsData>();
    private _buffer: PoolBufferItem[] = [];
    private _batchInterval: ReturnType<typeof setInterval> | null;
    private readonly _logger: PoolStatsLogger;

    constructor(options: { logger?: PoolStatsLogger; } = {}) {
        this._logger = options.logger ?? SILENT_POOL_STATS_LOGGER;
        this._batchInterval = setInterval(() => { this._flush(); }, 100);
        (this._batchInterval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
    }

    recordSelection(poolName: string, operation: string): void {
        this._buffer.push({ poolName, type: 'selection', operation, timestamp: Date.now() });
        this._flush();
    }

    async recordQuery(poolName: string, responseTime: number, error: Error | null): Promise<void> {
        this.recordRequest(poolName, responseTime, !error);
        this._flush();
    }

    recordConnections(poolName: string, count: number): void {
        let stats = this._stats.get(poolName);
        if (!stats) {
            stats = this._emptyStats();
            this._stats.set(poolName, stats);
        }
        stats.connections = count;
    }

    recordRequest(poolName: string, responseTime: number, success: boolean): void {
        this._buffer.push({ poolName, type: 'request', responseTime, success, timestamp: Date.now() });
    }

    private _flush(): void {
        if (this._buffer.length === 0) return;
        const batch = this._buffer.splice(0);
        for (const item of batch) {
            this._updateStats(item);
        }
    }

    private _updateStats(item: PoolBufferItem): void {
        let stats = this._stats.get(item.poolName);
        if (!stats) {
            stats = this._emptyStats();
            this._stats.set(item.poolName, stats);
        }
        if (item.type === 'selection') {
            stats.totalRequests += 1;
        } else if (item.type === 'request') {
            stats.totalRequests += 1;
            if (item.success) {
                stats.successRequests += 1;
            } else {
                stats.failedRequests += 1;
            }
            stats.totalResponseTime += item.responseTime ?? 0;
            stats.avgResponseTime = stats.totalResponseTime / stats.totalRequests;
            stats.errorRate = stats.failedRequests / stats.totalRequests;
        }
    }

    private _emptyStats(): PoolStatsData {
        return { connections: 0, available: 0, waiting: 0, totalRequests: 0, successRequests: 0, failedRequests: 0, totalResponseTime: 0, avgResponseTime: 0, errorRate: 0 };
    }

    getStats(poolName: string): PoolStatsData {
        return { ...(this._stats.get(poolName) ?? this._emptyStats()) };
    }

    getAllStats(): Record<string, PoolStatsData> {
        const result: Record<string, PoolStatsData> = {};
        for (const [poolName, stats] of this._stats.entries()) {
            result[poolName] = { ...stats };
        }
        return result;
    }

    reset(poolName?: string): void {
        if (poolName) {
            this._stats.delete(poolName);
        } else {
            this._stats.clear();
        }
    }

    resetAll(): void {
        this._stats.clear();
        this._buffer = [];
    }

    close(): void {
        if (this._batchInterval) {
            clearInterval(this._batchInterval);
            this._batchInterval = null;
        }
        this._flush();
    }
}
