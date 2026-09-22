import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BSON, Long, ObjectId } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('dataTasks job facade integration', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';

    before(async () => { uri = (await bootstrap.setup()).uri; });
    after(async () => { await bootstrap.teardown(); });

    it('preserves an unsafe-range Long identity through apply, reopen, and restore', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-long-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_long_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_long_target', config: { uri } });
        const code = Long.fromString('9007199254740993');
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertOne({ code, value: 'new' });
            await target.collection('items').insertOne({ code, value: 'old' });
            const job = {
                name: 'long-identity', source, target, targetEnvironment: 'test',
                collections: [{ name: 'items',
                    indexes: [{ key: { code: 1 }, options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] } } }],
                backup: { dir: backupDir, compression: 'none' as const },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const reopened = { runId: applied.backup.runId, manifestPath: applied.backup.manifestPath,
                checksum: applied.backup.checksum };
            const manifest = BSON.EJSON.parse(await fs.readFile(reopened.manifestPath, 'utf8'), { relaxed: false });
            assert.ok(manifest.appliedOperations[0].identity.code instanceof Long);
            assert.equal(manifest.appliedOperations[0].identity.code.toString(), code.toString());
            const restorePreview = await MonSQLize.dataTasks.previewRestore(reopened, { target });
            assert.equal(restorePreview.passed, true, restorePreview.errors.join('\n'));
            const restored = await MonSQLize.dataTasks.restore(reopened, { target, approval: restorePreview.approval });
            assert.equal(restored.passed, true, restored.errors.join('\n'));
            const document = await target.collection('items').findOne({ code });
            assert.equal(document.value, 'old');
            assert.ok(document.code instanceof Long);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('plans more than the public find default without exceeding maxDocuments', async () => {
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_bounded_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_bounded_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertMany(Array.from({ length: 501 }, (_, index) => ({
                code: `item-${index + 1}`,
                value: index + 1,
            })));

            const preview = await MonSQLize.dataTasks.preview({
                name: 'bounded-source-read',
                source,
                target,
                targetEnvironment: 'test',
                collections: [{
                    name: 'items',
                    indexes: [{ key: { code: 1 }, options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields', fields: ['code'] }, maxDocuments: 501 },
                }],
            });

            assert.equal(preview.passed, true, preview.errors.join('\n'));
            assert.equal(preview.collections[0].data.source, 501);
            assert.equal(preview.collections[0].data.insert, 501);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
        }
    });

    it('previews without database writes, then backs up, indexes, applies, and verifies', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-facade-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('feature_modules').insertMany([
                { code: 'A', release: '2026-07', legacyName: 'Alpha', developmentOnly: true },
                { code: 'B', release: '2026-07', legacyName: 'Beta', developmentOnly: true },
            ]);
            await target.collection('feature_modules').insertOne({ code: 'A', name: 'Old', localOnly: true });
            const originalId = (await target.collection('feature_modules').findOne({ code: 'A' }))._id;
            const job = {
                name: 'release-feature-modules', source, target, targetEnvironment: 'production',
                collections: [{
                    name: 'feature_modules',
                    indexes: [{ key: { code: 1 }, name: 'feature_modules_code_unique', options: { unique: true } }],
                    data: {
                        filter: { release: '2026-07' },
                        identity: { mode: 'fields' as const, fields: ['code'] },
                        rename: { legacyName: 'name' },
                        set: { schemaVersion: 2 },
                        unset: ['developmentOnly', 'release'],
                        batchSize: 1,
                    },
                    verify: { mode: 'full' as const, fields: ['code', 'name', 'schemaVersion'] },
                }],
                backup: { dir: backupDir, compression: 'gzip' as const },
            };

            const beforeIndexes = await target.collection('feature_modules').listIndexes();
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            assert.deepEqual(preview.collections[0].data, { source: 2, insert: 1, update: 1, unchanged: 0, conflict: 0 });
            assert.equal(preview.collections[0].indexes[0].status, 'missing');
            assert.equal(await target.collection('feature_modules').count({}), 1);
            assert.deepEqual(await target.collection('feature_modules').listIndexes(), beforeIndexes);

            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            assert.equal(applied.status, 'passed');
            assert.equal(await target.collection('feature_modules').count({}), 2);
            const updated = await target.collection('feature_modules').findOne({ code: 'A' });
            assert.equal(String(updated._id), String(originalId));
            assert.equal(updated.name, 'Alpha');
            assert.equal(updated.localOnly, true);
            assert.equal(updated.schemaVersion, 2);
            assert.equal(updated.legacyName, undefined);
            assert.equal(updated.developmentOnly, undefined);
            assert.equal(updated.release, undefined);
            const inserted = await target.collection('feature_modules').findOne({ code: 'B' });
            assert.equal(inserted.name, 'Beta');
            assert.equal(inserted.schemaVersion, 2);
            assert.equal(inserted.legacyName, undefined);
            assert.equal(inserted.developmentOnly, undefined);
            assert.equal(inserted.release, undefined);
            assert.ok((await target.collection('feature_modules').listIndexes()).some((index: { name?: string }) => index.name === 'feature_modules_code_unique'));
            assert.ok((await fs.stat(applied.backup.manifestPath)).isFile());

            const manifest = BSON.EJSON.parse(await fs.readFile(applied.backup.manifestPath, 'utf8'), { relaxed: true });
            const interruptedOperation = manifest.appliedOperations.shift();
            manifest.pendingOperations = [{
                collection: interruptedOperation.collection,
                targetCollection: interruptedOperation.targetCollection,
                identity: interruptedOperation.identity,
                operation: interruptedOperation.operation,
                beforeHash: 'simulated-before-hash',
                plannedAfterHash: interruptedOperation.afterHash,
            }];
            const interruptedIndex = manifest.createdIndexes.shift();
            manifest.pendingIndexes = [{ ...interruptedIndex, operation: 'create' }];
            manifest.pendingIndexes.push(
                { operation: 'create', collection: 'feature_modules', name: 'never_created', key: { never: 1 }, options: {} },
                { operation: 'drop', collection: 'feature_modules', name: '_id_', key: { _id: 1 }, options: {} },
            );
            await fs.writeFile(
                applied.backup.manifestPath,
                `${BSON.EJSON.stringify(manifest, undefined, 2, { relaxed: false })}\n`,
                'utf8',
            );

            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            assert.equal(restorePreview.passed, true, restorePreview.errors.join('\n'));
            assert.equal(restorePreview.restoreDocuments, 1);
            assert.equal(restorePreview.deleteDocuments, 1);
            assert.equal(restorePreview.dropIndexes, 1);
            assert.match(restorePreview.warnings.join('\n'), /recovered an applied operation/);
            assert.match(restorePreview.warnings.join('\n'), /recovered a created index/);
            assert.match(restorePreview.warnings.join('\n'), /pending index create had no target effect/);
            assert.match(restorePreview.warnings.join('\n'), /pending index drop had no target effect/);
            const restored = await MonSQLize.dataTasks.restore(applied.backup, { approval: restorePreview.approval });
            assert.equal(restored.passed, true, restored.errors.join('\n'));
            assert.equal(await target.collection('feature_modules').count({}), 1);
            const original = await target.collection('feature_modules').findOne({ code: 'A' });
            assert.equal(original.name, 'Old');
            assert.equal(original.localOnly, true);
            assert.equal(original.schemaVersion, undefined);
            assert.ok(!(await target.collection('feature_modules').listIndexes()).some((index: { name?: string }) => index.name === 'feature_modules_code_unique'));
            assert.ok((await fs.stat(restored.safetyBackup.manifestPath)).isFile());

            const safetyPreview = await MonSQLize.dataTasks.previewRestore(restored.safetyBackup);
            assert.equal(safetyPreview.passed, true, safetyPreview.errors.join('\n'));
            assert.equal(safetyPreview.restoreDocuments, 2);
            assert.equal(safetyPreview.createIndexes, 1);
            const safetyRestored = await MonSQLize.dataTasks.restore(restored.safetyBackup, { approval: safetyPreview.approval });
            assert.equal(safetyRestored.passed, true, safetyRestored.errors.join('\n'));
            assert.equal(await target.collection('feature_modules').count({}), 2);
            assert.equal((await target.collection('feature_modules').findOne({ code: 'A' })).name, 'Alpha');
            assert.ok((await target.collection('feature_modules').listIndexes()).some((index: { name?: string }) => index.name === 'feature_modules_code_unique'));
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('preserves source ids and rejects an approval after source drift', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-source-id-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_source_ids', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_target_ids', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            const sourceId = new ObjectId();
            await source.collection('seeds').insertOne({ _id: sourceId, code: 'seed', value: 1 });
            const job = {
                name: 'release-seeds', source, target, targetEnvironment: 'production',
                collections: [{ name: 'seeds', data: { all: true, identity: { mode: 'source-id' as const, conflictBy: ['code'] } } }],
                backup: { dir: backupDir, compression: 'none' as const },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            await source.collection('seeds').updateOne({ _id: sourceId }, { $set: { value: 2 } });
            await assert.rejects(() => MonSQLize.dataTasks.apply(job, { approval: preview.approval }), /sourceHash drifted/);
            assert.equal(await target.collection('seeds').count({}), 0);

            const refreshed = await MonSQLize.dataTasks.preview(job);
            const applied = await MonSQLize.dataTasks.apply(job, { approval: refreshed.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const inserted = await target.collection('seeds').findOne({ code: 'seed' });
            assert.equal(String(inserted._id), String(sourceId));
            assert.equal(inserted.value, 2);
            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            await target.collection('seeds').updateOne({ _id: sourceId }, { $set: { value: 3 } });
            await assert.rejects(
                () => MonSQLize.dataTasks.restore(applied.backup, { approval: restorePreview.approval }),
                /RESTORE_DRIFT/,
            );
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('uses a target database lease across runners and releases ownership after apply', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-lock-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_lock_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_lock_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('seeds').insertOne({ _id: 'seed-id', code: 'seed' });
            const job = {
                name: 'locked-seeds', source, target, targetEnvironment: 'production', lock: true,
                collections: [{ name: 'seeds', data: { all: true, identity: { mode: 'source-id' as const } } }],
                backup: { dir: backupDir },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            await target.collection('_monsqlize_data_task_locks').insertOne({
                _id: 'data-task:global', owner: 'another-runner', expiresAt: new Date(Date.now() + 60_000),
            });
            await assert.rejects(() => MonSQLize.dataTasks.apply(job, { approval: preview.approval }), /another data task holds/);
            assert.equal(await target.collection('seeds').count({}), 0);
            await target.collection('_monsqlize_data_task_locks').deleteOne({ _id: 'data-task:global' });

            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            assert.equal(await target.collection('seeds').count({}), 1);
            assert.equal(await target.collection('_monsqlize_data_task_locks').count({}), 0);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('keeps a write-ahead partial manifest recoverable after a mid-run failure', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-partial-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_partial_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_partial_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertMany([
                { code: 'A', value: 'new-a' },
                { code: 'B', value: 'new-b' },
            ]);
            await target.collection('items').insertMany([
                { code: 'A', value: 'old-a' },
                { code: 'B', value: 'old-b' },
            ]);
            await target.collection('items').createIndex({ code: 1 }, { name: 'items_code_unique', unique: true });
            let updateCount = 0;
            const targetRuntime = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'updateOne') {
                                return async (...args: unknown[]) => {
                                    updateCount += 1;
                                    if (updateCount === 2) return { matchedCount: 0 };
                                    return object.updateOne(...args);
                                };
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const job = {
                name: 'partial-items', source, target: targetRuntime, targetEnvironment: 'production',
                collections: [{
                    name: 'items',
                    indexes: [{ key: { code: 1 }, name: 'items_code_unique', options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] }, batchSize: 2 },
                    verify: { mode: 'full' as const },
                }],
                backup: { dir: backupDir },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, false);
            assert.equal(applied.status, 'partial');
            assert.match(applied.errors.join('\n'), /target document drifted before update/);
            assert.equal((await target.collection('items').findOne({ code: 'A' })).value, 'new-a');
            assert.equal((await target.collection('items').findOne({ code: 'B' })).value, 'old-b');
            await assert.rejects(
                () => MonSQLize.dataTasks.previewRestore({ ...applied.backup, runId: 'wrong-run' }, { target: targetRuntime }),
                /invalid backup manifest/,
            );
            await assert.rejects(
                () => MonSQLize.dataTasks.previewRestore({ ...applied.backup, checksum: 'wrong-checksum' }, { target: targetRuntime }),
                /backup checksum mismatch/,
            );

            const manifest = BSON.EJSON.parse(await fs.readFile(applied.backup.manifestPath, 'utf8'), { relaxed: true });
            assert.equal(manifest.appliedOperations.length, 0);
            assert.equal(manifest.pendingOperations.length, 2);
            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            assert.equal(restorePreview.passed, true, restorePreview.errors.join('\n'));
            assert.equal(restorePreview.restoreDocuments, 1);
            assert.match(restorePreview.warnings.join('\n'), /recovered an applied operation/);
            assert.match(restorePreview.warnings.join('\n'), /had no target effect and was skipped/);
            const restored = await MonSQLize.dataTasks.restore(applied.backup, { approval: restorePreview.approval });
            assert.equal(restored.passed, true, restored.errors.join('\n'));
            assert.equal((await target.collection('items').findOne({ code: 'A' })).value, 'old-a');
            assert.equal((await target.collection('items').findOne({ code: 'B' })).value, 'old-b');
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('rejects concurrent target changes without overwriting them during update and insert apply', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-cas-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_cas_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_cas_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('updates').insertOne({ code: 'A', value: 'planned' });
            await target.collection('updates').insertOne({ code: 'A', value: 'before', nullable: null });
            await target.collection('updates').createIndex({ code: 1 }, { name: 'updates_code_unique', unique: true });
            let updateInjected = false;
            const updateTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'updates') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'updateOne') {
                                return async (...args: unknown[]) => {
                                    if (!updateInjected) {
                                        updateInjected = true;
                                        await object.updateOne(
                                            { code: 'A' },
                                            { $unset: { nullable: 1 }, $set: { concurrentMarker: true } },
                                        );
                                    }
                                    return object.updateOne(...args);
                                };
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const updateJob = {
                name: 'cas-update', source, target: updateTarget, targetEnvironment: 'production',
                collections: [{
                    name: 'updates',
                    indexes: [{ key: { code: 1 }, name: 'updates_code_unique', options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] } },
                }],
                backup: { dir: backupDir },
            };
            const updatePreview = await MonSQLize.dataTasks.preview(updateJob);
            const updateResult = await MonSQLize.dataTasks.apply(updateJob, { approval: updatePreview.approval });
            assert.equal(updateResult.passed, false);
            assert.match(updateResult.errors.join('\n'), /target document drifted before update/);
            const concurrentUpdate = await target.collection('updates').findOne({ code: 'A' });
            assert.equal(concurrentUpdate.value, 'before');
            assert.equal('nullable' in concurrentUpdate, false);
            assert.equal(concurrentUpdate.concurrentMarker, true);

            await source.collection('inserts').insertOne({ code: 'B', value: 'planned' });
            await target.collection('inserts').createIndex({ code: 1 }, { name: 'inserts_code_unique', unique: true });
            let insertInjected = false;
            const insertTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'inserts') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'updateOne') {
                                return async (...args: unknown[]) => {
                                    if (!insertInjected) {
                                        insertInjected = true;
                                        await object.insertOne({ code: 'B', value: 'concurrent', concurrentMarker: true });
                                    }
                                    return object.updateOne(...args);
                                };
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const insertJob = {
                name: 'cas-insert', source, target: insertTarget, targetEnvironment: 'production',
                collections: [{
                    name: 'inserts',
                    indexes: [{ key: { code: 1 }, name: 'inserts_code_unique', options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] } },
                }],
                backup: { dir: backupDir },
            };
            const insertPreview = await MonSQLize.dataTasks.preview(insertJob);
            const insertResult = await MonSQLize.dataTasks.apply(insertJob, { approval: insertPreview.approval });
            assert.equal(insertResult.passed, false);
            assert.match(insertResult.errors.join('\n'), /target appeared after preview/);
            const concurrentInsert = await target.collection('inserts').findOne({ code: 'B' });
            assert.equal(concurrentInsert.value, 'concurrent');
            assert.equal(concurrentInsert.concurrentMarker, true);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('rejects concurrent target changes without overwriting them during restore', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-restore-cas-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_cas_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_cas_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertOne({ code: 'A', value: 'planned', nullable: null });
            await target.collection('items').insertOne({ code: 'A', value: 'before', nullable: 'before' });
            await target.collection('items').createIndex({ code: 1 }, { name: 'items_code_unique', unique: true });
            const job = {
                name: 'restore-cas', source, target, targetEnvironment: 'production',
                collections: [{
                    name: 'items',
                    indexes: [{ key: { code: 1 }, name: 'items_code_unique', options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] } },
                }],
                backup: { dir: backupDir },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            let restoreInjected = false;
            const restoreTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'replaceOne') {
                                return async (...args: unknown[]) => {
                                    if (!restoreInjected) {
                                        restoreInjected = true;
                                        await object.updateOne(
                                            { code: 'A' },
                                            { $unset: { nullable: 1 }, $set: { concurrentMarker: true } },
                                        );
                                    }
                                    return object.replaceOne(...args);
                                };
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const restored = await MonSQLize.dataTasks.restore(applied.backup, {
                target: restoreTarget,
                approval: restorePreview.approval,
            });
            assert.equal(restored.passed, false);
            assert.match(restored.errors.join('\n'), /restore replace did not affect one document/);
            const concurrent = await target.collection('items').findOne({ code: 'A' });
            assert.equal(concurrent.value, 'planned');
            assert.equal('nullable' in concurrent, false);
            assert.equal(concurrent.concurrentMarker, true);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('records a partial restore and keeps its safety backup recoverable after a mid-run failure', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-restore-partial-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_partial_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_partial_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertMany([
                { code: 'A', value: 'planned-a' },
                { code: 'B', value: 'planned-b' },
            ]);
            await target.collection('items').insertMany([
                { code: 'A', value: 'before-a' },
                { code: 'B', value: 'before-b' },
            ]);
            await target.collection('items').createIndex({ code: 1 }, { name: 'items_code_unique', unique: true });
            const job = {
                name: 'restore-partial', source, target, targetEnvironment: 'production',
                collections: [{
                    name: 'items',
                    indexes: [{ key: { code: 1 }, name: 'items_code_unique', options: { unique: true } }],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] } },
                }],
                backup: { dir: backupDir },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            let replaceCount = 0;
            const restoreTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'replaceOne') {
                                return async (...args: unknown[]) => {
                                    replaceCount += 1;
                                    if (replaceCount === 2) return { matchedCount: 0 };
                                    return object.replaceOne(...args);
                                };
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };

            const restored = await MonSQLize.dataTasks.restore(applied.backup, {
                target: restoreTarget,
                approval: restorePreview.approval,
            });
            assert.equal(restored.passed, false);
            assert.equal(restored.status, 'partial');
            assert.equal(restored.restoredDocuments, 1);
            assert.equal(restored.deletedDocuments, 0);
            assert.match(restored.errors.join('\n'), /restore replace did not affect one document/);
            const currentValues = await Promise.all(['A', 'B'].map(async (code) => (
                await target.collection('items').findOne({ code })
            ).value));
            assert.equal(currentValues.filter((value) => String(value).startsWith('before-')).length, 1);
            assert.equal(currentValues.filter((value) => String(value).startsWith('planned-')).length, 1);
            assert.ok((await fs.stat(restored.safetyBackup.manifestPath)).isFile());

            const safetyManifest = BSON.EJSON.parse(
                await fs.readFile(restored.safetyBackup.manifestPath, 'utf8'),
                { relaxed: true },
            );
            assert.equal(safetyManifest.status, 'partial');
            assert.equal(safetyManifest.appliedOperations.length, 1);
            assert.equal(safetyManifest.pendingOperations.length, 1);
            assert.match(safetyManifest.errors.join('\n'), /restore replace did not affect one document/);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('rejects unsupported and ineffective restore deletes without changing the target', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-restore-delete-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_delete_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_restore_delete_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertOne({ _id: 'restore-delete-id', value: 'planned' });
            const job = {
                name: 'restore-delete-contract', source, target, targetEnvironment: 'production',
                collections: [{
                    name: 'items',
                    data: { all: true, identity: { mode: 'source-id' as const } },
                }],
                backup: { dir: backupDir },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            const targetWithDelete = (deleteOne: unknown) => ({
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'deleteOne') return deleteOne;
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            });

            const unsupported = await MonSQLize.dataTasks.restore(applied.backup, {
                target: targetWithDelete(undefined),
                approval: restorePreview.approval,
            });
            assert.equal(unsupported.status, 'failed');
            assert.match(unsupported.errors.join('\n'), /does not support deleteOne/);
            assert.equal(await target.collection('items').count({}), 1);

            const ineffective = await MonSQLize.dataTasks.restore(applied.backup, {
                target: targetWithDelete(async () => ({ deletedCount: 0 })),
                approval: restorePreview.approval,
            });
            assert.equal(ineffective.status, 'failed');
            assert.match(ineffective.errors.join('\n'), /restore delete did not affect one document/);
            assert.equal(await target.collection('items').count({}), 1);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('supports insert strategy, generated index names, and empty follow-up backups', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-insert-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_insert_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_insert_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('items').insertOne({ _id: 'source-id', code: 'A', value: 1 });
            const job = {
                name: 'insert-items', source, target, targetEnvironment: 'production',
                collections: [{
                    name: 'items',
                    indexes: [
                        { key: { code: 1 }, options: { unique: true } },
                        { key: { value: 1 } },
                    ],
                    data: { all: true, identity: { mode: 'fields' as const, fields: ['code'] }, strategy: 'insert' as const },
                }],
                backup: { dir: backupDir, compression: 'none' as const },
            };
            const preview = await MonSQLize.dataTasks.preview(job);
            assert.equal(preview.passed, true, preview.errors.join('\n'));
            const applied = await MonSQLize.dataTasks.apply(job, { approval: preview.approval });
            assert.equal(applied.passed, true, applied.errors.join('\n'));
            const inserted = await target.collection('items').findOne({ code: 'A' });
            assert.notEqual(String(inserted._id), 'source-id');
            assert.ok((await target.collection('items').listIndexes()).some((index: { name?: string }) => index.name === 'code_1'));
            assert.ok((await target.collection('items').listIndexes()).some((index: { name?: string }) => index.name === 'value_1'));

            const followUpJob = {
                ...job,
                name: 'unchanged-items',
                collections: [{
                    ...job.collections[0],
                    data: { ...job.collections[0].data, strategy: 'upsert' as const },
                }],
            };
            const followUpPreview = await MonSQLize.dataTasks.preview(followUpJob);
            assert.equal(followUpPreview.collections[0].data.unchanged, 1);
            const followUp = await MonSQLize.dataTasks.apply(followUpJob, { approval: followUpPreview.approval });
            assert.equal(followUp.passed, true, followUp.errors.join('\n'));
            const followUpManifest = BSON.EJSON.parse(await fs.readFile(followUp.backup.manifestPath, 'utf8'), { relaxed: true });
            assert.equal(followUpManifest.entryCount, 0);

            const restorePreview = await MonSQLize.dataTasks.previewRestore(applied.backup);
            const restored = await MonSQLize.dataTasks.restore(applied.backup, { approval: restorePreview.approval });
            assert.equal(restored.passed, true, restored.errors.join('\n'));
            assert.equal(await target.collection('items').count({}), 0);
            assert.ok(!(await target.collection('items').listIndexes()).some((index: { name?: string }) => index.name === 'code_1'));
            assert.ok(!(await target.collection('items').listIndexes()).some((index: { name?: string }) => index.name === 'value_1'));
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('verifies object-shaped index results and preserves a pending index on readback failure', async () => {
        const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-index-adapter-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_index_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_index_target', config: { uri } });
        try {
            await Promise.all([source.connect(), target.connect()]);
            const objectResultTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'createIndex') {
                                return async (...args: unknown[]) => ({ name: await object.createIndex(...args) });
                            }
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const successfulJob = {
                name: 'object-index-result', source, target: objectResultTarget, targetEnvironment: 'production',
                collections: [{ name: 'items', indexes: [{ key: { code: 1 }, name: 'code_1' }] }],
                backup: { dir: backupDir },
            };
            const successfulPreview = await MonSQLize.dataTasks.preview(successfulJob);
            const successful = await MonSQLize.dataTasks.apply(successfulJob, { approval: successfulPreview.approval });
            assert.equal(successful.passed, true, successful.errors.join('\n'));

            const noReadbackTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'broken_items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'createIndex') return async () => 'missing_after_create';
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const failedJob = {
                name: '***', source, target: noReadbackTarget, targetEnvironment: 'production',
                collections: [{ name: 'broken_items', indexes: [{ key: { broken: 1 }, name: 'missing_after_create' }] }],
                backup: { dir: backupDir },
            };
            const failedPreview = await MonSQLize.dataTasks.preview(failedJob);
            const failed = await MonSQLize.dataTasks.apply(failedJob, { approval: failedPreview.approval });
            assert.equal(failed.passed, false);
            assert.equal(failed.status, 'partial');
            assert.match(failed.errors.join('\n'), /failed readback verification/);
            const manifest = BSON.EJSON.parse(await fs.readFile(failed.backup.manifestPath, 'utf8'), { relaxed: true });
            assert.equal(manifest.pendingIndexes.length, 1);
            const restorePreview = await MonSQLize.dataTasks.previewRestore(failed.backup);
            assert.equal(restorePreview.passed, true, restorePreview.errors.join('\n'));
            assert.equal(restorePreview.dropIndexes, 0);
            assert.match(restorePreview.warnings.join('\n'), /pending index create had no target effect/);

            const noNameTarget = {
                options: target.options,
                collection(name: string) {
                    const base = target.collection(name);
                    if (name !== 'nameless_items') return base;
                    return new Proxy(base, {
                        get(object, property) {
                            if (property === 'createIndex') return async () => undefined;
                            const value = Reflect.get(object, property);
                            return typeof value === 'function' ? value.bind(object) : value;
                        },
                    });
                },
            };
            const noNameJob = {
                name: 'nameless-index-result', source, target: noNameTarget, targetEnvironment: 'production',
                collections: [{ name: 'nameless_items', indexes: [{ key: { value: 1 } }] }],
                backup: { dir: backupDir },
            };
            const noNamePreview = await MonSQLize.dataTasks.preview(noNameJob);
            const noNameResult = await MonSQLize.dataTasks.apply(noNameJob, { approval: noNamePreview.approval });
            assert.equal(noNameResult.status, 'partial');
            assert.match(noNameResult.errors.join('\n'), /did not return a stable name/);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(backupDir, { recursive: true, force: true });
        }
    });

    it('runs preview, apply, preview-restore, and restore across CLI processes', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'monsqlize-job-cli-'));
        const source = new MonSQLize({ type: 'mongodb', databaseName: 'job_cli_source', config: { uri } });
        const target = new MonSQLize({ type: 'mongodb', databaseName: 'job_cli_target', config: { uri } });
        const taskFile = path.join(tempDir, 'job.cjs');
        const previewFile = path.join(tempDir, 'preview.json');
        const applyFile = path.join(tempDir, 'apply.json');
        const restorePreviewFile = path.join(tempDir, 'restore-preview.json');
        try {
            await Promise.all([source.connect(), target.connect()]);
            await source.collection('settings').insertOne({ _id: 'setting-id', code: 'theme', value: 'dark' });
            const job = {
                name: 'cli-settings',
                source: { type: 'mongodb', databaseName: 'job_cli_source', config: { uri } },
                target: { type: 'mongodb', databaseName: 'job_cli_target', config: { uri } },
                targetEnvironment: 'production',
                collections: [{ name: 'settings', data: { all: true, identity: { mode: 'source-id' } } }],
                backup: { dir: tempDir },
            };
            await fs.writeFile(taskFile, `module.exports = ${JSON.stringify(job)};\n`, 'utf8');
            const cli = (...args: string[]) => spawnSync(process.execPath, ['dist/cjs/cli/data-task.cjs', 'data-task', ...args], {
                cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8',
            });

            const preview = cli('preview', '--task', taskFile, '--out', previewFile, '--json');
            assert.equal(preview.status, 0, preview.stderr);
            assert.equal(JSON.parse(preview.stdout).passed, true);
            const apply = cli('apply', '--task', taskFile, '--approval', previewFile, '--out', applyFile, '--json');
            assert.equal(apply.status, 0, apply.stderr);
            const applied = JSON.parse(apply.stdout);
            assert.equal(applied.passed, true, JSON.stringify(applied.errors));
            assert.equal((await target.collection('settings').findOne({ code: 'theme' })).value, 'dark');

            const restorePreview = cli(
                'preview-restore', '--task', taskFile, '--backup', applied.backup.manifestPath,
                '--out', restorePreviewFile, '--json',
            );
            assert.equal(restorePreview.status, 0, restorePreview.stderr);
            assert.equal(JSON.parse(restorePreview.stdout).deleteDocuments, 1);
            const restore = cli(
                'restore', '--task', taskFile, '--backup', applied.backup.manifestPath,
                '--approval', restorePreviewFile, '--json',
            );
            assert.equal(restore.status, 0, restore.stderr);
            assert.equal(JSON.parse(restore.stdout).passed, true);
            assert.equal(await target.collection('settings').count({}), 0);
        } finally {
            await Promise.allSettled([source.close(), target.close()]);
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
