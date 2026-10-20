const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { configureMemoryServerEnv } = require('./memory-server-policy.cjs');
const { resolveLocalRehearsalDependencyTarballs } = require('./local-rehearsal-dependencies.cjs');
const {
    INTEGRATION_TEST_CONCURRENCY,
    REQUIRED_MONGODB_SERVER_VERSIONS,
    selectAdditionalVoltaNodeMajors,
    summarizeMatrixExecution,
} = require('./server-matrix-config.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const baseDriverRange = packageJson.dependencies.mongodb;
const currentDriverVersion = readInstalledDriverVersion();
const localRehearsalTarballs = resolveLocalRehearsalDependencyTarballs(projectRoot, ['schema-dsl']);
const testDistRoot = path.join('.generated', 'test-dist');
const memoryServerPolicy = configureMemoryServerEnv();
const memoryServerEnv = {
    MONGOMS_DOWNLOAD_DIR: memoryServerPolicy.downloadDir,
    MONGOMS_PREFER_GLOBAL_PATH: 'false',
    MONGOMS_RUNTIME_DOWNLOAD: 'true',
    MONSQLIZE_MEMORY_SERVER_CACHE_DIR: memoryServerPolicy.cacheRoot,
    MONSQLIZE_MEMORY_SERVER_DB_DIR: memoryServerPolicy.dbRoot,
};
const mongoVersions = REQUIRED_MONGODB_SERVER_VERSIONS;
const integrationSourceSuites = [
    'test/integration/mongodb/connect.test.js',
    'test/integration/mongodb/queries.test.js',
    'test/integration/mongodb/find-page.test.js',
    'test/integration/mongodb/find-page-advanced.test.js',
    'test/integration/mongodb/aggregate.test.js',
    'test/integration/mongodb/management.test.js',
    'test/integration/mongodb/writes-batch.test.js',
    'test/integration/model/model-features.test.js',
    'test/integration/model/model-schema-and-hooks.test.js',
    'test/integration/model/model-v1-compatibility-repair.test.js',
    'test/integration/pool/pool.test.js',
    'test/integration/slow-query-log/slow-query-log.test.js',
    'test/integration/transaction/transaction.test.js',
    'test/integration/runtime/review-regressions.test.js',
    'test/integration/data-tasks/data-task-job-facade.test.js',
    'test/integration/sync/sync.test.js',
];
const integrationSuites = integrationSourceSuites.map((suite) => path.join(testDistRoot, suite));
const compatibilitySuites = [
    'test/compatibility/exports/exports.test.js',
    'test/compatibility/matrix.test.js',
].map((suite) => path.join(testDistRoot, suite));

function commandExists(command) {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookupCommand, [command], { stdio: 'pipe', encoding: 'utf8' });
    return result.status === 0;
}

function run(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: projectRoot,
        stdio: options.capture ? 'pipe' : 'inherit',
        encoding: 'utf8',
        shell: options.shell ?? (process.platform === 'win32'),
        env: {
            ...process.env,
            ...memoryServerEnv,
            ...(options.env || {}),
        },
    });
}

function runNodeScenario(scenario, args, options = {}) {
    if (scenario.type === 'current') {
        return run('node', args, options);
    }
    return run('volta', ['run', '--node', scenario.major, 'node', ...args], options);
}

function runNpmScenario(scenario, npmArgs, options = {}) {
    if (scenario.type === 'current') {
        return run('npm', npmArgs, options);
    }
    return run('volta', ['run', '--node', scenario.major, 'npm', ...npmArgs], options);
}

function readInstalledDriverVersion() {
    return JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'node_modules', 'mongodb', 'package.json'), 'utf8'),
    ).version;
}

function installDriver(range) {
    return run('npm', ['install', ...localRehearsalTarballs, `mongodb@${range}`, '--no-save', '--package-lock=false']);
}

function restoreBaseDriver() {
    return installDriver(baseDriverRange);
}

function probeMongoVersion(scenario, version) {
    const result = runNodeScenario(
        scenario,
        ['scripts/validation/probe-memory-server-version.cjs', version],
        { capture: true, shell: false },
    );
    if (result.status === 0) {
        return { supported: true };
    }

    const errorText = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    const unsupported = /KnownVersionIncompatibilityError|Unsupported Architecture|not available for|does not provide binaries|cannot download/i.test(errorText);

    return {
        supported: false,
        unsupported,
        error: errorText,
    };
}

function fail(message) {
    console.error(`[memory-server-matrix] ${message}`);
    process.exit(1);
}

const currentNodeMajor = Number(process.versions.node.split('.')[0]);
const nodeScenarios = [
    { label: `Node ${process.version} (current environment)`, type: 'current', major: currentNodeMajor },
];

for (const major of selectAdditionalVoltaNodeMajors(currentNodeMajor, commandExists('volta'))) {
    nodeScenarios.push({ label: `Node ${major}.x (Volta)`, type: 'volta', major });
}

