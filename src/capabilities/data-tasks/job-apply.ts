import type {
    DataTaskApplyResult,
    DataTaskApproval,
    DataTaskConnection,
} from '../../../types/data-tasks';
import { cloneDocument, exactDataTaskDocumentFilter } from './document-utils';
import {
    DataTaskJobError,
    canonicalStringify,
    hashDataTaskValue,
    type NormalizedDataTaskCollection,
    type NormalizedDataTaskJob,
} from './job-normalizer';
import {
    classifyDataTaskIndexes,
    publicDataTaskCollections,
    type DataTaskJobPlan,
    type PlannedDataChange,
} from './job-planner';
import {
    createDataTaskBackup,
    dataTaskPendingIndexFingerprint,
    updateDataTaskBackup,
    type AppliedDataTaskOperation,
    type LoadedDataTaskBackup,
    type PendingDataTaskIndex,
    type PendingDataTaskOperation,
} from './job-backup';
import { getByPath, isRecord, type DataTaskCollectionLike, type DataTaskJobRuntimeHost, type GenericRecord } from './support';
import type { DataTaskLease } from './job-lock';

export function validateDataTaskApproval(approval: DataTaskApproval, plan: DataTaskJobPlan): void {
    if (!isRecord(approval) || approval.kind !== 'apply') throw new DataTaskJobError('APPROVAL_STALE', 'an apply approval is required.', 'approval');
    const { token, ...payload } = approval;
    if (hashDataTaskValue(payload) !== token) throw new DataTaskJobError('APPROVAL_STALE', 'approval token is invalid.', 'approval');
    if (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) {
        throw new DataTaskJobError('APPROVAL_STALE', 'approval has expired; run preview again.', 'approval');
    }
    for (const key of ['jobHash', 'sourceHash', 'targetHash', 'indexHash'] as const) {
        if (approval[key] !== plan.hashes[key]) throw new DataTaskJobError('APPROVAL_STALE', `${key} drifted; run preview again.`, 'approval');
    }
}

function writePayload(change: PlannedDataChange, config: NormalizedDataTaskCollection): GenericRecord {
    const payload = cloneDocument(change.after);
    if (change.before) delete payload._id;
    if (config.data?.identity.mode === 'fields') delete payload._id;
    return payload;
}

function writeUpdate(change: PlannedDataChange, config: NormalizedDataTaskCollection): GenericRecord {
    const payload = writePayload(change, config);
    const setRoots = Object.keys(payload);
    const unsetPaths = change.unsetPaths.filter((field) => !setRoots.some((root) => field === root || field.startsWith(`${root}.`)));
    return {
        ...(Object.keys(payload).length > 0 ? { $set: payload } : {}),
        ...(unsetPaths.length > 0 ? { $unset: Object.fromEntries(unsetPaths.map((field) => [field, 1])) } : {}),
    };
}

function resultCount(result: unknown, key: string): number {
    return isRecord(result) && typeof result[key] === 'number' ? result[key] as number : 0;
}

function expectedBeforeFilter(change: PlannedDataChange): GenericRecord {
    if (!change.before) return change.filter;
    return {
        $and: [
            change.filter,
            exactDataTaskDocumentFilter(change.before),
        ],
    };
}

async function findTarget(collection: DataTaskCollectionLike, identity: GenericRecord): Promise<GenericRecord> {
    const matches = await collection.find(identity).limit?.(2).toArray() ?? await collection.find(identity).toArray();
    if (matches.length !== 1) throw new DataTaskJobError('APPLY_PARTIAL', `identity resolved to ${matches.length} target documents after write.`, 'apply');
    return cloneDocument(matches[0]);
}

function currentMatchesPlan(current: GenericRecord, change: PlannedDataChange, config: NormalizedDataTaskCollection): boolean {
    if (change.operation !== 'insert' || config.data!.identity.mode !== 'fields') {
        return hashDataTaskValue(current) === hashDataTaskValue(change.after);
    }
    const actual = { ...current };
    delete actual._id;
    return hashDataTaskValue(actual) === hashDataTaskValue(change.after);
}

