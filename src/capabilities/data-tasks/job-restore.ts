import { Int32, Long } from 'mongodb';
import type {
    DataTaskApproval,
    DataTaskBackupRef,
    DataTaskConnection,
    DataTaskRestorePreviewResult,
    DataTaskRestoreResult,
} from '../../../types/data-tasks';
import {
    backupTargetHint,
    createRestoreSafetyBackup,
    dataTaskPendingIndexFingerprint,
    readDataTaskBackup,
    updateDataTaskBackup,
    type AppliedDataTaskOperation,
    type CreatedDataTaskIndex,
    type DataTaskBackupEntry,
    type LoadedDataTaskBackup,
    type PendingDataTaskIndex,
    type PendingDataTaskOperation,
} from './job-backup';
import { exactDataTaskDocumentFilter } from './document-utils';
import { classifyDataTaskIndexes } from './job-planner';
import { DataTaskJobError, canonicalStringify, hashDataTaskValue } from './job-normalizer';
import type { DataTaskLease } from './job-lock';
import { isRecord, type DataTaskCollectionLike, type DataTaskJobRuntimeHost, type GenericRecord } from './support';

interface RestoreDocumentAction {
    entry: DataTaskBackupEntry;
    applied: AppliedDataTaskOperation;
    current: GenericRecord | null;
    action: 'restore' | 'delete';
}

export interface DataTaskRestorePlan extends DataTaskRestorePreviewResult {
    backup: LoadedDataTaskBackup;
    actions: RestoreDocumentAction[];
    dropIndexActions: CreatedDataTaskIndex[];
    createIndexActions: CreatedDataTaskIndex[];
    beforeIndexes: Array<{ collection: string; indexes: GenericRecord[] }>;
    hashes: { jobHash: string; sourceHash: string; targetHash: string; indexHash: string };
}

async function findCurrent(collection: DataTaskCollectionLike, identity: GenericRecord): Promise<GenericRecord | null> {
    let chain = collection.find(identity);
    if (typeof chain.limit === 'function') chain = chain.limit(2);
    const matches = await chain.toArray();
    if (matches.length > 1) throw new DataTaskJobError('RESTORE_DRIFT', 'restore identity matches multiple target documents.', 'restore-preview');
    return matches[0] ?? null;
}

function entryKey(collection: string, identity: GenericRecord): string {
    return `${collection}:${canonicalStringify(identity)}`;
}

function restoreApproval(hashes: DataTaskRestorePlan['hashes']): DataTaskApproval {
    const issuedAt = new Date();
    const payload = {
        kind: 'restore' as const,
        ...hashes,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.getTime() + 15 * 60_000).toISOString(),
    };
    return { ...payload, token: hashDataTaskValue(payload) };
}

function comparableIndexKey(key: GenericRecord): GenericRecord {
    return Object.fromEntries(Object.entries(key).map(([field, value]) => {
        if (value instanceof Int32) return [field, value.valueOf()];
        if (Long.isLong(value) && value.toBigInt() <= BigInt(Number.MAX_SAFE_INTEGER)
            && value.toBigInt() >= BigInt(Number.MIN_SAFE_INTEGER)) return [field, Number(value.toBigInt())];
        return [field, value];
    }));
}

function exactIndex(index: CreatedDataTaskIndex, current: GenericRecord[]): boolean {
    return classifyDataTaskIndexes([{ key: comparableIndexKey(index.key), name: index.name, options: index.options }], current)[0]?.status === 'existing';
}

function pendingIndexMatches(index: PendingDataTaskIndex, current: GenericRecord[]): GenericRecord[] {
    return current.filter((candidate) => {
        if (index.name && candidate.name !== index.name) return false;
        return classifyDataTaskIndexes([{ key: comparableIndexKey(index.key), options: index.options }], [candidate])[0]?.status === 'existing';
    });
}

