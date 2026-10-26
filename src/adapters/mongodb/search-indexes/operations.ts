/**
 * Search index lifecycle operations (Usage Contract A02 v1).
 * Write-path policy checks are done by the caller (collection accessor) before these run.
 */
import { ErrorCodes } from '../../../core/errors';
import { classifySearchIndexError, mapSearchIndexError, searchIndexError } from './errors';
import { matchesSearchIndexType, missingSearchIndexInfo, normalizeSearchIndexInfo } from './normalize';
import type {
    CreateSearchIndexOptions,
    CreateSearchIndexResult,
    DropSearchIndexOptions,
    ListSearchIndexesOptions,
    SearchIndexContext,
    SearchIndexInfo,
    SearchIndexSpec,
    SearchIndexType,
    WaitForSearchIndexOptions,
} from './types';
import {
    assertBooleanOption,
    assertDefinition,
    assertEnumOption,
    assertIndexName,
    assertOptionsObject,
    assertSpec,
    resolveWaitOptions,
} from './validate';

/** Grace period during which a missing index is still awaited (N4; calibrated in A06). */
export const SEARCH_INDEX_MISSING_GRACE_MS = 30_000;

async function fetchByName(ctx: SearchIndexContext, operation: string, name: string, signal?: AbortSignal): Promise<SearchIndexInfo> {
    try {
        // The driver cursor honors options.signal at runtime although ListSearchIndexesOptions does not declare it.
        const docs = await ctx.collection.listSearchIndexes(name, signal ? { signal } : {}).toArray();
        const match = docs.find((doc) => doc.name === name);
        return match ? normalizeSearchIndexInfo(match) : missingSearchIndexInfo(name);
    } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (classifySearchIndexError(error) === 'namespaceNotFound') return missingSearchIndexInfo(name);
        throw mapSearchIndexError(error, { operation, namespace: ctx.namespace, indexName: name });
    }
}

export async function getSearchIndexOp(ctx: SearchIndexContext, name: string): Promise<SearchIndexInfo> {
    assertIndexName('getSearchIndex', ctx.namespace, name);
    return fetchByName(ctx, 'getSearchIndex', name);
}

export async function listSearchIndexesOp(ctx: SearchIndexContext, options?: ListSearchIndexesOptions): Promise<SearchIndexInfo[]> {
    const operation = 'listSearchIndexes';
    assertOptionsObject(operation, ctx.namespace, undefined, options);
    assertEnumOption(operation, ctx.namespace, undefined, 'options.type', options?.type, ['search', 'vectorSearch']);
    let docs;
    try {
        docs = await ctx.collection.listSearchIndexes().toArray();
    } catch (error) {
        if (classifySearchIndexError(error) === 'namespaceNotFound') return [];
        throw mapSearchIndexError(error, { operation, namespace: ctx.namespace });
    }
    const infos = docs.map(normalizeSearchIndexInfo);
    return options?.type ? infos.filter((info) => matchesSearchIndexType(info, options.type as SearchIndexType)) : infos;
}

