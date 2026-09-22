/** File and Redis persistence for change-stream resume tokens. */
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ErrorCodes, createError } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type { ResumeTokenConfig, ResumeTokenRedisLike } from '../../../types/sync';

export interface ResumeTokenStoreLike {
    load(): Promise<unknown | null>;
    save(token: unknown): Promise<void>;
    clear(): Promise<void>;
}

export function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

async function syncDirectory(directory: string): Promise<void> {
    try {
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Directory fsync is best-effort and unsupported on some platforms.
    }
}

/** Validate file or Redis resume-token persistence options. */
export function validateResumeTokenConfig(config: ResumeTokenConfig | null | undefined): void {
    if (!config || typeof config !== 'object') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken must be an object.');
    }
    const storage = config.storage ?? 'file';
    if (!['file', 'redis'].includes(storage)) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.storage must be file or redis.');
    }
    if (storage === 'file' && config.path !== undefined && typeof config.path !== 'string') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.path must be a string.');
    }
    if (storage === 'redis' && !config.redis) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.redis is required when storage is redis.');
    }
    if (storage === 'redis' && config.redis && typeof config.redis !== 'object') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.redis must be an object.');
    }
    if (config.strictSave !== undefined && typeof config.strictSave !== 'boolean') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.strictSave must be a boolean.');
    }
    if (config.strictLoad !== undefined && typeof config.strictLoad !== 'boolean') {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.strictLoad must be a boolean.');
    }
    if (config.saveRetries !== undefined && (!Number.isInteger(config.saveRetries) || config.saveRetries < 0)) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.saveRetries must be a non-negative integer.');
    }
    if (config.saveRetryDelayMs !== undefined && (!Number.isInteger(config.saveRetryDelayMs) || config.saveRetryDelayMs < 0)) {
        throw createError(ErrorCodes.INVALID_CONFIG, '[Sync] resumeToken.saveRetryDelayMs must be a non-negative integer.');
    }
}

/** Persists and retrieves change-stream resume tokens using a file or Redis. */
export class ResumeTokenStore implements ResumeTokenStoreLike {
    private readonly storage: 'file' | 'redis';
    public readonly path: string;
    private readonly redis?: ResumeTokenRedisLike;
    private readonly redisKey: string;
    private readonly logger: LoggerLike | null;
    private readonly strictLoad: boolean;
    private readonly strictSave: boolean;
    private readonly saveRetries: number;
    private readonly saveRetryDelayMs: number;

    constructor(options: ResumeTokenConfig & { logger?: LoggerLike | null; } = {}) {
        this.storage = options.storage ?? 'file';
        this.path = options.path ?? './.sync-resume-token';
        this.redis = options.redis;
        this.redisKey = options.key ?? 'monsqlize:sync:resume-token';
        this.logger = options.logger ?? null;
        this.strictSave = options.strictSave ?? true;
        this.strictLoad = options.strictLoad ?? this.strictSave;
        this.saveRetries = options.saveRetries ?? 0;
        this.saveRetryDelayMs = options.saveRetryDelayMs ?? 100;
        validateResumeTokenConfig(options);
    }

    async load(): Promise<unknown | null> {
        try {
            if (this.storage === 'redis' && this.redis) {
                const payload = await Promise.resolve(this.redis.get(this.redisKey));
                return payload ? JSON.parse(String(payload)) : null;
            }
            const payload = await readFile(this.path, 'utf8');
            return JSON.parse(payload);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT') this.logger?.warn?.('[Sync] failed to load resume token', error);
            if (code !== 'ENOENT' && this.strictLoad) {
                throw createError(ErrorCodes.DATABASE_ERROR, '[Sync] failed to load resume token', undefined, normalizeError(error));
            }
            return null;
        }
    }

    async save(token: unknown): Promise<void> {
        const payload = JSON.stringify(token, null, 2);
        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= this.saveRetries; attempt += 1) {
            try {
                await this.writePayload(payload);
                return;
            } catch (error) {
                lastError = normalizeError(error);
                if (attempt < this.saveRetries) {
                    this.logger?.warn?.('[Sync] failed to save resume token; retrying', {
                        attempt: attempt + 1, retries: this.saveRetries, error: lastError,
                    });
                    await delay(this.saveRetryDelayMs);
                }
            }
        }
        this.logger?.error?.('[Sync] failed to save resume token', lastError);
        if (this.strictSave) {
            throw createError(ErrorCodes.DATABASE_ERROR, '[Sync] failed to save resume token', undefined, lastError ?? undefined);
        }
    }

    private async writePayload(payload: string): Promise<void> {
        if (this.storage === 'redis' && this.redis) {
            await Promise.resolve(this.redis.set(this.redisKey, payload));
            return;
        }
        const directory = path.dirname(this.path);
        const basename = path.basename(this.path);
        const tempPath = path.join(directory, `.${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
        await mkdir(directory, { recursive: true });
        try {
            const handle = await open(tempPath, 'w');
            try {
                await handle.writeFile(payload, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }
            await this.backupCurrentFile();
            await rename(tempPath, this.path);
            await syncDirectory(directory);
        } catch (error) {
            await unlink(tempPath).catch(() => undefined);
            throw error;
        }
    }

    private async backupCurrentFile(): Promise<void> {
        try {
            await copyFile(this.path, `${this.path}.bak`);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT') throw error;
        }
    }

    async clear(): Promise<void> {
        try {
            if (this.storage === 'redis' && this.redis) {
                await Promise.resolve(this.redis.del?.(this.redisKey));
                return;
            }
            await unlink(this.path);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code !== 'ENOENT') this.logger?.warn?.('[Sync] failed to clear resume token', error);
        }
    }
}