function plannedDocumentMatches(current: GenericRecord | null, entry: DataTaskBackupEntry): boolean {
    if (hashDataTaskValue(current) === entry.plannedAfterHash) return true;
    if (!current || !entry.after) return false;
    const expectedKeys = Object.keys(entry.after).sort();
    const actualKeys = Object.keys(current)
        .filter((key) => key !== '_id' || Object.prototype.hasOwnProperty.call(entry.after, '_id'))
        .sort();
    return canonicalStringify(actualKeys) === canonicalStringify(expectedKeys)
        && expectedKeys.every((key) => canonicalStringify(current[key]) === canonicalStringify(entry.after![key]));
}

async function effectiveAppliedOperations(
    backup: LoadedDataTaskBackup,
    target: DataTaskJobRuntimeHost,
    entries: Map<string, DataTaskBackupEntry>,
    warnings: string[],
    errors: string[],
): Promise<AppliedDataTaskOperation[]> {
    const applied = [...backup.manifest.appliedOperations];
    const appliedKeys = new Set(applied.map((operation) => entryKey(operation.targetCollection, operation.identity)));
    for (const pending of backup.manifest.pendingOperations ?? []) {
        const key = entryKey(pending.targetCollection, pending.identity);
        if (appliedKeys.has(key)) continue;
        const entry = entries.get(key);
        if (!entry) {
            errors.push(`missing backup entry for pending operation ${pending.targetCollection} ${canonicalStringify(pending.identity)}`);
            continue;
        }
        const current = await findCurrent(target.collection(pending.targetCollection), pending.identity);
        if (hashDataTaskValue(current) === pending.beforeHash) {
            warnings.push(`pending operation had no target effect and was skipped for ${pending.targetCollection} ${canonicalStringify(pending.identity)}`);
            continue;
        }
        if (!plannedDocumentMatches(current, entry)) {
            errors.push(`pending operation drift detected for ${pending.targetCollection} ${canonicalStringify(pending.identity)}`);
            continue;
        }
        applied.push({
            collection: pending.collection,
            targetCollection: pending.targetCollection,
            identity: pending.identity,
            operation: pending.operation,
            targetId: current?._id ?? entry.before?._id,
            afterHash: hashDataTaskValue(current),
        });
        appliedKeys.add(key);
        warnings.push(`recovered an applied operation from the write-ahead manifest for ${pending.targetCollection} ${canonicalStringify(pending.identity)}`);
    }
    return applied;
}

function samePendingOperation(left: PendingDataTaskOperation, right: PendingDataTaskOperation): boolean {
    return left.targetCollection === right.targetCollection
        && canonicalStringify(left.identity) === canonicalStringify(right.identity);
}

function samePendingIndex(left: PendingDataTaskIndex, right: PendingDataTaskIndex): boolean {
    return dataTaskPendingIndexFingerprint(left) === dataTaskPendingIndexFingerprint(right);
}