export async function createSearchIndexOp(
    ctx: SearchIndexContext,
    spec: SearchIndexSpec,
    options?: CreateSearchIndexOptions,
): Promise<CreateSearchIndexResult> {
    const operation = 'createSearchIndex';
    assertSpec(operation, ctx.namespace, spec);
    assertOptionsObject(operation, ctx.namespace, spec.name, options);
    assertEnumOption(operation, ctx.namespace, spec.name, 'options.ifExists', options?.ifExists, ['error', 'skip', 'update']);
    const ifExists = options?.ifExists ?? 'error';
    const errCtx = { operation, namespace: ctx.namespace, indexName: spec.name };

    const existing = await fetchByName(ctx, operation, spec.name);
    if (existing.status !== 'DOES_NOT_EXIST') {
        if (ifExists === 'skip') return { name: spec.name, action: 'skipped', created: false };
        if (ifExists === 'error') {
            throw searchIndexError(ErrorCodes.SEARCH_INDEX_EXISTS, `Search index "${spec.name}" already exists`, errCtx);
        }
        if (existing.type !== undefined && existing.type !== spec.type) {
            throw searchIndexError(
                ErrorCodes.INVALID_SEARCH_INDEX_DEFINITION,
                `Search index "${spec.name}" has type "${existing.type}"; drop it before recreating as "${spec.type}"`,
                errCtx,
                { field: 'type', reason: 'type change requires drop and create' },
            );
        }
        try {
            await ctx.collection.updateSearchIndex(spec.name, spec.definition);
        } catch (error) {
            throw mapSearchIndexError(error, errCtx);
        }
        return { name: spec.name, action: 'updated', created: false };
    }

    try {
        const name = await ctx.collection.createSearchIndex({ name: spec.name, type: spec.type, definition: spec.definition });
        return { name: typeof name === 'string' && name.length > 0 ? name : spec.name, action: 'created', created: true };
    } catch (error) {
        const mapped = mapSearchIndexError(error, errCtx) as Error & { code?: string; };
        if (mapped.code === ErrorCodes.SEARCH_INDEX_EXISTS && ifExists === 'skip') {
            return { name: spec.name, action: 'skipped', created: false };
        }
        throw mapped;
    }
}

export async function createSearchIndexesOp(ctx: SearchIndexContext, specs: SearchIndexSpec[]): Promise<string[]> {
    const operation = 'createSearchIndexes';
    if (!Array.isArray(specs) || specs.length === 0) {
        throw searchIndexError(ErrorCodes.INVALID_SEARCH_INDEX_DEFINITION, `${operation}: specs must be a non-empty array`,
            { operation, namespace: ctx.namespace }, { field: 'specs', reason: 'non-empty array required' });
    }
    const seen = new Set<string>();
    for (const spec of specs) {
        assertSpec(operation, ctx.namespace, spec);
        if (seen.has(spec.name)) {
            throw searchIndexError(ErrorCodes.SEARCH_INDEX_EXISTS, `Search index "${spec.name}" is listed more than once`,
                { operation, namespace: ctx.namespace, indexName: spec.name });
        }
        seen.add(spec.name);
    }
    try {
        return await ctx.collection.createSearchIndexes(specs.map(({ name, type, definition }) => ({ name, type, definition })));
    } catch (error) {
        throw mapSearchIndexError(error, { operation, namespace: ctx.namespace });
    }
}

export async function updateSearchIndexOp(ctx: SearchIndexContext, name: string, definition: Record<string, unknown>): Promise<void> {
    const operation = 'updateSearchIndex';
    assertIndexName(operation, ctx.namespace, name);
    assertDefinition(operation, ctx.namespace, name, definition);
    const errCtx = { operation, namespace: ctx.namespace, indexName: name };
    const existing = await fetchByName(ctx, operation, name);
    if (existing.status === 'DOES_NOT_EXIST') {
        throw searchIndexError(ErrorCodes.SEARCH_INDEX_NOT_FOUND, `Search index "${name}" was not found`, errCtx);
    }
    if (existing.type !== undefined) assertDefinition(operation, ctx.namespace, name, definition, existing.type);
    try {
        await ctx.collection.updateSearchIndex(name, definition);
    } catch (error) {
        throw mapSearchIndexError(error, errCtx);
    }
}

export async function dropSearchIndexOp(ctx: SearchIndexContext, name: string, options?: DropSearchIndexOptions): Promise<void> {
    const operation = 'dropSearchIndex';
    assertIndexName(operation, ctx.namespace, name);
    assertOptionsObject(operation, ctx.namespace, name, options);
    assertBooleanOption(operation, ctx.namespace, name, 'options.ignoreMissing', options?.ignoreMissing);
    const errCtx = { operation, namespace: ctx.namespace, indexName: name };
    const existing = await fetchByName(ctx, operation, name);
    if (existing.status === 'DOES_NOT_EXIST') {
        if (options?.ignoreMissing) return;
        throw searchIndexError(ErrorCodes.SEARCH_INDEX_NOT_FOUND, `Search index "${name}" was not found`, errCtx);
    }
    try {
        await ctx.collection.dropSearchIndex(name);
    } catch (error) {
        const mapped = mapSearchIndexError(error, errCtx) as Error & { code?: string; };
        if (mapped.code === ErrorCodes.SEARCH_INDEX_NOT_FOUND && options?.ignoreMissing) return;
        throw mapped;
    }
}

