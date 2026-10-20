/**
 * Logging adapter layer.
 *
 * Notes:
 * - Provides a unified Logger wrapper compatible with custom loggers and the default console output.
 * - Supports debug / info / warn / error levels; silently no-ops when logger is null.
 * - Supports structured JSON output and optional AsyncLocalStorage-based trace IDs.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { LoggerLike, LoggerOptions } from '../../../types/base';

export type { LoggerLike, LoggerOptions } from '../../../types/base';

// Single shared AsyncLocalStorage instance for trace IDs.
let _storage: AsyncLocalStorage<{ traceId: string }> | null = null;
try {
    _storage = new AsyncLocalStorage<{ traceId: string }>();
} catch {
    _storage = null;
}

/**
 * Thin wrapper around an optional logger that normalises the log interface.
 * @since v1.0.0
 */
export class Logger {
    constructor(
        private readonly _logger: LoggerLike | null = null,
        private readonly _options: LoggerOptions = {},
    ) {}

    private _formatStructured(level: string, msg: unknown, ctx?: unknown): string {
        const entry: Record<string, unknown> = {
            level: level.toUpperCase(),
            timestamp: new Date().toISOString(),
            message: msg,
        };
        if (this._options.enableTraceId !== false && _storage) {
            const store = _storage.getStore();
            if (store?.traceId) {
                entry.traceId = store.traceId;
            }
        }
        if (ctx !== undefined) {
            entry.context = ctx;
        }
        return JSON.stringify(entry);
    }

    /**
     * Outputs a debug log.
     * @since v1.3.0
     */
    debug(msg?: unknown, ctx?: unknown): void {
        if (this._options.structured) {
            this._logger?.debug?.(this._formatStructured('debug', msg, ctx));
        } else {
            ctx !== undefined ? this._logger?.debug?.(msg, ctx) : this._logger?.debug?.(msg);
        }
    }

    /**
     * Outputs an info log.
     * @since v1.3.0
     */
    info(msg?: unknown, ctx?: unknown): void {
        if (this._options.structured) {
            this._logger?.info?.(this._formatStructured('info', msg, ctx));
        } else {
            ctx !== undefined ? this._logger?.info?.(msg, ctx) : this._logger?.info?.(msg);
        }
    }

    /**
     * Outputs a warn log.
     * @since v1.3.0
     */
    warn(msg?: unknown, ctx?: unknown): void {
        if (this._options.structured) {
            this._logger?.warn?.(this._formatStructured('warn', msg, ctx));
        } else {
            ctx !== undefined ? this._logger?.warn?.(msg, ctx) : this._logger?.warn?.(msg);
        }
    }

    /**
     * Outputs an error log.
     * @since v1.3.0
     */
    error(msg?: unknown, ctx?: unknown): void {
        if (this._options.structured) {
            this._logger?.error?.(this._formatStructured('error', msg, ctx));
        } else {
            ctx !== undefined ? this._logger?.error?.(msg, ctx) : this._logger?.error?.(msg);
        }
    }

    /**
     * Creates a Logger instance.
     * @since v1.3.0
     */
    static create(logger: LoggerLike | null = null, options: LoggerOptions = {}): Logger {
        // Fall back to null when an invalid custom logger is passed.
        const effectiveLogger = logger !== null && Logger.isValidLogger(logger) ? logger : null;
        return new Logger(effectiveLogger, options);
    }

    /**
     * Creates a silent logger that discards all output.
     * @since v1.4.0
     */
    static createSilent(): Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> {
        const noop = (): void => {};
        return { debug: noop, info: noop, warn: noop, error: noop };
    }

    /**
     * Generates a random 16-character hex trace ID.
     * @since v1.4.0
     */
    static generateTraceId(): string {
        return randomBytes(8).toString('hex');
    }

    /**
     * Returns true when the given value is a valid logger (has all four log-level methods).
     * @since v1.4.0
     */
    static isValidLogger(logger: unknown): boolean {
        if (!logger || typeof logger !== 'object') return false;
        const l = logger as Record<string, unknown>;
        return (
            typeof l.debug === 'function' &&
            typeof l.info === 'function' &&
            typeof l.warn === 'function' &&
            typeof l.error === 'function'
        );
    }

    /**
     * Runs `fn` inside an AsyncLocalStorage context tagged with `traceId`.
     * When AsyncLocalStorage is unavailable this is `undefined`.
     * @since v1.4.0
     */
    static withTraceId: ((fn: () => void | Promise<void>, traceId?: string) => void | Promise<void>) | undefined =
        _storage
            ? (fn, traceId) => _storage!.run({ traceId: traceId ?? Logger.generateTraceId() }, fn)
            : undefined;

    /**
     * Returns the trace ID from the current AsyncLocalStorage context, or `null` if none.
     * When AsyncLocalStorage is unavailable this is `undefined`.
     * @since v1.4.0
     */
    static getTraceId: (() => string | null) | undefined =
        _storage
            ? () => _storage!.getStore()?.traceId ?? null
            : undefined;

    /**
     * Creates a logger that prepends an ISO timestamp to every message.
     * @since v1.4.0
     */
    static createWithTimestamp(customLogger?: LoggerLike | null): Pick<Logger, 'debug' | 'info' | 'warn' | 'error'> {
        const base = new Logger(customLogger ?? null);
        const ts = (): string => new Date().toISOString();
        return {
            debug: (msg: unknown, ...args: unknown[]) => base.debug(`${ts()} ${msg}`, ...args),
            info: (msg: unknown, ...args: unknown[]) => base.info(`${ts()} ${msg}`, ...args),
            warn: (msg: unknown, ...args: unknown[]) => base.warn(`${ts()} ${msg}`, ...args),
            error: (msg: unknown, ...args: unknown[]) => base.error(`${ts()} ${msg}`, ...args),
        };
    }
}

