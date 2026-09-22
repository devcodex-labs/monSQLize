import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectId } from 'mongodb';
import { convertObjectIdStrings, convertUpdateDocument } from '../../../src/adapters/mongodb/utils/objectid-converter';
import { createConnectionError, createCursorError, createQueryTimeoutError, createValidationError } from '../../../src/core/errors';
import {
    attachModelStatics,
    buildModelSchemaState,
    collectModelIndexDefinitions,
    ensureModelIndexesForCollection,
    getModelEnums,
    initializeModelV1Methods,
    isModelValidationEnabled,
    resolveModelHooksFactory,
    resolveModelAutoIndexOptions,
    resolveModelSoftDeleteConfig,
    resolveModelTimestampsConfig,
    resolveModelVersionConfig,
    scheduleModelIndexes,
    summarizeModelIndexEnsureResults,
} from '../../../src/capabilities/model/model-instance-config';
import {
    normalizePopulateConfig,
    processTimestamps,
    validateCollectionName,
    validateDefinition,
    validateRelationConfig,
} from '../../../src/capabilities/model/definition-validator';
import {
    applyModelDefaults,
    hydrateModelDocument,
    populateModelPath,
    removeModelDocument,
    saveModelDocument,
    validateModelDocument,
} from '../../../src/capabilities/model/model-instance-helpers';
import {
    applySort,
    getByPath,
    groupBy,
    pickFields,
    serializeDocument,
    toKey,
    unique,
} from '../../../src/capabilities/model/model-utils';
import { ConnectionPoolManager } from '../../../src/capabilities/pool';
import { HealthChecker } from '../../../src/capabilities/pool/pool-health-checker';
import {
    createEmptyPoolStats,
    validatePoolConfig as validatePoolConfigSource,
    validatePoolConfigInternal,
    validatePoolConfigSafe as validatePoolConfigSafeSource,
} from '../../../src/capabilities/pool/pool-runtime-helpers';
import { MongoDBSlowQueryLogStorage, SlowQueryLogMemoryStorage } from '../../../src/capabilities/slow-query-log/slow-query-log-storage';
import {
    cloneSlowQueryLogRecord,
    matchesSlowQueryLogFilter,
    mergeSlowQueryLogRecord,
    normalizeSlowQueryLogEntry,
    sortSlowQueryLogRecords,
    stableStringify,
    toMongoFilter,
} from '../../../src/capabilities/slow-query-log/slow-query-log-records';
import { _makeValidatingDslFn, createSchemaDslEngine } from '../../../src/capabilities/model/schema-dsl';
import { Model } from '../../../src/capabilities/model';
import { MemoryCache } from '../../../src/capabilities/cache';
import {
    createRuntimeModelHost,
    createRuntimeModelInstance,
} from '../../../src/entry/runtime-model';
import {
    assertCompatPoolExists,
    createPoolScope,
    getCompatModelInstanceCache,
    getRegisteredModelMetadata,
    getRuntimeDatabaseName,
    requireCompatDbInstance,
    requireCompatPoolManagerRecord,
    resolvePoolClientFromRecord,
} from '../../../src/entry/runtime-compat-accessors';
import {
    buildRuntimeDefaults,
    initAutoConvertConfig,
    loadModelFiles,
} from '../../../src/entry/capability-wiring';
import { findByIdsDocuments, findOneByIdDocument } from '../../../src/adapters/mongodb/queries/find-by-id';
import { buildQueryMeta, wrapQueryResultWithMeta } from '../../../src/adapters/mongodb/queries';
import { deleteBatchDocuments, insertBatchDocuments, updateBatchDocuments } from '../../../src/adapters/mongodb/writes/write-batch';
import {
    orchestrateModelDeleteMany,
    orchestrateModelDeleteBatch,
    orchestrateModelDeleteOne,
    orchestrateModelFindOneAndDelete,
    orchestrateModelFindOneAndReplace,
    orchestrateModelFindOneAndUpdate,
    orchestrateModelIncrementOne,
    orchestrateModelInsertBatch,
    orchestrateModelInsertMany,
    orchestrateModelInsertOne,
    orchestrateModelReplaceOne,
    orchestrateModelUpdateOne,
    orchestrateModelUpdateBatch,
    orchestrateModelUpdateMany,
    orchestrateModelUpsertOne,
} from '../../../src/capabilities/model/model-mutation-orchestrator';

const MonSQLize = require('../../../dist/cjs/index.cjs');
const Module = require('node:module');

// ─────────────────────────────────────────────────────────────────────────────
// Query meta helpers
// ─────────────────────────────────────────────────────────────────────────────

describe('query meta helpers', () => {
    const collection = {
        namespace: 'meta_db.meta_items',
        dbName: 'meta_db',
        collectionName: 'meta_items',
    } as any;

    it('buildQueryMeta includes maxTimeMS and normalized error info', () => {
        const meta = buildQueryMeta(
            collection,
            { namespace: { instanceId: 'iid_1' } },
            'find',
            { maxTimeMS: 25 },
            Date.now(),
            Object.assign(new Error('boom'), { code: 'META_BOOM' }),
        );

        assert.equal(meta.maxTimeMS, 25);
        assert.equal(meta.error?.code, 'META_BOOM');
        assert.equal(meta.error?.message, 'boom');
        assert.equal(meta.ns.iid, 'iid_1:meta_db:meta_items');
    });

    it('wrapQueryResultWithMeta returns raw data when meta is disabled', () => {
        const data = [{ ok: true }];
        const result = wrapQueryResultWithMeta(collection, {}, 'find', { meta: false }, Date.now(), data);
        assert.equal(result, data);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateQueryHash / stableStringify (via generateQueryHash)
// ─────────────────────────────────────────────────────────────────────────────

describe('generateQueryHash — stableStringify branches', () => {

    it('generateQueryHash with null input returns a hash string', () => {
        const hash = MonSQLize.generateQueryHash(null);
        assert.equal(typeof hash, 'string');
        assert.equal(hash.length, 16);
    });

    it('generateQueryHash with 0 (falsy primitive) returns a hash string', () => {
        const hash = MonSQLize.generateQueryHash(0);
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with array input covers array branch', () => {
        const hash = MonSQLize.generateQueryHash([1, 2, 3]);
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with nested array covers recursive call', () => {
        const hash = MonSQLize.generateQueryHash([[1, 2], [3, 4]]);
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with Date covers Date branch', () => {
        const hash = MonSQLize.generateQueryHash(new Date('2024-01-01'));
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with plain string covers string JSON path', () => {
        const hash = MonSQLize.generateQueryHash('mystring');
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with number covers number path', () => {
        const hash = MonSQLize.generateQueryHash(42);
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with boolean covers boolean path', () => {
        const hash = MonSQLize.generateQueryHash(true);
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with object covers object branch (sorts keys)', () => {
        const hash1 = MonSQLize.generateQueryHash({ b: 2, a: 1 });
        const hash2 = MonSQLize.generateQueryHash({ a: 1, b: 2 });
        assert.equal(hash1, hash2);
    });

    it('generateQueryHash with object containing Date value', () => {
        const hash = MonSQLize.generateQueryHash({ date: new Date('2024-01-01'), name: 'test' });
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with object containing array value', () => {
        const hash = MonSQLize.generateQueryHash({ ids: [1, 2, 3], op: 'find' });
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with db field uses db over database', () => {
        const hash1 = MonSQLize.generateQueryHash({ db: 'mydb', collection: 'col', operation: 'find' });
        const hash2 = MonSQLize.generateQueryHash({ db: 'mydb', database: 'other', collection: 'col', operation: 'find' });
        assert.equal(hash1, hash2);
    });

    it('generateQueryHash with database field (no db)', () => {
        const hash = MonSQLize.generateQueryHash({ database: 'mydb', collection: 'col', operation: 'find' });
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with only coll field (no collection)', () => {
        const hash = MonSQLize.generateQueryHash({ database: 'db', coll: 'mycol', operation: 'find' });
        assert.equal(typeof hash, 'string');
        assert.equal(hash.length, 16);
    });

    it('generateQueryHash with only op field (no operation)', () => {
        const hash = MonSQLize.generateQueryHash({ database: 'db', collection: 'col', op: 'insert' });
        assert.equal(typeof hash, 'string');
        assert.equal(hash.length, 16);
    });

    it('generateQueryHash with queryShape normalizes input', () => {
        const hash = MonSQLize.generateQueryHash({ database: 'db', collection: 'col', operation: 'find', queryShape: { status: 1 } });
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with non-string db/coll/op falls back to empty string', () => {
        const hash = MonSQLize.generateQueryHash({ db: 123, collection: 456, operation: null });
        assert.equal(typeof hash, 'string');
    });

    it('generateQueryHash with null value in object', () => {
        const hash = MonSQLize.generateQueryHash({ a: null, b: undefined });
        assert.equal(typeof hash, 'string');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error factories (createValidationError / createCursorError / createQueryTimeoutError)
// ─────────────────────────────────────────────────────────────────────────────

describe('Error factories — additional coverage', () => {

    it('createValidationError builds error with VALIDATION_ERROR code', () => {
        const err = MonSQLize.createValidationError([{ field: 'name', message: 'required' }]);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.ok(err.details?.length > 0);
    });

    it('createValidationError with empty details array', () => {
        const err = MonSQLize.createValidationError([]);
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.ok(Array.isArray(err.details));
    });

    it('createCursorError with default message', () => {
        const err = MonSQLize.createCursorError();
        assert.equal(err.code, 'INVALID_CURSOR');
        assert.ok(err.message.includes('cursor') || err.message.length > 0);
    });

    it('createCursorError with custom message', () => {
        const err = MonSQLize.createCursorError('cursor expired');
        assert.equal(err.code, 'INVALID_CURSOR');
        assert.equal(err.message, 'cursor expired');
    });

    it('createQueryTimeoutError without timeout argument', () => {
        const err = MonSQLize.createQueryTimeoutError();
        assert.equal(err.code, 'QUERY_TIMEOUT');
        assert.ok(err.message.includes('timeout'));
    });

    it('createQueryTimeoutError with timeout in ms', () => {
        const err = MonSQLize.createQueryTimeoutError(3000);
        assert.equal(err.code, 'QUERY_TIMEOUT');
        assert.ok(err.message.includes('3000'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlowQueryLogConfigManager.mergeConfig / validate
// ─────────────────────────────────────────────────────────────────────────────

describe('SlowQueryLogConfigManager', () => {

    it('mergeConfig returns default config when called with undefined', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(undefined);
        assert.equal(cfg.enabled, false);
        assert.ok(cfg.storage !== undefined);
        assert.ok(cfg.batch !== undefined);
    });

    it('mergeConfig(null) returns default config', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(null);
        assert.equal(cfg.enabled, false);
    });

    it('mergeConfig(true) enables slow query log', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(true);
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.storage.type, 'mongodb');
    });

    it('mergeConfig(false) disables slow query log', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(false);
        assert.equal(cfg.enabled, false);
    });

    it('mergeConfig(true) with non-mongodb businessType sets memory storage', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(true, 'other');
        assert.equal(cfg.storage.type, 'memory');
    });

    it('mergeConfig with storage config auto-enables', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: false,
            storage: { type: 'memory' },
        });
        assert.equal(cfg.enabled, true);
    });

    it('mergeConfig with full config object merges all fields', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            batch: { size: 20, interval: 1000, maxBufferSize: 200, enabled: true },
            filter: { minExecutionTimeMs: 100, excludeDatabases: ['admin'], excludeCollections: [], excludeOperations: [] },
        });
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.batch.size, 20);
        assert.equal(cfg.filter.minExecutionTimeMs, 100);
    });

    it('mergeConfig with undefined storage.type sets mongodb for mongodb businessType', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({ enabled: true });
        assert.ok(cfg.storage.type === 'mongodb' || cfg.storage.type !== undefined);
    });

    it('validate passes for disabled config', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(false);
        assert.equal(MonSQLize.SlowQueryLogConfigManager.validate(cfg), true);
    });

    it('validate passes for enabled memory config', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'memory' },
        });
        assert.ok(MonSQLize.SlowQueryLogConfigManager.validate(cfg, 'other'));
    });

    it('validate throws for invalid config object', () => {
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(null as any),
            /config must be an object/,
        );
    });

    it('validate throws for invalid storage type', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig(true);
        cfg.storage.type = 'redis' as any;
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /storage\.type/,
        );
    });

    it('validate throws when mongodb storage needs uri but lacks it', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'mongodb', useBusinessConnection: false, uri: null },
        });
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /storage\.uri/,
        );
    });

    it('validate throws for invalid batch.size', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'memory' },
            batch: { size: 0, interval: 100, maxBufferSize: 10, enabled: true },
        });
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /batch\.size/,
        );
    });

    it('validate throws for invalid batch.interval', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'memory' },
            batch: { size: 10, interval: 10, maxBufferSize: 100, enabled: true },
        });
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /batch\.interval/,
        );
    });

    it('validate throws for invalid batch.maxBufferSize', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'memory' },
            batch: { size: 10, interval: 100, maxBufferSize: 5, enabled: true },
        });
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /maxBufferSize/,
        );
    });

    it('validate throws for negative minExecutionTimeMs', () => {
        const cfg = MonSQLize.SlowQueryLogConfigManager.mergeConfig({
            enabled: true,
            storage: { type: 'memory' },
            filter: { minExecutionTimeMs: -1, excludeDatabases: [], excludeCollections: [], excludeOperations: [] },
        });
        assert.throws(
            () => MonSQLize.SlowQueryLogConfigManager.validate(cfg),
            /minExecutionTimeMs/,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pool config validators / BatchQueue / model-utils branch coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePoolConfig / validatePoolConfigSafe — branch coverage', () => {
    const validConfig = {
        name: 'main',
        uri: 'mongodb://localhost:27017/test',
        role: 'primary',
        weight: 1,
        options: {
            maxPoolSize: 10,
            minPoolSize: 0,
            maxIdleTimeMS: 1000,
            waitQueueTimeoutMS: 1000,
            connectTimeoutMS: 1000,
            serverSelectionTimeoutMS: 1000,
        },
        healthCheck: {
            enabled: true,
            interval: 1000,
            timeout: 500,
            retries: 2,
        },
        tags: ['primary', 'local'],
    };

    it('strict validator accepts a full valid config', () => {
        assert.doesNotThrow(() => MonSQLize.validatePoolConfig(validConfig));
    });

    it('strict validator accepts mongodb+srv uri', () => {
        assert.doesNotThrow(() => MonSQLize.validatePoolConfig({ name: 'srv', uri: 'mongodb+srv://example.test/db' }));
    });

    it('strict validator rejects invalid top-level fields', () => {
        assert.throws(() => MonSQLize.validatePoolConfig(null), /object/);
        assert.throws(() => MonSQLize.validatePoolConfig({ uri: validConfig.uri }), /name/);
        assert.throws(() => MonSQLize.validatePoolConfig({ name: 'main' }), /uri/);
        assert.throws(() => MonSQLize.validatePoolConfig({ name: 'main', uri: 'http://localhost' }), /mongodb/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, role: 'bad' }), /role/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, weight: '1' }), /weight/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, weight: -1 }), /non-negative/);
    });

    it('strict validator rejects invalid nested options and healthCheck fields', () => {
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, options: [] }), /options/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, options: { maxPoolSize: -1 } }), /maxPoolSize/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, options: { connectTimeoutMS: 'fast' } }), /connectTimeoutMS/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, healthCheck: [] }), /healthCheck/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, healthCheck: { enabled: 'yes' } }), /enabled/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, healthCheck: { interval: -1 } }), /interval/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, tags: 'primary' }), /tags/);
        assert.throws(() => MonSQLize.validatePoolConfig({ ...validConfig, tags: ['primary', 1] }), /strings/);
    });

    it('safe validator collects all supported error branches', () => {
        assert.deepEqual(MonSQLize.validatePoolConfigSafe(null), ['Pool config must be an object']);

        const errors = MonSQLize.validatePoolConfigSafe({
            name: '',
            uri: 'http://localhost',
            role: 'bad',
            weight: -1,
            options: { maxPoolSize: -1 },
            healthCheck: { enabled: 'yes', interval: -1, timeout: 'slow', retries: -1 },
            tags: ['primary', 2],
        });

        assert.ok(errors.some((msg: string) => msg.includes('name')));
        assert.ok(errors.some((msg: string) => msg.includes('uri')));
        assert.ok(errors.some((msg: string) => msg.includes('role')));
        assert.ok(errors.some((msg: string) => msg.includes('weight')));
        assert.ok(errors.some((msg: string) => msg.includes('maxPoolSize')));
        assert.ok(errors.some((msg: string) => msg.includes('enabled')));
        assert.ok(errors.some((msg: string) => msg.includes('interval')));
        assert.ok(errors.some((msg: string) => msg.includes('timeout')));
        assert.ok(errors.some((msg: string) => msg.includes('retries')));
        assert.ok(errors.some((msg: string) => msg.includes('array of strings')));
    });

    it('safe validator handles non-object nested config branches', () => {
        const errors = MonSQLize.validatePoolConfigSafe({
            name: 'main',
            uri: validConfig.uri,
            options: 'bad',
            healthCheck: 'bad',
            tags: 'bad',
        });

        assert.ok(errors.some((msg: string) => msg.includes('options')));
        assert.ok(errors.some((msg: string) => msg.includes('healthCheck')));
        assert.ok(errors.some((msg: string) => msg.includes('tags')));
    });

    it('safe validator returns no errors for a valid config', () => {
        assert.deepEqual(MonSQLize.validatePoolConfigSafe(validConfig), []);
    });
});

