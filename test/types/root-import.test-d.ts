import { expectAssignable, expectNotAssignable, expectType } from 'tsd';
import MonSQLize, {
    compilePipelineExpressions,
    type AdminAccessor,
    type CacheLike,
    type CacheLockLike,
    type LockOptions,
    type LockStats,
    type SlowQueryLogConfig,
    type TransactionOptions,
    type TransactionContract,
    type DeleteBatchResult,
    type WritePathPolicyOptions,
    type BookmarkClearResult,
    type BookmarkListResult,
    type BookmarkPrewarmResult,
    type IncrementOneResult,
    expr,
    createExpression,
    hasExpressionInObject,
    hasExpressionInPipeline,
    isExpressionObject,
    withCache,
    type Collection,
    type DeleteResult,
    type DbAccessor,
    type ExpressionObject,
    type IndexCreateResult,
    type InsertBatchResult,
    type InsertManyResult,
    type InsertOneResult,
    type FunctionCacheStats,
    type FunctionCache,
    type FindOptions,
    type CountOptions,
    type AggregateOptions,
    type DistinctOptions,
    type LoggerLike,
    type ModelAccessor,
    type ModelInstance,
    type MonSQLizeOptions,
    type MonSQLizeSchemaDslRuntime,
    type PageResult,
    type RelationConfig,
    type ResultWithMeta,
    type SchemaDslRuntimeConfig,
    type SSHConfig,
    type TotalsInfo,
    type UpdateBatchResult,
    type UpdateResult,
    type VectorSearchHit,
    type VectorSearchOptions,
} from '../..';
import type { SchemaDslRuntime } from 'schema-dsl/runtime';


const expression = expr('COUNT(*)');
expectType<ExpressionObject>(expression);
expectType<ExpressionObject>(createExpression('SUM(price)'));
expectType<boolean>(isExpressionObject(expression));
expectType<boolean>(hasExpressionInObject({ total: expression }));
expectType<boolean>(hasExpressionInPipeline([{ $project: { total: expression } }]));
expectType<Array<{ $project: { total: ExpressionObject } }>>(compilePipelineExpressions([{ $project: { total: expression } }]));
expectType<boolean>(MonSQLize.isExpressionObject(expression));
expectType<boolean>(MonSQLize.hasExpressionInObject({ total: expression }));
expectType<boolean>(MonSQLize.hasExpressionInPipeline([{ $project: { total: expression } }]));

const cacheable = withCache(async (userId: string) => ({ userId }));
expectType<Promise<{ userId: string; }>>(cacheable('u_1'));

const logger: LoggerLike = {
    info: (...args: unknown[]) => args,
};

const lockManager: CacheLockLike = {
    isLocked: (_key: string) => false,
};

const db = new MonSQLize({
    type: 'mongodb',
    databaseName: 'p1_types',
    logger,
});

const writePathPolicy: WritePathPolicyOptions = {
    default: 'model-only',
    namespaces: {
        'analytics:p1_types.users': { mode: 'allow-both', raw: 'block', management: 'allow' },
        'p1_types.audit': { mode: 'model-only', onViolation: 'warn' },
    },
};

declare const schemaDslRuntime: SchemaDslRuntime;
expectAssignable<MonSQLizeSchemaDslRuntime>(schemaDslRuntime);
expectAssignable<SchemaDslRuntimeConfig>({
    runtime: schemaDslRuntime,
    options: { locale: 'en-US', strict: true },
    extensions: [],
});

expectAssignable<MonSQLizeOptions>({
    type: 'mongodb',
    databaseName: 'p1_types',
    logger,
    cache: new MonSQLize.MemoryCache(),
    config: { uri: 'mongodb://localhost', readPreference: 'secondaryPreferred', mongoHost: 'mongo.internal', mongoPort: 27018 },
    autoConvertObjectId: { enabled: true, excludeFields: ['legacyId'], maxDepth: 5, logLevel: 'warn' },
    countQueue: true,
    schemaDsl: false,
    writePathPolicy,
    log: { formatSlowQuery: (meta) => ({ meta }) },
});
expectAssignable<MonSQLizeOptions>({
    type: 'mongodb',
    schemaDsl: {
        runtime: schemaDslRuntime,
        options: { locale: 'zh-CN' },
        extensions: [],
    },
});