/** Sleeps for `ms`, rejecting with `signal.reason` on abort; always cleans up timer and listener. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Poll-level abort controller linking the user signal and the remaining-time deadline. */
function linkSignal(userSignal: AbortSignal | undefined, remainingMs: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void; } {
    const controller = new AbortController();
    let expired = false;
    const onUserAbort = (): void => controller.abort(userSignal?.reason);
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    const timer = setTimeout(() => {
        expired = true;
        controller.abort(new Error('search index wait deadline reached'));
    }, Math.max(0, remainingMs));
    return {
        signal: controller.signal,
        timedOut: () => expired,
        dispose: () => {
            clearTimeout(timer);
            userSignal?.removeEventListener('abort', onUserAbort);
        },
    };
}

export async function waitForSearchIndexOp(
    ctx: SearchIndexContext,
    name: string,
    options?: WaitForSearchIndexOptions,
    clock: () => number = Date.now,
): Promise<SearchIndexInfo> {
    const operation = 'waitForSearchIndex';
    assertIndexName(operation, ctx.namespace, name);
    const { until, timeoutMs, intervalMs, signal } = resolveWaitOptions(ctx.namespace, name, options);
    const errCtx = { operation, namespace: ctx.namespace, indexName: name };
    if (signal?.aborted) throw signal.reason;
    const start = clock();
    const grace = Math.min(SEARCH_INDEX_MISSING_GRACE_MS, timeoutMs);
    let last: SearchIndexInfo | undefined;

    const timeoutError = () => searchIndexError(
        ErrorCodes.SEARCH_INDEX_WAIT_TIMEOUT,
        `Timed out after ${timeoutMs}ms waiting for Search index "${name}" to become ${until}`,
        errCtx,
        { until, timeoutMs, last },
    );

    for (;;) {
        const link = linkSignal(signal, timeoutMs - (clock() - start));
        let info: SearchIndexInfo;
        try {
            info = await fetchByName(ctx, operation, name, link.signal);
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (link.timedOut()) throw timeoutError();
            throw error;
        } finally {
            link.dispose();
        }
        last = info;
        if (signal?.aborted) throw signal.reason;

        if (until === 'dropped') {
            if (info.status === 'DOES_NOT_EXIST') return info;
        } else if (info.status === 'DOES_NOT_EXIST') {
            if (clock() - start >= grace) {
                throw searchIndexError(ErrorCodes.SEARCH_INDEX_NOT_FOUND,
                    `Search index "${name}" was not found within ${grace}ms`, errCtx, { until, graceMs: grace });
            }
        } else if (until === 'queryable') {
            if (info.queryable) return info;
            if (info.status === 'FAILED') {
                throw searchIndexError(ErrorCodes.SEARCH_INDEX_BUILD_FAILED, `Search index "${name}" build failed`, errCtx,
                    { status: info.status, statusDetail: info.statusDetail });
            }
        } else {
            if (info.status === 'READY') return info;
            if (info.status === 'FAILED') {
                throw searchIndexError(ErrorCodes.SEARCH_INDEX_BUILD_FAILED, `Search index "${name}" build failed`, errCtx,
                    { status: info.status, statusDetail: info.statusDetail });
            }
        }

        const remaining = timeoutMs - (clock() - start);
        if (remaining <= 0) throw timeoutError();
        await sleep(Math.min(intervalMs, remaining), signal);
    }
}