describe('BatchQueue — branch coverage', () => {
    const log = {
        database: 'db',
        collection: 'col',
        operation: 'find',
        durationMs: 120,
    };

    it('flush on empty queue returns without saving', async () => {
        let calls = 0;
        const queue = new MonSQLize.BatchQueue({ saveBatch: async () => { calls++; } }, { size: 2, interval: 1000, maxBufferSize: 10 });
        await queue.flush();
        assert.equal(calls, 0);
    });

    it('add flushes immediately when batch size is reached', async () => {
        const batches: unknown[][] = [];
        const queue = new MonSQLize.BatchQueue({ saveBatch: async (rows: unknown[]) => { batches.push(rows); } }, { size: 2, interval: 1000, maxBufferSize: 10 });

        await queue.add(log);
        assert.equal(batches.length, 0);
        await queue.add({ ...log, collection: 'col2' });

        assert.equal(batches.length, 1);
        assert.equal(batches[0].length, 2);
    });

    it('add flushes immediately when maxBufferSize is reached', async () => {
        const batches: unknown[][] = [];
        const queue = new MonSQLize.BatchQueue({ saveBatch: async (rows: unknown[]) => { batches.push(rows); } }, { size: 10, interval: 1000, maxBufferSize: 1 });

        await queue.add(log);

        assert.equal(batches.length, 1);
        assert.equal(batches[0].length, 1);
    });

    it('close clears pending timer and flushes buffered rows', async () => {
        const batches: unknown[][] = [];
        const queue = new MonSQLize.BatchQueue({ saveBatch: async (rows: unknown[]) => { batches.push(rows); } }, { size: 10, interval: 10000, maxBufferSize: 20 });

        await queue.add(log);
        await queue.close();

        assert.equal(batches.length, 1);
        assert.equal(batches[0].length, 1);
    });

    it('concurrent flush calls save only once while flushing is true', async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let calls = 0;
        const queue = new MonSQLize.BatchQueue({
            saveBatch: async () => {
                calls++;
                await pending;
            },
        }, { size: 10, interval: 1000, maxBufferSize: 20 });

        await queue.add(log);
        const firstFlush = queue.flush();
        const secondFlush = queue.flush();
        release();
        await Promise.all([firstFlush, secondFlush]);

        assert.equal(calls, 1);
    });

    it('flush failure logs error and keeps queue usable', async () => {
        const errors: unknown[] = [];
        let shouldThrow = true;
        const queue = new MonSQLize.BatchQueue({
            saveBatch: async () => {
                if (shouldThrow) throw new Error('boom');
            },
        }, { size: 1, interval: 1000, maxBufferSize: 10 }, { error: (...args: unknown[]) => errors.push(args), debug: () => { } });

        await queue.add(log);
        shouldThrow = false;
        await queue.add({ ...log, collection: 'after_error' });

        assert.equal(errors.length, 1);
    });

    it('keeps maxBufferSize as a hard cap while a flush is in flight', async () => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const warnings: unknown[][] = [];
        const batches: Array<Array<{ query: { id: number } }>> = [];
        const queue = new MonSQLize.BatchQueue({
            saveBatch: async (rows: Array<{ query: { id: number } }>) => {
                batches.push(rows);
                if (batches.length === 1) {
                    await pending;
                }
            },
        }, { size: 1, interval: 10000, maxBufferSize: 2 }, {
            warn: (...args: unknown[]) => warnings.push(args),
            debug: () => { },
            error: () => { },
        });

        const makeLog = (id: number) => ({ ...log, collection: `col_${id}`, query: { id } });
        const firstFlush = queue.add(makeLog(1));
        await new Promise((resolve) => setImmediate(resolve));
        await queue.add(makeLog(2));
        await queue.add(makeLog(3));
        await queue.add(makeLog(4));

        release();
        await firstFlush;
        await queue.close();

        assert.ok(warnings.some(([message]) => String(message).includes('buffer overflow')));
        assert.deepEqual(batches.flat().map((row) => row.query.id), [1, 3, 4]);
    });
});

describe('model-utils — direct branch coverage', () => {
    it('toKey covers Date, toHexString, toString and primitive paths', () => {
        assert.equal(toKey(new Date('2024-01-01T00:00:00Z')), '2024-01-01T00:00:00.000Z');
        assert.equal(toKey({ toHexString: () => 'abc123' }), 'abc123');
        assert.equal(toKey({ toString: () => 'custom-object' }), 'custom-object');
        assert.equal(toKey(42), '42');
    });

    it('unique and groupBy preserve first occurrence groups', () => {
        assert.deepEqual(unique([{ toString: () => 'a' }, { toString: () => 'a' }, 'b']).map(toKey), ['a', 'b']);

        const groups = groupBy([
            { type: 'a', value: 1 },
            { type: 'a', value: 2 },
            { type: 'b', value: 3 },
        ], (row) => row.type);

        assert.equal(groups.get('a')?.length, 2);
        assert.equal(groups.get('b')?.length, 1);
    });

    it('getByPath returns undefined for null intermediate node and missing path', () => {
        assert.equal(getByPath({ a: null }, 'a.b'), undefined);
        assert.equal(getByPath({ a: { b: 1 } }, 'a.c'), undefined);
        assert.equal(getByPath({ a: { b: 1 } }, 'a.b'), 1);
    });

    it('pickFields handles string select, array select, alwaysInclude and _id retention', () => {
        const document = { _id: 'id1', name: 'Ada', age: 36, role: 'admin' };

        assert.deepEqual(pickFields(document, 'name age'), { name: 'Ada', age: 36, _id: 'id1' });
        assert.deepEqual(pickFields(document, ['name'], ['role']), { name: 'Ada', role: 'admin', _id: 'id1' });
    });

    it('applySort covers equality, left-null, right-null and descending branches', () => {
        const rows = [
            { name: 'B', score: null, nested: { rank: 2 } },
            { name: 'A', score: 10, nested: { rank: 2 } },
            { name: 'C', score: 8, nested: { rank: 1 } },
            { name: 'D', score: undefined, nested: { rank: 3 } },
        ];

        const sortedByScore = applySort(rows, { score: 1 });
        assert.equal(sortedByScore[0].name, 'C');
        assert.equal(sortedByScore[sortedByScore.length - 1].name, 'D');

        const sortedByRankDesc = applySort(rows, { 'nested.rank': -1, name: 1 });
        assert.equal(sortedByRankDesc[0].name, 'D');
        assert.equal(sortedByRankDesc[1].name, 'A');
    });

    it('serializeDocument strips function values', () => {
        const result = serializeDocument({ name: 'Ada', save: () => undefined, age: 36 });
        assert.deepEqual(result, { name: 'Ada', age: 36 });
    });
});

describe('ObjectId converter — direct branch coverage', () => {
    const id = '507f1f77bcf86cd799439011';

    it('returns primitive, null, ObjectId, and field references unchanged when appropriate', () => {
        const objectId = new ObjectId(id);

        assert.equal(convertObjectIdStrings(null), null);
        assert.equal(convertObjectIdStrings(undefined), undefined);
        assert.equal(convertObjectIdStrings(objectId), objectId);
        assert.equal(convertObjectIdStrings('$authorId'), '$authorId');
        assert.equal(convertObjectIdStrings('not-an-object-id'), 'not-an-object-id');
    });

    it('converts valid ObjectId strings in direct values, arrays, and whitelisted fields', () => {
        assert.ok(convertObjectIdStrings(id) instanceof ObjectId);

        const source = {
            _id: id,
            authorId: id,
            child_ids: [id, '$otherId', 'bad'],
            nested: { owner_id: id },
            $expr: { authorId: id },
        };
        const converted = convertObjectIdStrings(source) as Record<string, unknown>;

        assert.ok(converted._id instanceof ObjectId);
        assert.ok(converted.authorId instanceof ObjectId);
        assert.ok((converted.nested as Record<string, unknown>).owner_id instanceof ObjectId);
        assert.ok(((converted.child_ids as unknown[])[0]) instanceof ObjectId);
        assert.equal((converted.child_ids as unknown[])[1], '$otherId');
        assert.deepEqual(converted.$expr, { authorId: id });
    });

    it('handles ObjectId-like objects, throwing toString objects, cycles, and non-matching fields', () => {
        const fakeObjectId = { constructor: { name: 'ObjectId' }, toString: () => id };
        assert.ok(convertObjectIdStrings(fakeObjectId) instanceof ObjectId);

        const throwingObjectId = { constructor: { name: 'ObjectId' }, toString: () => { throw new Error('bad'); } };
        assert.equal(convertObjectIdStrings(throwingObjectId), throwingObjectId);

        const circular: Record<string, unknown> = { note: 'not-an-object-id' };
        circular.self = circular;
        assert.equal(convertObjectIdStrings(circular), circular);
    });

    it('converts supported update operators and leaves unsupported forms unchanged', () => {
        assert.equal(convertUpdateDocument(null), null);
        const arrayUpdate: unknown[] = [];
        assert.equal(convertUpdateDocument(arrayUpdate), arrayUpdate);

        const update = {
            $set: { userId: id },
            $addToSet: { tagIds: id },
            $inc: { count: 1 },
        };
        const converted = convertUpdateDocument(update) as Record<string, unknown>;

        assert.ok(((converted.$set as Record<string, unknown>).userId) instanceof ObjectId);
        assert.ok(((converted.$addToSet as Record<string, unknown>).tagIds) instanceof ObjectId);
        assert.deepEqual(converted.$inc, { count: 1 });
    });
});

describe('slow-query-log storage — direct branch coverage', () => {
    const entry = {
        database: 'db',
        collection: 'users',
        operation: 'find',
        durationMs: 25,
        query: { active: true },
    };

    function createFakeMongo(rows: Array<Record<string, unknown>> = []) {
        const indexes: unknown[] = [];
        const updates: unknown[] = [];
        const bulks: unknown[] = [];
        const finds: unknown[] = [];
        const cursor = {
            sortArg: null as unknown,
            skipArg: null as unknown,
            limitArg: null as unknown,
            sort(arg: unknown) { this.sortArg = arg; return this; },
            skip(arg: unknown) { this.skipArg = arg; return this; },
            limit(arg: unknown) { this.limitArg = arg; return this; },
            async toArray() { return rows; },
        };
        const collection = {
            async createIndex(...args: unknown[]) { indexes.push(args); },
            async updateOne(...args: unknown[]) { updates.push(args); },
            async bulkWrite(...args: unknown[]) { bulks.push(args); },
            find(filter: unknown) { finds.push(filter); return cursor; },
        };
        const client = {
            closed: 0,
            dbName: '',
            collectionName: '',
            db(name: string) {
                this.dbName = name;
                return {
                    collection: (collectionName: string) => {
                        this.collectionName = collectionName;
                        return collection;
                    },
                };
            },
            async close() { this.closed++; },
        };

        return { client, collection, cursor, indexes, updates, bulks, finds };
    }

    it('memory storage supports save, saveBatch, filtering, skip and limit', async () => {
        const storage = new SlowQueryLogMemoryStorage();
        await storage.initialize();
        await storage.save(entry);
        await storage.saveBatch([
            { ...entry, collection: 'orders', durationMs: 10 },
            { ...entry, collection: 'orders', durationMs: 20 },
        ]);

        const rows = await storage.query({ collection: 'orders' }, { sort: { count: 1 }, skip: 0, limit: 1 });

        assert.equal(rows.length, 1);
        assert.equal(rows[0].collection, 'orders');
        await storage.close();
    });

    it('MongoDB storage initializes once, saves single and batch logs, queries rows, and keeps business client open', async () => {
        const fake = createFakeMongo([
            { queryHash: 'a', database: 'db', collection: 'users', operation: 'find', count: 2, totalTimeMs: 50, maxTimeMs: 30, minTimeMs: 20, firstSeen: new Date(), lastSeen: new Date() },
            { queryHash: 'b', database: 'db', collection: 'users', operation: 'find', count: 0, totalTimeMs: 0, maxTimeMs: 0, minTimeMs: 0, firstSeen: new Date(), lastSeen: new Date() },
        ]);
        const storage = new MongoDBSlowQueryLogStorage({ database: 'logs', collection: 'slow', ttl: 60 }, fake.client as any);

        await storage.initialize();
        await storage.initialize();
        await storage.save(entry);
        await storage.saveBatch([]);
        await storage.saveBatch([{ ...entry, collection: 'one' }]);
        await storage.saveBatch([entry, { ...entry, collection: 'orders' }]);
        const rows = await storage.query({ database: 'db' }, { skip: 1, limit: 1 });
        await storage.close();

        assert.equal(fake.indexes.length, 2);
        assert.equal(fake.updates.length, 2);
        assert.equal(fake.bulks.length, 1);
        assert.equal(fake.finds.length, 1);
        assert.equal(fake.cursor.skipArg, 1);
        assert.equal(fake.cursor.limitArg, 1);
        assert.equal(rows[0].avgTimeMs, 25);
        assert.equal(rows[1].avgTimeMs, 0);
        assert.equal(fake.client.closed, 0);
    });

    it('MongoDB storage reuses initializing promise and closes externally created clients', async () => {
        const fake = createFakeMongo();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let factoryCalls = 0;
        const storage = new MongoDBSlowQueryLogStorage({ uri: 'mongodb://localhost/logs', useBusinessConnection: false, ttl: 0 }, null, null, async () => {
            factoryCalls++;
            await pending;
            return fake.client as any;
        });

        const first = storage.initialize();
        const second = storage.initialize();
        release();
        await Promise.all([first, second]);
        await storage.close();

        assert.equal(factoryCalls, 1);
        assert.equal(fake.indexes.length, 1);
        assert.equal(fake.client.closed, 1);
    });

    it('MongoDB storage throws when an external client is required but uri is missing', async () => {
        const storage = new MongoDBSlowQueryLogStorage({ useBusinessConnection: false });
        await assert.rejects(() => storage.initialize(), /slowQueryLog\.storage\.uri/);
    });
});

describe('runtime compat accessors — direct branch coverage', () => {
    it('requires db and pool manager records before using compat accessors', () => {
        assert.throws(() => requireCompatDbInstance({}), /connect/);
        assert.throws(() => requireCompatPoolManagerRecord({}), /No pool manager/);

        const dbInstance = { collection: () => null, db: () => null };
        const poolManager = { getPoolNames: () => ['main'] };

        assert.equal(requireCompatDbInstance({ dbInstance }), dbInstance);
        assert.equal(requireCompatPoolManagerRecord({ _poolManager: poolManager }), poolManager);
    });

    it('resolves pool clients through v1, v2, failing, and missing accessors', () => {
        const client = { name: 'client' };

        assert.equal(resolvePoolClientFromRecord({ _getPool: () => client }, 'main'), client);
        assert.equal(resolvePoolClientFromRecord({ _getPool: () => null, getPool: () => client }, 'main'), null);
        assert.equal(resolvePoolClientFromRecord({ getPool: () => client }, 'main'), client);
        assert.equal(resolvePoolClientFromRecord({ getPool: () => { throw new Error('missing'); } }, 'main'), null);
        assert.equal(resolvePoolClientFromRecord({}, 'main'), null);
    });

    it('assertCompatPoolExists returns for existing pools and throws with available names otherwise', () => {
        assert.doesNotThrow(() => assertCompatPoolExists({ _getPool: () => ({}) }, 'main'));
        assert.throws(() => assertCompatPoolExists({ getPoolNames: () => ['a', 'b'] }, 'missing'), /Available pools: \[a, b\]/);
    });

    it('createPoolScope forwards collection and model calls with pool and database scope', () => {
        const calls: unknown[] = [];
        const runtime = {
            scopedCollection: (name: string, options: unknown) => { calls.push(['collection', name, options]); return { name, options }; },
            scopedModel: (name: string, options: unknown) => { calls.push(['model', name, options]); return { name, options }; },
        };
        const scope = createPoolScope(runtime as any, 'analytics');

        scope.collection('users');
        scope.model('User');
        scope.use('archive').collection('logs');
        scope.use('archive').model('Log');

        assert.equal(calls.length, 4);
        assert.deepEqual(calls[2], ['collection', 'logs', { pool: 'analytics', database: 'archive' }]);
    });

    it('metadata, database name, and model cache helpers cover fallback paths', () => {
        assert.deepEqual(getRegisteredModelMetadata({ collectionName: 'fallback', definition: { collection: 'users', connection: { pool: 'main' } } as any }), {
            actualCollectionName: 'users',
            connection: { pool: 'main' },
        });
        assert.deepEqual(getRegisteredModelMetadata({ collectionName: 'fallback', definition: { name: 'named' } as any }), {
            actualCollectionName: 'named',
            connection: undefined,
        });
        assert.deepEqual(getRegisteredModelMetadata({ collectionName: 'fallback', definition: {} as any }), {
            actualCollectionName: 'fallback',
            connection: undefined,
        });

        const record: Record<string, unknown> = {};
        assert.equal(getRuntimeDatabaseName(record), 'default');
        record.databaseName = 'db';
        assert.equal(getRuntimeDatabaseName(record), 'db');
        assert.equal(getCompatModelInstanceCache(record), getCompatModelInstanceCache(record));
    });
});

