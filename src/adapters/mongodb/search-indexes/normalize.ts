/**
 * Normalizes driver `$listSearchIndexes` documents into SearchIndexInfo.
 */
import type { Document } from 'mongodb';
import type { SearchIndexInfo, SearchIndexStatus, SearchIndexType, SearchIndexTypeSource } from './types';

const STATUSES: ReadonlySet<string> = new Set(['PENDING', 'BUILDING', 'READY', 'FAILED', 'STALE', 'DELETING', 'DOES_NOT_EXIST']);

export function missingSearchIndexInfo(name: string): SearchIndexInfo {
    return { name, status: 'DOES_NOT_EXIST', queryable: false, typeSource: 'unknown', raw: {} };
}

export function normalizeSearchIndexInfo(doc: Document): SearchIndexInfo {
    const info: SearchIndexInfo = {
        name: String(doc.name),
        // Unknown future statuses are passed through verbatim rather than rewritten.
        status: (typeof doc.status === 'string' && doc.status.length > 0 ? doc.status : 'PENDING') as SearchIndexStatus,
        queryable: doc.queryable === true,
        typeSource: 'unknown',
        raw: doc as Record<string, unknown>,
    };
    if (typeof doc.id === 'string') info.id = doc.id;
    const resolved = resolveSearchIndexType(doc);
    info.typeSource = resolved.typeSource;
    if (resolved.type !== undefined) info.type = resolved.type;
    if (doc.latestDefinition && typeof doc.latestDefinition === 'object') info.latestDefinition = doc.latestDefinition;
    const version = doc.latestDefinitionVersion;
    if (version && typeof version === 'object') {
        info.latestDefinitionVersion = { version: Number(version.version), createdAt: version.createdAt as Date };
    }
    if (Array.isArray(doc.statusDetail)) info.statusDetail = doc.statusDetail as Array<Record<string, unknown>>;
    return info;
}

export function isKnownSearchIndexStatus(status: string): boolean {
    return STATUSES.has(status);
}

/**
 * Single place that resolves `SearchIndexInfo.type` (Usage Contract v1.1 §1.1).
 * 1. Server top-level `type` → typeSource 'server'.
 * 2. Otherwise infer from `latestDefinition`: `fields` containing a `type: 'vector'` entry → 'vectorSearch';
 *    else a `mappings` key → 'search' (typeSource 'inferred'). Self-managed mongot omits the top-level type.
 * 3. Otherwise type is omitted with typeSource 'unknown'.
 */
export function resolveSearchIndexType(doc: Document): { type?: SearchIndexType; typeSource: SearchIndexTypeSource; } {
    if (doc.type === 'search' || doc.type === 'vectorSearch') return { type: doc.type, typeSource: 'server' };
    const definition = doc.latestDefinition;
    if (definition && typeof definition === 'object' && !Array.isArray(definition)) {
        const fields = (definition as Document).fields;
        if (Array.isArray(fields) && fields.some((field) => field && typeof field === 'object' && (field as Document).type === 'vector')) {
            return { type: 'vectorSearch', typeSource: 'inferred' };
        }
        if (Object.prototype.hasOwnProperty.call(definition, 'mappings')) return { type: 'search', typeSource: 'inferred' };
    }
    return { typeSource: 'unknown' };
}

/** Whether an entry matches a `listSearchIndexes({ type })` filter (resolved type; unknown never matches). */
export function matchesSearchIndexType(info: SearchIndexInfo, type: SearchIndexType): boolean {
    return info.typeSource !== 'unknown' && info.type === type;
}