const driverScenarios = [
    {
        label: `Driver ${currentDriverVersion} (current dependency)`,
        range: null,
        setup() {
            return { skipped: false, version: readInstalledDriverVersion() };
        },
        cleanup() {
            return true;
        },
    },
    {
        label: 'Driver 7.x (temporary install)',
        range: '7',
        setup() {
            const installResult = installDriver('7');
            if (installResult.status !== 0) {
                return {
                    skipped: true,
                    reason: 'temporary mongodb@7 install failed',
                };
            }
            return { skipped: false, version: readInstalledDriverVersion() };
        },
        cleanup() {
            const restoreResult = restoreBaseDriver();
            if (restoreResult.status !== 0) {
                fail(`failed to restore base dependency ${baseDriverRange}`);
            }
            return true;
        },
    },
];

const summary = [];

for (const driverScenario of driverScenarios) {
    console.log(`\n[memory-server-matrix] === ${driverScenario.label} ===`);
    const driverSetup = driverScenario.setup();
    if (driverSetup.skipped) {
        summary.push({
            driver: driverScenario.label,
            status: 'unavailable',
            reason: driverSetup.reason,
            results: [],
        });
        continue;
    }

    const driverVersion = driverSetup.version;
    const driverSummary = {
        driver: `${driverScenario.label} -> ${driverVersion}`,
        status: 'pending',
        results: [],
    };

    for (const nodeScenario of nodeScenarios) {
        console.log(`[memory-server-matrix] -> ${nodeScenario.label}`);
        const buildResult = runNpmScenario(nodeScenario, ['run', 'build']);
        if (buildResult.status !== 0) {
            driverScenario.cleanup();
            fail(`${driverScenario.label} build failed under ${nodeScenario.label}`);
        }

        const buildTestsResult = runNpmScenario(nodeScenario, ['run', 'build:tests']);
        if (buildTestsResult.status !== 0) {
            driverScenario.cleanup();
            fail(`${driverScenario.label} test build failed under ${nodeScenario.label}`);
        }

        const compatibilityResult = runNodeScenario(nodeScenario, ['--test', ...compatibilitySuites]);
        if (compatibilityResult.status !== 0) {
            driverScenario.cleanup();
            fail(`${driverScenario.label} compatibility tests failed under ${nodeScenario.label}`);
        }

        for (const mongoVersion of mongoVersions) {
            const probe = probeMongoVersion(nodeScenario, mongoVersion.version);
            if (!probe.supported) {
                driverSummary.results.push({
                    node: nodeScenario.label,
                    mongo: mongoVersion.label,
                    status: 'unavailable',
                    reason: probe.unsupported ? 'memory-server does not support this required version/platform combination' : 'required memory-server probe failed',
                    error: probe.error,
                });
                continue;
            }

            console.log(`[memory-server-matrix]    verifying ${nodeScenario.label} / ${driverVersion} / ${mongoVersion.label}`);
            const integrationResult = runNodeScenario(nodeScenario, [
                '--test',
                `--test-concurrency=${INTEGRATION_TEST_CONCURRENCY}`,
                ...integrationSuites,
            ], {
                env: {
                    MONSQLIZE_MATRIX_MODE: '1',
                    MONSQLIZE_MEMORY_MONGO_BINARY_VERSION: mongoVersion.version,
                    MONSQLIZE_REPLSET_BINARY_VERSION: mongoVersion.version,
                },
            });

            if (integrationResult.status !== 0) {
                driverScenario.cleanup();
                fail(`${driverScenario.label} integration tests failed under ${nodeScenario.label} + ${mongoVersion.label}`);
            }

            driverSummary.results.push({
                node: nodeScenario.label,
                mongo: mongoVersion.label,
                status: 'verified',
            });
        }
    }

    const expectedResults = nodeScenarios.length * mongoVersions.length;
    driverSummary.status = driverSummary.results.length === expectedResults
        && driverSummary.results.every((result) => result.status === 'verified')
        ? 'verified'
        : 'failed';
    driverScenario.cleanup();
    summary.push(driverSummary);
}

if (readInstalledDriverVersion() !== currentDriverVersion) {
    const restoreResult = restoreBaseDriver();
    if (restoreResult.status !== 0) {
        fail(`final driver restore to ${baseDriverRange} failed`);
    }
}

const verdict = summarizeMatrixExecution(
    summary,
    driverScenarios.length,
    nodeScenarios.length * mongoVersions.length,
);
const finalSummary = {
    checkedAt: new Date().toISOString(),
    node: process.version,
    baseDriver: currentDriverVersion,
    summary,
    verdict,
};

console.log('\n[memory-server-matrix] summary:');
console.log(JSON.stringify(finalSummary, null, 2));

if (!verdict.ready) {
    process.exitCode = 1;
}
