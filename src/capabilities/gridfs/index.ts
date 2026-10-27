import type { Db } from 'mongodb';
import type { Logger } from '../../core/logger';
import type { NormalizedWritePathPolicy } from '../write-path-policy';
import { MonSQLizeGridFSBucketImpl } from './bucket';
import { createGridFSDriver } from './driver';
import { GridFSIndexLatch } from './indexes';
import { DEFAULT_CHUNK_SIZE_BYTES, type GridFSDriver } from './types';
import { assertBucketName, assertChunkSize } from './validate';

export interface CreateGridFSBucketDeps {
    db: Db;
    bucketName: string;
    dbName: string;
    poolName?: string;
    chunkSizeBytes?: number;
    source: 'db' | 'model';
    policy?: NormalizedWritePathPolicy;
    logger?: Pick<Logger, 'warn'>;
    driver?: GridFSDriver;
}

export function createMonSQLizeGridFSBucket(deps: CreateGridFSBucketDeps): MonSQLizeGridFSBucketImpl {
    assertBucketName(deps.bucketName);
    const chunkSizeBytes = deps.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    assertChunkSize(chunkSizeBytes, 'gridfs');
    const driver = deps.driver ?? createGridFSDriver(deps.db, deps.bucketName, chunkSizeBytes);
    return new MonSQLizeGridFSBucketImpl({
        db: deps.db,
        driver,
        bucketName: deps.bucketName,
        dbName: deps.dbName,
        poolName: deps.poolName,
        chunkSizeBytes,
        source: deps.source,
        policy: deps.policy,
        logger: deps.logger,
        indexes: new GridFSIndexLatch(deps.db, deps.bucketName),
    });
}

export { MonSQLizeGridFSBucketImpl };
export type { GridFSDriver, GridFSFileInfo } from './types';
