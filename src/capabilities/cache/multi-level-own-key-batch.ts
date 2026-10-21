import type { CacheLike } from 'cache-hub';

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const unknownTtl = Symbol('unknown-backfill-ttl');
type BackfillTtl = number | typeof unknownTtl;

export function needsOwnKeyBatch(keys: string[]): boolean {
    return keys.some((key) => own(Object.prototype, key));
}

async function readRemote(remote: CacheLike, keys: string[], timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve(remote.getMany(keys)),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('Remote cache batch timed out.')), timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function resolveTtls(remote: CacheLike, keys: string[]): Promise<Record<string, BackfillTtl | undefined>> {
    if (remote.getRemainingTtlMany) {
        try {
            const ttls = await remote.getRemainingTtlMany(keys);
            // An empty batch result is authoritative, including for prototype names.
            return Object.fromEntries(Object.entries(ttls).map(([key, ttl]) => [key, ttl === null ? 0 : ttl]));
        } catch { /* Preserve the existing fallback to single-key TTL reads. */ }
    }
    const entries: Array<[string, BackfillTtl | undefined]> = [];
    for (const key of keys) {
        let ttl: BackfillTtl | undefined = unknownTtl;
        if (remote.getRemainingTtl) {
            try {
                const remaining = await remote.getRemainingTtl(key);
                ttl = remaining === null ? 0 : remaining;
            } catch { /* An unavailable TTL uses the adapter's default. */ }
        }
        entries.push([key, ttl]);
    }
    return Object.fromEntries(entries);
}

/** The hub's batch algorithm with own-key lookups, within the caller's read fence. */
export async function getManyWithOwnKeys(
    local: CacheLike,
    remote: CacheLike | undefined,
    keys: string[],
    options: { backfill: boolean; timeoutMs: number },
): Promise<Record<string, unknown>> {
    const l1 = await local.getMany(keys);
    const missing = keys.filter((key) => !own(l1, key) || l1[key] === undefined);
    if (!remote || missing.length === 0) return l1;
    let l2: Record<string, unknown>;
    try { l2 = await readRemote(remote, missing, options.timeoutMs); }
    catch { return l1; }
    if (options.backfill) {
        const hits = Object.fromEntries(missing.filter((key) => own(l2, key) && l2[key] !== undefined)
            .map((key) => [key, l2[key]]));
        const hitKeys = Object.keys(hits);
        if (hitKeys.length > 0) {
            try {
                const ttls = await resolveTtls(remote, hitKeys);
                for (const key of hitKeys) {
                    const ttl = own(ttls, key) ? ttls[key] : undefined;
                    if (ttl === unknownTtl) await local.set(key, hits[key]);
                    else if (ttl !== undefined) await local.set(key, hits[key], ttl);
                }
            } catch { /* A failed backfill must not discard the remote result. */ }
        }
    }
    return { ...l1, ...l2 };
}
