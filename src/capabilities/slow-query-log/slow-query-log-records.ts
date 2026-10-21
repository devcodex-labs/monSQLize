/**
 * Slow query log record helpers.
 *
 * Provides query hash generation (generateQueryHash), threshold calculation
 * (getSlowQueryThreshold), and an operation wrapper (withSlowQueryLog).
 */
import { createHash } from 'node:crypto';
import { ErrorCodes, createError } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type {
    SlowQueryLogConfig,
    SlowQueryLogEntry,
    SlowQueryLogFilter,
    SlowQueryLogRecord,
} from '../../../types/slow-query-log';

export function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }
    if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, current]) => `${JSON.stringify(key)}:${stableStringify(current)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function normalizeHashInput(input: unknown): unknown {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return input;
    }

    const record = input as Record<string, unknown>;
    return {
        db: typeof (record.db ?? record.database) === 'string' ? (record.db ?? record.database) : '',
        collection: typeof (record.collection ?? record.coll) === 'string' ? (record.collection ?? record.coll) : '',
        operation: typeof (record.operation ?? record.op) === 'string' ? (record.operation ?? record.op) : '',
        queryShape: record.queryShape ?? record.query ?? {},
    };
}

export function generateQueryHash(input: unknown): string {
    return createHash('sha256').update(stableStringify(normalizeHashInput(input))).digest('hex').slice(0, 16);
}

export function handleSlowQueryLogError(
    logger: LoggerLike | null,
    policy: SlowQueryLogConfig['advanced']['errorHandling'],
    error: unknown,
): void {
    if (policy === 'throw') {
        throw error instanceof Error ? error : new Error(String(error));
    }
    if (policy === 'log') {
        try { logger?.error?.('[SlowQueryLog] operation failed', error); }
        catch { /* Diagnostic sinks must not turn the log policy into throw. */ }
    }
}

export function toMongoFilter(filter: SlowQueryLogFilter): Record<string, unknown> {
    const query: Record<string, unknown> = {};
    if (filter.database) {
        query.database = filter.database;
    }
    if (filter.collection) {
        query.collection = filter.collection;
    }
    if (filter.operation) {
        query.operation = filter.operation;
    }
    if (filter.queryHash) {
        query.queryHash = filter.queryHash;
    }
    return query;
}

export function normalizeSlowQueryLogEntry(log: SlowQueryLogEntry): SlowQueryLogRecord {
    if (!log.database || !log.collection || !log.operation) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, '[SlowQueryLog] database / collection / operation are required.');
    }
    if (!Number.isFinite(log.durationMs) || log.durationMs < 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, '[SlowQueryLog] durationMs must be a non-negative number.');
    }
    const timestamp = log.timestamp ?? new Date();
    return {
        queryHash: log.queryHash ?? generateQueryHash({
            database: log.database,
            collection: log.collection,
            operation: log.operation,
            query: log.query,
        }),
        database: log.database,
        collection: log.collection,
        operation: log.operation,
        count: 1,
        totalTimeMs: log.durationMs,
        avgTimeMs: log.durationMs,
        maxTimeMs: log.durationMs,
        minTimeMs: log.durationMs,
        firstSeen: timestamp,
        lastSeen: timestamp,
        sampleQuery: log.query,
        metadata: log.metadata,
    };
}

export function mergeSlowQueryLogRecord(existing: SlowQueryLogRecord | undefined, incoming: SlowQueryLogRecord): SlowQueryLogRecord {
    if (!existing) {
        return incoming;
    }
    const count = existing.count + incoming.count;
    const totalTimeMs = existing.totalTimeMs + incoming.totalTimeMs;
    return {
        ...existing,
        count,
        totalTimeMs,
        avgTimeMs: totalTimeMs / count,
        maxTimeMs: Math.max(existing.maxTimeMs, incoming.maxTimeMs),
        minTimeMs: Math.min(existing.minTimeMs, incoming.minTimeMs),
        firstSeen: existing.firstSeen < incoming.firstSeen ? existing.firstSeen : incoming.firstSeen,
        lastSeen: existing.lastSeen > incoming.lastSeen ? existing.lastSeen : incoming.lastSeen,
        sampleQuery: incoming.sampleQuery ?? existing.sampleQuery,
        metadata: incoming.metadata ?? existing.metadata,
    };
}

export function recordKey(record: Pick<SlowQueryLogRecord, 'queryHash' | 'database' | 'collection' | 'operation'>): string {
    return `${record.queryHash}:${record.database}:${record.collection}:${record.operation}`;
}

export function matchesSlowQueryLogFilter(record: SlowQueryLogRecord, filter: SlowQueryLogFilter): boolean {
    if (filter.database && record.database !== filter.database) {
        return false;
    }
    if (filter.collection && record.collection !== filter.collection) {
        return false;
    }
    if (filter.operation && record.operation !== filter.operation) {
        return false;
    }
    if (filter.queryHash && record.queryHash !== filter.queryHash) {
        return false;
    }
    return true;
}

export function sortSlowQueryLogRecords(
    records: SlowQueryLogRecord[],
    sort: Record<string, 1 | -1> = { lastSeen: -1 },
): SlowQueryLogRecord[] {
    const entries = Object.entries(sort);
    return [...records].sort((left, right) => {
        for (const [field, direction] of entries) {
            const leftValue = left[field as keyof SlowQueryLogRecord];
            const rightValue = right[field as keyof SlowQueryLogRecord];
            if (leftValue === rightValue) {
                continue;
            }
            if (leftValue == null) return direction;
            if (rightValue == null) return -direction;
            return (leftValue > rightValue ? 1 : -1) * direction;
        }
        return 0;
    });
}

export function cloneSlowQueryLogRecord(record: SlowQueryLogRecord): SlowQueryLogRecord {
    return {
        ...record,
        firstSeen: new Date(record.firstSeen),
        lastSeen: new Date(record.lastSeen),
    };
}

export function getSlowQueryThreshold(defaults: Record<string, unknown> | null | undefined): number {
    const resolvedDefaults = defaults || {};
    const value = resolvedDefaults.slowQueryMs;
    return typeof value === 'number' ? value : 500;
}

export async function withSlowQueryLog<T>(
    logger: LoggerLike | null | undefined,
    defaults: Record<string, unknown> | null | undefined,
    op: string,
    ns: { iid?: string; type?: string; db: string; coll: string } | null | undefined,
    options: Record<string, unknown> | null | undefined,
    exec: () => Promise<T>,
    slowLogShaper?: ((options: unknown) => Record<string, unknown>) | null,
    onEmit?: ((info: unknown) => void) | null,
): Promise<T> {
    const startedAt = Date.now();
    const result = await exec();
    const durationMs = Date.now() - startedAt;
    const threshold = getSlowQueryThreshold(defaults);
    if (durationMs >= threshold && logger) {
        const resolvedDefaults = defaults || {};
        const scope = (resolvedDefaults as Record<string, unknown> & { namespace?: { scope?: unknown } }).namespace?.scope;
        const logTag = (resolvedDefaults as Record<string, unknown> & {
            log?: { slowQueryTag?: { event?: string; code?: string }; formatSlowQuery?: (base: unknown) => unknown };
        }).log;
        const base: Record<string, unknown> = {
            event: logTag?.slowQueryTag?.event || 'slow_query',
            code: logTag?.slowQueryTag?.code || 'SLOW_QUERY',
            category: 'performance',
            type: ns?.type || 'mongodb',
            iid: ns?.iid,
            scope,
            db: ns?.db,
            coll: ns?.coll,
            op,
            ms: durationMs,
            threshold,
            ts: new Date().toISOString(),
            ...(typeof slowLogShaper === 'function' ? slowLogShaper(options) : {}),
        };
        try {
            if (typeof logTag?.formatSlowQuery === 'function') {
                const formatted = (logTag.formatSlowQuery(base) || base) as Record<string, unknown>;
                logger.warn?.('\u23f1\ufe0f Slow query', formatted as unknown as string);
                if (typeof onEmit === 'function') {
                    try { onEmit(formatted); } catch (_) { /* noop */ }
                }
            } else {
                logger.warn?.('\u23f1\ufe0f Slow query', base as unknown as string);
                if (typeof onEmit === 'function') {
                    try { onEmit(base); } catch (_) { /* noop */ }
                }
            }
        } catch (_) { /* ignore logging errors */ }
    }
    return result;
}
