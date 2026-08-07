import { expectAssignable, expectNotAssignable, expectType } from 'tsd';
import MonSQLize, {
    type ModelAccessor,
    type ModelAutoIndexOptions,
    type ModelDefinition,
    type ModelDocument,
    type ModelEnsureAllIndexesOptions,
    type ModelEnsureIndexesOptions,
    type ModelIndexEnsureResult,
    type ModelIndexEnsureSummary,
    type ModelVectorSearchOptions,
    type PopulateProxy,
    type RelationConfig,
    type RelationProtectedDeleteOptions,
    type RelationProtectedDeleteResult,
    type RelationUsageOptions,
    type RelationUsageReport,
    type VirtualConfig,
} from 'monsqlize';

type UserDoc = {
    _id?: unknown;
    firstName: string;
    lastName: string;
    nickname?: string;
    posts?: Array<{ title: string }>;
};

const relation: RelationConfig = {
    from: 'posts',
    localField: '_id',
    foreignField: 'authorId',
    select: 'title createdAt',
};

const relationUsageOptions: RelationUsageOptions = {
    maxTargets: 10,
    maxSamples: 3,
    includeRelations: ['comments.author'],
    includeSoftDeletedReferences: true,
};

expectAssignable<RelationProtectedDeleteOptions>({ maxSamples: 3, session: {} });
expectNotAssignable<RelationProtectedDeleteOptions>({ includeRelations: ['comments.author'] });

const modelVectorOptions: ModelVectorSearchOptions = {
    index: 'users_embedding_index',
    path: 'embedding',
    queryVector: [0.1, 0.2],
    limit: 5,
    numCandidates: 100,
    withDeleted: true,
};

const virtual: VirtualConfig = {
    get() {
        return `${this.firstName} ${this.lastName}`;
    },
};

expectAssignable<ModelDefinition<UserDoc>>({
    schema: { type: 'object', properties: { firstName: { type: 'string' } } },
    indexes: [{ key: { firstName: 1 }, unique: false }],
    defaults: { nickname: 'ada' },
    methods: {
        greet() {
            return `${this.firstName}`;
        },
    },
    relations: { posts: relation },
    virtuals: { displayName: virtual },
    connection: { database: 'tenant_a' },
    options: {
        validate: true,
        timestamps: { createdAt: true, updatedAt: 'updatedAt' },
        autoIndex: false,
        version: { enabled: true, field: 'version', updateMany: 'strict' },
    },
});

expectAssignable<ModelDefinition<UserDoc>>({
    schema: (s) => s({
        firstName: 'string!',
        lastName: s.string().require(),
    }),
});

expectAssignable<ModelAutoIndexOptions>({ enabled: false, emitEvents: true });
expectAssignable<ModelEnsureIndexesOptions>({ dryRun: true, throwOnError: true });
expectAssignable<ModelEnsureAllIndexesOptions>({ models: ['users'], database: 'types_model' });