expectAssignable<FindOptions>({ projection: ['name'], sort: { name: 1 }, cache: 1000, meta: { level: 'op' } });
expectAssignable<FindOptions>({ project: ['name'], sort: { name: 1 } });
expectAssignable<CountOptions>({ cache: 1000, maxTimeMS: 500, meta: true });
expectAssignable<AggregateOptions>({ allowDiskUse: true, hint: { status: 1 }, comment: 'aggregate' });
expectAssignable<VectorSearchOptions>({
    index: 'embeddings_index',
    path: 'embedding',
    queryVector: [0.1, 0.2],
    limit: 5,
    numCandidates: 100,
    filter: { status: 'published' },
    projection: ['title'],
    aggregateOptions: { allowDiskUse: true },
});
expectNotAssignable<VectorSearchOptions>({
    index: 'embeddings_index',
    path: 'embedding',
    queryVector: [0.1, 0.2],
    limit: 5,
    numCandidates: 100,
    aggregateOptions: { meta: true },
});
expectAssignable<DistinctOptions>({ collation: { locale: 'en' }, hint: 'name_1', meta: { includeCache: true } });

expectAssignable<SSHConfig>({
    host: 'bastion.example.com',
    port: 22,
    username: 'deploy',
    privateKeyPath: '~/.ssh/id_rsa',
});
expectNotAssignable<SSHConfig>({
    host: 'bastion.example.com',
    username: 'deploy',
    scopedCollection: (_name: string) => null,
});

expectType<Promise<{
    collection: <TSchema = any>(name: string) => Collection<TSchema>;
    db: (name?: string) => DbAccessor;
    use: (name: string) => {
        collection: <TSchema = any>(collectionName: string) => Collection<TSchema>;
        model: <TDocument = any>(modelName: string) => ModelAccessor<TDocument>;
    };
    instance: MonSQLize;
}>>(db.connect());
expectType<Collection>(db.collection('users'));
expectType<DbAccessor>(db.db());
expectType<AdminAccessor>(db.db().admin());
expectAssignable<CacheLike>(MonSQLize.createRedisCacheAdapter({
    get() { return null; },
    set() { },
    del() { return 0; },
    exists() { return false; },
    mget() { return []; },
    scan() { return ['0', []]; },
    flushdb() { },
    pipeline() {
        return {
            set() { return this; },
            del() { return this; },
            exec() { return Promise.resolve([]); },
        };
    },
}));

