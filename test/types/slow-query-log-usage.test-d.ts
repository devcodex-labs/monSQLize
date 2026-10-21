import { expectType } from 'tsd';
import MonSQLize, {
    BatchQueue,
    SlowQueryLogConfigManager,
    SlowQueryLogManager,
    generateQueryHash,
    type SlowQueryLogConfig,
    type SlowQueryLogRecord,
} from 'monsqlize';

const config: SlowQueryLogConfig = SlowQueryLogConfigManager.mergeConfig({
    enabled: true,
    storage: { type: 'memory' },
    batch: { enabled: false, size: 1, interval: 100, maxBufferSize: 5 },
});

expectType<SlowQueryLogConfig>(SlowQueryLogConfigManager.mergeConfig({ batch: { enabled: false } }));
expectType<SlowQueryLogConfig>(SlowQueryLogConfigManager.mergeConfig({ advanced: { errorHandling: 'silent' } }));
expectType<SlowQueryLogConfig>(SlowQueryLogConfigManager.mergeConfig({ filter: { excludeOperations: ['find'] } }));
// @ts-expect-error Nested inputs still enforce the field type.
SlowQueryLogConfigManager.mergeConfig({ batch: { size: 'bad' } });
// @ts-expect-error Normalized configuration still requires all batch fields.
const incompleteNormalizedBatch: SlowQueryLogConfig['batch'] = { enabled: false };
void incompleteNormalizedBatch;

expectType<string>(generateQueryHash({ collection: 'users', query: { id: 1 } }));
const manager = new SlowQueryLogManager(config);
expectType<Promise<void>>(manager.initialize());
expectType<Promise<SlowQueryLogRecord[]>>(manager.query({ collection: 'users' }));

const queue = new BatchQueue({
    saveBatch: async () => {},
});
expectType<Promise<void>>(queue.add({
    database: 'app',
    collection: 'users',
    operation: 'find',
    durationMs: 1200,
}));

const runtime = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    slowQueryLog: config,
});
expectType<SlowQueryLogManager | null>(runtime.getSlowQueryLogManager());
expectType<Promise<void>>(runtime.recordSlowQuery({
    database: 'app',
    collection: 'users',
    operation: 'find',
    durationMs: 900,
}));
expectType<Promise<SlowQueryLogRecord[]>>(runtime.getSlowQueryLogs({ collection: 'users' }));

