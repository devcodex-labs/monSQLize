'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function checkPackage() {
    const [directory, incompatibleBinding] = process.argv.slice(2);
    assert.ok(directory, 'provide the root of an independent package install');
    const load = createRequire(path.resolve(directory, 'package.json'));
    const packageEntry = load.resolve('@monsqlize/sqlite-native');
    const { openFoundation } = load('@monsqlize/sqlite-native');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
        import foundation from '@monsqlize/sqlite-native';
        const db = await foundation.openFoundation({ memory: true });
        await db.close();
    `], { cwd: path.resolve(directory), timeout: 8000 });
    const target = `${process.platform}-${process.arch}`;
    const assets = path.join(path.dirname(packageEntry), 'prebuild', target);
    const extensionNames = { win32: 'probe.dll', linux: 'probe.so', darwin: 'probe.dylib' };
    const extension = path.join(assets, extensionNames[process.platform]);
    const bindingPath = path.join(assets, 'binding.node');
    const shell = path.join(assets, process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3');
    const build = JSON.parse(fs.readFileSync(path.join(assets, 'build.json'), 'utf8'));
    const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    assert.equal(build.target, target);
    assert.equal(digest(bindingPath), build.artifacts.binding);
    assert.equal(digest(extension), build.artifacts.extension);
    assert.equal(digest(shell), build.artifacts.shell);
    const native = require(bindingPath);
    assert.ok(build.sqliteRuntimeOptions.every(option => native.compileOptions.includes(option)));
    assert.match(build.engineBuildHash, /^[a-f0-9]{64}$/);
    assert.equal(native.engineBuildHash, build.engineBuildHash);

    function runShell(filename, sql) {
        const flags = filename === ':memory:' ? [] : ['-readonly'];
        return execFileSync(shell, ['-batch', '-bail', '-init', os.devNull, '-noheader', ...flags, filename, sql], {
            cwd: path.resolve(directory), encoding: 'utf8', timeout: 8000,
        }).trim();
    }

    assert.equal(runShell(':memory:', 'SELECT monsqlize_engine_build_hash(), sqlite_source_id()'),
        `${native.engineBuildHash}|${native.sourceId}`);

    assert.throws(() => native.execute({}, 'SELECT 1', [], 1n), /invalid SQLite native connection/);
    await assert.rejects(openFoundation({ memory: true, filename: 'file.db' }), /invalid SQLite foundation open/);
    const root = fs.realpathSync(os.tmpdir());
    const scratch = fs.mkdtempSync(path.join(root, 'monsqlize-w03-package-'));
    const file = path.join(scratch, '基础 🌿.sqlite');
    let writer;
    let reader;
    let control;
    let pending;
    let controller;
    const longInsert = `
        INSERT INTO cancelled_rows
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 5000000)
        SELECT n FROM numbers
    `;
    try {
        const alteredPackage = path.join(scratch, 'altered-package');
        const alteredAssets = path.join(alteredPackage, 'prebuild', target);
        fs.mkdirSync(alteredAssets, { recursive: true });
        const alteredEntry = path.join(alteredPackage, 'index.cjs');
        fs.copyFileSync(packageEntry, alteredEntry);
        fs.copyFileSync(path.join(path.dirname(packageEntry), 'engine-build.cjs'), path.join(alteredPackage, 'engine-build.cjs'));
        fs.copyFileSync(path.join(path.dirname(packageEntry), 'source-manifest.json'), path.join(alteredPackage, 'source-manifest.json'));
        const alteredBuild = path.join(alteredAssets, 'build.json');
        fs.writeFileSync(alteredBuild, JSON.stringify({ ...build, target: 'wrong-target' }));
        fs.writeFileSync(path.join(alteredAssets, 'binding.node'), 'fixture for a mismatched build digest');
        const { openFoundation: openAltered } = require(alteredEntry);
        const rejectedFile = path.join(scratch, 'rejected.sqlite');
        await assert.rejects(openAltered({ filename: rejectedFile }), /does not match its source manifest/);
        fs.writeFileSync(alteredBuild, JSON.stringify({ ...build, engineBuildHash: '0'.repeat(64) }));
        await assert.rejects(openAltered({ filename: rejectedFile }), /does not match its source manifest/);
        fs.writeFileSync(alteredBuild, JSON.stringify(build));
        await assert.rejects(openAltered({ filename: rejectedFile }), /native asset digest mismatch/);
        if (incompatibleBinding) {
            const alteredBinding = path.join(alteredAssets, 'binding.node');
            fs.copyFileSync(incompatibleBinding, alteredBinding);
            fs.writeFileSync(alteredBuild, JSON.stringify({
                ...build, artifacts: { ...build.artifacts, binding: digest(alteredBinding) },
            }));
            // Run the DLL load in a child process so Windows releases it before cleanup.
            execFileSync(process.execPath, ['-e', `
                const assert = require('node:assert/strict');
                const [entry, binding, file, expectedHash, sourceId] = process.argv.slice(1);
                const control = require(binding);
                assert.equal(control.sourceId, sourceId);
                assert.notEqual(control.engineBuildHash, expectedHash);
                assert.rejects(require(entry).openFoundation({ filename: file }), /does not match its source manifest/)
                    .catch(error => { console.error(error); process.exitCode = 1; });
            `, alteredEntry, alteredBinding, rejectedFile, build.engineBuildHash, build.sqlite], { timeout: 8000 });
        }
        assert.equal(fs.existsSync(rejectedFile), false);

        writer = await openFoundation({ filename: file });
        await writer.execute('CREATE TABLE entries (id INTEGER PRIMARY KEY, payload BLOB, label TEXT)');
        const id = 9223372036854775807n;
        const blob = Buffer.from([0, 255, 32]);
        const insert = writer.execute('INSERT INTO entries VALUES (?, ?, ?)', [id, blob, '初始']);
        blob[0] = 42;
        assert.equal((await insert).totalChanges, 1n);
        reader = await openFoundation({ filename: file, readonly: true });
        const observed = await reader.execute('SELECT id, payload, label FROM entries');
        assert.deepEqual(observed.columns, ['id', 'payload', 'label']);
        assert.deepEqual(observed.rows, [[id, Buffer.from([0, 255, 32]), '初始']]);
        assert.equal(runShell(file, 'SELECT id, hex(payload) FROM entries'), `${id}|00FF20`);
        assert.equal((await writer.execute('UPDATE entries SET label=? WHERE id=?', ['更新', id])).totalChanges, 1n);
        assert.deepEqual((await reader.execute('SELECT label FROM entries')).rows, [['更新']]);
        assert.equal((await writer.execute('DELETE FROM entries WHERE id=?', [id])).totalChanges, 1n);
        assert.deepEqual((await reader.execute('SELECT id FROM entries')).rows, []);
        assert.deepEqual((await writer.execute('SELECT typeof(?), ?', [Buffer.alloc(0), Buffer.alloc(0)])).rows,
            [['blob', Buffer.alloc(0)]]);
        await assert.rejects(writer.execute("INSERT INTO entries VALUES (1, NULL, 'forbidden'); SELECT 1"), /expected one/);
        assert.deepEqual((await reader.execute('SELECT id FROM entries')).rows, []);
        await writer.execute('PRAGMA foreign_keys=OFF');
        await assert.rejects(writer.execute('PRAGMA foreign_keys=ON; SELECT 1'), /expected one/);
        assert.deepEqual((await writer.execute('PRAGMA foreign_keys')).rows, [[0n]]);
        const timeoutBefore = (await writer.execute('PRAGMA busy_timeout')).rows;
        await assert.rejects(writer.execute("PRAGMA busy_timeout='42;--'; SELECT 1"), /expected one/);
        assert.deepEqual((await writer.execute('PRAGMA busy_timeout')).rows, timeoutBefore);
        assert.deepEqual((await writer.execute("SELECT ';' AS literal; -- trailing comment")).rows, [[';']]);
        await writer.execute('CREATE TABLE audit (event TEXT)');
        await writer.execute(`
            CREATE TRIGGER record_entry AFTER INSERT ON entries BEGIN
                INSERT INTO audit VALUES ('first;');
                INSERT INTO audit VALUES ('second');
            END;
        `);
        await writer.execute("INSERT INTO entries VALUES (1, NULL, 'trigger')");
        assert.deepEqual((await reader.execute('SELECT event FROM audit ORDER BY rowid')).rows, [['first;'], ['second']]);
        await assert.rejects(reader.execute("INSERT INTO entries VALUES (1, NULL, 'readonly')"),
            error => error.code === 8 && error.extendedCode === 8);

        await writer.loadFixtureExtension(extension);
        assert.deepEqual((await writer.execute('SELECT b01_probe_value()')).rows, [[54n]]);
        await assert.rejects(writer.execute('SELECT load_extension(?)', [extension]), /not authorized/);

        await writer.execute('CREATE TABLE lease_effects (id INTEGER PRIMARY KEY)');
        await writer.execute('CREATE TABLE lease_receipts (id INTEGER PRIMARY KEY)');
        const timeSql = "SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)";
        const databaseTime = async () => (await writer.execute(timeSql)).rows[0][0];
        await assert.rejects(writer.commitBefore(0n), /invalid SQLite commit deadline/);
        await assert.rejects(writer.commitBefore(await databaseTime() + 5000n), /requires an active main database write transaction/);
        const expires = await databaseTime() + 1000n;
        await writer.execute('BEGIN IMMEDIATE');
        await writer.execute('INSERT INTO lease_effects VALUES (1)');
        await writer.execute('INSERT INTO lease_receipts VALUES (1)');
        assert.ok(await databaseTime() < expires, 'admission occurs before the deadline');
        const waitUntil = process.hrtime.bigint() + 4_000_000_000n;
        while (await databaseTime() < expires) {
            assert.ok(process.hrtime.bigint() < waitUntil, 'the database VFS clock must reach expiry');
            await delay(20);
        }
        await assert.rejects(writer.commitBefore(expires), error => error.code === 19 && error.extendedCode === 531);
        assert.deepEqual((await reader.execute('SELECT id FROM lease_effects')).rows, []);
        assert.deepEqual((await reader.execute('SELECT id FROM lease_receipts')).rows, []);
        await writer.execute('BEGIN IMMEDIATE');
        await writer.execute('INSERT INTO lease_effects VALUES (2)');
        await writer.execute('INSERT INTO lease_receipts VALUES (2)');
        await writer.commitBefore(await databaseTime() + 30000n);
        await writer.execute('BEGIN IMMEDIATE');
        await writer.execute('INSERT INTO lease_effects VALUES (3)');
        await writer.execute('COMMIT');
        assert.deepEqual((await reader.execute('SELECT id FROM lease_effects ORDER BY id')).rows, [[2n], [3n]]);
        assert.deepEqual((await reader.execute('SELECT id FROM lease_receipts')).rows, [[2n]]);

        const cancelledBeforeAdmission = globalThis.AbortSignal.abort();
        await assert.rejects(writer.execute('SELECT 1', [], { signal: cancelledBeforeAdmission }), { name: 'AbortError' });
        control = await native.open(file, 2, 0);
        await native.execute(control, 'CREATE TABLE cancelled_rows (n INTEGER)', [], 1n);
        pending = native.execute(control, longInsert, [], 2n);
        const interrupted = assert.rejects(pending, error => error.code === 9 && error.extendedCode === 9);
        interrupted.catch(() => {});
        const deadline = Date.now() + 2000;
        while (!native.hasProgressed(control) && Date.now() < deadline) await delay(2);
        assert.ok(native.hasProgressed(control), 'SQLite must have executed before cancellation');
        assert.equal(native.interrupt(control, 1n), false, 'a settled operation token must not cancel the active successor');
        assert.equal(native.interrupt(control, 2n), true);
        await interrupted;
        assert.equal(native.interrupt(control, 2n), false);
        assert.deepEqual((await reader.execute('SELECT count(*) FROM cancelled_rows')).rows, [[0n]]);
        assert.deepEqual((await native.execute(control, 'SELECT 7', [], 3n)).rows, [[7n]]);
        await native.close(control);
        control = undefined;
        pending = undefined;

        assert.deepEqual((await writer.execute('PRAGMA journal_mode=DELETE')).rows, [['delete']]);
        const journal = `${file}-journal`;
        assert.equal(fs.existsSync(journal), false);
        controller = new globalThis.AbortController();
        controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
        const throughPackage = writer.execute(longInsert, [], { signal: controller.signal });
        const packageInterrupt = assert.rejects(throughPackage, error => error.code === 9);
        packageInterrupt.catch(() => {});
        const journalDeadline = Date.now() + 3500;
        while (!fs.existsSync(journal) && Date.now() < journalDeadline) await delay(2);
        assert.ok(fs.existsSync(journal), 'SQLite must have started its rollback journal before package cancellation');
        controller.abort();
        await packageInterrupt;
        assert.deepEqual((await reader.execute('SELECT count(*) FROM cancelled_rows')).rows, [[0n]]);

        const readBeforeClose = writer.execute('SELECT 34');
        const closed = writer.close();
        assert.equal(writer.close(), closed);
        await assert.rejects(writer.execute('SELECT 1'), /closing or closed/);
        assert.deepEqual((await readBeforeClose).rows, [[34n]]);
        await closed;
        assert.equal(writer.closed, true);
        console.log(JSON.stringify({
            package: '@monsqlize/sqlite-native', kind: 'W03 foundation package', host: target, node: process.version,
            sqliteSource: native.sourceId, installedTarball: true, crud: true, inFlightInterrupt: true,
            installedBindingSha256: build.artifacts.binding,
            installedShellSha256: build.artifacts.shell, engineBuildHash: build.engineBuildHash,
            independentShellRead: true,
            nativeLeaseCommitDeadline: true,
            incompatibleRuntimeRejectedBeforeOpen: Boolean(incompatibleBinding),
            runtimeCompileOptionsMatched: true, mismatchedAssetRejectedBeforeOpen: true,
            interruptedStatementLeftZeroRows: true, idleCancelDoesNotCarry: true, closeAfterSettlement: true,
            rejectedMultipleStatementsBeforePragmaSideEffects: true,
            staleTokenRejectedDuringSuccessor: true, packageSignalCancelsDespiteStoppedPropagation: true,
            realExtensionLoaded: true, opaqueNativeControl: true,
        }));
    } finally {
        controller?.abort();
        if (control) {
            if (pending) {
                native.interrupt(control, 2n);
                await pending.catch(() => {});
            }
            await native.close(control);
        }
        if (reader) await reader.close();
        if (writer) await writer.close();
        assert.equal(path.dirname(scratch), root);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

checkPackage().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
