import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { BSON, Int32, Long } from 'mongodb';
import type { DataTaskBackupRef, DataTaskConnection } from '../../../types/data-tasks';
import {
    DEFAULT_DATA_TASK_BACKUP_MAX_BYTES,
    DataTaskJobError,
    hashDataTaskValue,
    type NormalizedDataTaskJob,
} from './job-normalizer';
import type { DataTaskJobPlan, PlannedDataChange } from './job-planner';
import type { DataTaskJobRuntimeHost, GenericRecord } from './support';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const BACKUP_TARGET = Symbol('dataTaskBackupTarget');

export interface DataTaskBackupEntry extends Omit<PlannedDataChange, 'operation' | 'after'> {
    operation: 'insert' | 'update' | 'delete';
    after: GenericRecord | null;
    beforeHash: string;
    plannedAfterHash: string;
}

export interface AppliedDataTaskOperation {
    collection: string;
    targetCollection: string;
    identity: GenericRecord;
    operation: 'insert' | 'update' | 'delete';
    targetId: unknown;
    afterHash: string;
}

export interface PendingDataTaskOperation {
    collection: string;
    targetCollection: string;
    identity: GenericRecord;
    operation: 'insert' | 'update' | 'delete';
    beforeHash: string;
    plannedAfterHash: string;
}

export interface CreatedDataTaskIndex {
    collection: string;
    name: string;
    key: GenericRecord;
    options: GenericRecord;
}

export interface PendingDataTaskIndex extends Omit<CreatedDataTaskIndex, 'name'> {
    operation: 'create' | 'drop';
    name?: string;
}

export function dataTaskPendingIndexFingerprint(index: PendingDataTaskIndex): string {
    return hashDataTaskValue({
        operation: index.operation,
        collection: index.collection,
        name: index.name ?? null,
        key: index.key,
        options: index.options,
    });
}

export interface DataTaskBackupManifest {
    version: 1;
    kind: 'monsqlize-data-task-backup';
    runId: string;
    jobName: string;
    jobHash: string;
    createdAt: string;
    updatedAt: string;
    status: 'prepared' | 'running' | 'passed' | 'partial' | 'failed' | 'restored';
    compression: 'gzip' | 'none';
    dataFile: string;
    checksum: string;
    entryCount: number;
    maxBytes?: number;
    hashes: DataTaskJobPlan['hashes'];
    namespaces: Array<{ source: string; target: string }>;
    beforeIndexes: Array<{ collection: string; indexes: GenericRecord[] }>;
    pendingOperations?: PendingDataTaskOperation[];
    appliedOperations: AppliedDataTaskOperation[];
    pendingIndexes?: PendingDataTaskIndex[];
    createdIndexes: CreatedDataTaskIndex[];
    droppedIndexes: CreatedDataTaskIndex[];
    errors: string[];
    restore?: { restoredAt: string; safetyBackup: DataTaskBackupRef };
}

export interface LoadedDataTaskBackup {
    ref: DataTaskBackupRef;
    manifest: DataTaskBackupManifest;
    entries: DataTaskBackupEntry[];
}

function checksum(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function ejsonLine(value: unknown): string {
    return BSON.EJSON.stringify(value, { relaxed: false });
}

function ejsonManifest(value: DataTaskBackupManifest): string {
    return BSON.EJSON.stringify(value, undefined, 2, { relaxed: false });
}

function manifestInteger(value: unknown, field: string, minimum: number): number {
    const numeric = value instanceof Int32 ? value.valueOf()
        : Long.isLong(value) ? value.toBigInt()
            : value;
    if (typeof numeric === 'bigint') {
        if (numeric < BigInt(minimum) || numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error(`invalid backup ${field}`);
        }
        return Number(numeric);
    }
    if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric) || numeric < minimum) {
        throw new Error(`invalid backup ${field}`);
    }
    return numeric;
}

function decodeManifestControls(raw: unknown): DataTaskBackupManifest {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid backup manifest');
    const manifest = raw as DataTaskBackupManifest;
    manifest.version = manifestInteger(manifest.version, 'manifest', 1) as 1;
    manifest.entryCount = manifestInteger(manifest.entryCount, 'entry count', 0);
    if (manifest.maxBytes !== undefined) manifest.maxBytes = manifestInteger(manifest.maxBytes, 'max bytes', 1);
    return manifest;
}

function sanitizeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'data-task';
}

function attachTarget(ref: DataTaskBackupRef, target: DataTaskConnection | DataTaskJobRuntimeHost): DataTaskBackupRef {
    Object.defineProperty(ref, BACKUP_TARGET, { value: target, enumerable: false, configurable: false });
    return ref;
}

export function backupTargetHint(ref: DataTaskBackupRef): DataTaskConnection | DataTaskJobRuntimeHost | undefined {
    return (ref as DataTaskBackupRef & { [BACKUP_TARGET]?: DataTaskConnection | DataTaskJobRuntimeHost })[BACKUP_TARGET];
}