const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'types_model', autoIndex: { enabled: false } });
const users = runtime.model<UserDoc>('users');
declare const userDocument: ModelDocument<UserDoc>;
expectType<ModelAccessor<UserDoc>>(users);
expectType<PopulateProxy<ModelDocument<UserDoc> | null>>(users.findOne({ firstName: 'Ada' }));
expectType<PopulateProxy<ModelDocument<UserDoc> | null>>(users.findOneById('id').populate('posts'));
expectType<PopulateProxy<ModelDocument<UserDoc> | null>>(userDocument.populate('posts'));
expectType<PopulateProxy<ModelDocument<UserDoc> | null>>(userDocument.populate('posts').populate('posts'));
expectType<Promise<{ valid: boolean; errors?: Array<{ field: string; message: string; value?: unknown }>; data?: unknown }>>(userDocument.validate());
expectType<PopulateProxy<Array<ModelDocument<UserDoc>>>>(users.find({}).populate([{ path: 'posts' }]));
expectType<PopulateProxy<{ data: Array<ModelDocument<UserDoc>>; total: number }>>(users.findAndCount({}));
expectType<PopulateProxy<{
    items: Array<ModelDocument<UserDoc>>;
    pageInfo: {
        hasNext: boolean;
        hasPrev: boolean;
        startCursor: string | null;
        endCursor: string | null;
        currentPage?: number;
    };
    totals?: import('monsqlize').TotalsInfo;
    meta?: import('monsqlize').MetaInfo;
}>>(users.findPage({ page: 1, limit: 10 }));
expectType<PopulateProxy<{
    items: Array<ModelDocument<UserDoc>>;
    pageInfo: {
        hasNext: boolean;
        hasPrev: boolean;
        startCursor: string | null;
        endCursor: string | null;
        currentPage?: number;
    };
    totals: import('monsqlize').TotalsInfo & {
        mode: 'sync';
        total: number;
        totalPages: number;
    };
    meta?: import('monsqlize').MetaInfo;
}>>(users.findPage({ page: 1, limit: 10, totals: { mode: 'sync' } }));
expectType<{ valid: boolean; errors?: Array<{ field: string; message: string; value?: unknown }>; data?: unknown }>(users.validate({ firstName: 'Ada', lastName: 'Lovelace' }));
expectType<Record<string, string>>(users.getEnums());
expectType<Promise<ModelIndexEnsureResult>>(users.ensureIndexes());
expectType<Promise<ModelIndexEnsureResult>>(users.ensureIndexes({ dryRun: true, throwOnError: true }));
expectType<Promise<ModelIndexEnsureSummary>>(runtime.ensureModelIndexes({ models: ['users'], dryRun: true }));
expectType<Promise<import('monsqlize').InsertManyResult>>(users.insertMany([{ firstName: 'Ada', lastName: 'Lovelace' }]));
expectType<Promise<import('monsqlize').UpdateResult>>(users.updateOne({ firstName: 'Ada' }, { $set: { nickname: 'Countess' } }));
expectType<Promise<import('monsqlize').UpdateResult>>(users.updateOne({ firstName: 'Ada' }, { $set: { nickname: 'Countess' } }, { expectedVersion: 1 }));
expectType<Promise<import('monsqlize').UpdateResult>>(users.updateMany({}, { $set: { nickname: 'Analyst' } }, { versionMode: 'counter' }));
expectType<Promise<import('monsqlize').UpdateResult>>(users.replaceOne({ firstName: 'Ada' }, { firstName: 'Ada', lastName: 'Byron' }));
expectType<Promise<import('monsqlize').IncrementOneResult<UserDoc>>>(users.incrementOne({ firstName: 'Ada' }, 'visits', 1));
expectType<Promise<import('monsqlize').RestoreResult>>(users.restore({ firstName: 'Ada' }));
expectType<Promise<import('monsqlize').RestoreResult>>(users.restoreMany({ firstName: 'Ada' }));
expectType<Promise<import('monsqlize').InsertBatchResult>>(users.insertBatch([{ firstName: 'Ada', lastName: 'Lovelace' }]));
expectType<Promise<import('monsqlize').UpdateBatchResult>>(users.updateBatch({}, { $set: { nickname: 'Analyst' } }));
expectType<Promise<import('monsqlize').DeleteBatchResult>>(users.deleteBatch({ firstName: 'Ada' }));
expectType<Promise<Array<import('monsqlize').VectorSearchHit<ModelDocument<UserDoc>>>>>(users.vectorSearch(modelVectorOptions));
expectType<Promise<RelationUsageReport>>(users.checkRelationUsage({ firstName: 'Ada' }, relationUsageOptions));
expectType<Promise<RelationProtectedDeleteResult>>(users.deleteOneWithRelations({ firstName: 'Ada' }, { maxSamples: 1 }));
expectType<Promise<RelationProtectedDeleteResult>>(users.forceDeleteWithRelations({ firstName: 'Ada' }));
expectType<Promise<import('monsqlize').BookmarkPrewarmResult>>(users.prewarmBookmarks({ limit: 10 }, [1, 2]));
expectType<Promise<import('monsqlize').BookmarkListResult>>(users.listBookmarks({ limit: 10 }));
expectType<Promise<import('monsqlize').BookmarkClearResult>>(users.clearBookmarks({ limit: 10 }));
expectType<NodeJS.ReadableStream>(users.stream({ firstName: 'Ada' }));
expectType<Promise<unknown>>(users.explain({ firstName: 'Ada' }));
expectType<Promise<number>>(users.invalidate('find'));
expectType<Promise<boolean>>(users.dropCollection());
expectType<Promise<boolean>>(users.createCollection('users_archive'));
expectType<Promise<boolean>>(users.createView('users_view', 'users', []));
expectType<Promise<unknown[]>>(users.indexStats());
expectType<Promise<{ ok: number; collection: string }>>(users.setValidator({ $jsonSchema: { bsonType: 'object' } }));
expectType<Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }>>(users.getValidator());
expectType<Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }>>(users.stats());
expectType<Promise<{ renamed: boolean; from: string; to: string }>>(users.renameCollection('users_renamed'));
expectType<Promise<Record<string, unknown>>>(users.collMod({ validationLevel: 'moderate' }));
expectType<Promise<{ ok: number; collection: string; capped: boolean; size: number }>>(users.convertToCapped(1024));

const scoped = runtime.use('tenant_a').model<UserDoc>('users');
expectType<ModelAccessor<UserDoc>>(scoped);