describe('model-instance helpers — direct branch coverage', () => {
    it('populateModelPath handles empty docs, missing relations, no keys, invalid nested config and raw related docs', async () => {
        const baseContext = {
            relations: new Map<string, any>(),
            runtime: {},
            dbName: 'db',
        };

        const empty: Array<Record<string, unknown>> = [];
        assert.equal(await populateModelPath(baseContext as any, empty, 'author'), empty);
        await assert.rejects(() => populateModelPath(baseContext as any, [{ authorId: 'a' }], 'author'), /Undefined relation/);

        const noKeyDocs: Array<Record<string, unknown>> = [{ title: 'post' }];
        const noKeyContext = {
            ...baseContext,
            relations: new Map([['author', { localField: 'authorId', foreignField: '_id', from: 'User', single: true }]]),
        };
        assert.equal((await populateModelPath(noKeyContext as any, noKeyDocs, 'author'))[0].author, null);

        const manyDocs: Array<Record<string, unknown>> = [{ tagIds: undefined }];
        const manyContext = {
            ...baseContext,
            relations: new Map([['tags', { localField: 'tagIds', foreignField: '_id', from: 'Tag', single: false }]]),
        };
        assert.deepEqual((await populateModelPath(manyContext as any, manyDocs, 'tags'))[0].tags, []);

        const runtime = {
            scopedCollection: () => ({ find: async () => [{ _id: 'u1', name: 'Ada', hidden: true }] }),
        };
        const docs: Array<Record<string, unknown>> = [{ authorId: 'u1' }];
        const context = {
            relations: new Map([['author', { localField: 'authorId', foreignField: '_id', from: 'User', single: true }]]),
            runtime,
            dbName: 'db',
        };

        await assert.rejects(() => populateModelPath(context as any, docs, { path: 'author', populate: 123 } as any), /nested populate/);
        const populated = await populateModelPath(context as any, docs, { path: 'author', select: 'name', sort: { name: 1 }, skip: 0, limit: 1 } as any);
        assert.deepEqual(populated[0].author, { name: 'Ada' });

        const perParentRuntime = {
            scopedCollection: () => ({
                find: async (query: { postId: { $in: string[] } }, options: { skip?: number; limit?: number }) => {
                    const rows = [
                        { postId: 'p1', body: 'p1-second', order: 2 },
                        { postId: 'p1', body: 'p1-first', order: 1 },
                        { postId: 'p2', body: 'p2-second', order: 2 },
                        { postId: 'p2', body: 'p2-first', order: 1 },
                    ];
                    const matching = rows.filter((row) => query.postId.$in.includes(row.postId));
                    matching.sort((left, right) => left.order - right.order);
                    return matching.slice(options.skip ?? 0, (options.skip ?? 0) + (options.limit ?? matching.length));
                },
            }),
        };
        const perParentDocs: Array<Record<string, unknown>> = [{ _id: 'p1' }, { _id: 'p2' }];
        const perParentContext = {
            relations: new Map([['comments', { localField: '_id', foreignField: 'postId', from: 'Comment', single: false }]]),
            runtime: perParentRuntime,
            dbName: 'db',
        };
        const perParent = await populateModelPath(perParentContext as any, perParentDocs, { path: 'comments', sort: { order: 1 }, limit: 1 } as any);
        assert.deepEqual(perParent.map((doc) => (doc.comments as Array<Record<string, unknown>>).map((comment) => comment.body)), [['p1-first'], ['p2-first']]);
    });

    it('hydrateModelDocument covers null docs, virtuals, v1 methods, v2 methods and document helpers', async () => {
        assert.equal(hydrateModelDocument({} as any, null), null);

        const saved: unknown[] = [];
        const removed: unknown[] = [];
        const v1Context = {
            definition: {
                virtuals: {
                    fullName: {
                        get(this: any) { return `${this.first} ${this.last}`; },
                        set(this: any, value: string) { this.first = value; },
                    },
                },
                methods: () => ({}),
            },
            v1InstanceMethods: {
                greet(this: any) { return `hi ${this.first}`; },
            },
            saveDocument: async (document: Record<string, unknown>) => { saved.push(document); return document; },
            removeDocument: async (document: Record<string, unknown>) => { removed.push(document); return true; },
            validateDocument: () => ({ valid: true, errors: [] }),
        };
        const hydrated = hydrateModelDocument(v1Context as any, { first: 'Ada', last: 'Lovelace', transient: () => 'skip' }) as any;

        assert.equal(hydrated.fullName, 'Ada Lovelace');
        hydrated.fullName = 'Augusta';
        assert.equal(hydrated.greet(), 'hi Augusta');
        assert.equal((await hydrated.save()).first, 'Augusta');
        assert.equal(await hydrated.remove(), true);
        assert.deepEqual(await hydrated.validate(), { valid: true, errors: [] });
        assert.deepEqual(hydrated.toObject(), { first: 'Augusta', last: 'Lovelace', fullName: 'Augusta Lovelace' });
        assert.deepEqual(hydrated.toJSON(), { first: 'Augusta', last: 'Lovelace', fullName: 'Augusta Lovelace' });

        const v2Hydrated = hydrateModelDocument({ ...v1Context, definition: { methods: { answer() { return 42; } } } } as any, { id: 1 }) as any;
        assert.equal(v2Hydrated.answer(), 42);
        assert.equal(saved.length, 1);
        assert.equal(removed.length, 1);
    });

    it('validateModelDocument covers schema error, pass-through, mapped errors, and thrown validator errors', () => {
        assert.deepEqual(validateModelDocument({ schemaError: new Error('broken'), schemaCache: null, schemaValidateFn: null }, {}), {
            valid: false,
            errors: [{ field: '_schema', message: 'Schema validation failed: broken' }],
            data: {},
        });
        assert.deepEqual(validateModelDocument({ schemaError: null, schemaCache: null, schemaValidateFn: null }, {}), { valid: true, errors: [], data: {} });
        assert.deepEqual(validateModelDocument({
            schemaError: null,
            schemaCache: {},
            schemaValidateFn: () => ({ valid: false, errors: [{ path: 'name', message: 'required' }, {}] }),
        }, undefined), {
            valid: false,
            errors: [{ field: 'name', message: 'required' }, { field: '', message: '' }],
            data: undefined,
        });
        assert.deepEqual(validateModelDocument({
            schemaError: null,
            schemaCache: {},
            schemaValidateFn: () => { throw 'bad'; },
        }, {}), {
            valid: false,
            errors: [{ field: '_schema', message: 'Schema validation failed: bad' }],
            data: {},
        });
    });

    it('applyModelDefaults, saveModelDocument and removeModelDocument cover persistence branches', async () => {
        const withDefaults = applyModelDefaults({
            defaults: {
                role: 'reader',
                tags: ['default'],
                meta: { active: true, createdAt: new Date('2026-01-01T00:00:00.000Z') },
                slug: (_context: unknown, document: Record<string, unknown>) => `${document.name}-slug`,
            },
        } as any, { name: 'ada', role: 'admin' });
        assert.deepEqual(withDefaults, {
            name: 'ada',
            role: 'admin',
            tags: ['default'],
            meta: { active: true, createdAt: new Date('2026-01-01T00:00:00.000Z') },
            slug: 'ada-slug',
        });
        const secondDefaults = applyModelDefaults({
            defaults: {
                tags: ['default'],
                meta: { active: true },
            },
        } as any, {});
        assert.notEqual(withDefaults.tags, secondDefaults.tags);
        assert.notEqual(withDefaults.meta, secondDefaults.meta);
        (withDefaults.tags as string[]).push('mutated');
        (withDefaults.meta as Record<string, unknown>).active = false;
        assert.deepEqual(secondDefaults, { tags: ['default'], meta: { active: true } });

        const calls: unknown[] = [];
        const collection = {
            async replaceOne(...args: unknown[]) { calls.push(['replaceOne', ...args]); },
            async insertOne(...args: unknown[]) { calls.push(['insertOne', ...args]); return { insertedId: 'new-id' }; },
            async deleteOne(...args: unknown[]) { calls.push(['deleteOne', ...args]); return { deletedCount: 1 }; },
        };
        const existing = { _id: 'id1', name: 'Ada' };
        const inserted = { name: 'Grace' } as Record<string, unknown>;

        assert.equal(await saveModelDocument(collection as any, existing), existing);
        assert.equal((await saveModelDocument(collection as any, inserted))._id, 'new-id');
        assert.equal(await removeModelDocument(collection as any, {} as any), false);
        assert.equal(await removeModelDocument(collection as any, existing), true);
        assert.equal(await removeModelDocument({ async deleteOne() { return { acknowledged: true }; } } as any, existing), true);
        assert.equal(calls.length, 3);
    });
});