const users = db.collection<{ name: string; }>('users');
expectType<Promise<number>>(users.count({}));
expectType<Promise<ResultWithMeta<number>>>(users.count({}, { meta: true }));
expectType<Promise<InsertOneResult>>(users.insertOne({ name: 'Ada' }));
expectType<Promise<InsertManyResult>>(users.insertMany([{ name: 'Ada' }, { name: 'Grace' }]));
expectType<Promise<InsertBatchResult>>(users.insertBatch([{ name: 'Ada' }, { name: 'Grace' }]));
expectType<Promise<UpdateResult>>(users.updateOne({}, { $set: { name: 'Ada Lovelace' } }));
expectType<Promise<UpdateResult>>(users.updateMany({}, { $set: { active: true } }));
expectType<Promise<UpdateBatchResult>>(users.updateBatch({}, { $set: { active: true } }));
expectType<Promise<UpdateResult>>(users.replaceOne({}, { name: 'Grace' }));
expectType<Promise<{ name: string; } | null>>(users.findOneAndUpdate({}, { $set: { name: 'Grace' } }));
expectType<Promise<{ name: string; } | null>>(users.findOneAndDelete({ name: 'Grace' }));
expectType<Promise<UpdateResult>>(users.upsertOne({}, { $set: { name: 'Upserted' } }));
expectType<Promise<IncrementOneResult<{ name: string; }>>>(users.incrementOne({}, 'visits'));
expectType<Promise<DeleteResult>>(users.deleteOne({ name: 'Ada Lovelace' }));
expectType<Promise<DeleteResult>>(users.deleteMany({ active: false }));
expectType<Promise<DeleteBatchResult>>(users.deleteBatch({ active: false }));
expectType<Promise<IndexCreateResult>>(users.createIndex({ email: 1 }));
expectType<Promise<string[]>>(users.createIndexes([{ key: { email: 1 }, unique: true }]));
expectType<Promise<Record<string, unknown>[]>>(users.listIndexes());
expectType<Promise<unknown>>(users.dropIndex('email_1'));
expectType<Promise<unknown>>(users.dropIndexes());
expectType<Promise<BookmarkPrewarmResult>>(users.prewarmBookmarks({ query: { name: 'Ada' }, limit: 1 }, [1]));
expectType<Promise<BookmarkListResult>>(users.listBookmarks({ query: { name: 'Ada' }, limit: 1 }));
expectType<Promise<BookmarkClearResult>>(users.clearBookmarks({ query: { name: 'Ada' }, limit: 1 }));
expectType<Promise<unknown[]>>(users.distinct('name'));
expectType<Promise<ResultWithMeta<unknown[]>>>(users.distinct('name', {}, { meta: true }));
const findChain = users.find({ name: 'Ada' });
expectAssignable<Promise<{ name: string; }[]>>(findChain);
findChain.limit(1);
findChain.skip(0);
findChain.sort({ name: 1 });
findChain.project({ name: 1 });
expectType<Promise<unknown>>(findChain.explain());
const metaFindChain = users.find({ name: 'Ada' }, { meta: true });
expectAssignable<Promise<ResultWithMeta<{ name: string; }[]>>>(metaFindChain);
metaFindChain.limit(1);
expectType<Promise<ResultWithMeta<{ name: string; } | null>>>(users.findOne({ name: 'Ada' }, { meta: true }));

const aggregateChain = users.aggregate([]);
expectAssignable<Promise<unknown[]>>(aggregateChain);
aggregateChain.allowDiskUse(true);
aggregateChain.batchSize(100);
expectType<Promise<unknown>>(aggregateChain.explain());
const metaAggregateChain = users.aggregate<{ total: number }>([], { meta: true });
expectAssignable<Promise<ResultWithMeta<Array<{ total: number }>>>>(metaAggregateChain);
expectType<Promise<Array<VectorSearchHit<{ name: string; }>>>>(users.vectorSearch({
    index: 'users_embedding_index',
    path: 'embedding',
    queryVector: [0.1, 0.2],
    limit: 5,
    numCandidates: 100,
}));