export async function probeDataTaskBackupDirectory(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    const probe = path.join(absolute, `.monsqlize-probe-${randomUUID()}`);
    try {
        await mkdir(absolute, { recursive: true });
        await writeFile(probe, 'probe', { encoding: 'utf8', flag: 'wx' });
        if ((await readFile(probe, 'utf8')) !== 'probe') throw new Error('backup probe readback mismatch');
        await stat(absolute);
    } catch (error) {
        throw new DataTaskJobError('BACKUP_FAILED', `backup.dir probe failed: ${error instanceof Error ? error.message : String(error)}`, 'backup');
    } finally {
        await rm(probe, { force: true }).catch(() => undefined);
    }
}

function backupEntries(plan: DataTaskJobPlan): DataTaskBackupEntry[] {
    return plan.plannedCollections.flatMap((collection) => collection.changes.map((change) => ({
        ...change,
        beforeHash: hashDataTaskValue(change.before),
        plannedAfterHash: hashDataTaskValue(change.after),
    })));
}

function serializeBackupEntries(entries: DataTaskBackupEntry[], maxBytes: number): Buffer {
    const lines: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
        const line = `${ejsonLine(entry)}\n`;
        bytes += Buffer.byteLength(line);
        if (bytes > maxBytes) {
            throw new DataTaskJobError('BACKUP_FAILED', `backup size ${bytes} bytes exceeds backup.maxBytes=${maxBytes}.`, 'backup');
        }
        lines.push(line);
    }
    return Buffer.from(lines.join(''), 'utf8');
}