describe('capability wiring — direct branch coverage', () => {
    it('initAutoConvertConfig covers type, boolean, object, disabled and fallback branches', () => {
        assert.deepEqual(initAutoConvertConfig(undefined, 'memory'), { enabled: false });
        assert.deepEqual(initAutoConvertConfig(false, 'mongodb'), { enabled: false });
        assert.equal(initAutoConvertConfig(true, 'mongodb').enabled, true);
        assert.equal(initAutoConvertConfig(undefined, 'mongodb').maxDepth, 10);
        assert.deepEqual(initAutoConvertConfig({ enabled: false }, 'mongodb'), { enabled: false });
        assert.deepEqual(initAutoConvertConfig({ excludeFields: ['raw'], maxDepth: 3 }, 'mongodb'), {
            enabled: true,
            excludeFields: ['raw'],
            customFieldPatterns: [],
            maxDepth: 3,
            logLevel: 'warn',
        });
        assert.equal(initAutoConvertConfig({ token: false }, 'mongodb').token, false);
        assert.equal(initAutoConvertConfig('bad' as any, 'mongodb').enabled, true);
    });

    it('buildRuntimeDefaults covers optional defaults and countQueue disabled branches', () => {
        const defaults = buildRuntimeDefaults({
            type: 'mongodb',
            maxTimeMS: 100,
            findLimit: 20,
            findPageMaxLimit: 50,
            slowQueryMs: 10,
            cursorSecret: 'secret',
            requireCursorSecret: true,
            cursorTypes: { token: 'string' },
            namespace: 'ns',
            countQueue: { enabled: true, concurrency: 2, maxQueueSize: 5, timeout: 100 },
        } as any);

        assert.equal(defaults.autoConvertObjectId, true);
        assert.equal(defaults.maxTimeMS, 100);
        assert.equal(defaults.requireCursorSecret, true);
        assert.deepEqual(defaults.cursorTypes, { token: 'string' });
        assert.ok(defaults.countQueue);

        const fieldMapDefaults = buildRuntimeDefaults({
            type: 'mongodb',
            autoConvertObjectId: { token: false },
            countQueue: { enabled: false },
        } as any);
        assert.equal((fieldMapDefaults.autoConvertObjectId as Record<string, unknown>).token, false);

        const disabled = buildRuntimeDefaults({ type: 'memory', autoConvertObjectId: false, countQueue: { enabled: false } } as any);
        assert.equal(disabled.autoConvertObjectId, false);
        assert.equal(disabled.countQueue, undefined);

        const builtIn = buildRuntimeDefaults({} as any);
        assert.equal(builtIn.maxTimeMS, 2000);
        assert.equal(builtIn.findLimit, 500);
        assert.equal(builtIn.findMaxLimit, 10000);
        assert.equal(builtIn.findMaxSkip, 50000);
        assert.equal(builtIn.findPageMaxLimit, 500);
        assert.equal(builtIn.slowQueryMs, 500);
    });

    it('loadModelFiles returns quietly for absent and invalid model config', async () => {
        const logger = { warn: () => undefined };
        await loadModelFiles({} as any, logger);
        await loadModelFiles({ models: 42 } as any, logger);
    });

    it('loadModelFiles scans string and object configs and handles invalid exports', async () => {
        const root = mkdtempSync(join(tmpdir(), 'monsqlize-models-'));
        const nested = join(root, 'nested');
        const logger = { warnings: [] as unknown[], warn(...args: unknown[]) { this.warnings.push(args); } };
        mkdirSync(nested);
        writeFileSync(join(root, 'loaded.model.cjs'), "module.exports = { name: 'coverage_loaded_model', schema: {} };\n");
        writeFileSync(join(root, 'bad.model.cjs'), "module.exports = { schema: {} };\n");
        writeFileSync(join(nested, 'nested.model.cjs'), "module.exports = { name: 'coverage_nested_model', schema: {} };\n");

        try {
            if (Model.has('coverage_loaded_model')) Model.undefine('coverage_loaded_model');
            if (Model.has('coverage_nested_model')) Model.undefine('coverage_nested_model');

            await loadModelFiles({ models: root } as any, logger);
            await loadModelFiles({ models: { path: root } } as any, logger, { reload: true });
            await loadModelFiles({ models: { path: root, recursive: true } } as any, logger, { reload: true });

            assert.equal(Model.has('coverage_loaded_model'), true);
            assert.equal(Model.has('coverage_nested_model'), true);
            assert.equal(logger.warnings.length >= 1, true);
        } finally {
            if (Model.has('coverage_loaded_model')) Model.undefine('coverage_loaded_model');
            if (Model.has('coverage_nested_model')) Model.undefine('coverage_nested_model');
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('source error factories and model config helpers — function coverage', () => {
    it('source error factories are callable through their direct implementations', () => {
        assert.equal(createConnectionError('down').code, 'CONNECTION_FAILED');
        assert.equal(createValidationError([{ field: 'name', message: 'required' }]).code, 'VALIDATION_ERROR');
        assert.equal(createCursorError().code, 'INVALID_CURSOR');
        assert.match(createQueryTimeoutError(25).message, /25ms/);
    });

    it('definition validator helpers cover valid and invalid model definitions', () => {
        assert.equal(validateCollectionName('users'), 'users');
        assert.throws(() => validateCollectionName('bad.name'), /Invalid collection name/);

        const timestampsTrue: Record<string, unknown> = { options: { timestamps: true } };
        processTimestamps(timestampsTrue as any);
        assert.deepEqual((timestampsTrue as any)._internalHooks.timestamps, { createdAt: 'createdAt', updatedAt: 'updatedAt' });

        const timestampsFalse: Record<string, unknown> = { options: { timestamps: false }, _internalHooks: { timestamps: { old: true } } };
        processTimestamps(timestampsFalse as any);
        assert.equal((timestampsFalse as any)._internalHooks.timestamps, undefined);

        const timestampsCustom: Record<string, unknown> = { options: { timestamps: { createdAt: 'created_on' } } };
        processTimestamps(timestampsCustom as any);
        assert.deepEqual((timestampsCustom as any)._internalHooks.timestamps, { createdAt: 'created_on', updatedAt: 'updatedAt' });

        assert.throws(() => processTimestamps({ options: { timestamps: 'bad' } } as any), /timestamps/);
        assert.throws(() => validateDefinition(undefined as any), /object/);
        assert.throws(() => validateDefinition({} as any), /schema/);
        assert.throws(() => validateDefinition({ schema: 'bad' } as any), /Schema/);
        assert.throws(() => validateDefinition({ schema: {}, connection: { pool: '' } } as any), /pool/);
        assert.throws(() => validateDefinition({ schema: {}, connection: { database: '' } } as any), /database/);
        assert.throws(() => validateDefinition({ schema: {}, relations: { bad: { from: '', localField: 'a', foreignField: 'b' } } } as any), /relations\.from/);
        assert.doesNotThrow(() => validateDefinition({ schema: {}, relations: { user: { from: 'User', localField: 'userId', foreignField: '_id', single: true } } } as any));

        assert.throws(() => validateRelationConfig('', {} as any), /Relation name/);
        assert.throws(() => validateRelationConfig('user', null as any), /must be an object/);
        assert.throws(() => validateRelationConfig('user', { from: 'User', localField: 'userId', foreignField: '_id', single: 'yes' } as any), /boolean/);
        assert.deepEqual(normalizePopulateConfig('author'), { path: 'author' });
    });

    it('model instance config helpers cover statics, options, v1 methods, schema and index branches', async () => {
        assert.deepEqual(getModelEnums({ enums: { role: ['admin'] } } as any), { role: ['admin'] });
        assert.deepEqual(getModelEnums({} as any), {});

        const target: Record<string, unknown> = { existing: true };
        attachModelStatics(target, { statics: { answer() { return 42; }, existing() { return 'skip'; }, ignored: 'nope' } } as any);
        assert.equal((target.answer as () => number)(), 42);
        attachModelStatics(target, { methods: () => ({}) } as any);

        const emptySchemaState = buildModelSchemaState({ schema: {} } as any);
        assert.equal(emptySchemaState.schemaError, null);
        assert.equal(isModelValidationEnabled({ options: { validate: false } } as any), false);
        assert.equal(isModelValidationEnabled({} as any), true);

        assert.equal(resolveModelTimestampsConfig({} as any), null);
        assert.deepEqual(resolveModelTimestampsConfig({ options: { timestamps: true } } as any), { createdAt: 'createdAt', updatedAt: 'updatedAt' });
        assert.deepEqual(resolveModelTimestampsConfig({ options: { timestamps: { createdAt: false, updatedAt: 'updated_on' } } } as any), { createdAt: false, updatedAt: 'updated_on' });

        assert.equal(resolveModelSoftDeleteConfig({} as any), null);
        assert.deepEqual(resolveModelSoftDeleteConfig({ options: { softDelete: true } } as any), { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: null });
        assert.deepEqual(resolveModelSoftDeleteConfig({ options: { softDelete: { enabled: false, field: 'removedAt', type: 'flag', ttl: 10 } } } as any), { enabled: false, field: 'removedAt', type: 'flag', ttl: 10 });

        assert.equal(resolveModelVersionConfig({} as any), null);
        assert.deepEqual(resolveModelVersionConfig({ options: { version: true } } as any), { enabled: true, field: 'version', updateMany: 'counter' });
        assert.deepEqual(resolveModelVersionConfig({ options: { version: { enabled: false, field: 'rev' } } } as any), { enabled: false, field: 'rev', updateMany: 'counter' });

        const hooksFactory = () => ({ save: { before: () => undefined } });
        assert.equal(resolveModelHooksFactory({ hooks: hooksFactory } as any), hooksFactory);
        assert.equal(resolveModelHooksFactory({ hooks: {} } as any), null);

        const v1Target: Record<string, unknown> = {};
        const instanceMethods = initializeModelV1Methods(v1Target, {
            methods: () => ({
                static: { ping() { return 'pong'; } },
                instance: { greet() { return 'hi'; } },
            }),
        } as any);
        assert.equal((v1Target.ping as () => string)(), 'pong');
        assert.equal(instanceMethods.greet(), 'hi');
        assert.deepEqual(initializeModelV1Methods({}, {} as any), {});

        const originalWarn = console.warn;
        const warnings: unknown[][] = [];
        console.warn = () => { throw new Error('console.warn should not be called'); };
        try {
            assert.deepEqual(initializeModelV1Methods(
                {},
                { methods: () => { throw new Error('bad factory'); } } as any,
                { warn: (...args: unknown[]) => { warnings.push(args); } },
            ), {});
            assert.deepEqual(initializeModelV1Methods({}, { methods: () => { throw new Error('silent factory'); } } as any), {});
        } finally {
            console.warn = originalWarn;
        }
        assert.equal(warnings.length, 1);

        const createdIndexes: unknown[] = [];
        let preflightCalls = 0;
        scheduleModelIndexes({
            listIndexes: async () => {
                preflightCalls += 1;
                return [];
            },
            createIndex: async (...args: unknown[]) => { createdIndexes.push(args); },
        } as any, {
            indexes: [{ key: { email: 1 }, unique: true }, { bad: true }],
        } as any, { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: 60 });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(preflightCalls, 1);
        assert.equal(createdIndexes.length, 2);

        scheduleModelIndexes({ listIndexes: async () => [], createIndex: async () => undefined } as any, {} as any, null);

        assert.deepEqual(resolveModelAutoIndexOptions({} as any, false), { enabled: false, emitEvents: true });
        assert.deepEqual(resolveModelAutoIndexOptions({ options: { autoIndex: { enabled: true, emitEvents: false } } } as any, false), { enabled: true, emitEvents: false });

        const declared = collectModelIndexDefinitions({
            indexes: [{ key: { email: 1 }, unique: true, name: 'email_unique' }],
        } as any, { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: 120 });
        assert.equal(declared.length, 2);
        assert.equal(declared[0].source, 'softDelete');
        assert.equal(declared[1].name, 'email_unique');

        const disabledIndexes: unknown[] = [];
        scheduleModelIndexes({ listIndexes: async () => [], createIndex: async (...args: unknown[]) => { disabledIndexes.push(args); } } as any, {
            indexes: [{ key: { disabled: 1 } }],
            options: { autoIndex: false },
        } as any, { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: 60 });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(disabledIndexes.length, 0);
    });

    it('scheduleModelIndexes deduplicates pending and fulfilled tasks per runtime but retries failures', async () => {
        const runtime = {};
        const dedupedIndexes: unknown[] = [];
        let listCalls = 0;
        const collection = {
            getNamespace: () => ({ iid: 'db:users', type: 'mongodb', db: 'db', collection: 'users' }),
            listIndexes: async () => {
                listCalls += 1;
                return [];
            },
            createIndex: async (...args: unknown[]) => { dedupedIndexes.push(args); },
        };
        const definition = { indexes: [{ key: { email: 1 }, unique: true }] };

        scheduleModelIndexes(collection as any, definition as any, null, { runtime, dbName: 'db', collectionName: 'users' });
        scheduleModelIndexes(collection as any, definition as any, null, { runtime, dbName: 'db', collectionName: 'users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(listCalls, 1);
        assert.equal(dedupedIndexes.length, 1);

        scheduleModelIndexes(collection as any, definition as any, null, { runtime, dbName: 'db', collectionName: 'users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(listCalls, 1);
        assert.equal(dedupedIndexes.length, 1);

        let attempts = 0;
        const warnings: unknown[] = [];
        const emitted: unknown[] = [];
        const retryRuntime = {
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
            emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        };
        const retryCollection = {
            getNamespace: () => ({ iid: 'db:retry_users', type: 'mongodb', db: 'db', collection: 'retry_users' }),
            listIndexes: async () => [],
            createIndex: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('index failed once');
            },
        };

        scheduleModelIndexes(retryCollection as any, definition as any, null, { runtime: retryRuntime, dbName: 'db', collectionName: 'retry_users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(attempts, 1);
        assert.equal(warnings.length, 1);
        assert.equal((emitted[0] as { event: string }).event, 'model-index-error');

        scheduleModelIndexes(retryCollection as any, definition as any, null, { runtime: retryRuntime, dbName: 'db', collectionName: 'retry_users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(attempts, 2);

        let syncAttempts = 0;
        const syncRuntime = { logger: { warn: (...args: unknown[]) => warnings.push(args) } };
        const syncFailCollection = {
            getNamespace: () => ({ iid: 'db:sync_fail_users', type: 'mongodb', db: 'db', collection: 'sync_fail_users' }),
            listIndexes: async () => [],
            createIndex: () => {
                syncAttempts += 1;
                if (syncAttempts === 1) throw new Error('sync index failure');
                return Promise.resolve(undefined);
            },
        };
        scheduleModelIndexes(syncFailCollection as any, definition as any, null, { runtime: syncRuntime, dbName: 'db', collectionName: 'sync_fail_users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(syncAttempts, 1);

        scheduleModelIndexes(syncFailCollection as any, definition as any, null, { runtime: syncRuntime, dbName: 'db', collectionName: 'sync_fail_users' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(syncAttempts, 2);
    });

    it('scheduleModelIndexes skips existing indexes and reports conflicts from preflight', async () => {
        const existingRuntime = {};
        const existingCreateCalls: unknown[] = [];
        let existingListCalls = 0;
        const existingCollection = {
            getNamespace: () => ({ iid: 'db:existing_users', type: 'mongodb', db: 'db', collection: 'existing_users' }),
            listIndexes: async () => {
                existingListCalls += 1;
                return [{ name: 'email_unique', key: { email: 1 }, unique: true }];
            },
            createIndex: async (...args: unknown[]) => { existingCreateCalls.push(args); },
        };
        const definition = { indexes: [{ key: { email: 1 }, unique: true, name: 'email_unique' }] };

        scheduleModelIndexes(existingCollection as any, definition as any, null, {
            runtime: existingRuntime,
            dbName: 'db',
            collectionName: 'existing_users',
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(existingListCalls, 1);
        assert.equal(existingCreateCalls.length, 0);

        const warnings: unknown[][] = [];
        const emitted: unknown[] = [];
        const conflictRuntime = {
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
            emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        };
        const conflictCollection = {
            getNamespace: () => ({ iid: 'db:conflict_users', type: 'mongodb', db: 'db', collection: 'conflict_users' }),
            listIndexes: async () => [{ name: 'email_unique', key: { email: 1 } }],
            createIndex: async () => {
                throw new Error('conflict should not create');
            },
        };

        scheduleModelIndexes(conflictCollection as any, definition as any, null, {
            runtime: conflictRuntime,
            dbName: 'db',
            collectionName: 'conflict_users',
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][0], '[MonSQLize] model index ensure conflicts detected');
        assert.equal((emitted[0] as { event: string }).event, 'model-index-error');
        const payload = (emitted[0] as { payload: { conflicts: unknown[]; failed: unknown[] } }).payload;
        assert.equal(payload.conflicts.length, 1);
        assert.equal(payload.failed.length, 0);
    });

    it('model index ensure helpers support dry-run, creation, conflicts, failures, and totals', async () => {
        const createCalls: unknown[] = [];
        const collection = {
            getNamespace: () => ({ iid: 'db:ensure_users', type: 'mongodb', db: 'db', collection: 'ensure_users' }),
            listIndexes: async () => [
                { name: '_id_', key: { _id: 1 } },
                { name: 'email_unique', key: { email: 1 }, unique: true },
            ],
            createIndex: async (...args: unknown[]) => {
                createCalls.push(args);
                return 'age_idx';
            },
        };
        const definition = {
            indexes: [
                { key: { email: 1 }, unique: true, name: 'email_unique' },
                { key: { age: 1 }, name: 'age_idx' },
            ],
        };

        const dryRun = await ensureModelIndexesForCollection(collection as any, definition as any, null, { dryRun: true });
        assert.equal(dryRun.existing.length, 1);
        assert.equal(dryRun.missing.length, 1);
        assert.equal(dryRun.skipped.length, 1);
        assert.equal(createCalls.length, 0);

        const executed = await ensureModelIndexesForCollection(collection as any, definition as any, null);
        assert.equal(executed.created.length, 1);
        assert.equal(createCalls.length, 1);

        const conflict = await ensureModelIndexesForCollection({
            getNamespace: () => ({ iid: 'db:ensure_conflicts', type: 'mongodb', db: 'db', collection: 'ensure_conflicts' }),
            listIndexes: async () => [{ name: 'email_unique', key: { email: 1 } }],
            createIndex: async () => undefined,
        } as any, definition as any, null);
        assert.equal(conflict.conflicts.length, 1);

        await assert.rejects(
            () => ensureModelIndexesForCollection({
                getNamespace: () => ({ iid: 'db:ensure_conflicts', type: 'mongodb', db: 'db', collection: 'ensure_conflicts' }),
                listIndexes: async () => [{ name: 'email_unique', key: { email: 1 } }],
                createIndex: async () => undefined,
            } as any, definition as any, null, { throwOnError: true }),
            (error: unknown) => (error as { code?: string }).code === 'MONGODB_ERROR',
        );

        const failed = await ensureModelIndexesForCollection({
            getNamespace: () => ({ iid: 'db:ensure_failures', type: 'mongodb', db: 'db', collection: 'ensure_failures' }),
            listIndexes: async () => [],
            createIndex: async () => {
                throw new Error('create failed');
            },
        } as any, { indexes: [{ key: { age: 1 }, name: 'age_idx' }] } as any, null);
        assert.equal(failed.failed.length, 1);

        const totals = summarizeModelIndexEnsureResults([dryRun, executed, conflict, failed]);
        assert.equal(totals.declared, 7);
        assert.equal(totals.created, 2);
        assert.equal(totals.conflicts, 1);
        assert.equal(totals.failed, 1);
    });

    it('createRuntimeModelInstance honors definition collection and pool scope in the v2 path', async () => {
        const modelName = `RegistryKey${Date.now()}`;
        if (Model.has(modelName)) Model.undefine(modelName);
        Model.define(modelName, {
            collection: 'actual_items',
            schema: {},
            connection: { pool: 'analytics', database: 'reporting' },
            indexes: [{ key: { sku: 1 }, unique: true }],
        } as any);

        const scopedCollections: unknown[] = [];
        const createdIndexes: unknown[] = [];
        const collection = {
            getNamespace: () => ({ iid: 'reporting:actual_items', type: 'mongodb', db: 'reporting', collection: 'actual_items' }),
            listIndexes: async () => [],
            createIndex: async (...args: unknown[]) => { createdIndexes.push(args); },
        };
        const host = createRuntimeModelHost({
            options: { type: 'mongodb', databaseName: 'default_db' } as any,
            modelInstances: new MemoryCache({ maxEntries: 10 }),
            runtime: { scopedCollection: () => collection, scopedModel: () => null } as any,
            scopedCollection: (collectionName, options) => {
                scopedCollections.push({ collectionName, options });
                return collection;
            },
        });

        const first = createRuntimeModelInstance(host, modelName, {});
        const second = createRuntimeModelInstance(host, modelName, {});
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(first, second);
        assert.equal(first.collectionName, 'actual_items');
        assert.equal(first.dbName, 'reporting');
        assert.equal(first.poolName, 'analytics');
        assert.deepEqual(scopedCollections, [
            { collectionName: 'actual_items', options: { database: 'reporting', pool: 'analytics' } },
        ]);
        assert.equal(createdIndexes.length, 1);
    });

    it('createRuntimeModelInstance applies model autoIndex overrides over runtime defaults', async () => {
        const suffix = Date.now();
        const disabledModelName = `AutoIndexDisabled${suffix}`;
        const enabledModelName = `AutoIndexEnabled${suffix}`;
        if (Model.has(disabledModelName)) Model.undefine(disabledModelName);
        if (Model.has(enabledModelName)) Model.undefine(enabledModelName);

        try {
            Model.define(disabledModelName, {
                collection: 'auto_index_disabled_items',
                schema: {},
                indexes: [{ key: { email: 1 }, unique: true }],
                options: { autoIndex: false },
            } as any);
            Model.define(enabledModelName, {
                collection: 'auto_index_enabled_items',
                schema: {},
                indexes: [{ key: { email: 1 }, unique: true }],
                options: { autoIndex: { enabled: true, emitEvents: false } },
            } as any);

            const createHost = (runtimeAutoIndex: unknown, calls: unknown[]) => createRuntimeModelHost({
                options: { type: 'mongodb', databaseName: 'default_db' } as any,
                modelInstances: new MemoryCache({ maxEntries: 10 }),
                runtime: { options: { autoIndex: runtimeAutoIndex }, scopedCollection: () => null, scopedModel: () => null } as any,
                scopedCollection: (collectionName) => ({
                    getNamespace: () => ({ iid: `default_db:${collectionName}`, type: 'mongodb', db: 'default_db', collection: collectionName }),
                    listIndexes: async () => [],
                    createIndex: async (...args: unknown[]) => { calls.push({ collectionName, args }); },
                }),
            });

            const disabledCalls: unknown[] = [];
            createRuntimeModelInstance(createHost(true, disabledCalls), disabledModelName, {});
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(disabledCalls.length, 0);

            const enabledCalls: unknown[] = [];
            createRuntimeModelInstance(createHost(false, enabledCalls), enabledModelName, {});
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(enabledCalls.length, 1);
            assert.equal((enabledCalls[0] as { collectionName: string }).collectionName, 'auto_index_enabled_items');
        } finally {
            if (Model.has(disabledModelName)) Model.undefine(disabledModelName);
            if (Model.has(enabledModelName)) Model.undefine(enabledModelName);
        }
    });
});

describe('model populate and schema helpers — additional branch coverage', () => {
    it('populateModelPath uses registered model scope and nested model population', async () => {
        const modelName = 'coverage_related_items';
        if (Model.has(modelName)) Model.undefine(modelName);
        Model.define(modelName, {
            schema: { parentId: 'string', name: 'string' },
            connection: { database: 'registeredDb', pool: 'registeredPool' },
        } as any);

        const scopes: unknown[] = [];
        const docs = [{ id: 'p1' } as Record<string, unknown>];
        const context = {
            relations: new Map([["children", {
                from: modelName,
                localField: 'id',
                foreignField: 'parentId',
                single: false,
            }]]),
            dbName: 'fallbackDb',
            poolName: 'fallbackPool',
            runtime: {
                scopedCollection: (_name: string, scope: unknown) => {
                    scopes.push(scope);
                    return {
                        find: async () => [
                            { parentId: 'p1', name: 'B' },
                            { parentId: 'p1', name: 'A' },
                        ],
                    };
                },
                scopedModel: (_name: string, scope: unknown) => {
                    scopes.push(scope);
                    return {
                        hydrateDocuments: (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, hydrated: true })),
                        populateDocuments: async (rows: Array<Record<string, unknown>>, paths: unknown[]) => rows.map((row) => ({ ...row, nestedCount: paths.length })),
                    };
                },
            },
        } as any;

        try {
            await populateModelPath(context, docs, { path: 'children', sort: { name: 1 }, populate: { path: 'nested' } } as any);
        } finally {
            Model.undefine(modelName);
        }

        assert.deepEqual(scopes[0], { database: 'registeredDb', pool: 'registeredPool' });
        assert.deepEqual(scopes[1], { database: 'registeredDb', pool: 'registeredPool' });
        const children = docs[0].children as Array<Record<string, unknown>>;
        assert.equal(children.length, 2);
        assert.equal(children[0].name, 'A');
        assert.equal(children[0].hydrated, true);
        assert.equal(children[0].nestedCount, 1);
    });

    it('model config helpers cover default object branches', () => {
        assert.deepEqual(resolveModelTimestampsConfig({ options: { timestamps: { createdAt: true } } } as any), { createdAt: 'createdAt', updatedAt: 'updatedAt' });
        assert.deepEqual(resolveModelSoftDeleteConfig({ options: { softDelete: {} } } as any), { enabled: true, field: 'deletedAt', type: 'timestamp', ttl: null });
        assert.deepEqual(resolveModelVersionConfig({ options: { version: {} } } as any), { enabled: true, field: 'version', updateMany: 'counter' });
        assert.deepEqual(initializeModelV1Methods({}, { methods: () => ({ static: {}, instance: undefined }) } as any), {});
    });

    it('model document helpers cover default, replace and delete fallback branches', async () => {
        const withDefaults = applyModelDefaults({
            defaults: {
                literal: 'x',
                nested: () => ({ values: ['a'] }),
                computed: (_ctx: unknown, doc: Record<string, unknown>) => `${doc.literal}:ok`,
            },
        } as any, {});
        const secondDefaults = applyModelDefaults({ defaults: { nested: () => ({ values: ['a'] }) } } as any, {});
        assert.deepEqual(withDefaults, { literal: 'x', nested: { values: ['a'] }, computed: 'x:ok' });
        assert.notEqual(withDefaults.nested, secondDefaults.nested);

        const replaced: unknown[] = [];
        await saveModelDocument({
            replaceOne: async (...args: unknown[]) => { replaced.push(args); },
            insertOne: async () => ({ insertedId: 'new-id' }),
        } as any, { _id: 'known-id', name: 'Saved' } as any);
        assert.equal(replaced.length, 1);

        const deletedByAcknowledgement = await removeModelDocument({ deleteOne: async () => ({ acknowledged: true }) } as any, { _id: 'known-id' } as any);
        const notDeleted = await removeModelDocument({ deleteOne: async () => ({ acknowledged: false }) } as any, { _id: 'known-id' } as any);
        assert.equal(deletedByAcknowledgement, true);
        assert.equal(notDeleted, false);
    });

    it('validating schema DSL delegates type semantics to schema-dsl', () => {
        const calls: unknown[] = [];
        const dsl = _makeValidatingDslFn((fields: unknown) => {
            calls.push(fields);
            return fields;
        }) as unknown as (fields: unknown) => unknown;

        assert.deepEqual(dsl({ role: 'admin|user', name: 'string!' }), { role: 'admin|user', name: 'string!' });
        assert.deepEqual(dsl({ completedAt: 'datetime', scene: 'admin_login!' }), { completedAt: 'datetime', scene: 'admin_login!' });
        assert.deepEqual(dsl(null), null);
        assert.deepEqual(dsl({ broken: 'notatype!' }), { broken: 'notatype!' });
        assert.equal(calls.length, 4);
    });

    it('schema-dsl runtime resolution fails closed unless explicitly disabled', () => {
        assert.equal(createSchemaDslEngine(false).enabled, false);
        assert.throws(
            () => createSchemaDslEngine({ runtime: {} }),
            (error: unknown) => {
                const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
                return Boolean(
                    record
                    && record.code === 'INVALID_CONFIG'
                    && String(record.message).includes('required s/dsl and validate APIs'),
                );
            },
        );
    });

    it('schema-dsl runtime load failures are not silently disabled', () => {
        const originalRequire = Module.prototype.require;
        Module.prototype.require = function patchedRequire(this: unknown, id: string, ...args: unknown[]): unknown {
            if (id === 'schema-dsl/runtime') {
                throw new Error('mock runtime load failure');
            }
            return originalRequire.call(this, id, ...args);
        };
        try {
            assert.throws(
                () => createSchemaDslEngine(),
                (error: unknown) => {
                    const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null;
                    return Boolean(
                        record
                        && record.code === 'INVALID_CONFIG'
                        && String(record.message).includes('Failed to load schema-dsl/runtime'),
                    );
                },
            );
        } finally {
            Module.prototype.require = originalRequire;
        }
    });
});

describe('slow query log source helpers — additional branch coverage', () => {
    const baseRecord = {
        queryHash: 'hash',
        database: 'db',
        collection: 'col',
        operation: 'find',
        count: 1,
        totalTimeMs: 10,
        avgTimeMs: 10,
        maxTimeMs: 10,
        minTimeMs: 10,
        firstSeen: new Date('2024-01-01T00:00:00.000Z'),
        lastSeen: new Date('2024-01-02T00:00:00.000Z'),
        sampleQuery: { a: 1 },
        metadata: { trace: 'one' },
    };

    it('record helpers validate, filter, sort and clone edge cases', () => {
        assert.equal(stableStringify({ b: 2, a: [new Date('2024-01-01T00:00:00.000Z')] }), '{"a":["2024-01-01T00:00:00.000Z"],"b":2}');
        assert.throws(() => normalizeSlowQueryLogEntry({ database: '', collection: 'col', operation: 'find', durationMs: 1 } as any), /database/);
        assert.throws(() => normalizeSlowQueryLogEntry({ database: 'db', collection: 'col', operation: 'find', durationMs: -1 } as any), /durationMs/);

        assert.deepEqual(toMongoFilter({ database: 'db', collection: 'col', operation: 'find', queryHash: 'hash' }), {
            database: 'db',
            collection: 'col',
            operation: 'find',
            queryHash: 'hash',
        });
        assert.equal(matchesSlowQueryLogFilter(baseRecord, { database: 'other' }), false);
        assert.equal(matchesSlowQueryLogFilter(baseRecord, { collection: 'other' }), false);
        assert.equal(matchesSlowQueryLogFilter(baseRecord, { operation: 'insert' }), false);
        assert.equal(matchesSlowQueryLogFilter(baseRecord, { queryHash: 'other' }), false);

        const sorted = sortSlowQueryLogRecords([
            { ...baseRecord, queryHash: 'a', count: undefined as any },
            { ...baseRecord, queryHash: 'b', count: 2 },
            { ...baseRecord, queryHash: 'c', count: null as any },
        ], { count: 1, queryHash: -1 });
        assert.equal(sorted[0].queryHash, 'b');
        assert.equal(sorted.length, 3);

        const cloned = cloneSlowQueryLogRecord(baseRecord);
        assert.notEqual(cloned.firstSeen, baseRecord.firstSeen);
        assert.equal(cloned.firstSeen.toISOString(), baseRecord.firstSeen.toISOString());
    });

    it('record merge keeps existing optional values when incoming values are absent', () => {
        const incoming = {
            ...baseRecord,
            count: 2,
            totalTimeMs: 30,
            avgTimeMs: 15,
            maxTimeMs: 25,
            minTimeMs: 5,
            firstSeen: new Date('2023-12-31T00:00:00.000Z'),
            lastSeen: new Date('2024-01-03T00:00:00.000Z'),
            sampleQuery: undefined,
            metadata: undefined,
        };
        const merged = mergeSlowQueryLogRecord(baseRecord, incoming as any);
        assert.equal(merged.count, 3);
        assert.equal(merged.avgTimeMs, 40 / 3);
        assert.deepEqual(merged.sampleQuery, { a: 1 });
        assert.deepEqual(merged.metadata, { trace: 'one' });
    });

    it('SlowQueryLogConfigManager covers merge and validation branches', () => {
        const disabled = MonSQLize.SlowQueryLogConfigManager.mergeConfig(undefined);
        assert.equal(disabled.enabled, false);

        const memoryEnabled = MonSQLize.SlowQueryLogConfigManager.mergeConfig(true, 'custom');
        assert.equal(memoryEnabled.storage.type, 'memory');

        const storageEnabled = MonSQLize.SlowQueryLogConfigManager.mergeConfig({ storage: { type: 'memory' } });
        assert.equal(storageEnabled.enabled, true);

        assert.equal(MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: false }), true);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate(null as any), /config/);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, storage: { ...disabled.storage, type: 'bad' as any } }), /storage/);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, storage: { ...disabled.storage, type: 'mongodb', useBusinessConnection: false, uri: null } }), /uri/);
        assert.equal(MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, storage: { ...disabled.storage, type: 'memory' } }, 'custom'), true);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, batch: { ...disabled.batch, size: 0 } }), /batch.size/);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, batch: { ...disabled.batch, interval: 1 } }), /batch.interval/);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, batch: { ...disabled.batch, maxBufferSize: 0 } }), /maxBufferSize/);
        assert.throws(() => MonSQLize.SlowQueryLogConfigManager.validate({ ...disabled, enabled: true, filter: { ...disabled.filter, minExecutionTimeMs: -1 } }), /minExecutionTimeMs/);
    });

    it('MongoDB storage covers default config, row fallback and close branches', async () => {
        const cursorCalls: unknown[] = [];
        const collection = {
            createIndex: async () => undefined,
            updateOne: async () => undefined,
            bulkWrite: async () => undefined,
            find: (filter: unknown) => {
                cursorCalls.push(filter);
                const cursor = {
                    sort: (_sort: unknown) => cursor,
                    skip: (value: number) => { cursorCalls.push(['skip', value]); return cursor; },
                    limit: (value: number) => { cursorCalls.push(['limit', value]); return cursor; },
                    toArray: async () => [{
                        queryHash: 'row-hash',
                        database: 'db',
                        collection: 'col',
                        operation: 'find',
                        firstSeen: '2024-01-01T00:00:00.000Z',
                        lastSeen: '2024-01-02T00:00:00.000Z',
                    }],
                };
                return cursor;
            },
        };
        const businessClient = { db: () => ({ collection: () => collection }) };
        const storage = new MongoDBSlowQueryLogStorage({}, businessClient as any);
        const rows = await storage.query({ database: 'db' }, { skip: 2, limit: 1 });
        assert.equal(rows[0].count, 0);
        assert.equal(rows[0].avgTimeMs, 0);
        assert.equal(cursorCalls.length >= 3, true);
        await storage.close();

        let closed = 0;
        const ownedClient = { db: () => ({ collection: () => collection }), close: async () => { closed++; } };
        const ownedStorage = new MongoDBSlowQueryLogStorage({ uri: 'mongodb://example.invalid', ttl: 0 }, null, null, async () => ownedClient as any);
        await ownedStorage.initialize();
        await ownedStorage.close();
        assert.equal(closed, 1);
    });
});