async function applyChange(
    target: DataTaskCollectionLike,
    change: PlannedDataChange,
    config: NormalizedDataTaskCollection,
    lease?: DataTaskLease,
): Promise<AppliedDataTaskOperation> {
    lease?.assertHeld();
    const payload = writePayload(change, config);
    if (change.operation === 'update') {
        const result = await target.updateOne(expectedBeforeFilter(change), writeUpdate(change, config), {
            collation: { locale: 'simple' },
        });
        if (resultCount(result, 'matchedCount') !== 1) throw new DataTaskJobError('APPLY_PARTIAL', 'target document drifted before update.', 'apply', config.name);
    } else if (config.data!.strategy === 'insert') {
        await target.insertOne(payload);
    } else if (config.data!.identity.mode === 'source-id') {
        const { _id, ...fields } = payload;
        void _id;
        const result = await target.updateOne(change.filter, { $setOnInsert: fields }, { upsert: true });
        if (resultCount(result, 'upsertedCount') !== 1) {
            throw new DataTaskJobError('APPLY_PARTIAL', 'source-id target appeared after preview; no existing document was updated.', 'apply', config.name);
        }
    } else {
        const result = await target.updateOne(change.filter, { $setOnInsert: payload }, { upsert: true });
        if (resultCount(result, 'upsertedCount') !== 1) {
            throw new DataTaskJobError('APPLY_PARTIAL', 'fields target appeared after preview; no existing document was updated.', 'apply', config.name);
        }
    }
    const current = await findTarget(target, change.identity);
    if (!currentMatchesPlan(current, change, config)) {
        throw new DataTaskJobError('APPLY_PARTIAL', 'post-write document does not match the planned after-image.', 'verify', config.name);
    }
    if (config.data!.identity.mode === 'source-id' && canonicalStringify(current._id) !== canonicalStringify(change.identity._id)) {
        throw new DataTaskJobError('APPLY_PARTIAL', 'source-id was not preserved.', 'verify', config.name);
    }
    return {
        collection: config.name,
        targetCollection: config.targetName,
        identity: change.identity,
        operation: change.operation,
        targetId: current._id,
        afterHash: hashDataTaskValue(current),
    };
}

async function createMissingIndexes(
    targetHost: DataTaskJobRuntimeHost,
    plan: DataTaskJobPlan,
    backup: LoadedDataTaskBackup,
    lease?: DataTaskLease,
): Promise<void> {
    for (const collectionPlan of plan.plannedCollections) {
        const target = targetHost.collection(collectionPlan.target);
        for (const index of collectionPlan.indexes.filter((candidate) => candidate.status === 'missing')) {
            lease?.assertHeld();
            const pending: PendingDataTaskIndex = {
                operation: 'create',
                collection: collectionPlan.target,
                ...(index.name ? { name: index.name } : {}),
                key: index.key,
                options: index.options,
            };
            await updateDataTaskBackup(backup, (manifest) => {
                manifest.status = 'running';
                manifest.pendingIndexes = [...(manifest.pendingIndexes ?? []), pending];
            });
            const result = await target.createIndex(index.key, { ...index.options, ...(index.name ? { name: index.name } : {}) });
            const name = typeof result === 'string' ? result : isRecord(result) && typeof result.name === 'string' ? result.name : index.name;
            if (!name) throw new DataTaskJobError('APPLY_PARTIAL', 'created index did not return a stable name.', 'indexes', collectionPlan.source);
            const current = await target.listIndexes();
            const declared = [{ name, key: index.key, options: index.options }];
            if (classifyDataTaskIndexes(declared, current)[0]?.status !== 'existing') {
                throw new DataTaskJobError('APPLY_PARTIAL', `created index "${name}" failed readback verification.`, 'indexes', collectionPlan.source);
            }
            await updateDataTaskBackup(backup, (manifest) => {
                manifest.status = 'running';
                manifest.pendingIndexes = (manifest.pendingIndexes ?? []).filter((candidate) => (
                    dataTaskPendingIndexFingerprint(candidate) !== dataTaskPendingIndexFingerprint(pending)
                ));
                manifest.createdIndexes.push({ collection: collectionPlan.target, name, key: index.key, options: index.options });
            });
        }
    }
}

function pendingOperation(change: PlannedDataChange): PendingDataTaskOperation {
    return {
        collection: change.collection,
        targetCollection: change.targetCollection,
        identity: change.identity,
        operation: change.operation,
        beforeHash: hashDataTaskValue(change.before),
        plannedAfterHash: hashDataTaskValue(change.after),
    };
}

function samePendingOperation(left: PendingDataTaskOperation, right: PendingDataTaskOperation): boolean {
    return left.targetCollection === right.targetCollection
        && canonicalStringify(left.identity) === canonicalStringify(right.identity);
}

