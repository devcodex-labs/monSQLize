/**
 * Slow query log batch flush queue.
 *
 * Buffers log entries and automatically flushes them to the storage backend
 * by batch size or timer interval, reducing write pressure in high-frequency query scenarios.
 */
import type { LoggerLike } from '../../core/logger';
import type { SlowQueryLogConfig, SlowQueryLogEntry, SlowQueryLogStorage } from '../../../types/slow-query-log';
import { DEFAULT_SLOW_QUERY_LOG_CONFIG } from './slow-query-log-config';

export class BatchQueue {
    private readonly buffer: SlowQueryLogEntry[] = [];
    private readonly batchSize: number;
    private readonly flushInterval: number;
    private readonly maxBufferSize: number;
    private readonly logger: LoggerLike | null;
    private timer: NodeJS.Timeout | null = null;
    private flushing = false;
    private flushPromise: Promise<void> | null = null;

    constructor(
        private readonly storage: Pick<SlowQueryLogStorage, 'saveBatch'>,
        options: Partial<SlowQueryLogConfig['batch']> = {},
        logger: LoggerLike | null = null,
        private readonly errorHandling: 'log' | 'silent' = 'log',
    ) {
        this.batchSize = options.size ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.batch.size;
        this.flushInterval = options.interval ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.batch.interval;
        this.maxBufferSize = options.maxBufferSize ?? DEFAULT_SLOW_QUERY_LOG_CONFIG.batch.maxBufferSize;
        this.logger = logger;
    }

    async add(log: SlowQueryLogEntry): Promise<void> {
        this.buffer.push(log);
        this.enforceMaxBufferSize();
        if (this.buffer.length >= this.maxBufferSize || this.buffer.length >= this.batchSize) {
            if (!this.flushing) {
                await this.flush();
            }
            return;
        }
        if (!this.timer) {
            this.scheduleTimer();
        }
    }

    async flush(): Promise<void> {
        if (this.flushPromise) {
            return this.flushPromise;
        }
        if (this.buffer.length === 0) {
            return;
        }

        this.flushPromise = this.flushOnce();
        return this.flushPromise;
    }

    private async flushOnce(): Promise<void> {
        this.flushing = true;
        const payload = this.buffer.splice(0, this.buffer.length);
        this.clearTimer();
        try {
            await this.storage.saveBatch(payload);
            this.logger?.debug?.('[SlowQueryLog] batch flushed', { count: payload.length });
        } catch (error) {
            if (this.errorHandling === 'log') {
                try { this.logger?.error?.('[SlowQueryLog] batch flush failed', error); } catch { /* Scheduled flushes must settle. */ }
            }
        } finally {
            this.flushing = false;
            this.flushPromise = null;
            if (this.buffer.length >= this.batchSize) {
                void this.flush();
            } else if (this.buffer.length > 0 && !this.timer) {
                this.scheduleTimer();
            }
        }
    }

    async close(): Promise<void> {
        this.clearTimer();
        while (this.flushPromise || this.buffer.length > 0) {
            await (this.flushPromise ?? this.flush());
        }
    }

    private enforceMaxBufferSize(): void {
        const overflow = this.buffer.length - this.maxBufferSize;
        if (overflow <= 0) return;
        this.buffer.splice(0, overflow);
        this.logger?.warn?.('[SlowQueryLog] batch buffer overflow, dropped oldest entries', { dropped: overflow });
    }

    private scheduleTimer(): void {
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, this.flushInterval);
        this.timer.unref?.();
    }

    private clearTimer(): void {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = null;
    }
}