expectType<Promise<{ name: string; } | null>>(users.findOneById('507f1f77bcf86cd799439011'));
expectType<Promise<{ name: string; }[]>>(users.findByIds(['507f1f77bcf86cd799439011']));
expectType<Promise<import('../..').FindAndCountResult<{ name: string; }>>>(users.findAndCount({ name: 'Ada' }));
expectType<Promise<import('../..').FindPageResult<{ name: string; }>>>(users.findPage({ page: 1, limit: 10 }));
expectType<Promise<import('../..').FindPageResult<{ name: string; }>>>(users.findPage({ page: 1, limit: 10, project: ['name'] }));
expectType<Promise<PageResult<{ name: string; }>>>(users.findPage({ page: 1, limit: 10 }));
const syncTotalsPage = users.findPage({ page: 1, limit: 10, totals: { mode: 'sync' } });
expectAssignable<Promise<Omit<PageResult<{ name: string; }>, 'totals'> & {
    totals: TotalsInfo & {
        mode: 'sync';
        total: number;
        totalPages: number;
    };
}>>(syncTotalsPage);
expectType<Promise<number>>(syncTotalsPage.then((page) => page.totals.total));
expectType<Promise<number>>(syncTotalsPage.then((page) => page.totals.totalPages));
expectType<Promise<{ name: string; } | null>>(users.findOneAndReplace({}, { name: 'Grace' }));
expectType<Promise<boolean>>(db.db().admin().ping());
expectType<Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }>>(users.stats());
expectType<Promise<{ renamed: boolean; from: string; to: string }>>(users.renameCollection('users_archive'));
expectType<Promise<Record<string, unknown>>>(users.collMod({ validationLevel: 'moderate' }));
expectType<Promise<{ ok: number; collection: string; capped: boolean; size: number }>>(users.convertToCapped(1024));
expectType<Promise<{ ok: number; collection: string }>>(users.setValidator({ $jsonSchema: { bsonType: 'object' } }));
expectType<Promise<{ ok: number; validationLevel: string }>>(users.setValidationLevel('moderate'));
expectType<Promise<{ ok: number; validationAction: string }>>(users.setValidationAction('warn'));
expectType<Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }>>(users.getValidator());

const memoryCache = new MonSQLize.MemoryCache();
memoryCache.setLockManager(lockManager);
expectType<CacheLockLike | null>(memoryCache.getLockManager());
expectType<Record<string, unknown>>(memoryCache.getMany(['a']));

const functionCache = new MonSQLize.FunctionCache();
expectType<FunctionCache>(functionCache);
expectType<Promise<void>>(functionCache.register('lookup', async () => 1));
expectType<Promise<unknown>>(functionCache.execute('lookup'));
expectType<FunctionCacheStats | Record<string, FunctionCacheStats> | null>(functionCache.getStats('lookup'));

declare const modelInstance: ModelInstance<{ name: string }>;
declare const inferredModelAccessor: ReturnType<MonSQLize['model']>;
declare const inferredCollectionAccessor: ReturnType<MonSQLize['collection']>;
expectType<Record<string, RelationConfig>>(modelInstance.getRelations());
expectType<Record<string, string>>(modelInstance.getEnums());
expectAssignable<ModelAccessor<any>>(inferredModelAccessor);
expectAssignable<Collection<any>>(inferredCollectionAccessor);

const txOptions: TransactionOptions = { maxDuration: 1000, maxRetries: 1 };
const lockOptions: LockOptions = { ttl: 1000, retryTimes: 1 };
expectType<Promise<TransactionContract>>(db.startSession(txOptions));
expectType<Promise<string>>(db.withTransaction(async (tx) => tx.id, txOptions));
expectType<Promise<number>>(db.withLock('cron:job', async () => 1, lockOptions));
expectType<Promise<import('../..').LockContract>>(db.acquireLock('cron:job', lockOptions));
expectType<Promise<import('../..').LockContract | null>>(db.tryAcquireLock('cron:job', { ttl: 1000 }));
expectType<LockStats>(new MonSQLize.LockManager().getStats());

const slowQueryConfig = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
    storage: { type: 'memory' },
    batch: { enabled: false, size: 1, interval: 100, maxBufferSize: 5 },
});
expectType<SlowQueryLogConfig>(slowQueryConfig);
expectType<string>(MonSQLize.generateQueryHash({ collection: 'users', query: { id: 1 } }));
const slowQueryQueue = new MonSQLize.BatchQueue({
    saveBatch: async () => { },
});
expectType<Promise<void>>(slowQueryQueue.add({
    database: 'app',
    collection: 'users',
    operation: 'find',
    durationMs: 900,
}));
expectAssignable<object>(new MonSQLize.SlowQueryLogMemoryStorage());
expectAssignable<object>(MonSQLize.MongoDBSlowQueryLogStorage);

expectType<Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }> | string[]>>(db.db().listDatabases());