async function verifyAppliedPlan(targetHost: DataTaskJobRuntimeHost, plan: DataTaskJobPlan, lease?: DataTaskLease): Promise<void> {
    for (const collectionPlan of plan.plannedCollections) {
        lease?.assertHeld();
        const config = plan.normalized.collections.find((item) => item.targetName === collectionPlan.target)!;
        const target = targetHost.collection(collectionPlan.target);
        const indexes = classifyDataTaskIndexes(config.indexes, await target.listIndexes());
        if (indexes.some((index) => index.status !== 'existing')) throw new DataTaskJobError('APPLY_PARTIAL', 'configured index verification failed.', 'verify', config.name);
        const candidates = config.verify.mode === 'full'
            ? collectionPlan.changes
            : collectionPlan.changes.slice(0, config.verify.sampleSize);
        for (const change of candidates) {
            const current = await findTarget(target, change.identity);
            const fields = config.verify.fields ?? Object.keys(writePayload(change, config));
            for (const field of fields) {
                if (canonicalStringify(getByPath(current, field)) !== canonicalStringify(getByPath(change.after, field))) {
                    throw new DataTaskJobError('APPLY_PARTIAL', `verification failed for field "${field}".`, 'verify', config.name);
                }
            }
            for (const field of change.unsetPaths) {
                if (getByPath(current, field) !== undefined) {
                    throw new DataTaskJobError('APPLY_PARTIAL', `verification failed because field "${field}" still exists.`, 'verify', config.name);
                }
            }
        }
    }
}

export async function applyDataTaskPlan(
    job: NormalizedDataTaskJob,
    plan: DataTaskJobPlan,
    targetHost: DataTaskJobRuntimeHost,
    targetHint: DataTaskConnection | DataTaskJobRuntimeHost,
    lease?: DataTaskLease,
): Promise<DataTaskApplyResult> {
    const backup = await createDataTaskBackup(job, plan, targetHint);
    let applied = 0;
    try {
        await updateDataTaskBackup(backup, (manifest) => { manifest.status = 'running'; });
        lease?.assertHeld();
        await createMissingIndexes(targetHost, plan, backup, lease);
        for (const collectionPlan of plan.plannedCollections) {
            const config = job.collections.find((item) => item.targetName === collectionPlan.target)!;
            const target = targetHost.collection(collectionPlan.target);
            const changes = collectionPlan.changes;
            for (let offset = 0; offset < changes.length; offset += config.data?.batchSize ?? 500) {
                const batch = changes.slice(offset, offset + (config.data?.batchSize ?? 500));
                const pendingBatch = batch.map(pendingOperation);
                await updateDataTaskBackup(backup, (manifest) => {
                    manifest.pendingOperations = [
                        ...(manifest.pendingOperations ?? []).filter((candidate) => (
                            !pendingBatch.some((pending) => samePendingOperation(candidate, pending))
                        )),
                        ...pendingBatch,
                    ];
                });
                const appliedBatch: AppliedDataTaskOperation[] = [];
                for (const change of batch) {
                    const operation = await applyChange(target, change, config, lease);
                    applied += 1;
                    appliedBatch.push(operation);
                }
                await updateDataTaskBackup(backup, (manifest) => {
                    manifest.pendingOperations = (manifest.pendingOperations ?? []).filter((candidate) => (
                        !pendingBatch.some((pending) => samePendingOperation(candidate, pending))
                    ));
                    manifest.appliedOperations.push(...appliedBatch);
                });
            }
        }
        await verifyAppliedPlan(targetHost, plan, lease);
        await updateDataTaskBackup(backup, (manifest) => { manifest.status = 'passed'; });
        return {
            mode: 'apply', runId: backup.ref.runId, jobName: job.name, passed: true, status: 'passed',
            collections: publicDataTaskCollections(plan.plannedCollections), backup: backup.ref, warnings: [], errors: [],
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const partial = applied > 0
            || backup.manifest.createdIndexes.length > 0
            || (backup.manifest.pendingOperations?.length ?? 0) > 0
            || (backup.manifest.pendingIndexes?.length ?? 0) > 0;
        await updateDataTaskBackup(backup, (manifest) => {
            manifest.status = partial ? 'partial' : 'failed';
            manifest.errors.push(message);
        }).catch(() => undefined);
        return {
            mode: 'apply', runId: backup.ref.runId, jobName: job.name, passed: false, status: partial ? 'partial' : 'failed',
            collections: publicDataTaskCollections(plan.plannedCollections), backup: backup.ref, warnings: [], errors: [message],
        };
    }
}