export async function planDataTaskRestore(
    ref: DataTaskBackupRef,
    target: DataTaskJobRuntimeHost,
): Promise<DataTaskRestorePlan> {
    const backup = await readDataTaskBackup(ref);
    const entries = new Map(backup.entries.map((entry) => [entryKey(entry.targetCollection, entry.identity), entry]));
    const actions: RestoreDocumentAction[] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const appliedOperations = await effectiveAppliedOperations(backup, target, entries, warnings, errors);
    for (const applied of appliedOperations) {
        const entry = entries.get(entryKey(applied.targetCollection, applied.identity));
        if (!entry) {
            errors.push(`missing backup entry for ${applied.targetCollection} ${canonicalStringify(applied.identity)}`);
            continue;
        }
        const current = await findCurrent(target.collection(applied.targetCollection), entry.identity);
        if (hashDataTaskValue(current) !== applied.afterHash) {
            errors.push(`target drift detected for ${applied.targetCollection} ${canonicalStringify(entry.identity)}`);
            continue;
        }
        if (applied.operation !== 'insert' && !entry.before) {
            errors.push(`restore before-image is missing for ${applied.targetCollection}`);
            continue;
        }
        actions.push({ entry, applied, current, action: applied.operation === 'insert' ? 'delete' : 'restore' });
    }

    const relevantCollections = new Set([
        ...backup.manifest.createdIndexes.map((index) => index.collection),
        ...(backup.manifest.droppedIndexes ?? []).map((index) => index.collection),
        ...(backup.manifest.pendingIndexes ?? []).map((index) => index.collection),
        ...actions.map((action) => action.entry.targetCollection),
    ]);
    const beforeIndexes: Array<{ collection: string; indexes: GenericRecord[] }> = [];
    for (const collection of relevantCollections) {
        beforeIndexes.push({ collection, indexes: await target.collection(collection).listIndexes() });
    }
    const createdIndexes = [...backup.manifest.createdIndexes];
    const droppedIndexes = [...(backup.manifest.droppedIndexes ?? [])];
    for (const pending of backup.manifest.pendingIndexes ?? []) {
        const current = beforeIndexes.find((item) => item.collection === pending.collection)!.indexes;
        const label = pending.name ?? canonicalStringify(pending.key);
        const matches = pendingIndexMatches(pending, current);
        const named = pending.name ? current.find((candidate) => candidate.name === pending.name) : undefined;
        if (pending.operation === 'create') {
            if (matches.length === 0 && named) {
                errors.push(`pending index create drift detected for ${pending.collection}.${label}`);
            } else if (matches.length === 0) {
                warnings.push(`pending index create had no target effect and was skipped for ${pending.collection}.${label}`);
            } else if (matches.length === 1 && typeof matches[0].name === 'string') {
                createdIndexes.push({ collection: pending.collection, name: matches[0].name, key: pending.key, options: pending.options });
                warnings.push(`recovered a created index from the write-ahead manifest for ${pending.collection}.${matches[0].name}`);
            } else {
                errors.push(`pending index create could not be matched uniquely for ${pending.collection}.${label}`);
            }
        } else if (!pending.name) {
            errors.push(`pending index drop is missing a stable name for ${pending.collection}.${label}`);
        } else if (!named) {
            droppedIndexes.push({ collection: pending.collection, name: pending.name, key: pending.key, options: pending.options });
            warnings.push(`recovered a dropped index from the write-ahead manifest for ${pending.collection}.${pending.name}`);
        } else if (matches.length === 1) {
            warnings.push(`pending index drop had no target effect and was skipped for ${pending.collection}.${pending.name}`);
        } else {
            errors.push(`pending index drop drift detected for ${pending.collection}.${pending.name}`);
        }
    }
    for (const index of createdIndexes) {
        const current = beforeIndexes.find((item) => item.collection === index.collection)!.indexes;
        if (!exactIndex(index, current)) errors.push(`created index "${index.name}" is missing or drifted on ${index.collection}`);
    }
    for (const index of droppedIndexes) {
        const current = beforeIndexes.find((item) => item.collection === index.collection)!.indexes;
        if (current.some((candidate) => candidate.name === index.name)) errors.push(`index "${index.name}" already exists before safety restore`);
    }

    const hashes = {
        jobHash: backup.manifest.jobHash,
        sourceHash: hashDataTaskValue(backup.entries),
        targetHash: hashDataTaskValue(actions.map((action) => action.current)),
        indexHash: hashDataTaskValue(beforeIndexes),
    };
    const passed = errors.length === 0;
    return {
        mode: 'preview-restore',
        runId: backup.manifest.runId,
        passed,
        restoreDocuments: actions.filter((action) => action.action === 'restore').length,
        deleteDocuments: actions.filter((action) => action.action === 'delete').length,
        dropIndexes: createdIndexes.length,
        createIndexes: droppedIndexes.length,
        warnings,
        errors,
        ...(passed ? { approval: restoreApproval(hashes) } : {}),
        backup,
        actions,
        dropIndexActions: createdIndexes,
        createIndexActions: droppedIndexes,
        beforeIndexes,
        hashes,
    };
}

export function validateRestoreApproval(approval: DataTaskApproval, plan: DataTaskRestorePlan): void {
    if (!isRecord(approval) || approval.kind !== 'restore') throw new DataTaskJobError('RESTORE_DRIFT', 'a restore approval is required.', 'restore-approval');
    const { token, ...payload } = approval;
    if (hashDataTaskValue(payload) !== token) throw new DataTaskJobError('RESTORE_DRIFT', 'restore approval token is invalid.', 'restore-approval');
    if (Date.parse(approval.expiresAt) <= Date.now()) throw new DataTaskJobError('RESTORE_DRIFT', 'restore approval expired.', 'restore-approval');
    for (const key of ['jobHash', 'sourceHash', 'targetHash', 'indexHash'] as const) {
        if (approval[key] !== plan.hashes[key]) throw new DataTaskJobError('RESTORE_DRIFT', `${key} drifted; preview restore again.`, 'restore-approval');
    }
}