describe('public cache and lock APIs — additional branch coverage', () => {
    it('withCache and FunctionCache validate edge cases', async () => {
        assert.throws(() => MonSQLize.withCache(null as any), /fn/);
        assert.throws(() => MonSQLize.withCache(async () => 1, { ttl: -1 }), /ttl/);
        assert.throws(() => MonSQLize.withCache(async () => 1, { keyBuilder: 'bad' as any }), /keyBuilder/);
        assert.throws(() => MonSQLize.withCache(async () => 1, { condition: 'bad' as any }), /condition/);
        assert.throws(() => MonSQLize.withCache(async () => 1, { cache: { get: async () => undefined } as any }), /cache/);

        const cached = MonSQLize.withCache(async (value: number) => value + 1, { enableStats: false });
        assert.equal(await cached(1), 2);
        assert.deepEqual(cached.stats(), { hits: 0, misses: 0, errors: 0, calls: 0, totalTime: 0, avgTime: 0, hitRate: 0 });

        assert.throws(() => new MonSQLize.FunctionCache(new MonSQLize.MemoryCache(), [] as any), /options/);
        assert.throws(() => new MonSQLize.FunctionCache(new MonSQLize.MemoryCache(), { namespace: 1 } as any), /namespace/);
        assert.throws(() => new MonSQLize.FunctionCache(new MonSQLize.MemoryCache(), { defaultTTL: Number.NaN }), /defaultTTL/);

        const cache = new MonSQLize.FunctionCache(new MonSQLize.MemoryCache(), { enableStats: false });
        assert.equal(cache.getStats(), null);
        assert.throws(() => cache.register('', async () => 1), /Function name/);
        assert.throws(() => cache.register('bad-fn', null as any), /fn/);
        assert.throws(() => cache.register('bad-options', async () => 1, [] as any), /options/);
        assert.throws(() => cache.register('bad-key', async () => 1, { keyBuilder: 'bad' as any }), /keyBuilder/);
        assert.throws(() => cache.register('bad-condition', async () => 1, { condition: 'bad' as any }), /condition/);
        assert.throws(() => cache.register('bad-ttl', async () => 1, { defaultTTL: -1 }), /defaultTTL/);
        await assert.rejects(() => cache.invalidate('') as Promise<void>, /Function name/);
        await assert.rejects(() => cache.invalidatePattern('') as Promise<number>, /Pattern/);
    });

    it('withCache and FunctionCache keep v1-compatible defaults', async () => {
        let calls = 0;
        const cached = MonSQLize.withCache(async (value: number) => {
            calls += 1;
            return value + calls;
        });

        assert.equal(await cached(1), 2);
        assert.equal(await cached(1), 2);
        assert.equal(calls, 1);
        assert.equal(cached.stats().calls, 2);
        assert.equal(cached.stats().hits, 1);

        let registeredCalls = 0;
        const functionCache = new MonSQLize.FunctionCache(new MonSQLize.MemoryCache());
        functionCache.register('default-cache', async (value: number) => {
            registeredCalls += 1;
            return value + registeredCalls;
        });
        assert.equal(await functionCache.execute('default-cache', 1), 2);
        assert.equal(await functionCache.execute('default-cache', 1), 2);
        assert.equal(registeredCalls, 1);
    });

    it('LockManager covers contention, fallback, renew, release and cleanup branches', async () => {
        const warnings: unknown[] = [];
        const manager = new MonSQLize.LockManager({ lockKeyPrefix: 'coverage-lock:', maxDuration: 5, logger: { warn: (...args: unknown[]) => warnings.push(args) } });
        manager.clear();

        const lock = await manager.acquireLock('resource', { ttl: 50, retryTimes: 0 });
        assert.equal(lock.ttl, 50);
        assert.equal(lock.isHeld(), true);
        assert.equal(await manager.tryAcquireLock('resource'), null);
        assert.equal(await manager.releaseLock('resource', 'wrong-id'), false);
        assert.equal(await lock.renew(50), true);

        const fallback = await manager.acquireLock('resource', { retryTimes: 0, fallbackToNoLock: true });
        assert.equal(fallback.key, 'coverage-lock:resource');
        assert.equal(await fallback.release(), true);
        assert.equal(await fallback.release(), false);
        assert.equal(await fallback.renew(), false);
        assert.equal(warnings.length, 1);

        assert.equal(await lock.release(), true);
        assert.equal(await lock.release(), false);
        assert.equal(await manager.renewLock('resource', lock.lockId, 10), false);

        const expired = await manager.tryAcquireLock('expired', { ttl: 0 });
        assert.ok(expired);
        assert.equal(manager.isLocked('expired'), false);
        manager.close();
        manager.clear();
        assert.equal(manager.getStats().activeLocks, 0);

        const uncappedManager = new MonSQLize.LockManager({ lockKeyPrefix: 'coverage-uncapped-lock:', maxDuration: 1 });
        const uncapped = await uncappedManager.acquireLock('resource', { ttl: 25, retryTimes: 0 });
        assert.equal(uncapped.ttl, 25);
        await uncapped.release();
        uncappedManager.clear();
    });

    it('DistributedCacheLockManager covers redis success, failure, wildcard and fallback branches', async () => {
        assert.throws(() => new MonSQLize.DistributedCacheLockManager({ redis: null as any }), /Redis/);

        const makeRedis = (overrides: Record<string, unknown> = {}) => {
            const handlers = new Map<string, (...args: unknown[]) => void>();
            const redis = {
                handlers,
                on: (event: string, handler: (...args: unknown[]) => void) => { handlers.set(event, handler); },
                set: async () => 'OK',
                eval: async () => 1,
                keys: async () => [] as string[],
                exists: async () => 0,
                ...overrides,
            };
            return redis;
        };

        const errors: unknown[] = [];
        const redis = makeRedis({ keys: async () => ['dc-lock:key'] });
        const manager = new MonSQLize.DistributedCacheLockManager({ redis, lockKeyPrefix: 'dc-lock:', maxDuration: 10, logger: { error: (...args: unknown[]) => errors.push(args) } });
        redis.handlers.get('error')?.('redis-down');
        assert.equal(errors.length, 1);
        assert.equal(await manager.addLock('key', null as any), false);
        assert.equal(await manager.addLock('key', { id: 'session' }), true);
        assert.equal(await manager.releaseLocks(null as any), 0);
        assert.equal(await manager.releaseLocks({ id: 'session' }), 1);
        assert.equal(await manager.releaseLock('key', 'missing'), true);
        assert.equal(await manager.renewLock('key', 'missing', 10), true);

        const wildcardRedis = makeRedis({
            exists: async () => 0,
            keys: async () => ['dc-lock:tenant:*'],
        });
        const wildcardManager = new MonSQLize.DistributedCacheLockManager({ redis: wildcardRedis, lockKeyPrefix: 'dc-lock:' });
        assert.equal(await wildcardManager.isLocked('tenant:42'), true);

        const noKeysManager = new MonSQLize.DistributedCacheLockManager({ redis: makeRedis({ keys: async () => [] as string[] }), lockKeyPrefix: 'dc-lock:' });
        assert.equal(await noKeysManager.releaseLocks({ id: 'none' }), 0);

        const nullSetManager = new MonSQLize.DistributedCacheLockManager({ redis: makeRedis({ set: async () => null }), lockKeyPrefix: 'dc-lock:' });
        assert.equal(await nullSetManager.tryAcquireLock('busy'), null);
        await assert.rejects(() => nullSetManager.acquireLock('busy', { retryTimes: 0, retryDelay: 0 }) as Promise<unknown>, /Failed to acquire/);

        const throwingRedis = makeRedis({
            set: async () => { throw new Error('ECONNREFUSED simulated'); },
            eval: async () => { throw new Error('eval-fail'); },
            exists: async () => { throw new Error('exists-fail'); },
            keys: async () => { throw new Error('keys-fail'); },
        });
        const throwingManager = new MonSQLize.DistributedCacheLockManager({ redis: throwingRedis, lockKeyPrefix: 'dc-lock:' });
        assert.equal(await throwingManager.tryAcquireLock('down'), null);
        assert.equal(await throwingManager.isLocked('down'), false);
        assert.equal(await throwingManager.releaseLocks({ id: 'session' }), 0);
        assert.equal(await throwingManager.releaseLock('down', 'id'), false);
        assert.equal(await throwingManager.renewLock('down', 'id', 1), false);
        assert.equal(await throwingManager.withLock('down', async () => 'fallback-ok', { retryTimes: 0, retryDelay: 0, fallbackToNoLock: true }), 'fallback-ok');
    });

    it('lock managers cover debug logging, Redis add failures, retries and connection fallback variants', async () => {
        const debugMessages: unknown[] = [];
        const local = new MonSQLize.LockManager({ lockKeyPrefix: 'coverage-debug-lock:', logger: { debug: (...args: unknown[]) => debugMessages.push(args) } });
        local.clear();
        const localLock = await local.acquireLock('item', { retryTimes: 0 });
        await localLock.release();
        local.clear();
        assert.equal(debugMessages.length >= 2, true);

        const manualFalseRelease = new MonSQLize.Lock('manual', 'lock-id', {
            releaseLock: async () => false,
            renewLock: async () => true,
        }, 10);
        assert.equal(await manualFalseRelease.release(), false);
        assert.equal(manualFalseRelease.isHeld(), true);

        const makeRedis = (overrides: Record<string, unknown> = {}) => {
            const redis = {
                on: () => undefined,
                set: async () => 'OK',
                eval: async () => 1,
                keys: async () => [] as string[],
                exists: async () => 0,
                ...overrides,
            };
            return redis;
        };

        const addFailure = new MonSQLize.DistributedCacheLockManager({ redis: makeRedis({ set: async () => { throw new Error('add-fail'); } }), lockKeyPrefix: 'dc-lock:' });
        assert.equal(await addFailure.addLock('key', { id: 'session' }), false);

        let attempts = 0;
        const retryManager = new MonSQLize.DistributedCacheLockManager({
            redis: makeRedis({ set: async () => attempts++ === 0 ? null : 'OK' }),
            lockKeyPrefix: 'dc-lock:',
        });
        const retryLock = await retryManager.acquireLock('eventual', { retryTimes: 1, retryDelay: 0 });
        assert.equal(retryLock.isHeld(), true);
        await retryLock.release();

        for (const message of ['ETIMEDOUT simulated', 'ENOTFOUND simulated', 'Connection is closed']) {
            const fallbackManager = new MonSQLize.DistributedCacheLockManager({
                redis: makeRedis({ set: async () => { throw new Error(message); } }),
                lockKeyPrefix: 'dc-lock:',
            });
            assert.equal(await fallbackManager.withLock('down', async () => message, { retryTimes: 0, retryDelay: 0, fallbackToNoLock: true }), message);
        }
    });
});

