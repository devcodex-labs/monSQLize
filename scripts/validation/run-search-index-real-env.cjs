'use strict';

/**
 * Opt-in real-environment check for the Search index lifecycle API (v3.4.0).
 *
 * Runs only when MONSQLIZE_ATLAS_LOCAL_URI is set (e.g. mongodb/mongodb-atlas-local);
 * otherwise prints a skip notice and exits 0. Not part of npm test / verify.
 *
 * Env:
 *   MONSQLIZE_ATLAS_LOCAL_URI     connection string (required to run)
 *   SEARCH_INDEX_REAL_REPS        latency repetitions per collection size (default 20)
 *   SEARCH_INDEX_REAL_SIZES       comma-separated document counts (default "1000,50000")
 *   SEARCH_INDEX_REAL_DIMS        vector dimensions (default 64)
 *   SEARCH_INDEX_REAL_TIMEOUT_MS  per-wait timeout (default 600000)
 *   SEARCH_INDEX_REAL_OUT         report path (default .generated/search-index-real.json)
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const uri = process.env.MONSQLIZE_ATLAS_LOCAL_URI;
if (!uri) {
    console.log('[search-index-real] SKIPPED: set MONSQLIZE_ATLAS_LOCAL_URI to run against mongodb-atlas-local / Atlas.');
    process.exit(0);
}

const { MongoClient } = require('mongodb');
const MonSQLize = require(path.join(root, 'dist', 'cjs', 'index.cjs'));

function isKnownVectorUpdateLimitation(error) {
    const cause = error && error.cause;
    return Boolean(error && error.code === 'MONGODB_ERROR' && cause && cause.code === 2 && /"mappings" is required/.test(String(cause.message || '')));
}

const REPS = Number(process.env.SEARCH_INDEX_REAL_REPS || 20);
const SIZES = String(process.env.SEARCH_INDEX_REAL_SIZES || '1000,50000').split(',').map((v) => Number(v.trim())).filter((v) => v > 0);
const DIMS = Number(process.env.SEARCH_INDEX_REAL_DIMS || 64);
const TIMEOUT_MS = Number(process.env.SEARCH_INDEX_REAL_TIMEOUT_MS || 600000);
const OUT = process.env.SEARCH_INDEX_REAL_OUT || path.join(root, '.generated', 'search-index-real.json');
const DB = `msq_si_real_${Date.now()}`;
const POLL_MS = 50;

const report = { startedAt: new Date().toISOString(), config: { reps: REPS, sizes: SIZES, dims: DIMS, timeoutMs: TIMEOUT_MS, db: DB }, environment: {}, steps: [], openItems: {}, latency: {}, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000000n);
const vectorDef = (extra = []) => ({ fields: [{ type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'cosine' }, ...extra] });
const searchDef = { mappings: { dynamic: true } };
const errInfo = (e) => (e ? { code: e.code, codeName: e.codeName, message: String(e.message).slice(0, 300), causeCode: e.cause && e.cause.code, causeCodeName: e.cause && e.cause.codeName } : null);

function step(name, ok, data = {}) {
    report.steps.push({ name, ok, ...data });
    console.log(`[search-index-real] ${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}`);
}
async function attempt(fn) { try { return { ok: true, value: await fn() }; } catch (error) { return { ok: false, error }; } }
function percentile(values, p) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
const stats = (values) => ({ n: values.length, p50: percentile(values, 50), p99: percentile(values, 99), max: values.length ? Math.max(...values) : null, min: values.length ? Math.min(...values) : null });

async function seed(col, count) {
    const batch = 1000;
    for (let i = 0; i < count; i += batch) {
        const docs = [];
        for (let j = i; j < Math.min(count, i + batch); j++) {
            docs.push({ i: j, tenantId: `t${j % 10}`, text: `document ${j}`, embedding: Array.from({ length: DIMS }, (_, k) => Math.sin(j * 31 + k)) });
        }
        await col.insertMany(docs, { ordered: false });
    }
}

async function main() {
    let client;
    let runtime;
    try {
        client = await MongoClient.connect(uri);
        runtime = new MonSQLize({ type: 'mongodb', databaseName: DB, config: { uri } });
        await runtime.connect();
        const build = await client.db('admin').command({ buildInfo: 1 });
        report.environment = { serverVersion: build.version, gitVersion: build.gitVersion, modules: build.modules, node: process.version, driver: require('mongodb/package.json').version };
        console.log(`[search-index-real] server ${build.version}`);

        const rawDb = client.db(DB);
        await seed(rawDb.collection('small'), Math.min(SIZES[0] || 1000, 1000));
        const docs = runtime.collection('small');
        const rawSmall = rawDb.collection('small');

        // ---- vectorSearch lifecycle ----
        const created = await docs.createSearchIndex({ name: 'vec_idx', type: 'vectorSearch', definition: vectorDef() });
        step('vector.create', created.action === 'created', { result: created });
        const q1 = await docs.waitForSearchIndex('vec_idx', { until: 'queryable', timeoutMs: TIMEOUT_MS });
        step('vector.wait-queryable', q1.queryable === true, { status: q1.status, version: q1.latestDefinitionVersion && q1.latestDefinitionVersion.version, typeSource: q1.typeSource });
        const hits = await attempt(() => docs.vectorSearch({ index: 'vec_idx', path: 'embedding', queryVector: Array.from({ length: DIMS }, (_, k) => Math.sin(k)), limit: 3, numCandidates: 30 }));
        step('vector.query', hits.ok && Array.isArray(hits.value) && hits.value.length > 0, hits.ok ? { hits: hits.value.length } : { error: errInfo(hits.error) });

        const v1 = q1.latestDefinitionVersion && q1.latestDefinitionVersion.version;
        const vecUpdate = await attempt(() => docs.updateSearchIndex('vec_idx', vectorDef([{ type: 'filter', path: 'tenantId' }])));
        // DEC-A06-2: some deployments (observed: atlas-local mongod 8.3.13) reject vectorSearch updates with
        // BadValue(2) '"mappings" is required'. Only that exact rejection is a known environment limitation.
        const vecUpdateKnownLimitation = !vecUpdate.ok && isKnownVectorUpdateLimitation(vecUpdate.error);
        if (!vecUpdate.ok && !vecUpdateKnownLimitation) throw vecUpdate.error;
        if (vecUpdateKnownLimitation) {
            report.knownEnvironmentLimitations = report.knownEnvironmentLimitations || [];
            report.knownEnvironmentLimitations.push({ step: 'vector.update', status: 'known-environment-limitation', error: errInfo(vecUpdate.error), workaround: 'drop the index, wait for dropped, create it again' });
            console.log(`[search-index-real] KNOWN-LIMITATION vector.update ${JSON.stringify(errInfo(vecUpdate.error))}`);
        }
        const afterUpdateStatuses = [];
        let afterUpdate;
        const deadline = now() + TIMEOUT_MS;
        while (vecUpdate.ok && now() < deadline) {
            afterUpdate = await docs.getSearchIndex('vec_idx');
            afterUpdateStatuses.push(`${afterUpdate.status}/${afterUpdate.queryable}`);
            if (afterUpdate.latestDefinitionVersion && afterUpdate.latestDefinitionVersion.version !== v1 && afterUpdate.status === 'READY') break;
            await sleep(500);
        }
        const v2 = afterUpdate && afterUpdate.latestDefinitionVersion && afterUpdate.latestDefinitionVersion.version;
        if (vecUpdate.ok) step('vector.update', v2 !== undefined && v2 !== v1, { versionBefore: v1, versionAfter: v2, queryableDuringRebuild: afterUpdateStatuses.every((s) => s.endsWith('true')), statuses: [...new Set(afterUpdateStatuses)] });

        // OA1: same-definition update
        const before = await docs.getSearchIndex('vec_idx');
        const same = await attempt(() => docs.updateSearchIndex('vec_idx', before.latestDefinition));
        const sameStatuses = [];
        let sameAfter = before;
        const sameDeadline = now() + Math.min(TIMEOUT_MS, 120000);
        while (same.ok && now() < sameDeadline) {
            sameAfter = await docs.getSearchIndex('vec_idx');
            sameStatuses.push(sameAfter.status);
            if (sameAfter.latestDefinitionVersion && before.latestDefinitionVersion && sameAfter.latestDefinitionVersion.version !== before.latestDefinitionVersion.version && sameAfter.status === 'READY') break;
            await sleep(500);
        }
        const versionChanged = Boolean(sameAfter.latestDefinitionVersion && before.latestDefinitionVersion && sameAfter.latestDefinitionVersion.version !== before.latestDefinitionVersion.version);
        report.openItems.OA1 = {
            question: 'updateSearchIndex with an identical definition: accepted? rebuild triggered? latestDefinitionVersion changes?',
            accepted: same.ok,
            error: same.ok ? null : errInfo(same.error),
            rejectedBy: same.ok ? null : (same.error && same.error.cause ? 'server' : (String(same.error && same.error.code).startsWith('INVALID_SEARCH_INDEX') ? 'local-validation' : 'server')),
            versionBefore: before.latestDefinitionVersion && before.latestDefinitionVersion.version,
            versionAfter: sameAfter.latestDefinitionVersion && sameAfter.latestDefinitionVersion.version,
            latestDefinitionVersionChanged: versionChanged,
            rebuildObserved: versionChanged || sameStatuses.some((s) => s !== 'READY'),
            statusesObserved: [...new Set(sameStatuses)],
            observationWindowMs: Math.min(TIMEOUT_MS, 120000),
            conclusion: !same.ok ? `REJECTED (${same.error && same.error.cause ? 'server' : 'see error'})` : versionChanged ? 'ACCEPTED; new definition version (rebuild)' : 'ACCEPTED; no version change observed (no rebuild)',
        };
        console.log(`[search-index-real] OA1 ${report.openItems.OA1.conclusion}`);

        // ---- full-text search lifecycle ----
        const sCreated = await docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: searchDef });
        step('search.create', sCreated.created === true);
        const sListed = await docs.listSearchIndexes({ type: 'search' });
        step('search.list-filter', sListed.some((i) => i.name === 'text_idx') && !sListed.some((i) => i.name === 'vec_idx') && sListed.every((i) => i.type === 'search'), { names: sListed.map((i) => i.name) });
        const sInfo = await docs.waitForSearchIndex('text_idx', { timeoutMs: TIMEOUT_MS });
        step('search.wait-queryable', sInfo.queryable === true, { typeSource: sInfo.typeSource, type: sInfo.type });

        // OA2: top-level type in raw list output
        const rawList = await rawSmall.listSearchIndexes().toArray();
        const byName = Object.fromEntries(rawList.map((d) => [d.name, d]));
        report.openItems.OA2 = {
            question: 'Does listSearchIndexes return a top-level type field?',
            vectorSearch: { topLevelTypePresent: Object.prototype.hasOwnProperty.call(byName.vec_idx || {}, 'type'), value: (byName.vec_idx || {}).type, monsqlizeTypeSource: (await docs.getSearchIndex('vec_idx')).typeSource },
            search: { topLevelTypePresent: Object.prototype.hasOwnProperty.call(byName.text_idx || {}, 'type'), value: (byName.text_idx || {}).type, monsqlizeTypeSource: sInfo.typeSource },
            rawKeys: rawList.map((d) => ({ name: d.name, keys: Object.keys(d) })),
        };
        console.log(`[search-index-real] OA2 ${JSON.stringify({ vectorSearch: report.openItems.OA2.vectorSearch, search: report.openItems.OA2.search })}`);

        // ---- duplicates / missing / error mapping (OA5) ----
        const dupErr = await attempt(() => docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: searchDef }));
        step('dup.error', !dupErr.ok && dupErr.error.code === 'SEARCH_INDEX_EXISTS');
        const dupSkip = await docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: searchDef }, { ifExists: 'skip' });
        step('dup.skip', dupSkip.action === 'skipped');
        const dupUpd = await docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: { mappings: { dynamic: false, fields: { text: { type: 'string' } } } } }, { ifExists: 'update' });
        step('dup.update', dupUpd.action === 'updated');
        const missDrop = await attempt(() => docs.dropSearchIndex('nope_idx'));
        step('missing.drop', !missDrop.ok && missDrop.error.code === 'SEARCH_INDEX_NOT_FOUND');
        await docs.dropSearchIndex('nope_idx', { ignoreMissing: true });
        step('missing.drop-ignore', true);
        const missGet = await docs.getSearchIndex('nope_idx');
        step('missing.get', missGet.status === 'DOES_NOT_EXIST');

        const raw = {};
        raw.duplicateCreate = errInfo((await attempt(() => rawSmall.createSearchIndex({ name: 'text_idx', type: 'search', definition: searchDef }))).error);
        raw.dropMissing = errInfo((await attempt(() => rawSmall.dropSearchIndex('nope_idx'))).error);
        raw.updateMissing = errInfo((await attempt(() => rawSmall.updateSearchIndex('nope_idx', searchDef))).error);
        raw.invalidVectorDefinition = errInfo((await attempt(() => rawSmall.createSearchIndex({ name: 'bad_idx', type: 'vectorSearch', definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: -1, similarity: 'cosine' }] } }))).error);
        raw.invalidSearchDefinition = errInfo((await attempt(() => rawSmall.createSearchIndex({ name: 'bad2_idx', type: 'search', definition: { mappings: { dynamic: 'yes' } } }))).error);
        const viaApi = await attempt(() => docs.createSearchIndex({ name: 'bad2_idx', type: 'search', definition: { mappings: { dynamic: 'yes' } } }));
        report.openItems.OA5 = { question: 'Server error codes per failure', raw, invalidSearchDefinitionViaApi: viaApi.ok ? 'ACCEPTED' : errInfo(viaApi.error) };
        console.log(`[search-index-real] OA5 ${JSON.stringify(report.openItems.OA5)}`);
        if (viaApi.ok) await docs.dropSearchIndex('bad2_idx', { ignoreMissing: true });

        // OA9: create same name while DELETING
        await docs.dropSearchIndex('text_idx');
        const deleting = await docs.getSearchIndex('text_idx');
        const recreate = await attempt(() => rawSmall.createSearchIndex({ name: 'text_idx', type: 'search', definition: searchDef }));
        report.openItems.OA9 = { statusRightAfterDrop: deleting.status, rawCreateDuringDeleting: recreate.ok ? 'ACCEPTED' : errInfo(recreate.error) };
        console.log(`[search-index-real] OA9 ${JSON.stringify(report.openItems.OA9)}`);
        await docs.dropSearchIndex('text_idx', { ignoreMissing: true });
        await docs.waitForSearchIndex('text_idx', { until: 'dropped', timeoutMs: TIMEOUT_MS });
        step('search.drop-wait-dropped', true);

        // OA10: list on missing collection
        const missingColl = await attempt(() => runtime.collection('no_such_collection').listSearchIndexes());
        const missingCollRaw = await attempt(() => rawDb.collection('no_such_collection').listSearchIndexes().toArray());
        report.openItems.OA10 = { monsqlize: missingColl.ok ? { result: missingColl.value } : errInfo(missingColl.error), raw: missingCollRaw.ok ? { result: missingCollRaw.value } : errInfo(missingCollRaw.error) };
        console.log(`[search-index-real] OA10 ${JSON.stringify(report.openItems.OA10)}`);

        await docs.dropSearchIndex('vec_idx');
        const dropped = await docs.waitForSearchIndex('vec_idx', { until: 'dropped', timeoutMs: TIMEOUT_MS });
        step('vector.drop-wait-dropped', dropped.status === 'DOES_NOT_EXIST');

        // ---- OA3: visibility latency ----
        for (const size of SIZES) {
            const name = `lat_${size}`;
            const col = rawDb.collection(name);
            const seedStart = now();
            await seed(col, size);
            const acc = runtime.collection(name);
            const visible = [];
            const queryable = [];
            const failures = [];
            console.log(`[search-index-real] latency size=${size} seeded in ${now() - seedStart}ms, reps=${REPS}`);
            for (let r = 0; r < REPS; r++) {
                const idx = `lat_idx_${r}`;
                await acc.createSearchIndex({ name: idx, type: 'vectorSearch', definition: vectorDef() });
                const t0 = now();
                let tVisible = null;
                let tQueryable = null;
                while (now() - t0 < TIMEOUT_MS) {
                    const info = await acc.getSearchIndex(idx);
                    if (tVisible === null && info.status !== 'DOES_NOT_EXIST') tVisible = now() - t0;
                    if (info.queryable) { tQueryable = now() - t0; break; }
                    if (info.status === 'FAILED') break;
                    await sleep(POLL_MS);
                }
                // Failed or timed-out samples are right-censored at TIMEOUT_MS so they raise max/P99 instead of vanishing.
                visible.push(tVisible !== null ? tVisible : TIMEOUT_MS);
                queryable.push(tQueryable !== null ? tQueryable : TIMEOUT_MS);
                if (tVisible === null || tQueryable === null) failures.push({ rep: r, tVisible, tQueryable });
                await acc.dropSearchIndex(idx, { ignoreMissing: true });
                await acc.waitForSearchIndex(idx, { until: 'dropped', timeoutMs: TIMEOUT_MS });
            }
            report.latency[size] = { docs: size, dims: DIMS, approxDocBytes: 60 + DIMS * 8, pollMs: POLL_MS, visibleMs: stats(visible), queryableMs: stats(queryable), failures };
            console.log(`[search-index-real] OA3 size=${size} visible=${JSON.stringify(report.latency[size].visibleMs)} queryable=${JSON.stringify(report.latency[size].queryableMs)}`);
        }
        const latencies = Object.values(report.latency);
        const samples = latencies.reduce((n, l) => n + l.visibleMs.n, 0);
        const anyFailures = latencies.some((l) => l.failures.length > 0);
        const allVisibleMax = samples > 0 ? Math.max(...latencies.map((l) => l.visibleMs.max)) : null;
        report.openItems.OA3 = {
            samples,
            anyFailures,
            question: 'Delay from createSearchIndex returning until listed / queryable; is 30s grace adequate?',
            maxVisibleMs: allVisibleMax,
            currentGraceMs: 30000,
            graceAdequate: samples > 0 && !anyFailures && allVisibleMax < 30000,
            suggestedGraceMs: samples > 0 ? Math.max(5000, Math.ceil((allVisibleMax * 3) / 1000) * 1000) : null,
        };
        console.log(`[search-index-real] OA3 ${JSON.stringify(report.openItems.OA3)}`);
    } catch (error) {
        report.errors.push(errInfo(error));
        console.error('[search-index-real] ERROR', error);
    } finally {
        if (client) {
            await client.db(DB).dropDatabase().catch((error) => report.errors.push({ cleanup: 'dropDatabase', ...errInfo(error) }));
        }
        if (runtime) await runtime.close().catch((error) => report.errors.push({ cleanup: 'runtime.close', ...errInfo(error) }));
        if (client) await client.close().catch((error) => report.errors.push({ cleanup: 'client.close', ...errInfo(error) }));
        report.finishedAt = new Date().toISOString();
        if (report.openItems.OA3 && report.openItems.OA3.anyFailures) report.steps.push({ name: 'latency.all-reps-queryable', ok: false });
        report.summary = { pass: report.steps.filter((s) => s.ok).length, fail: report.steps.filter((s) => !s.ok).length, errors: report.errors.length };
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`[search-index-real] summary ${JSON.stringify(report.summary)} report=${OUT}`);
        process.exitCode = report.summary.fail > 0 || report.errors.length > 0 ? 1 : 0;
    }
}

main();