async function syncDirectory(directory: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(directory, 'r');
        await handle.sync();
    } catch {
        // Some platforms do not support fsync on directory handles.
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function atomicWriteFile(filePath: string, contents: string | Buffer): Promise<void> {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(temporary, 'wx');
        if (typeof contents === 'string') await handle.writeFile(contents, { encoding: 'utf8' });
        else await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, filePath);
        await syncDirectory(path.dirname(filePath));
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function atomicWriteManifest(manifestPath: string, manifest: DataTaskBackupManifest): Promise<void> {
    await atomicWriteFile(manifestPath, `${ejsonManifest(manifest)}\n`);
}

export async function createDataTaskBackup(
    job: NormalizedDataTaskJob,
    plan: DataTaskJobPlan,
    targetHint: DataTaskConnection | DataTaskJobRuntimeHost,
): Promise<LoadedDataTaskBackup> {
    await probeDataTaskBackupDirectory(job.backup.dir);
    const runId = `${Date.now()}-${randomUUID()}`;
    const runDirectory = path.resolve(job.backup.dir, sanitizeName(job.name), runId);
    await mkdir(runDirectory, { recursive: true });
    const entries = backupEntries(plan);
    const plain = serializeBackupEntries(entries, job.backup.maxBytes);
    const contents = job.backup.compression === 'gzip' ? await gzipAsync(plain) : plain;
    const dataFile = `backup.ejsonl${job.backup.compression === 'gzip' ? '.gz' : ''}`;
    const dataPath = path.join(runDirectory, dataFile);
    const manifestPath = path.join(runDirectory, 'manifest.json');
    const digest = checksum(contents);
    const now = new Date().toISOString();
    const manifest: DataTaskBackupManifest = {
        version: 1,
        kind: 'monsqlize-data-task-backup',
        runId,
        jobName: job.name,
        jobHash: job.jobHash,
        createdAt: now,
        updatedAt: now,
        status: 'prepared',
        compression: job.backup.compression,
        dataFile,
        checksum: digest,
        entryCount: entries.length,
        maxBytes: job.backup.maxBytes,
        hashes: plan.hashes,
        namespaces: plan.plannedCollections.map((collection) => ({ source: collection.source, target: collection.target })),
        beforeIndexes: plan.plannedCollections.map((collection) => ({ collection: collection.target, indexes: collection.existingIndexes })),
        pendingOperations: [],
        appliedOperations: [],
        pendingIndexes: [],
        createdIndexes: [],
        droppedIndexes: [],
        errors: [],
    };
    try {
        await atomicWriteFile(dataPath, contents);
        await atomicWriteManifest(manifestPath, manifest);
        const ref = attachTarget({ runId, manifestPath, checksum: digest }, targetHint);
        const loaded = await readDataTaskBackup(ref);
        if (loaded.entries.length !== entries.length) throw new Error('backup entry count readback mismatch');
        return loaded;
    } catch (error) {
        throw new DataTaskJobError('BACKUP_FAILED', `could not create and verify backup: ${error instanceof Error ? error.message : String(error)}`, 'backup');
    }
}

export async function createRestoreSafetyBackup(
    source: LoadedDataTaskBackup,
    entries: DataTaskBackupEntry[],
    beforeIndexes: Array<{ collection: string; indexes: GenericRecord[] }>,
    targetHint: DataTaskConnection | DataTaskJobRuntimeHost,
): Promise<LoadedDataTaskBackup> {
    const runId = `${Date.now()}-${randomUUID()}`;
    const directory = path.resolve(path.dirname(source.ref.manifestPath), 'restore-safety', runId);
    await mkdir(directory, { recursive: true });
    const maxBytes = source.manifest.maxBytes ?? DEFAULT_DATA_TASK_BACKUP_MAX_BYTES;
    const plain = serializeBackupEntries(entries, maxBytes);
    const contents = source.manifest.compression === 'gzip' ? await gzipAsync(plain) : plain;
    const dataFile = `backup.ejsonl${source.manifest.compression === 'gzip' ? '.gz' : ''}`;
    const dataPath = path.join(directory, dataFile);
    const manifestPath = path.join(directory, 'manifest.json');
    const digest = checksum(contents);
    const now = new Date().toISOString();
    const manifest: DataTaskBackupManifest = {
        version: 1,
        kind: 'monsqlize-data-task-backup',
        runId,
        jobName: `${source.manifest.jobName}-restore-safety`,
        jobHash: hashDataTaskValue({ sourceRunId: source.manifest.runId, entries, beforeIndexes }),
        createdAt: now,
        updatedAt: now,
        status: 'prepared',
        compression: source.manifest.compression,
        dataFile,
        checksum: digest,
        entryCount: entries.length,
        maxBytes,
        hashes: {
            jobHash: source.manifest.jobHash,
            sourceHash: hashDataTaskValue(entries.map((entry) => entry.before)),
            targetHash: hashDataTaskValue(entries.map((entry) => entry.after)),
            indexHash: hashDataTaskValue(beforeIndexes),
        },
        namespaces: source.manifest.namespaces,
        beforeIndexes,
        pendingOperations: [],
        appliedOperations: [],
        pendingIndexes: [],
        createdIndexes: [],
        droppedIndexes: [],
        errors: [],
    };
    try {
        await atomicWriteFile(dataPath, contents);
        await atomicWriteManifest(manifestPath, manifest);
        return readDataTaskBackup(attachTarget({ runId, manifestPath, checksum: digest }, targetHint));
    } catch (error) {
        throw new DataTaskJobError('BACKUP_FAILED', `restore safety backup failed: ${error instanceof Error ? error.message : String(error)}`, 'restore-backup');
    }
}

export async function readDataTaskBackup(ref: DataTaskBackupRef): Promise<LoadedDataTaskBackup> {
    try {
        const manifest = decodeManifestControls(BSON.EJSON.parse(await readFile(ref.manifestPath, 'utf8'), { relaxed: false }));
        if (manifest.kind !== 'monsqlize-data-task-backup' || manifest.version !== 1 || manifest.runId !== ref.runId) throw new Error('invalid backup manifest');
        if (manifest.compression !== 'gzip' && manifest.compression !== 'none') throw new Error('invalid backup compression');
        if (typeof manifest.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.checksum)) throw new Error('invalid backup checksum');
        if (typeof manifest.dataFile !== 'string'
            || manifest.dataFile.length === 0
            || path.isAbsolute(manifest.dataFile)
            || path.basename(manifest.dataFile) !== manifest.dataFile) {
            throw new Error('backup data file must stay beside its manifest');
        }
        const manifestDirectory = path.resolve(path.dirname(ref.manifestPath));
        const dataPath = path.resolve(manifestDirectory, manifest.dataFile);
        if (path.dirname(dataPath) !== manifestDirectory) throw new Error('backup data file escaped its manifest directory');
        const contents = await readFile(dataPath);
        const digest = checksum(contents);
        if (digest !== manifest.checksum || digest !== ref.checksum) throw new Error('backup checksum mismatch');
        const plain = manifest.compression === 'gzip' ? await gunzipAsync(contents) : contents;
        const lines = plain.toString('utf8').split(/\r?\n/).filter(Boolean);
        const entries = lines.map((line) => BSON.EJSON.parse(line, { relaxed: false }) as DataTaskBackupEntry);
        if (entries.length !== manifest.entryCount) throw new Error('backup entry count mismatch');
        return { ref: attachTarget({ ...ref }, backupTargetHint(ref) as DataTaskConnection | DataTaskJobRuntimeHost), manifest, entries };
    } catch (error) {
        if (error instanceof DataTaskJobError) throw error;
        throw new DataTaskJobError('BACKUP_FAILED', `backup validation failed: ${error instanceof Error ? error.message : String(error)}`, 'backup');
    }
}

export async function updateDataTaskBackup(
    backup: LoadedDataTaskBackup,
    mutate: (manifest: DataTaskBackupManifest) => void,
): Promise<void> {
    mutate(backup.manifest);
    backup.manifest.updatedAt = new Date().toISOString();
    await atomicWriteManifest(backup.ref.manifestPath, backup.manifest);
}