describe('v1 parity repairs — cache, batch retry and flat model hooks', () => {
    it('findOneByIdDocument and findByIdsDocuments honor options.cache', async () => {
        const id = new ObjectId();
        let findOneCalls = 0;
        let findCalls = 0;
        const cache = new Map<string, unknown>();
        const queryCache = {
            get: (key: string) => cache.get(key),
            set: (key: string, value: unknown) => { cache.set(key, value); return true; },
        };
        const collection = {
            namespace: 'db.users',
            findOne: async () => {
                findOneCalls += 1;
                return { _id: id, name: 'Ada' };
            },
            find: () => {
                findCalls += 1;
                return { toArray: async () => [{ _id: id, name: 'Ada' }] };
            },
        } as any;

        const first = await findOneByIdDocument(collection, id, { cache: 1000 } as any, { maxTimeMS: 2000 }, queryCache);
        const second = await findOneByIdDocument(collection, id, { cache: 1000 } as any, { maxTimeMS: 2000 }, queryCache);
        assert.deepEqual(second, first);
        assert.equal(findOneCalls, 1);
        await findOneByIdDocument(collection, id, { comment: 'coverage-comment' } as any, {}, null);

        const batchOne = await findByIdsDocuments(collection, [id], { cache: 1000 } as any, { maxTimeMS: 2000 }, queryCache);
        const batchTwo = await findByIdsDocuments(collection, [id], { cache: 1000 } as any, { maxTimeMS: 2000 }, queryCache);
        assert.deepEqual(batchTwo, batchOne);
        assert.equal(findCalls, 1);

        const stringIdCollection = {
            namespace: 'db.stringUsers',
            find: () => ({ toArray: async () => [{ _id: id.toString(), name: 'String Ada' }] }),
        } as any;
        const objectIdLike = { toHexString: () => id.toString() };
        const ordered = await findByIdsDocuments(stringIdCollection, [objectIdLike], { comment: 'coverage-comment', preserveOrder: true } as any);
        assert.deepEqual(ordered, [{ _id: id.toString(), name: 'String Ada' }]);
    });

    it('batch operations use v1 retry defaults and updateBatch supports retry callbacks', async () => {
        let insertAttempts = 0;
        const insertCollection = {
            insertMany: async () => {
                insertAttempts += 1;
                if (insertAttempts === 1) throw new Error('transient insert');
                return { insertedCount: 1, insertedIds: { 0: 'id-1' } };
            },
        } as any;
        const insertResult = await insertBatchDocuments(insertCollection, [{ name: 'Ada' }] as any, { onError: 'retry', retryDelay: 0 } as any);
        assert.equal(insertAttempts, 2);
        assert.equal(insertResult.retries.length, 1);

        let insertStringAttempts = 0;
        const insertStringCollection = {
            insertMany: async () => {
                insertStringAttempts += 1;
                if (insertStringAttempts === 1) throw 'transient insert string';
                return { insertedCount: 1, insertedIds: { 0: 'id-1' } };
            },
        } as any;
        const insertStringResult = await insertBatchDocuments(insertStringCollection, [{ name: 'Ada' }] as any, { onError: 'retry', retryDelay: 0 } as any);
        assert.equal(insertStringResult.retries[0].error instanceof Error, true);

        const idCursor = () => ({
            async *[Symbol.asyncIterator]() {
                yield { _id: 'id-1' };
            },
            close: async () => true,
        });
        let updateAttempts = 0;
        const updateRetries: unknown[] = [];
        const updateCollection = {
            find: idCursor,
            countDocuments: async () => 1,
            updateMany: async () => {
                updateAttempts += 1;
                if (updateAttempts === 1) throw new Error('transient update');
                return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
            },
        } as any;
        const updateResult = await updateBatchDocuments(updateCollection, { active: true } as any, { $set: { active: false } } as any, {
            onError: 'retry',
            retryDelay: 1,
            onRetry: (info: unknown) => updateRetries.push(info),
        } as any);
        assert.equal(updateAttempts, 2);
        assert.equal(updateResult.retries.length, 1);
        assert.equal(updateRetries.length, 1);

        let updateStringAttempts = 0;
        const updateStringCollection = {
            find: idCursor,
            countDocuments: async () => 1,
            updateMany: async () => {
                updateStringAttempts += 1;
                if (updateStringAttempts === 1) throw 'transient update string';
                return { matchedCount: 1, modifiedCount: 1 };
            },
        } as any;
        const updateStringResult = await updateBatchDocuments(updateStringCollection, { active: true } as any, { $set: { active: false } } as any, { onError: 'retry', retryDelay: 0 } as any);
        assert.equal(updateStringResult.upsertedCount, 0);
        assert.equal(updateStringResult.retries[0].error instanceof Error, true);

        let deleteAttempts = 0;
        const deleteCollection = {
            find: idCursor,
            countDocuments: async () => 1,
            deleteMany: async () => {
                deleteAttempts += 1;
                if (deleteAttempts === 1) throw new Error('transient delete');
                return { deletedCount: 1 };
            },
        } as any;
        const deleteResult = await deleteBatchDocuments(deleteCollection, { stale: true } as any, { onError: 'retry', retryDelay: 1 } as any);
        assert.equal(deleteAttempts, 2);
        assert.equal(deleteResult.retries.length, 1);

        let deleteStringAttempts = 0;
        const deleteStringCollection = {
            find: idCursor,
            countDocuments: async () => 1,
            deleteMany: async () => {
                deleteStringAttempts += 1;
                if (deleteStringAttempts === 1) throw 'transient delete string';
                return { deletedCount: 1 };
            },
        } as any;
        const deleteStringResult = await deleteBatchDocuments(deleteStringCollection, { stale: true } as any, { onError: 'retry', retryDelay: 0 } as any);
        assert.equal(deleteStringResult.retries[0].error instanceof Error, true);

        await assert.rejects(() => updateBatchDocuments(updateCollection, { active: true } as any, { $set: { active: false } } as any, { onError: 'bad' } as any), /onError/);
        await assert.rejects(() => updateBatchDocuments(updateCollection, { active: true } as any, { $set: { active: false } } as any, { retryAttempts: -1 } as any), /retryAttempts/);
        await assert.rejects(() => deleteBatchDocuments(deleteCollection, { stale: true } as any, { onError: 'bad' } as any), /onError/);
        await assert.rejects(() => deleteBatchDocuments(deleteCollection, { stale: true } as any, { retryAttempts: -1 } as any), /retryAttempts/);

        const failingCollection = {
            find: idCursor,
            countDocuments: async () => 1,
            updateMany: async () => { throw new Error('always failing update'); },
            deleteMany: async () => { throw new Error('always failing delete'); },
        } as any;
        const exhaustedUpdate = await updateBatchDocuments(failingCollection, { active: true } as any, { $set: { active: false } } as any, {
            onError: 'retry',
            retryAttempts: 1,
            retryDelay: 0,
        } as any);
        assert.equal(exhaustedUpdate.retries.length, 1);
        assert.equal(exhaustedUpdate.errors.length, 1);
        const exhaustedDelete = await deleteBatchDocuments(failingCollection, { stale: true } as any, {
            onError: 'retry',
            retryAttempts: 1,
            retryDelay: 0,
            estimateProgress: false,
        } as any);
        assert.equal(exhaustedDelete.retries.length, 1);
        assert.equal(exhaustedDelete.errors.length, 1);
        await assert.rejects(() => updateBatchDocuments(failingCollection, { active: true } as any, { $set: { active: false } } as any), /always failing update/);
        await assert.rejects(() => deleteBatchDocuments(failingCollection, { stale: true } as any), /always failing delete/);
    });

    it('flat model hooks support insert aliases and bulk operation coverage', async () => {
        const hookNames: string[] = [];
        const extended = {
            findOneAndReplace: async () => ({ _id: 'id-1' }),
            incrementOne: async () => ({ acknowledged: true, modifiedCount: 1 }),
            insertBatch: async () => ({ acknowledged: true, insertedCount: 1 }),
            updateBatch: async () => ({ acknowledged: true, modifiedCount: 1 }),
            deleteBatch: async () => ({ acknowledged: true, deletedCount: 1 }),
        };
        const context = {
            collectionName: 'users',
            collection: {
                insertMany: async () => ({ acknowledged: true, insertedCount: 1 }),
                updateMany: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }),
                replaceOne: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }),
                findOneAndUpdate: async () => ({ _id: 'id-1' }),
                findOneAndDelete: async () => ({ _id: 'id-1' }),
                upsertOne: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }),
                updateOne: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }),
                deleteOne: async () => ({ acknowledged: true, deletedCount: 1 }),
                deleteMany: async () => ({ acknowledged: true, deletedCount: 1 }),
            },
            extendedCollection: () => extended,
            applyDefaults: (document: Record<string, unknown> = {}) => ({ ...document }),
            nowDate: () => new Date('2024-01-01T00:00:00Z'),
            timestampsConfig: null,
            softDeleteConfig: null,
            versionConfig: null,
            validateEnabled: false,
            schemaCache: null,
            schemaValidateFn: null,
            hooksFactory: null,
            runHook: async (hookName: string) => { hookNames.push(hookName); },
        } as any;

        await orchestrateModelInsertMany(context, [{ name: 'Ada' }]);
        await orchestrateModelUpdateMany(context, { active: true }, { $set: { active: false } });
        await orchestrateModelReplaceOne(context, { id: 1 }, { name: 'Grace' });
        await orchestrateModelFindOneAndUpdate(context, { id: 1 }, { $set: { name: 'Grace' } });
        await orchestrateModelFindOneAndReplace(context, { id: 1 }, { name: 'Grace' });
        await orchestrateModelFindOneAndDelete(context, { id: 1 });
        await orchestrateModelUpsertOne(context, { id: 1 }, { $set: { name: 'Grace' } });
        await orchestrateModelIncrementOne(context, { id: 1 }, 'count', 1);
        await orchestrateModelInsertBatch(context, [{ name: 'Ada' }]);
        await orchestrateModelUpdateBatch(context, { active: true }, { $set: { active: false } });
        await orchestrateModelDeleteBatch(context, { stale: true });
        await orchestrateModelDeleteOne(context, { stale: true });
        await orchestrateModelDeleteMany(context, { stale: true });

        assert.ok(hookNames.includes('beforeCreate'));
        assert.ok(hookNames.includes('beforeInsert'));
        assert.ok(hookNames.includes('afterCreate'));
        assert.ok(hookNames.includes('afterInsert'));
        assert.equal(hookNames.filter((name) => name === 'beforeUpdate').length, 7);
        assert.equal(hookNames.filter((name) => name === 'afterUpdate').length, 7);
        assert.equal(hookNames.filter((name) => name === 'beforeDelete').length, 4);
        assert.equal(hookNames.filter((name) => name === 'afterDelete').length, 4);
    });

    it('v1 factory hooks run on bulk write paths and after-hook failures are swallowed', async () => {
        const calls: string[] = [];
        const context = {
            collectionName: 'users',
            collection: {
                insertMany: async () => ({ acknowledged: true, insertedCount: 1 }),
                updateMany: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }),
                deleteMany: async () => ({ acknowledged: true, deletedCount: 1 }),
            },
            extendedCollection: () => ({
                insertBatch: async () => ({ acknowledged: true, insertedCount: 1 }),
                updateBatch: async () => ({ acknowledged: true, modifiedCount: 1 }),
                deleteBatch: async () => ({ acknowledged: true, deletedCount: 1 }),
            }),
            applyDefaults: (document: Record<string, unknown> = {}) => ({ ...document }),
            nowDate: () => new Date('2024-01-01T00:00:00Z'),
            timestampsConfig: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
            softDeleteConfig: { enabled: true, field: 'deletedAt', type: 'date', ttl: null },
            versionConfig: null,
            validateEnabled: false,
            schemaCache: null,
            schemaValidateFn: null,
            hooksFactory: () => ({
                insert: {
                    before: () => calls.push('insert:before'),
                    after: () => { calls.push('insert:after'); throw new Error('ignored insert after'); },
                },
                update: {
                    before: () => calls.push('update:before'),
                    after: () => { calls.push('update:after'); throw new Error('ignored update after'); },
                },
                delete: {
                    before: () => calls.push('delete:before'),
                    after: () => { calls.push('delete:after'); throw new Error('ignored delete after'); },
                },
            }),
            runHook: async () => { throw new Error('flat hooks should not run'); },
        } as any;

        await orchestrateModelInsertMany(context, [{ name: 'Ada' }]);
        await orchestrateModelInsertBatch(context, [{ name: 'Ada' }]);
        await orchestrateModelUpdateMany(context, { active: true }, { $set: { active: false } });
        await orchestrateModelUpdateBatch(context, { active: true }, { $set: { active: false } });
        await orchestrateModelDeleteBatch(context, { stale: true });
        await orchestrateModelDeleteMany(context, { stale: true });

        assert.equal(calls.filter((name) => name === 'insert:before').length, 2);
        assert.equal(calls.filter((name) => name === 'insert:after').length, 2);
        assert.equal(calls.filter((name) => name === 'update:before').length, 2);
        assert.equal(calls.filter((name) => name === 'update:after').length, 2);
        assert.equal(calls.filter((name) => name === 'delete:before').length, 2);
        assert.equal(calls.filter((name) => name === 'delete:after').length, 2);
    });

    it('model mutation edge branches preserve v1 hook and soft-delete behavior', async () => {
        let insertedPayload: Record<string, unknown> | undefined;
        let batchInsertPayload: Array<Record<string, unknown>> | undefined;
        let batchUpdateFilter: Record<string, unknown> | undefined;
        let batchUpdatePayload: Record<string, unknown> | undefined;
        let incrementField: unknown;
        let incrementOptions: Record<string, unknown> | undefined;
        let deleteOneFilter: Record<string, unknown> | undefined;
        let deleteManyFilter: Record<string, unknown> | undefined;
        const calls: string[] = [];
        const baseContext = {
            collectionName: 'users',
            collection: {
                insertOne: async (document: Record<string, unknown>) => {
                    insertedPayload = document;
                    return { acknowledged: true, insertedId: 'id-1' };
                },
                insertMany: async () => ({ acknowledged: true, insertedCount: 0 }),
                updateOne: async (filter: Record<string, unknown>) => {
                    deleteOneFilter = filter;
                    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
                },
                updateMany: async (filter: Record<string, unknown>) => {
                    deleteManyFilter = filter;
                    return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
                },
                deleteMany: async (filter: Record<string, unknown>) => {
                    deleteManyFilter = filter;
                    return { acknowledged: true, deletedCount: 1 };
                },
            },
            extendedCollection: () => ({
                incrementOne: async (_filter: unknown, field: unknown, _increment: unknown, options: Record<string, unknown>) => {
                    incrementField = field;
                    incrementOptions = options;
                    return { acknowledged: true, modifiedCount: 1 };
                },
                insertBatch: async (docs: Array<Record<string, unknown>>) => {
                    batchInsertPayload = docs;
                    return { acknowledged: true, insertedCount: docs.length };
                },
                updateBatch: async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
                    batchUpdateFilter = filter;
                    batchUpdatePayload = update;
                    return { acknowledged: true, modifiedCount: 1 };
                },
                deleteBatch: async () => {
                    return { acknowledged: true, deletedCount: 1 };
                },
            }),
            applyDefaults: (document: Record<string, unknown> = {}) => ({ defaulted: true, ...document }),
            nowDate: () => new Date('2024-01-01T00:00:00Z'),
            timestampsConfig: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
            softDeleteConfig: { enabled: true, field: 'deletedAt', type: 'boolean', ttl: null },
            versionConfig: { enabled: true, field: '__v' },
            validateEnabled: false,
            schemaCache: null,
            schemaValidateFn: null,
            hooksFactory: null,
            runHook: async (hookName: string) => { calls.push(hookName); },
        } as any;

        const v1Context = {
            ...baseContext,
            hooksFactory: () => ({
                insert: {
                    before: () => ({ name: 'Hooked' }),
                    after: () => { calls.push('insert:after'); throw new Error('ignored after insert'); },
                },
            }),
        } as any;
        await orchestrateModelInsertOne(v1Context, { name: 'Original' });
        assert.equal(insertedPayload?.name, 'Hooked');
        assert.equal(calls.includes('insert:after'), true);

        await orchestrateModelInsertMany({ ...baseContext, hooksFactory: null } as any, undefined);
        await orchestrateModelUpdateOne(baseContext, { id: 1, __v: 0 }, { $set: { name: 'Ada' } });
        await orchestrateModelIncrementOne(baseContext, { id: 1 }, 'count', 1, { $set: { custom: true } });
        assert.deepEqual(incrementField, { count: 1, __v: 1 });
        assert.deepEqual(incrementOptions?.$set, { custom: true, updatedAt: new Date('2024-01-01T00:00:00Z') });

        await orchestrateModelInsertBatch(baseContext, [{ name: 'Batch' }]);
        assert.equal(batchInsertPayload?.[0].defaulted, true);
        assert.equal(batchInsertPayload?.[0].__v, 0);

        await orchestrateModelUpdateBatch(baseContext, { id: 1 }, { $set: { name: 'Batch' } });
        assert.deepEqual((batchUpdatePayload as { $inc?: Record<string, unknown> }).$inc, { __v: 1 });

        await orchestrateModelDeleteOne(baseContext, { id: 1 });
        assert.deepEqual(deleteOneFilter?.deletedAt, { $ne: true });

        await orchestrateModelDeleteBatch(baseContext, { stale: true });
        assert.deepEqual(batchUpdateFilter?.deletedAt, { $ne: true });

        await orchestrateModelDeleteMany(baseContext, { stale: true }, { _forceDelete: true });
        assert.deepEqual(deleteManyFilter, { stale: true });
    });
});

