#!/usr/bin/env node
/**
 * Unified test runner — supports full run and per-suite run.
 *
 * Usage:
 *   node test/run-tests.cjs              # run all suites
 *   node test/run-tests.cjs <suite>      # run one suite by name
 *   node test/run-tests.cjs --list       # list available suite names
 *
 * Final summary (full run):
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  monSQLize Test Suite                                       │
 *   │  ✅ 142 passed   ❌ 0 failed   ⏭  5 skipped  │  Total: 147 │
 *   └────────────────────────────────────────────────────────────┘
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_DIST_ROOT = path.join(ROOT, '.generated', 'test-dist');
const QUIET = process.env.MONSQLIZE_TEST_SUMMARY_ONLY === '1';

// ─── Ordered test suites ─────────────────────────────────────────────────────

const SMOKE = [
    'test/smoke/root-cjs.test.js',
    'test/smoke/root-esm.test.js',
    'test/smoke/pack-artifacts.test.js',
    'test/smoke/data-task-cli.test.js',
    'test/smoke/release-contract.test.js',
];

const COMPAT = [
    'test/compatibility/exports/exports.test.js',
    'test/compatibility/matrix.test.js',
];

const UNIT = [
    'test/unit/expression/expression.test.js',
    'test/unit/expression/operators.test.js',
    'test/unit/errors/errors.test.js',
    'test/unit/management/management.test.js',
    'test/unit/writes/batch.test.js',
    'test/unit/cache/cache.test.js',
    'test/unit/cache/cache-refactor-guard.test.js',
    'test/unit/coverage/core-helpers.test.js',
    'test/unit/function-cache/function-cache.test.js',
    'test/unit/model/model-registry.test.js',
    'test/unit/lock/lock.test.js',
    'test/unit/transaction/transaction.test.js',
    'test/unit/pool/pool.test.js',
    'test/unit/runtime/runtime-compat.test.js',
    'test/unit/runtime/vector-search.test.js',
    'test/unit/runtime/model-relations-p0.test.js',
    'test/unit/runtime/write-path-policy.test.js',
    'test/unit/validation/server-matrix-contract.test.js',
    'test/unit/data-tasks/data-task-job-facade.test.js',
    'test/unit/data-tasks/data-task-job-branches.test.js',
    'test/unit/sync/sync.test.js',
    'test/unit/slow-query-log/slow-query-log.test.js',
    'test/unit/saga/saga.test.js',
    // Phase B: unit capability tests
    'test/unit/count-queue/count-queue.test.js',
    'test/unit/slow-query-log/slow-query-log-behavior.test.js',
    'test/unit/model/model-softdelete-versioning.test.js',
    'test/unit/function-cache/function-cache-behavior.test.js',
    'test/unit/saga/saga-behavior.test.js',
    // Coverage gap fill
    'test/unit/lock/lock-distributed.test.js',
    'test/unit/coverage/capability-wiring.test.js',
    'test/unit/pool/pool-stats.test.js',
    'test/unit/coverage/pure-functions.test.js',
    // Coverage gap fill — Phase E
    'test/unit/coverage/expression-branches.test.js',
    'test/unit/coverage/model-definition-branches.test.js',
    // Coverage gap fill — Phase F
    'test/unit/coverage/slow-query-log-branches.test.js',
    'test/unit/coverage/logger-branches.test.js',
    // Coverage gap fill — Phase G
    'test/unit/coverage/runtime-core-edge-cases.test.js',
    'test/unit/coverage/runtime-connect-cleanup.test.js',
    'test/unit/coverage/runtime-safety-helpers.test.js',
    // Coverage gap fill — Phase H
    'test/unit/coverage/errors-factory.test.js',
    'test/unit/coverage/slow-query-records-branches.test.js',
    // Coverage gap fill — Phase I
    'test/unit/coverage/extra-unit-branches.test.js',
    // Coverage gap fill — Phase J
    'test/unit/coverage/pool-selector-branches.test.js',
    'test/unit/coverage/saga-branches.test.js',
    'test/unit/coverage/distributed-cache-invalidator-branches.test.js',
    'test/unit/coverage/pool-manager-branches.test.js',
    'test/unit/coverage/slow-query-storage-unit.test.js',
    // Coverage gap fill — Phase K
    'test/unit/coverage/error-and-normalize-unit.test.js',
    'test/unit/coverage/lock-branches.test.js',
    // Coverage gap fill — Phase L
    'test/unit/coverage/slow-query-helpers-unit.test.js',
    'test/unit/coverage/capability-wiring-extra.test.js',
    // Coverage gap fill — Phase M
    'test/unit/coverage/sync-validation-branches.test.js',
    'test/unit/coverage/lock-manager-extra-branches.test.js',
    'test/unit/coverage/model-utils-write-utils-branches.test.js',
    'test/unit/coverage/model-instance-config-branches.test.js',
    'test/unit/coverage/model-utils-branches.test.js',
    'test/unit/coverage/objectid-converter-branches.test.js',
    // Coverage gap fill — Phase N
    'test/unit/coverage/public-api-extra-coverage.test.js',
    // Coverage gap fill — Phase O
    'test/unit/coverage/model-schema-validate-branches.test.js',
    'test/unit/model/model-schema-normalized-writes.test.js',
    // Coverage gap fill — Phase P
    'test/unit/coverage/lock-noop-and-extra.test.js',
    // Coverage gap fill — Phase Q
    'test/unit/coverage/error-factories-direct.test.js',
];

const INTEGRATION = [
    'test/integration/cache/cache.test.js',
    'test/integration/mongodb/connect.test.js',
    'test/integration/mongodb/queries.test.js',
    'test/integration/mongodb/management.test.js',
    'test/integration/mongodb/writes-batch.test.js',
    // Phase A: per-method integration tests
    'test/integration/mongodb/find.test.js',
    'test/integration/mongodb/find-one.test.js',
    'test/integration/mongodb/find-page.test.js',
    'test/integration/mongodb/aggregate.test.js',
    'test/integration/mongodb/chaining.test.js',
    'test/integration/mongodb/insert.test.js',
    'test/integration/mongodb/update.test.js',
    'test/integration/mongodb/delete.test.js',
    // Phase B: capability layer tests
    'test/integration/cache/cache-behavior.test.js',
    'test/integration/mongodb/update-pipeline.test.js',
    // 'test/integration/mongodb/chaining.test.js',    // Phase A pending
    // 'test/integration/mongodb/insert.test.js',      // Phase A pending
    // 'test/integration/mongodb/update.test.js',      // Phase A pending
    // 'test/integration/mongodb/delete.test.js',      // Phase A pending
    'test/integration/model/model-features.test.js',
    'test/integration/transaction/transaction.test.js',
    'test/integration/pool/pool.test.js',
    'test/integration/pool/pool-behavior.test.js',
    'test/integration/watch/watch-native.test.js',
    'test/integration/runtime/runtime-core-regression.test.js',
    'test/integration/data-tasks/data-task-job-facade.test.js',
    'test/integration/sync/sync.test.js',
    'test/integration/slow-query-log/slow-query-log.test.js',
    // Coverage gap fill — Phase C
    'test/integration/model/model-crud-extended.test.js',
    'test/integration/mongodb/management-complete.test.js',
    'test/integration/runtime/runtime-methods-extended.test.js',
    // Coverage gap fill — Phase D
    'test/integration/mongodb/find-page-advanced.test.js',
    // Coverage gap fill — Phase E
    'test/integration/mongodb/queries-branches.test.js',
    'test/integration/model/model-instance-branches.test.js',
    // Coverage gap fill — Phase F
    'test/integration/mongodb/queries-chain-extended.test.js',
    'test/integration/model/model-write-extended.test.js',
    // Coverage gap fill — Phase G
    'test/integration/mongodb/lock-advanced.test.js',
    'test/integration/model/model-advanced.test.js',
    // Coverage gap fill — Phase H
    'test/integration/mongodb/management-extra-branches.test.js',
    'test/integration/mongodb/queries-advanced-branches.test.js',
    // Coverage gap fill — Phase J
    'test/integration/mongodb/write-batch-branches.test.js',
    'test/integration/mongodb/collection-mgmt-validation.test.js',
    'test/integration/mongodb/objectid-converter-branches.test.js',
    'test/integration/model/model-config-and-utils-branches.test.js',
    // Coverage gap fill — Phase K
    'test/integration/runtime/runtime-core-branches.test.js',
    'test/integration/mongodb/management-branches.test.js',
    'test/integration/mongodb/find-page-branches2.test.js',
    'test/integration/mongodb/query-chain-branches.test.js',
    'test/integration/slow-query-log/slow-query-log-branches.test.js',
    'test/integration/model/model-write-branches.test.js',
    // Coverage gap fill — Phase L
    'test/integration/model/model-instance-extra-branches.test.js',
    'test/integration/runtime/runtime-core-extra-branches.test.js',
    // Coverage gap fill — Phase M
    'test/integration/mongodb/management-and-queries-extra.test.js',
    // Coverage gap fill — Phase N
    'test/integration/mongodb/find-page-n-branches.test.js',
    'test/integration/model/model-schema-and-hooks.test.js',
    'test/integration/mongodb/management-n-branches.test.js',
    'test/integration/mongodb/write-ops-extra-branches.test.js',
    'test/integration/mongodb/queries-n-branches.test.js',
    // Coverage gap fill — Phase O
    'test/integration/mongodb/write-batch-extra.test.js',
    // Coverage gap fill — Phase P
    'test/integration/mongodb/increment-and-config-branches.test.js',
    'test/integration/model/model-schema-validation-errors.test.js',
    'test/integration/runtime/runtime-core-branches3.test.js',
    'test/integration/mongodb/collection-advanced-ops.test.js',
    'test/integration/pool/pool-config-validation.test.js',
    'test/integration/model/populate-promise-coverage.test.js',
    'test/integration/model/model-v1-compatibility-repair.test.js',
    'test/integration/runtime/adapter-bridge-coverage.test.js',
    'test/integration/mongodb/write-batch-sleep.test.js',
    // Coverage gap fill — Phase R
    'test/integration/runtime/runtime-final-coverage.test.js',
];

// ─── Suite name registry ──────────────────────────────────────────────────────
// Maps logical suite names to their source file path(s).
// Add a new entry here whenever a new test file is created.

const SUITE_MAP = {
    // Groups
    smoke: SMOKE,
    compat: COMPAT,
    compatibility: COMPAT,
    unit: UNIT,
    integration: INTEGRATION,
    // Individual SMOKE
    'root-cjs': ['test/smoke/root-cjs.test.js'],
    'root-esm': ['test/smoke/root-esm.test.js'],
    'pack-artifacts': ['test/smoke/pack-artifacts.test.js'],
    'data-task-cli': ['test/smoke/data-task-cli.test.js'],
    // Individual COMPAT
    'exports': ['test/compatibility/exports/exports.test.js'],
    'matrix': ['test/compatibility/matrix.test.js'],
    // Individual UNIT
    'expression': ['test/unit/expression/expression.test.js', 'test/unit/expression/operators.test.js'],
    'errors': ['test/unit/errors/errors.test.js'],
    'cache-unit': ['test/unit/cache/cache.test.js'],
    'cache-guard': ['test/unit/cache/cache-refactor-guard.test.js'],
    'core-helpers': ['test/unit/coverage/core-helpers.test.js'],
    'function-cache': ['test/unit/function-cache/function-cache.test.js'],
    'model-registry': ['test/unit/model/model-registry.test.js'],
    'lock': ['test/unit/lock/lock.test.js'],
    'transaction': ['test/unit/transaction/transaction.test.js'],
    'pool': ['test/unit/pool/pool.test.js'],
    'runtime-compat': ['test/unit/runtime/runtime-compat.test.js'],
    'write-path-policy': ['test/unit/runtime/write-path-policy.test.js'],
    'server-matrix-contract': ['test/unit/validation/server-matrix-contract.test.js'],
    'data-tasks': [
        'test/unit/data-tasks/data-task-job-facade.test.js',
        'test/unit/data-tasks/data-task-job-branches.test.js',
    ],
    'sync': ['test/unit/sync/sync.test.js'],
    'slow-query-log': ['test/unit/slow-query-log/slow-query-log.test.js'],
    'saga': ['test/unit/saga/saga.test.js'],
    'count-queue': ['test/unit/count-queue/count-queue.test.js'],
    'slow-query-log-behavior': ['test/unit/slow-query-log/slow-query-log-behavior.test.js'],
    'model-softdelete': ['test/unit/model/model-softdelete-versioning.test.js'],
    'function-cache-behavior': ['test/unit/function-cache/function-cache-behavior.test.js'],
    'saga-behavior': ['test/unit/saga/saga-behavior.test.js'],
    'lock-distributed': ['test/unit/lock/lock-distributed.test.js'],
    'capability-wiring': ['test/unit/coverage/capability-wiring.test.js'],
    'pool-stats': ['test/unit/pool/pool-stats.test.js'],
    // Individual INTEGRATION
    'cache': ['test/integration/cache/cache.test.js'],
    'connect': ['test/integration/mongodb/connect.test.js'],
    'queries': ['test/integration/mongodb/queries.test.js'],
    'management': ['test/integration/mongodb/management.test.js'],
    'writes-batch': ['test/integration/mongodb/writes-batch.test.js'],
    // Phase A: per-method mongodb tests
    'find': ['test/integration/mongodb/find.test.js'],
    'find-one': ['test/integration/mongodb/find-one.test.js'],
    'find-page': ['test/integration/mongodb/find-page.test.js'],
    'aggregate': ['test/integration/mongodb/aggregate.test.js'],
    'chaining': ['test/integration/mongodb/chaining.test.js'],
    'insert': ['test/integration/mongodb/insert.test.js'],
    'update': ['test/integration/mongodb/update.test.js'],
    'delete': ['test/integration/mongodb/delete.test.js'],
    // Phase B: capability layer
    'cache-behavior': ['test/integration/cache/cache-behavior.test.js'],
    'update-pipeline': ['test/integration/mongodb/update-pipeline.test.js'],
    // 'chaining':      ['test/integration/mongodb/chaining.test.js'],
    // 'insert':        ['test/integration/mongodb/insert.test.js'],
    // 'update':        ['test/integration/mongodb/update.test.js'],
    // 'delete':        ['test/integration/mongodb/delete.test.js'],
    'model-features': ['test/integration/model/model-features.test.js'],
    'transaction-int': ['test/integration/transaction/transaction.test.js'],
    'pool-int': ['test/integration/pool/pool.test.js'],
    'pool-behavior': ['test/integration/pool/pool-behavior.test.js'],
    'watch-native': ['test/integration/watch/watch-native.test.js'],
    'runtime-regression': ['test/integration/runtime/runtime-core-regression.test.js'],
    'data-tasks-integration': [
        'test/integration/data-tasks/data-task-job-facade.test.js',
    ],
    'sync-int': ['test/integration/sync/sync.test.js'],
    'slow-query-log-int': ['test/integration/slow-query-log/slow-query-log.test.js'],
    // Coverage gap fill — Phase C
    'model-crud-extended': ['test/integration/model/model-crud-extended.test.js'],
    'management-complete': ['test/integration/mongodb/management-complete.test.js'],
    'runtime-methods-extended': ['test/integration/runtime/runtime-methods-extended.test.js'],
    'pure-functions': ['test/unit/coverage/pure-functions.test.js'],
    'find-page-advanced': ['test/integration/mongodb/find-page-advanced.test.js'],
    // Phase E
    'expression-branches': ['test/unit/coverage/expression-branches.test.js'],
    'model-definition-branches': ['test/unit/coverage/model-definition-branches.test.js'],
    'queries-branches': ['test/integration/mongodb/queries-branches.test.js'],
    'model-instance-branches': ['test/integration/model/model-instance-branches.test.js'],
    // Phase F
    'slow-query-log-branches': ['test/unit/coverage/slow-query-log-branches.test.js'],
    'logger-branches': ['test/unit/coverage/logger-branches.test.js'],
    'queries-chain-extended': ['test/integration/mongodb/queries-chain-extended.test.js'],
    'model-write-extended': ['test/integration/model/model-write-extended.test.js'],
    // Phase G
    'runtime-core-edge-cases': ['test/unit/coverage/runtime-core-edge-cases.test.js'],
    'runtime-connect-cleanup': ['test/unit/coverage/runtime-connect-cleanup.test.js'],
    'runtime-safety-helpers': ['test/unit/coverage/runtime-safety-helpers.test.js'],
    'lock-advanced': ['test/integration/mongodb/lock-advanced.test.js'],
    'model-advanced': ['test/integration/model/model-advanced.test.js'],
    // Phase H
    'errors-factory': ['test/unit/coverage/errors-factory.test.js'],
    'slow-query-records-branches': ['test/unit/coverage/slow-query-records-branches.test.js'],
    'management-extra-branches': ['test/integration/mongodb/management-extra-branches.test.js'],
    'queries-advanced-branches': ['test/integration/mongodb/queries-advanced-branches.test.js'],
    // Phase I
    'extra-unit-branches': ['test/unit/coverage/extra-unit-branches.test.js'],
    // Phase J
    'pool-selector-branches': ['test/unit/coverage/pool-selector-branches.test.js'],
    'saga-branches': ['test/unit/coverage/saga-branches.test.js'],
    'distributed-cache-invalidator-branches': ['test/unit/coverage/distributed-cache-invalidator-branches.test.js'],
    'pool-manager-branches': ['test/unit/coverage/pool-manager-branches.test.js'],
    'slow-query-storage-unit': ['test/unit/coverage/slow-query-storage-unit.test.js'],
    'write-batch-branches': ['test/integration/mongodb/write-batch-branches.test.js'],
    'collection-mgmt-validation': ['test/integration/mongodb/collection-mgmt-validation.test.js'],
    'objectid-converter-branches': ['test/integration/mongodb/objectid-converter-branches.test.js'],
    'model-config-and-utils-branches': ['test/integration/model/model-config-and-utils-branches.test.js'],
    // Phase K
    'error-and-normalize-unit': ['test/unit/coverage/error-and-normalize-unit.test.js'],
    'lock-branches': ['test/unit/coverage/lock-branches.test.js'],
    'runtime-core-branches': ['test/integration/runtime/runtime-core-branches.test.js'],
    'management-branches': ['test/integration/mongodb/management-branches.test.js'],
    'find-page-branches2': ['test/integration/mongodb/find-page-branches2.test.js'],
    'query-chain-branches': ['test/integration/mongodb/query-chain-branches.test.js'],
    'slow-query-log-branches-k': ['test/integration/slow-query-log/slow-query-log-branches.test.js'],
    'model-write-branches': ['test/integration/model/model-write-branches.test.js'],
    // Phase L
    'slow-query-helpers-unit': ['test/unit/coverage/slow-query-helpers-unit.test.js'],
    'capability-wiring-extra': ['test/unit/coverage/capability-wiring-extra.test.js'],
    'model-instance-extra-branches': ['test/integration/model/model-instance-extra-branches.test.js'],
    'runtime-core-extra-branches': ['test/integration/runtime/runtime-core-extra-branches.test.js'],
    // Phase M
    'sync-validation-branches': ['test/unit/coverage/sync-validation-branches.test.js'],
    'lock-manager-extra-branches': ['test/unit/coverage/lock-manager-extra-branches.test.js'],
    'model-utils-write-utils-branches': ['test/unit/coverage/model-utils-write-utils-branches.test.js'],
    'model-instance-config-branches': ['test/unit/coverage/model-instance-config-branches.test.js'],
    'model-utils-branches': ['test/unit/coverage/model-utils-branches.test.js'],
    'objectid-converter-unit-branches': ['test/unit/coverage/objectid-converter-branches.test.js'],
    'management-and-queries-extra': ['test/integration/mongodb/management-and-queries-extra.test.js'],
    // Phase N
    'public-api-extra-coverage': ['test/unit/coverage/public-api-extra-coverage.test.js'],
    'find-page-n-branches': ['test/integration/mongodb/find-page-n-branches.test.js'],
    'model-schema-and-hooks': ['test/integration/model/model-schema-and-hooks.test.js'],
    'management-n-branches': ['test/integration/mongodb/management-n-branches.test.js'],
    'write-ops-extra-branches': ['test/integration/mongodb/write-ops-extra-branches.test.js'],
    'queries-n-branches': ['test/integration/mongodb/queries-n-branches.test.js'],
    // Phase O
    'model-schema-validate-branches': ['test/unit/coverage/model-schema-validate-branches.test.js'],
    'model-schema-normalized-writes': ['test/unit/model/model-schema-normalized-writes.test.js'],
    'write-batch-extra': ['test/integration/mongodb/write-batch-extra.test.js'],
    // Phase P
    'lock-noop-and-extra': ['test/unit/coverage/lock-noop-and-extra.test.js'],
    'error-factories-direct': ['test/unit/coverage/error-factories-direct.test.js'],
    'increment-and-config-branches': ['test/integration/mongodb/increment-and-config-branches.test.js'],
    'model-schema-validation-errors': ['test/integration/model/model-schema-validation-errors.test.js'],
    'runtime-core-branches3': ['test/integration/runtime/runtime-core-branches3.test.js'],
    'collection-advanced-ops': ['test/integration/mongodb/collection-advanced-ops.test.js'],
    // Phase Q
    'pool-config-validation': ['test/integration/pool/pool-config-validation.test.js'],
    'populate-promise-coverage': ['test/integration/model/populate-promise-coverage.test.js'],
    'model-v1-compatibility-repair': ['test/integration/model/model-v1-compatibility-repair.test.js'],
    'adapter-bridge-coverage': ['test/integration/runtime/adapter-bridge-coverage.test.js'],
    'write-batch-sleep': ['test/integration/mongodb/write-batch-sleep.test.js'],
    // Phase R
    'runtime-final-coverage': ['test/integration/runtime/runtime-final-coverage.test.js'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function banner(label) {
    if (QUIET) return;
    const line = '─'.repeat(60);
    console.log(`\n${line}`);
    console.log(`  ${label}`);
    console.log(line);
}

function parseStats(output) {
    let pass = 0, fail = 0, skip = 0;
    for (const line of output.split('\n')) {
        const passMatch = line.match(/^(?:#|ℹ)\s+pass(?:ed)?\s+(\d+)/i);
        const failMatch = line.match(/^(?:#|ℹ)\s+fail(?:ed)?\s+(\d+)/i);
        const skipMatch = line.match(/^(?:#|ℹ)\s+skip(?:ped)?\s+(\d+)/i);
        if (passMatch) pass += parseInt(passMatch[1], 10);
        if (failMatch) fail += parseInt(failMatch[1], 10);
        if (skipMatch) skip += parseInt(skipMatch[1], 10);
    }
    return { pass, fail, skip };
}

function runCommand(label, args) {
    banner(label);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, {
            cwd: ROOT,
            stdio: ['inherit', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            if (!QUIET) process.stdout.write(text);
        });
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            if (!QUIET) process.stderr.write(text);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
    });
}

function resolveTestFile(file) {
    const testDistFile = path.join(TEST_DIST_ROOT, file).replace(/\.ts$/, '.js').replace(/\.js$/, '.js');
    const sourceTsFile = path.join(ROOT, file).replace(/\.js$/, '.ts');
    if (fs.existsSync(sourceTsFile) && fs.existsSync(testDistFile)) {
        return path.relative(ROOT, testDistFile);
    }
    return file;
}

async function runSuite(label, files) {
    const result = await runCommand(label, ['--test', '--test-concurrency=1', ...files.map(resolveTestFile)]);
    const stats = parseStats(result.stdout || '');
    return { ...stats, ...result };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const arg = process.argv[2];

    if (arg === '--list') {
        console.log('\nAvailable suite names:\n');
        for (const name of Object.keys(SUITE_MAP).sort()) {
            const files = SUITE_MAP[name];
            console.log(`  ${name.padEnd(22)} (${files.length} file${files.length !== 1 ? 's' : ''})`);
        }
        console.log();
        return;
    }

    if (arg) {
        const files = SUITE_MAP[arg];
        if (!files) {
            console.error(`\n❌ Unknown suite: "${arg}"`);
            console.error('Run "node test/run-tests.cjs --list" to see available suites.\n');
            process.exit(1);
        }
        const stats = await runSuite(`Suite: ${arg}`, files);
        const total = stats.pass + stats.fail + stats.skip;
        const line = '─'.repeat(65);
        console.log(`\n${'═'.repeat(65)}`);
        console.log(`  Suite "${arg}" — Summary`);
        console.log(line);
        console.log(`  ✅  Passed :  ${String(stats.pass).padStart(5)}`);
        console.log(`  ❌  Failed :  ${String(stats.fail).padStart(5)}`);
        console.log(`  ⏭   Skipped:  ${String(stats.skip).padStart(5)}`);
        console.log(line);
        console.log(`  📊  Total  :  ${String(total).padStart(5)}`);
        console.log(`${'═'.repeat(65)}\n`);
        process.exit(stats.exitCode !== 0 || stats.fail > 0 ? 1 : 0);
        return;
    }

    // Full run: all groups in order
    const groups = [
        { label: 'Smoke Tests', files: SMOKE },
        { label: 'Compatibility Tests', files: COMPAT },
        { label: 'Unit Tests', files: UNIT },
        { label: 'Integration Tests', files: INTEGRATION },
    ];

    let totalPass = 0, totalFail = 0, totalSkip = 0, anyFailed = false;

    for (const { label, files } of groups) {
        const stats = await runSuite(label, files);
        totalPass += stats.pass;
        totalFail += stats.fail;
        totalSkip += stats.skip;
        if (stats.exitCode !== 0 || stats.fail > 0) {
            anyFailed = true;
            if (QUIET) {
                console.error(`\n[tests] ${label} failed; replaying captured output:\n`);
                if (stats.stdout) process.stdout.write(stats.stdout);
                if (stats.stderr) process.stderr.write(stats.stderr);
            }
        }
    }

    const total = totalPass + totalFail + totalSkip;
    const line = '─'.repeat(65);

    console.log(`\n${'═'.repeat(65)}`);
    console.log('  monSQLize Test Suite — Final Summary');
    console.log(line);
    console.log(`  ✅  Passed :  ${String(totalPass).padStart(5)}`);
    console.log(`  ❌  Failed :  ${String(totalFail).padStart(5)}`);
    console.log(`  ⏭   Skipped:  ${String(totalSkip).padStart(5)}`);
    console.log(line);
    console.log(`  📊  Total  :  ${String(total).padStart(5)}`);
    console.log(`${'═'.repeat(65)}\n`);

    if (anyFailed) {
        console.error('❌ One or more test suites FAILED.\n');
        process.exit(1);
    }
    console.log('✅ All test suites passed.\n');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