function resultCount(result: unknown, key: string): number {
    return isRecord(result) && typeof result[key] === 'number' ? result[key] as number : 0;
}

function safetyEntries(plan: DataTaskRestorePlan): DataTaskBackupEntry[] {
    return plan.actions.map((action) => ({
        collection: action.entry.collection,
        targetCollection: action.entry.targetCollection,
        identity: action.entry.identity,
        filter: action.entry.filter,
        operation: action.action === 'delete' ? 'delete' : 'update',
        before: action.current,
        after: action.action === 'delete' ? null : action.entry.before,
        unsetPaths: [],
        beforeHash: hashDataTaskValue(action.current),
        plannedAfterHash: hashDataTaskValue(action.action === 'delete' ? null : action.entry.before),
    }));
}

async function restoreDocument(target: DataTaskCollectionLike, action: RestoreDocumentAction): Promise<AppliedDataTaskOperation> {
    if (action.action === 'delete') {
        if (!target.deleteOne) throw new DataTaskJobError('RESTORE_FAILED', 'target does not support deleteOne.', 'restore');
        const result = await target.deleteOne(exactDataTaskDocumentFilter(action.current!));
        if (resultCount(result, 'deletedCount') !== 1) throw new DataTaskJobError('RESTORE_FAILED', 'restore delete did not affect one document.', 'restore');
        return { ...action.applied, operation: 'delete', afterHash: hashDataTaskValue(null) };
    }
    const before = action.entry.before!;
    if (!action.current) {
        const result = await target.updateOne(action.entry.identity, { $setOnInsert: before }, { upsert: true });
        if (resultCount(result, 'upsertedCount') !== 1) {
            throw new DataTaskJobError('RESTORE_FAILED', 'restore insert found a document that appeared after preview.', 'restore');
        }
        return { ...action.applied, operation: 'update', targetId: before._id, afterHash: hashDataTaskValue(before) };
    }
    const result = await target.replaceOne(exactDataTaskDocumentFilter(action.current!), before);
    if (resultCount(result, 'matchedCount') !== 1) {
        throw new DataTaskJobError('RESTORE_FAILED', 'restore replace did not affect one document.', 'restore');
    }
    return { ...action.applied, operation: 'update', targetId: before._id, afterHash: hashDataTaskValue(before) };
}

async function verifyRestore(target: DataTaskJobRuntimeHost, plan: DataTaskRestorePlan): Promise<void> {
    for (const action of plan.actions) {
        const current = await findCurrent(target.collection(action.entry.targetCollection), action.entry.identity);
        const expected = action.action === 'delete' ? null : action.entry.before;
        if (hashDataTaskValue(current) !== hashDataTaskValue(expected)) throw new DataTaskJobError('RESTORE_FAILED', 'restored document verification failed.', 'restore-verify');
    }
    for (const index of plan.dropIndexActions) {
        if ((await target.collection(index.collection).listIndexes()).some((candidate) => candidate.name === index.name)) {
            throw new DataTaskJobError('RESTORE_FAILED', `index "${index.name}" was not dropped.`, 'restore-verify');
        }
    }
    for (const index of plan.createIndexActions) {
        if (!exactIndex(index, await target.collection(index.collection).listIndexes())) {
            throw new DataTaskJobError('RESTORE_FAILED', `index "${index.name}" was not recreated.`, 'restore-verify');
        }
    }
}