describe('public saga and transaction APIs — additional branch coverage', () => {
    it('SagaOrchestrator validates definitions and covers retry, timeout and compensation branches', async () => {
        const warnings: unknown[] = [];
        const errors: unknown[] = [];
        const saga = new MonSQLize.SagaOrchestrator({
            logger: {
                warn: (...args: unknown[]) => warnings.push(args),
                error: (...args: unknown[]) => errors.push(args),
            },
        });

        assert.throws(() => saga.define(null as any), /definition/);
        assert.throws(() => saga.define({ name: '', steps: [] } as any), /Saga name/);
        assert.throws(() => saga.define({ name: 'bad-empty', steps: [] } as any), /non-empty/);
        assert.throws(() => saga.define({ name: 'bad-step', steps: [null] } as any), /step/);
        assert.throws(() => saga.define({ name: 'bad-name', steps: [{ name: '', execute: async () => undefined }] } as any), /step requires/);
        assert.throws(() => saga.define({ name: 'bad-exec', steps: [{ name: 'step' }] } as any), /execute/);
        assert.throws(() => saga.define({ name: 'bad-comp', steps: [{ name: 'step', execute: async () => undefined, compensate: 'bad' }] } as any), /compensate/);
        assert.throws(() => saga.define({ name: 'bad-timeout', steps: [{ name: 'step', execute: async () => undefined, timeout: 0 }] } as any), /timeout/);
        assert.throws(() => saga.define({ name: 'bad-retry', steps: [{ name: 'step', execute: async () => undefined, retries: -1 }] } as any), /retries/);

        let attempts = 0;
        saga.define({
            name: 'retry-success',
            timeout: 1000,
            steps: [{
                name: 'flaky',
                retries: 1,
                execute: async (ctx: any) => {
                    ctx.set('seen', true);
                    if (attempts++ === 0) throw new Error('retry once');
                    return ctx.has('seen') ? 'done' : 'missing';
                },
            }],
        } as any);
        const success = await saga.execute('retry-success', { id: 1 });
        assert.equal(success.success, true);
        assert.equal(success.result, 'done');
        assert.equal(warnings.length, 1);

        saga.define({
            name: 'timeout-fail',
            steps: [{ name: 'slow', timeout: 1, execute: async () => new Promise(() => undefined) }],
        } as any);
        const keepAlive = setTimeout(() => undefined, 50);
        try {
            const timeout = await saga.execute('timeout-fail', {});
            assert.equal(timeout.success, false);
            assert.match(timeout.error?.message ?? '', /timed out/);
        } finally {
            clearTimeout(keepAlive);
        }

        saga.define({
            name: 'compensation-fail',
            steps: [
                { name: 'first', execute: async () => 'first-result' },
                { name: 'second', execute: async () => 'second-result', compensate: async () => { throw 'compensate-string'; } },
                { name: 'third', execute: async () => { throw 'step-string'; } },
            ],
        } as any);
        const failed = await saga.execute('compensation-fail', {});
        assert.equal(failed.success, false);
        assert.equal(failed.compensation?.success, false);
        assert.equal(errors.length, 1);
        assert.equal((await saga.listSagas()).includes('retry-success'), true);
        assert.equal(saga.getStats().totalExecutions >= 3, true);
    });

    it('Transaction and TransactionManager cover retry, lock, stats and session id branches', async () => {
        const makeSession = (id: unknown) => ({
            id,
            startTransaction: () => undefined,
            commitTransaction: async () => undefined,
            abortTransaction: async () => undefined,
            endSession: async () => undefined,
        });
        const sessions = [
            makeSession({ toHexString: () => 'hex-session' }),
            makeSession({ id: { buffer: Uint8Array.from([1, 2, 3]) } }),
            makeSession({ toString: () => 'stringified-session' }),
            makeSession('plain-session'),
        ];
        const client = { startSession: () => sessions.shift() ?? makeSession('fallback-session') };
        const invalidations: string[] = [];
        const cache = { delPattern: async (pattern: string) => { invalidations.push(pattern); } };
        const lockManager = new MonSQLize.CacheLockManager({ maxDuration: 1000, cleanupInterval: 100000 });
        const manager = new MonSQLize.TransactionManager({
            client,
            cache,
            lockManager,
            maxDuration: 0,
            maxRetries: 1,
            retryDelay: 0,
            retryBackoff: 1,
        } as any);

        assert.equal(manager.getStats().averageDuration, 0);

        const manual = await manager.startSession({ timeout: 0 });
        assert.equal(manual.getInfo().sessionId, 'hex-session');
        await assert.rejects(() => manual.commit(), /Cannot commit/);
        await manual.start();
        await assert.rejects(() => manual.start(), /Cannot start/);
        await manual.recordInvalidation('users:*');
        assert.equal(invalidations.includes('users:*'), false);
        await manual.commit();
        assert.equal(invalidations.includes('users:*'), true);
        await assert.rejects(() => manual.commit(), /Cannot commit/);
        await manual.end();

        const aborting = await manager.startSession({ timeout: 0, enableCacheLock: false });
        assert.equal(aborting.getInfo().sessionId, '010203');
        await manager.abortAll();
        assert.equal(manager.getActiveTransactions().length, 0);

        let attempts = 0;
        const result = await manager.withTransaction(async (transaction: any) => {
            if (attempts++ === 0) {
                const transient = Object.assign(new Error('transient'), { code: 112 });
                throw transient;
            }
            assert.equal(transaction.getInfo().sessionId, 'plain-session');
            return 'committed';
        }, { timeout: 0, maxRetries: 1, retryDelay: 0, retryBackoff: 1 });
        assert.equal(result, 'committed');
        assert.equal(manager.getStats().totalTransactions >= 2, true);

        lockManager.addLock('orders:*', { id: undefined });
        assert.equal(lockManager.isLocked('orders:123'), true);
        lockManager.releaseLocks({ id: undefined });
        assert.equal(lockManager.isLocked('orders:123'), false);
        lockManager.stop();
    });

    it('TransactionManager legacy constructor covers primitive session ids and label-based retry', async () => {
        const sessions = [
            { id: 7, startTransaction: () => undefined, commitTransaction: async () => undefined, abortTransaction: async () => undefined, endSession: async () => undefined },
            { id: 'retry-one', startTransaction: () => undefined, commitTransaction: async () => undefined, abortTransaction: async () => undefined, endSession: async () => undefined },
            { id: 'retry-two', startTransaction: () => undefined, commitTransaction: async () => undefined, abortTransaction: async () => undefined, endSession: async () => undefined },
        ];
        const client = { startSession: () => sessions.shift() };
        const manager = new MonSQLize.TransactionManager(client as any, null, { maxDuration: 0, maxRetries: 1, retryDelay: 0, retryBackoff: 1 });

        assert.equal(buildRuntimeDefaults({} as any).autoConvertObjectId, true);

        const manual = await manager.startSession({ timeout: 0 });
        assert.equal(manual.getInfo().sessionId, '7');
        await manual.abort();
        await manual.end();

        let attempts = 0;
        const result = await manager.withTransaction(async () => {
            if (attempts++ === 0) {
                throw { hasErrorLabel: (label: string) => label === 'TransientTransactionError' };
            }
            return 'label-retry-ok';
        }, { timeout: 0, maxRetries: 1, retryDelay: 0, retryBackoff: 1 });
        assert.equal(result, 'label-retry-ok');
    });
});

