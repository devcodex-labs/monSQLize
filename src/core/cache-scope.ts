import { createHash, randomUUID } from 'node:crypto';
import type { MongoClient } from 'mongodb';
import type { RuntimeDefaults } from '../types/internal/query';

const identities = new WeakMap<object, string>();
const routes = new WeakMap<object, Map<string, Set<string>>>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Only hashes reach cache keys; credentials and connection strings stay private. */
export function scopedCacheDefaults(
    defaults: RuntimeDefaults, client: unknown, cache: object | null | undefined, pool = 'default',
): RuntimeDefaults {
    const options = (client as MongoClient | undefined)?.options;
    let source: string;
    let identity: string;
    if (options?.hosts) {
        source = digest({ hosts: options.hosts.map(host => host.toString()).sort(), replicaSet: options.replicaSet });
        identity = digest({ source, credentials: options.credentials, tls: options.tls, proxyHost: options.proxyHost, proxyPort: options.proxyPort });
    } else {
        const object = client && typeof client === 'object' ? client : defaults;
        identity = identities.get(object) ?? randomUUID();
        identities.set(object, identity);
        source = 'unknown';
    }
    const scope = `v2:${identity}:${encodeURIComponent(pool)}`;
    let group: Set<string> = new Set([scope]);
    let sources: Map<string, Set<string>> | undefined;
    if (cache) {
        sources = routes.get(cache);
        if (!sources) { sources = new Map(); routes.set(cache, sources); }
        group = sources.get(source) ?? new Set();
        group.add(scope);
        sources.set(source, group);
    }
    return { ...defaults, cacheScope: scope, relatedCacheScopes: () => source === 'unknown' && sources
        ? [...new Set([...sources.values()].flatMap(scopes => [...scopes]))]
        : [...new Set([...group, ...(sources?.get('unknown') ?? [])])] };
}

export function cacheNamespace(namespace: string, defaults: RuntimeDefaults = {}, scope = defaults.cacheScope): string {
    const instance = defaults.namespace?.instanceId;
    const prefix = scope ? `${scope}:` : '';
    return `${prefix}${instance ? `${instance}:` : ''}${namespace}`;
}

export function relatedCacheNamespaces(namespace: string, defaults: RuntimeDefaults = {}): string[] {
    return defaults.relatedCacheScopes
        ? defaults.relatedCacheScopes().map(scope => cacheNamespace(namespace, defaults, scope))
        : [...new Set([cacheNamespace(namespace, defaults), ...(defaults.cacheScope ? [] : [namespace])])];
}