export async function restoreDataTaskPlan(
    plan: DataTaskRestorePlan,
    target: DataTaskJobRuntimeHost,
    targetHint: DataTaskConnection | DataTaskJobRuntimeHost,
    lease: DataTaskLease,
): Promise<DataTaskRestoreResult> {
    const safety = await createRestoreSafetyBackup(plan.backup, safetyEntries(plan), plan.beforeIndexes, targetHint);
    const safetyEntriesByKey = new Map(safety.entries.map((entry) => [entryKey(entry.targetCollection, entry.identity), entry]));
    let restoredDocuments = 0;
    let deletedDocuments = 0;
    let droppedIndexes = 0;
    let createdIndexes = 0;
    try {
        await updateDataTaskBackup(safety, (manifest) => { manifest.status = 'running'; });
        for (const action of plan.actions) {
            lease.assertHeld();
            const entry = safetyEntriesByKey.get(entryKey(action.entry.targetCollection, action.entry.identity))!;
            const pending: PendingDataTaskOperation = {
                collection: entry.collection,
                targetCollection: entry.targetCollection,
                identity: entry.identity,
                operation: entry.operation,
                beforeHash: entry.beforeHash,
                plannedAfterHash: entry.plannedAfterHash,
            };
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingOperations = [
                    ...(manifest.pendingOperations ?? []).filter((candidate) => !samePendingOperation(candidate, pending)),
                    pending,
                ];
            });
            const operation = await restoreDocument(target.collection(action.entry.targetCollection), action);
            if (action.action === 'delete') deletedDocuments += 1; else restoredDocuments += 1;
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingOperations = (manifest.pendingOperations ?? [])
                    .filter((candidate) => !samePendingOperation(candidate, pending));
                manifest.appliedOperations.push(operation);
            });
        }
        for (const index of plan.dropIndexActions) {
            lease.assertHeld();
            const collection = target.collection(index.collection);
            if (!collection.dropIndex) throw new DataTaskJobError('RESTORE_FAILED', 'target does not support dropIndex.', 'restore');
            const pending: PendingDataTaskIndex = { ...index, operation: 'drop' };
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingIndexes = [...(manifest.pendingIndexes ?? []), pending];
            });
            await collection.dropIndex(index.name);
            droppedIndexes += 1;
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingIndexes = (manifest.pendingIndexes ?? []).filter((candidate) => !samePendingIndex(candidate, pending));
                manifest.droppedIndexes.push(index);
            });
        }
        for (const index of plan.createIndexActions) {
            lease.assertHeld();
            const collection = target.collection(index.collection);
            const pending: PendingDataTaskIndex = { ...index, operation: 'create' };
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingIndexes = [...(manifest.pendingIndexes ?? []), pending];
            });
            await collection.createIndex(comparableIndexKey(index.key), { ...index.options, name: index.name });
            if (!exactIndex(index, await collection.listIndexes())) {
                throw new DataTaskJobError('RESTORE_FAILED', `index "${index.name}" failed immediate readback.`, 'restore');
            }
            createdIndexes += 1;
            await updateDataTaskBackup(safety, (manifest) => {
                manifest.pendingIndexes = (manifest.pendingIndexes ?? []).filter((candidate) => !samePendingIndex(candidate, pending));
                manifest.createdIndexes.push(index);
            });
        }
        await verifyRestore(target, plan);
        await updateDataTaskBackup(safety, (manifest) => { manifest.status = 'passed'; });
        await updateDataTaskBackup(plan.backup, (manifest) => {
            manifest.status = 'restored';
            manifest.restore = { restoredAt: new Date().toISOString(), safetyBackup: safety.ref };
        });
        return {
            mode: 'restore', runId: plan.runId, passed: true, status: 'passed', safetyBackup: safety.ref,
            restoredDocuments, deletedDocuments, droppedIndexes, createdIndexes, warnings: [], errors: [],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const partial = restoredDocuments + deletedDocuments + droppedIndexes + createdIndexes > 0;
        await updateDataTaskBackup(safety, (manifest) => {
            manifest.status = partial ? 'partial' : 'failed';
            manifest.errors.push(message);
        }).catch(() => undefined);
        return {
            mode: 'restore', runId: plan.runId, passed: false, status: partial ? 'partial' : 'failed', safetyBackup: safety.ref,
            restoredDocuments, deletedDocuments, droppedIndexes, createdIndexes, warnings: [], errors: [message],
        };
    }
}

export { backupTargetHint };