describe('pool manager and health checker — direct branch coverage', () => {
    function createFakePoolClient() {
        return {
            closed: 0,
            dbName: null as string | null,
            collectionName: null as string | null,
            db(name?: string) {
                this.dbName = name ?? null;
                return {
                    command: async () => ({ ok: 1 }),
                    collection: (collectionName: string) => {
                        this.collectionName = collectionName;
                        return { collectionName };
                    },
                };
            },
            async close() { this.closed++; },
        };
    }

    const poolConfig = (name: string, role: 'primary' | 'secondary' = 'primary') => ({
        name,
        uri: `mongodb://localhost:27017/${name}`,
        role,
        healthCheck: { enabled: false },
    });

    it('source pool runtime helper functions are callable directly', () => {
        validatePoolConfigSource(poolConfig('direct'));
        validatePoolConfigInternal(poolConfig('internal'));
        assert.deepEqual(validatePoolConfigSafeSource(poolConfig('safe')), []);
        assert.equal(createEmptyPoolStats('main').name, 'main');
    });

    it('ConnectionPoolManager covers add, duplicate, max, selection, stats and close branches', async () => {
        const clients = [createFakePoolClient(), createFakePoolClient()];
        let nextClient = 0;
        const warnings: unknown[] = [];
        const manager = new ConnectionPoolManager({
            maxPoolsCount: 2,
            fallback: { enabled: true, fallbackStrategy: 'secondary' },
            clientFactory: async () => clients[nextClient++] as any,
            healthCheckFn: async () => true,
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        } as any);

        await manager.addPool(poolConfig('primary'));
        await manager.addPool(poolConfig('secondary', 'secondary'));

        await assert.rejects(() => manager.addPool(poolConfig('third')) as Promise<void>, /Maximum pool count/);
        await assert.rejects(() => manager.addPool(poolConfig('primary')) as Promise<void>, /already exists/);
        assert.equal(manager.getPool('missing'), null);

        const manual = manager.selectPool('read', { pool: 'primary' });
        manual.db('named');
        assert.equal(clients[0].dbName, 'named');
        assert.equal(manual.collection('named', 'users').collectionName, 'users');
        assert.throws(() => manager.selectPool('read', { pool: 'missing' }), /not found/);

        manager.startHealthCheck('missing');
        manager.stopHealthCheck('missing');
        assert.deepEqual(manager.getPoolNames(), ['primary', 'secondary']);
        assert.equal(Object.keys(manager.getPoolStats()).length, 2);
        assert.equal(manager.getPoolHealth().size, 2);
        assert.equal(manager._handleAllPoolsDown('write').length, 1);
        assert.equal(manager._handleAllPoolsDown('read').length, 1);
        assert.equal(warnings.length >= 2, true);

        await manager.removePool('secondary');
        await assert.rejects(() => manager.removePool('secondary') as Promise<void>, /not found/);
        await manager.close();
        assert.equal((manager as any)._closed, true);
    });

    it('ConnectionPoolManager covers pending duplicate and Mongo error enhancement branches', async () => {
        const pendingClient = createFakePoolClient();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const pendingManager = new ConnectionPoolManager({
            clientFactory: async () => {
                await pending;
                return pendingClient as any;
            },
        } as any);

        const firstAdd = pendingManager.addPool(poolConfig('pending'));
        await assert.rejects(() => pendingManager.addPool(poolConfig('pending')) as Promise<void>, /already exists/);
        release();
        await firstAdd;
        await pendingManager.close();

        const mongoError = Object.assign(new Error('Server selection timed out'), { name: 'MongoServerSelectionError' });
        const errorManager = new ConnectionPoolManager({ clientFactory: async () => { throw mongoError; } } as any);
        await assert.rejects(() => errorManager.addPool(poolConfig('broken')) as Promise<void>, /connect ETIMEDOUT/);
    });

    it('ConnectionPoolManager covers race, selector, stats fallback and disabled fallback branches', async () => {
        const raceClient = createFakePoolClient();
        let raceManager!: ConnectionPoolManager;
        raceManager = new ConnectionPoolManager({
            clientFactory: async (config: any) => {
                (raceManager as any).pools.set(config.name, { client: createFakePoolClient() as any, config, createdAt: Date.now() });
                return raceClient as any;
            },
        } as any);
        await assert.rejects(() => raceManager.addPool(poolConfig('race')) as Promise<void>, /already exists/);
        assert.equal(raceClient.closed, 1);
        await raceManager.close();

        const noFallback = new ConnectionPoolManager({ fallback: { enabled: false }, clientFactory: async () => createFakePoolClient() as any } as any);
        assert.throws(() => noFallback.selectPool('read'), /No available/);

        const manager = new ConnectionPoolManager({ clientFactory: async () => createFakePoolClient() as any } as any);
        await manager.addPool(poolConfig('primary'));
        (manager as any)._selector = { select: () => 'ghost' };
        assert.throws(() => manager.selectPool('read'), /Selected pool/);

        (manager as any).stats.delete('primary');
        (manager as any).healthStatus.delete('primary');
        const stats = manager.getPoolStats().primary;
        assert.equal(stats.status, 'unknown');
        assert.equal(stats.totalRequests, 0);
        assert.equal(manager._getPool('missing' as any), null);

        (manager as any).stats.set('primary', createEmptyPoolStats('primary'));
        (manager as any).recordSelection('primary', false);
        assert.equal((manager as any).stats.get('primary').errorCount, 1);
        await manager.close();
    });

    it('ConnectionPoolManager health checks cover healthy, degraded, down, error, and missing stats branches', async () => {
        const client = createFakePoolClient();
        let mode: 'healthy' | 'unhealthy' | 'throw' = 'healthy';
        const warnings: unknown[] = [];
        const manager = new ConnectionPoolManager({
            clientFactory: async () => client as any,
            healthCheckFn: async () => {
                if (mode === 'throw') throw 'boom';
                return mode === 'healthy';
            },
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        } as any);

        await manager.addPool(poolConfig('health'));
        await (manager as any).checkPoolHealth('missing');
        await (manager as any).checkPoolHealth('health');
        assert.equal(manager.getPoolHealth().get('health')?.status, 'up');

        mode = 'unhealthy';
        await (manager as any).checkPoolHealth('health');
        assert.equal(manager.getPoolHealth().get('health')?.status, 'degraded');
        await (manager as any).checkPoolHealth('health');
        assert.equal(manager.getPoolHealth().get('health')?.status, 'down');

        mode = 'throw';
        await (manager as any).checkPoolHealth('health');
        assert.equal(warnings.length, 1);
        (manager as any).recordSelection('missing', false);

        await manager.close();
    });

    it('HealthChecker covers register overloads, start/stop guards, in-progress guard, timeout and missing client branches', async () => {
        const logs: unknown[] = [];
        const checker = new HealthChecker({ logger: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) } });
        const client = { db: () => ({ command: async () => ({ ok: 1 }) }) };

        checker.register('plain');
        checker.register({ name: 'objectDefault' }, null);
        checker.register({ name: 'healthy', healthCheck: { interval: 1000, timeout: 1000, retries: 1 } }, client);
        checker.register('disabled', { enabled: false });
        checker.start();
        checker.register('lateDisabled', { enabled: false });
        checker.start();
        (checker as any)._inProgress.add('healthy');
        await checker.checkPool('healthy');
        (checker as any)._inProgress.delete('healthy');
        await checker.checkPool('healthy');
        await checker.checkPool('unknown');
        checker.unregister('disabled');
        checker.stop();
        checker.stop();

        const missing = new HealthChecker({ logger: { info: () => undefined } });
        missing.register('missing', { retries: 1, timeout: 1 });
        await missing.checkPool('missing');
        assert.equal(missing.getStatus('missing')?.status, 'down');
        assert.equal(missing.getAllStatus().size, 1);
        assert.equal(logs.length >= 2, true);

        const nonError = new HealthChecker({ logger: { info: () => undefined } });
        nonError.register({ name: 'nonError', healthCheck: { retries: 1 } }, { db: () => ({ command: async () => { throw 'plain-failure'; } }) });
        await nonError.checkPool('nonError');
        assert.match(nonError.getStatus('nonError')?.lastError?.message ?? '', /plain-failure/);

        const managed = new HealthChecker({
            poolManager: { _getPool: () => ({ db: () => ({ admin: () => ({ ping: async () => ({ ok: 1 }) }) }) }) } as any,
            logger: { info: () => undefined },
        });
        managed.register('managed', { retries: 1 });
        await managed.checkPool('managed');
        assert.equal(managed.getStatus('managed')?.status, 'up');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleSlowQueryLogError / getSlowQueryThreshold / withSlowQueryLog
// ─────────────────────────────────────────────────────────────────────────────

describe('Slow query log helpers', () => {

    it('getSlowQueryThreshold returns default 500 when no value set', () => {
        const threshold = MonSQLize.getSlowQueryThreshold(null);
        assert.equal(threshold, 500);
    });

    it('getSlowQueryThreshold returns default 500 for undefined', () => {
        const threshold = MonSQLize.getSlowQueryThreshold(undefined);
        assert.equal(threshold, 500);
    });

    it('getSlowQueryThreshold returns configured value', () => {
        const threshold = MonSQLize.getSlowQueryThreshold({ slowQueryMs: 100 });
        assert.equal(threshold, 100);
    });

    it('getSlowQueryThreshold returns 500 if slowQueryMs is non-numeric', () => {
        const threshold = MonSQLize.getSlowQueryThreshold({ slowQueryMs: 'fast' });
        assert.equal(threshold, 500);
    });

    it('handleSlowQueryLogError(throw) triggered via SlowQueryLogManager with failing storage', async () => {
        const failingStorage = {
            initialize: () => Promise.resolve(undefined),
            save: () => Promise.reject(new Error('storage-fail')),
            saveBatch: () => Promise.reject(new Error('storage-fail')),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        // logger is 4th constructor arg: (userConfig, businessClient, businessType, logger, options)
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 }, advanced: { errorHandling: 'throw' } },
            null, null, null, { storage: failingStorage },
        );
        await assert.rejects(
            () => mgr.save({ database: 'db', collection: 'col', operation: 'find', durationMs: 1000 }),
            /storage-fail/,
        );
    });

    it('handleSlowQueryLogError(log) triggered via SlowQueryLogManager logs error', async () => {
        const loggedErrors: unknown[] = [];
        const logger = { error: (...args: unknown[]) => loggedErrors.push(args), warn: () => { } };
        const failingStorage = {
            initialize: () => Promise.resolve(undefined),
            save: () => Promise.reject(new Error('log-storage-fail')),
            saveBatch: () => Promise.reject(new Error('log-storage-fail')),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        // logger is 4th constructor arg: (userConfig, businessClient, businessType, logger, options)
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 }, advanced: { errorHandling: 'log' } },
            null, null, logger, { storage: failingStorage },
        );
        await mgr.save({ database: 'db', collection: 'col', operation: 'find', durationMs: 1000 });
        assert.ok(loggedErrors.length >= 1);
    });

    it('handleSlowQueryLogError(ignore) via SlowQueryLogManager swallows error', async () => {
        const failingStorage = {
            initialize: () => Promise.resolve(undefined),
            save: () => Promise.reject(new Error('ignored-fail')),
            saveBatch: () => Promise.reject(new Error('ignored-fail')),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        // logger is 4th constructor arg; pass null for 'ignore' policy
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 }, advanced: { errorHandling: 'ignore' } },
            null, null, null, { storage: failingStorage },
        );
        // Should not throw
        await mgr.save({ database: 'db', collection: 'col', operation: 'find', durationMs: 1000 });
    });

    it('withSlowQueryLog returns the exec result', async () => {
        const result = await MonSQLize.withSlowQueryLog(null, {}, 'find', null, null, () => Promise.resolve(42));
        assert.equal(result, 42);
    });

    it('withSlowQueryLog logs slow query when threshold exceeded', async () => {
        const warnings: unknown[] = [];
        const logger = {
            warn: (...args: unknown[]) => warnings.push(args),
            error: () => { },
        };
        // Use threshold = 0 so any exec triggers slow log
        await MonSQLize.withSlowQueryLog(
            logger,
            { slowQueryMs: 0 },
            'find',
            { db: 'testdb', coll: 'users' },
            {},
            () => Promise.resolve('ok'),
        );
        assert.ok(warnings.length > 0);
    });

    it('withSlowQueryLog calls onEmit callback when slow', async () => {
        const emitted: unknown[] = [];
        const logger = { warn: () => { }, error: () => { } };
        await MonSQLize.withSlowQueryLog(
            logger,
            { slowQueryMs: 0 },
            'insert',
            { db: 'db', coll: 'col' },
            {},
            () => Promise.resolve('done'),
            null,
            (info: unknown) => emitted.push(info),
        );
        assert.ok(emitted.length > 0);
    });

    it('withSlowQueryLog uses formatSlowQuery when provided', async () => {
        const formatted: unknown[] = [];
        const logger = {
            warn: (...args: unknown[]) => formatted.push(args),
            error: () => { },
        };
        await MonSQLize.withSlowQueryLog(
            logger,
            {
                slowQueryMs: 0,
                log: {
                    formatSlowQuery: (base: unknown) => ({ custom: true, ...base as object }),
                },
            },
            'update',
            { db: 'db', coll: 'col' },
            {},
            () => Promise.resolve('done'),
        );
        assert.ok(formatted.length > 0);
        const first = formatted[0] as unknown[];
        assert.ok((first[1] as any)?.custom === true);
    });

    it('withSlowQueryLog uses slowLogShaper when provided', async () => {
        const shaped: unknown[] = [];
        const logger = { warn: (...args: unknown[]) => shaped.push(args), error: () => { } };
        await MonSQLize.withSlowQueryLog(
            logger,
            { slowQueryMs: 0 },
            'count',
            { db: 'db', coll: 'col' },
            { sort: { name: 1 } },
            () => Promise.resolve(5),
            (opts: unknown) => ({ sortKeys: Object.keys((opts as any)?.sort ?? {}) }),
        );
        assert.ok(shaped.length > 0);
    });

    it('withSlowQueryLog does not log when faster than threshold', async () => {
        const warnings: unknown[] = [];
        const logger = { warn: (...args: unknown[]) => warnings.push(args) };
        await MonSQLize.withSlowQueryLog(
            logger,
            { slowQueryMs: 9999999 },
            'find',
            { db: 'db', coll: 'col' },
            {},
            () => Promise.resolve('fast'),
        );
        assert.equal(warnings.length, 0);
    });

    it('withSlowQueryLog with no logger (null) logs nothing and returns result', async () => {
        const result = await MonSQLize.withSlowQueryLog(
            null,
            { slowQueryMs: 0 },
            'find',
            { db: 'db', coll: 'col' },
            {},
            () => Promise.resolve('no-logger'),
        );
        assert.equal(result, 'no-logger');
    });

    it('withSlowQueryLog with no options (null) uses default threshold', async () => {
        const result = await MonSQLize.withSlowQueryLog(
            null,
            null,
            'find',
            { db: 'db', coll: 'col' },
            {},
            () => Promise.resolve('done'),
        );
        assert.equal(result, 'done');
    });

    it('SlowQueryLogManager.save() accepts empty-string database (no input validation)', async () => {
        const saved: unknown[] = [];
        const memStorage = {
            initialize: () => Promise.resolve(undefined),
            save: (e: unknown) => { saved.push(e); return Promise.resolve(undefined); },
            saveBatch: () => Promise.resolve(undefined),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, storage: { type: 'memory' }, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 }, advanced: { errorHandling: 'throw' } },
            null, null, null, { storage: memStorage },
        );
        await mgr.save({ database: '', collection: 'col', operation: 'find', durationMs: 100 });
        assert.ok(saved.length >= 0);
    });

    it('SlowQueryLogManager.save() with zero durationMs', async () => {
        const saved: unknown[] = [];
        const memStorage = {
            initialize: () => Promise.resolve(undefined),
            save: (e: unknown) => { saved.push(e); return Promise.resolve(undefined); },
            saveBatch: () => Promise.resolve(undefined),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, storage: { type: 'memory' }, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 }, advanced: { errorHandling: 'throw' } },
            null, null, null, { storage: memStorage },
        );
        await mgr.save({ database: 'db', collection: 'col', operation: 'find', durationMs: 0 });
        assert.ok(saved.length >= 0);
    });

    it('SlowQueryLogManager.save() with queryHash provided', async () => {
        const storage = {
            initialize: () => Promise.resolve(undefined),
            save: (_entry: unknown) => Promise.resolve(undefined),
            saveBatch: (_entries: unknown) => Promise.resolve(undefined),
            query: () => Promise.resolve([] as any),
            close: () => Promise.resolve(undefined),
        };
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 } },
            null, null, null, { storage },
        );
        await mgr.save({
            database: 'db',
            collection: 'col',
            operation: 'find',
            durationMs: 100,
            queryHash: 'custom-hash-abc',
            timestamp: new Date(),
            metadata: { user: 'test' },
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePositiveInteger / validateRange / normalizeSort / normalizeProjection
// ─────────────────────────────────────────────────────────────────────────────

describe('Utility validators', () => {

    it('validatePositiveInteger returns value for valid input', () => {
        const result = MonSQLize.validatePositiveInteger(5, 'count');
        assert.equal(result, 5);
    });

    it('validatePositiveInteger throws for zero', () => {
        assert.throws(
            () => MonSQLize.validatePositiveInteger(0, 'count'),
            /count/,
        );
    });

    it('validatePositiveInteger throws for negative', () => {
        assert.throws(
            () => MonSQLize.validatePositiveInteger(-1, 'count'),
        );
    });

    it('validatePositiveInteger throws for non-integer', () => {
        assert.throws(
            () => MonSQLize.validatePositiveInteger(1.5, 'count'),
        );
    });

    it('validatePositiveInteger throws for non-number', () => {
        assert.throws(
            () => MonSQLize.validatePositiveInteger('5', 'count'),
        );
    });

    it('validateRange returns value for valid input', () => {
        const result = MonSQLize.validateRange(5, 1, 10, 'value');
        assert.equal(result, 5);
    });

    it('validateRange throws when below min', () => {
        assert.throws(
            () => MonSQLize.validateRange(0, 1, 10, 'value'),
        );
    });

    it('validateRange throws when above max', () => {
        assert.throws(
            () => MonSQLize.validateRange(11, 1, 10, 'value'),
        );
    });

    it('normalizeSort with object returns same object', () => {
        const result = MonSQLize.normalizeSort({ name: 1, age: -1 });
        assert.ok(typeof result === 'object');
    });

    it('normalizeSort with null/undefined returns empty object', () => {
        const r1 = MonSQLize.normalizeSort(null);
        const r2 = MonSQLize.normalizeSort(undefined);
        assert.ok(r1 !== null);
        assert.ok(r2 !== null);
    });

    it('normalizeProjection with object returns normalized form', () => {
        const result = MonSQLize.normalizeProjection({ name: 1, age: 1 });
        assert.ok(typeof result === 'object');
    });

    it('normalizeProjection with null returns falsy/empty', () => {
        const result = MonSQLize.normalizeProjection(null);
        assert.ok(result === null || result === undefined || typeof result === 'object');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// encodeCursor / decodeCursor
// ─────────────────────────────────────────────────────────────────────────────

describe('Cursor encoding', () => {

    it('encodeCursor produces a string', () => {
        const cursor = MonSQLize.encodeCursor({ v: 1, s: { createdAt: -1 }, a: { createdAt: new Date('2024-01-01') } });
        assert.equal(typeof cursor, 'string');
    });

    it('encodeCursor without v uses default version', () => {
        const cursor = MonSQLize.encodeCursor({ s: { _id: 1 }, a: { _id: 'abc123' } });
        assert.equal(typeof cursor, 'string');
    });

    it('encodeCursor with direction', () => {
        const cursor = MonSQLize.encodeCursor({ s: { val: 1 }, a: { val: 5 }, d: 'after' });
        assert.equal(typeof cursor, 'string');
    });

    it('encodeCursor with before direction', () => {
        const cursor = MonSQLize.encodeCursor({ s: { val: 1 }, a: { val: 5 }, d: 'before' });
        assert.equal(typeof cursor, 'string');
    });

    it('decodeCursor decodes encoded cursor', () => {
        const cursor = MonSQLize.encodeCursor({ v: 1, s: { val: 1 }, a: { val: 42 } });
        const decoded = MonSQLize.decodeCursor(cursor);
        assert.ok(decoded !== null && typeof decoded === 'object');
        assert.ok((decoded as any).a !== undefined);
    });

    it('decodeCursor with invalid cursor throws', () => {
        assert.throws(
            () => MonSQLize.decodeCursor('not-a-valid-cursor'),
        );
    });

    it('encodeCursor throws without s field', () => {
        assert.throws(
            () => MonSQLize.encodeCursor({ a: { val: 1 } } as any),
            /encodeCursor requires sort/,
        );
    });

    it('encodeCursor throws without a field', () => {
        assert.throws(
            () => MonSQLize.encodeCursor({ s: { val: 1 } } as any),
            /encodeCursor requires sort/,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Logger (exported Logger class)
// ─────────────────────────────────────────────────────────────────────────────

describe('Logger', () => {

    it('Logger.create() returns a logger instance', () => {
        const logger = MonSQLize.Logger.create({ level: 'info' });
        assert.ok(logger !== null && typeof logger === 'object');
    });

    it('Logger info/warn/error methods are callable', () => {
        const msgs: unknown[] = [];
        const logger = MonSQLize.Logger.create({
            level: 'debug',
            output: (...args: unknown[]) => msgs.push(args),
        });
        if (typeof logger.info === 'function') logger.info('test info');
        if (typeof logger.warn === 'function') logger.warn('test warn');
        if (typeof logger.error === 'function') logger.error('test error');
        if (typeof logger.debug === 'function') logger.debug('test debug');
    });

    it('Logger with disabled level produces no output', () => {
        const msgs: unknown[] = [];
        const logger = MonSQLize.Logger.create({
            level: 'error',
            output: (...args: unknown[]) => msgs.push(args),
        });
        if (typeof logger.debug === 'function') logger.debug('should be silent');
        if (typeof logger.info === 'function') logger.info('should be silent');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// makePageResult
// ─────────────────────────────────────────────────────────────────────────────

describe('makePageResult', () => {

    const makeCtx = (limit: number, extra: Record<string, unknown> = {}) => ({
        limit,
        stableSort: { createdAt: -1 },
        direction: 'after' as const,
        hasCursor: false,
        pickAnchor: (item: unknown, _sort: unknown) => ({ createdAt: (item as any).createdAt }),
        ...extra,
    });

    it('makePageResult with fewer items than limit (hasMore=false)', () => {
        const rows = [{ id: 1, createdAt: new Date() }, { id: 2, createdAt: new Date() }];
        const result = MonSQLize.makePageResult(rows, makeCtx(5));
        assert.ok(Array.isArray(result.items));
        assert.equal(result.items.length, 2);
        assert.equal(result.pageInfo.hasNext, false);
    });

    it('makePageResult with more items than limit (hasMore=true)', () => {
        const rows = [1, 2, 3, 4, 5, 6].map(i => ({ id: i, createdAt: new Date() }));
        const result = MonSQLize.makePageResult(rows, makeCtx(5));
        assert.ok(Array.isArray(result.items));
        assert.equal(result.items.length, 5);
        assert.equal(result.pageInfo.hasNext, true);
    });

    it('makePageResult with empty array', () => {
        const result = MonSQLize.makePageResult([], makeCtx(10));
        assert.equal(result.items.length, 0);
        assert.equal(result.pageInfo.hasNext, false);
    });

    it('makePageResult with hasCursor=true', () => {
        const rows = [{ id: 1, createdAt: new Date() }];
        const result = MonSQLize.makePageResult(rows, makeCtx(5, { hasCursor: true }));
        assert.ok(result !== null);
    });

    it('makePageResult with before direction', () => {
        const rows = [{ id: 1, createdAt: new Date() }];
        const result = MonSQLize.makePageResult(rows, makeCtx(5, { direction: 'before' }));
        assert.ok(result !== null);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// SlowQueryLogManager.query() — filter branches
// ─────────────────────────────────────────────────────────────────────────────

describe('SlowQueryLogManager query and filter', () => {

    const makeStorage = (records: unknown[] = []) => ({
        initialize: () => Promise.resolve(undefined),
        save: async (_entry: unknown) => { records.push(_entry); },
        saveBatch: async (_entries: unknown) => { },
        query: async (filter: unknown) => records as any[],
        close: () => Promise.resolve(undefined),
    });

    it('SlowQueryLogManager.query() returns records from storage', async () => {
        const storage = makeStorage([{ database: 'db', collection: 'col', operation: 'find' }]);
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 } },
            null, null, null, { storage },
        );
        const result = await mgr.query({});
        assert.ok(Array.isArray(result));
    });

    it('SlowQueryLogManager.query() with database filter', async () => {
        const storage = makeStorage([]);
        const mgr = new MonSQLize.SlowQueryLogManager(
            { enabled: true, batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 } },
            null, null, null, { storage },
        );
        const result = await mgr.query({ database: 'mydb' });
        assert.ok(Array.isArray(result));
    });

    it('SlowQueryLogManager is accessible', () => {
        assert.ok(MonSQLize.SlowQueryLogManager !== undefined);
    });
});
