import type { MonSQLizeOptions } from './monsqlize';

export type DataTaskEnvironment = 'development' | 'test' | 'staging' | 'production' | 'prod' | 'live';

export interface DataTaskIndexDefinition {
    key: Record<string, unknown>;
    options?: Record<string, unknown>;
    name?: string;
}

export type DataTaskJobErrorCode =
    | 'INVALID_JOB'
    | 'IDENTITY_CONFLICT'
    | 'INDEX_CONFLICT'
    | 'APPROVAL_STALE'
    | 'BACKUP_FAILED'
    | 'LOCK_NOT_ACQUIRED'
    | 'LOCK_LOST'
    | 'APPLY_PARTIAL'
    | 'RESTORE_DRIFT'
    | 'RESTORE_FAILED';

export declare class DataTaskJobError extends Error {
    readonly code: DataTaskJobErrorCode;
    readonly phase: string;
    readonly collection?: string;
    constructor(code: DataTaskJobErrorCode, message: string, phase?: string, collection?: string);
}

export interface DataTaskConnectionRuntime {
    readonly options?: MonSQLizeOptions;
    collection(name: string): unknown;
    connect?(): Promise<unknown>;
    close?(): Promise<void>;
}

export type DataTaskConnection = DataTaskConnectionRuntime | MonSQLizeOptions;

export type DataTaskIdentity =
    | { mode: 'fields'; fields: string[] }
    | { mode: 'source-id'; conflictBy?: string[] };

export interface DataTaskDataRule {
    filter?: Record<string, unknown>;
    all?: boolean;
    identity: DataTaskIdentity;
    strategy?: 'upsert' | 'insert';
    projection?: Record<string, unknown>;
    /** Rename only the listed source fields before synchronizing them. */
    rename?: Record<string, string>;
    /** Set only the listed literal values before synchronizing the document. */
    set?: Record<string, unknown>;
    /** Remove only the listed field paths from the synchronized target document. */
    unset?: string[];
    /** Maximum source documents this collection may plan. Defaults to 10000. */
    maxDocuments?: number;
    /** Write-ahead checkpoint batch size. Writes remain ordered within each batch. */
    batchSize?: number;
}

export interface DataTaskVerifyRule {
    mode?: 'sample' | 'full';
    fields?: string[];
    sampleSize?: number;
}

export interface DataTaskCollectionJob {
    name: string;
    targetName?: string;
    indexes?: DataTaskIndexDefinition[];
    data?: DataTaskDataRule;
    verify?: DataTaskVerifyRule;
}

export interface DataTaskBackupOptions {
    dir?: string;
    format?: 'extended-jsonl';
    compression?: 'gzip' | 'none';
    retentionDays?: number;
    /** Maximum uncompressed affected-scope backup size in bytes. Defaults to 256 MiB. */
    maxBytes?: number;
}

export interface DataTaskLeaseLockOptions {
    ttlMs?: number;
    waitTimeoutMs?: number;
}

export interface DataTaskJob {
    name: string;
    description?: string;
    source: DataTaskConnection;
    target: DataTaskConnection;
    targetEnvironment: DataTaskEnvironment;
    collections: DataTaskCollectionJob[];
    backup?: DataTaskBackupOptions;
    lock?: boolean | DataTaskLeaseLockOptions;
}

export interface DataTaskApproval {
    kind: 'apply' | 'restore';
    token: string;
    jobHash: string;
    sourceHash: string;
    targetHash: string;
    indexHash: string;
    issuedAt: string;
    expiresAt: string;
}

export interface DataTaskIndexPlan {
    name?: string;
    key: Record<string, unknown>;
    options: Record<string, unknown>;
    status: 'existing' | 'missing' | 'conflict';
    reason?: string;
}

export interface DataTaskChangeSample {
    identity: Record<string, unknown>;
    operation: 'insert' | 'update';
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
}

export interface DataTaskCollectionPreview {
    source: string;
    target: string;
    data: {
        source: number;
        insert: number;
        update: number;
        unchanged: number;
        conflict: number;
    };
    indexes: DataTaskIndexPlan[];
    samples: DataTaskChangeSample[];
    backupDocuments: number;
    backupBytes: number;
}

export interface DataTaskPreviewResult {
    mode: 'preview';
    jobName: string;
    passed: boolean;
    collections: DataTaskCollectionPreview[];
    warnings: string[];
    errors: string[];
    approval?: DataTaskApproval;
}

export interface DataTaskPreviewOptions {
    approvalTtlMs?: number;
    sampleSize?: number;
}

export interface DataTaskBackupRef {
    /** Canonical EJSON backup manifest. BSON identities and payloads remain typed when reopened. */
    runId: string;
    manifestPath: string;
    checksum: string;
}

export interface DataTaskApplyOptions {
    approval: DataTaskApproval;
}

export interface DataTaskApplyResult {
    mode: 'apply';
    runId: string;
    jobName: string;
    passed: boolean;
    status: 'passed' | 'partial' | 'failed';
    collections: DataTaskCollectionPreview[];
    backup: DataTaskBackupRef;
    warnings: string[];
    errors: string[];
}

export interface DataTaskRestoreTargetOptions {
    target?: DataTaskConnection;
}

export interface DataTaskRestorePreviewResult {
    mode: 'preview-restore';
    runId: string;
    passed: boolean;
    restoreDocuments: number;
    deleteDocuments: number;
    dropIndexes: number;
    createIndexes: number;
    warnings: string[];
    errors: string[];
    approval?: DataTaskApproval;
}

export interface DataTaskRestoreOptions extends DataTaskRestoreTargetOptions {
    approval: DataTaskApproval;
}

export interface DataTaskRestoreResult {
    mode: 'restore';
    runId: string;
    passed: boolean;
    status: 'passed' | 'partial' | 'failed';
    safetyBackup: DataTaskBackupRef;
    restoredDocuments: number;
    deletedDocuments: number;
    droppedIndexes: number;
    createdIndexes: number;
    warnings: string[];
    errors: string[];
}

export interface DataTaskService {
    preview(job: DataTaskJob, options?: DataTaskPreviewOptions): Promise<DataTaskPreviewResult>;
    apply(job: DataTaskJob, options: DataTaskApplyOptions): Promise<DataTaskApplyResult>;
    previewRestore(backup: DataTaskBackupRef, options?: DataTaskRestoreTargetOptions): Promise<DataTaskRestorePreviewResult>;
    restore(backup: DataTaskBackupRef, options: DataTaskRestoreOptions): Promise<DataTaskRestoreResult>;
}

export declare const dataTasks: DataTaskService;
