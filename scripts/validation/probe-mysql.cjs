'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function verifyLease({ writer, successor, reader, rows }) {
    await rows(writer, 'CREATE TABLE b01_lease (id INT PRIMARY KEY, epoch INT NOT NULL, expires DATETIME(6) NOT NULL) ENGINE=InnoDB');
    await rows(writer, 'CREATE TABLE b01_receipts (op VARCHAR(32) PRIMARY KEY, epoch INT NOT NULL) ENGINE=InnoDB');
    await rows(writer, 'CREATE TABLE b01_effects (op VARCHAR(32) PRIMARY KEY, epoch INT NOT NULL) ENGINE=InnoDB');
    await rows(writer, 'INSERT INTO b01_lease VALUES (1,1,UTC_TIMESTAMP(6)+INTERVAL 1 MINUTE)');

    async function put(client, epoch, operation) {
        const [active] = await client.execute(
            'SELECT epoch FROM b01_lease WHERE id=1 AND epoch=? AND expires>UTC_TIMESTAMP(6) FOR UPDATE', [epoch],
        );
        if (!active.length) return 0;
        const [prior] = await client.execute('SELECT epoch FROM b01_receipts WHERE op=?', [operation]);
        if (prior.length) return 0;
        await client.execute('INSERT INTO b01_receipts VALUES (?,?)', [operation, epoch]);
        await client.execute('INSERT INTO b01_effects VALUES (?,?)', [operation, epoch]);
        return 1;
    }

    await rows(writer, 'START TRANSACTION');
    assert.equal(await put(writer, 1, 'prior'), 1);
    await rows(successor, 'START TRANSACTION');
    const takeoverLock = rows(successor, 'SELECT epoch FROM b01_lease WHERE id=1 FOR UPDATE');
    takeoverLock.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 80 && !blocked; attempt++) {
        const [waiting] = await reader.execute(`
            SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits waits
            JOIN performance_schema.threads thread ON waits.REQUESTING_THREAD_ID=thread.THREAD_ID
            WHERE thread.PROCESSLIST_ID=?
        `, [successor.threadId]);
        blocked = Number(waiting[0].n) > 0;
        if (!blocked) await delay(25);
    }
    assert.ok(blocked, 'successor must wait for the old writer transaction');
    assert.deepEqual(await rows(reader, 'SELECT * FROM b01_receipts'), []);
    assert.deepEqual(await rows(reader, 'SELECT * FROM b01_effects'), []);
    await rows(writer, 'UPDATE b01_lease SET expires=UTC_TIMESTAMP(6)-INTERVAL 1 SECOND WHERE id=1');
    await rows(writer, 'COMMIT');
    assert.deepEqual(await takeoverLock, [{ epoch: 1 }]);
    const takeover = await rows(successor, 'UPDATE b01_lease SET epoch=2,expires=UTC_TIMESTAMP(6)+INTERVAL 1 MINUTE WHERE id=1 AND expires<UTC_TIMESTAMP(6)');
    assert.equal(takeover.affectedRows, 1);
    assert.equal(await put(successor, 2, 'after'), 1);
    await rows(successor, 'COMMIT');

    await rows(writer, 'START TRANSACTION');
    assert.equal(await put(writer, 1, 'late'), 0);
    await rows(writer, 'ROLLBACK');
    await rows(successor, 'START TRANSACTION');
    assert.equal(await put(successor, 2, 'after'), 0);
    await rows(successor, 'COMMIT');
    const expected = [{ op: 'after', epoch: 2 }, { op: 'prior', epoch: 1 }];
    assert.deepEqual(await rows(reader, 'SELECT * FROM b01_receipts ORDER BY op'), expected);
    assert.deepEqual(await rows(reader, 'SELECT * FROM b01_effects ORDER BY op'), expected);
    return { successorWaitedForServerLock: true, staleEffects: 0, staleReceipts: 0, replayEffects: 0 };
}

async function verifyPublishedReceipt({ writer, reader, connect, rows }) {
    await rows(writer, 'CREATE TABLE b01_publish_receipts (op VARCHAR(32) PRIMARY KEY, sha CHAR(64)) ENGINE=InnoDB');
    const root = await fs.realpath(os.tmpdir());
    const work = await fs.mkdtemp(path.join(root, 'monsqlize-my-publish-'));
    try {
        const staged = path.join(work, 'backup.temporary');
        const final = path.join(work, 'backup.json');
        const body = Buffer.from('{"fixture":"published once"}\n');
        const sha = createHash('sha256').update(body).digest('hex');
        const artifact = await fs.open(staged, 'wx');
        try {
            await artifact.writeFile(body);
            await artifact.sync();
        } finally {
            await artifact.close();
        }
        await assert.rejects(fs.stat(final), { code: 'ENOENT' });
        await fs.rename(staged, final);
        assert.deepEqual(await fs.readFile(final), body);

        const interrupted = await connect();
        await rows(interrupted, 'START TRANSACTION');
        await interrupted.execute('INSERT INTO b01_publish_receipts VALUES (?,?)', ['published', sha]);
        assert.deepEqual(await rows(reader, 'SELECT op FROM b01_publish_receipts'), []);
        const socket = interrupted.connection.stream;
        const fault = new Error('fixture dropped the MySQL COMMIT response before SQL client delivery');
        let buffered = Buffer.alloc(0);
        let sawOk = false;
        interrupted.connection.on('error', () => {});
        socket.removeAllListeners('data');
        socket.on('data', bytes => {
            buffered = Buffer.concat([buffered, bytes]);
            if (buffered.length < 4) return;
            const length = buffered.readUIntLE(0, 3);
            if (buffered.length < 4 + length) return;
            sawOk = length > 0 && buffered[4] === 0x00;
            socket.destroy(sawOk ? fault : new Error('fixture received an unexpected MySQL COMMIT response'));
        });
        const deadline = setTimeout(() => socket.destroy(new Error('fixture did not reach the MySQL COMMIT response')), 4000);
        try {
            await assert.rejects(rows(interrupted, 'COMMIT'), error => error.message === fault.message);
        } finally {
            clearTimeout(deadline);
        }
        assert.ok(sawOk);
        assert.deepEqual(await rows(reader, 'SELECT op, sha FROM b01_publish_receipts'), [{ op: 'published', sha }]);
        assert.equal(createHash('sha256').update(await fs.readFile(final)).digest('hex'), sha);
        return { stagedFsyncBeforeRename: true, callerCommitResponseLost: true, receiptAndFileDigestReconciled: true };
    } finally {
        assert.equal(path.dirname(work), root);
        await fs.rm(work, { recursive: true, force: true });
    }
}

/** Exercises a private MySQL 8.4 fixture with four independent server sessions. */
async function main() {
    const [driverRoot, socketPath, mysqlbinlog, logDirectory] = process.argv.slice(2);
    assert.ok(driverRoot && [socketPath, mysqlbinlog, logDirectory].every(value => path.isAbsolute(value ?? '')),
        'Usage: node probe-mysql.cjs <node_modules> <private socket or named pipe> <mysqlbinlog> <private binlog directory>');
    const mysql = require(path.resolve(driverRoot, 'mysql2/promise'));
    const sessions = [];
    async function connect() {
        const client = await mysql.createConnection({
            socketPath, user: 'root', database: 'monsqlize_b01', connectTimeout: 4000,
            supportBigNumbers: true, bigNumberStrings: true,
        });
        sessions.push(client);
        return client;
    }
    async function rows(client, sql) {
        const [data] = await client.query({ sql, timeout: 9000 });
        return data;
    }
    function decodedRows(file, selectors) {
        assert.match(file, /^binlog\.\d+$/);
        return execFileSync(mysqlbinlog, [
            '--no-defaults', '--base64-output=DECODE-ROWS', '-vv', ...selectors, path.join(logDirectory, file),
        ], { encoding: 'utf8', timeout: 5000 }).split(/\r?\n/).filter(line => line.startsWith('### '));
    }
    function rowsBetween(before, after) {
        assert.equal(after.File, before.File, 'the short fixture fits in one binlog segment');
        return decodedRows(after.File, [`--start-position=${before.Position}`, `--stop-position=${after.Position}`]);
    }
    function streamArguments(file, selectors, user = 'b01_replication') {
        assert.match(file, /^binlog\.\d+$/);
        const pipe = process.platform === 'win32';
        const socket = pipe ? path.win32.basename(socketPath) : socketPath;
        return [
            '--no-defaults', `--protocol=${pipe ? 'PIPE' : 'SOCKET'}`, `--socket=${socket}`, `--user=${user}`,
            '--base64-output=DECODE-ROWS', '-vv', ...selectors, file,
        ];
    }
    function streamedRows(file, selectors, user) {
        return execFileSync(mysqlbinlog, streamArguments(file, selectors, user),
            { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).split(/\r?\n/)
            .filter(line => line.startsWith('### '));
    }

    let lock;
    let holding = false;
    let holdingBackup = false;
    try {
        const reader = await connect();
        const writer = await connect();
        lock = await connect();
        const snapshot = await connect();
        const server = (await rows(reader, `
            SELECT VERSION() AS version, @@binlog_format AS format, @@binlog_row_image AS row_image, @@gtid_mode AS gtid
        `))[0];
        assert.match(server.version, /^8\.4\./);
        assert.equal(server.format, 'ROW');
        assert.equal(server.row_image, 'FULL');
        assert.equal(server.gtid, 'ON');
        await rows(writer, "CREATE USER 'b01_replication'@'localhost'");
        await rows(writer, "GRANT REPLICATION SLAVE ON *.* TO 'b01_replication'@'localhost'");
        await rows(writer, "CREATE USER 'b01_no_replication'@'localhost'");
        await rows(writer, 'CREATE TABLE b01_rows (id BIGINT PRIMARY KEY, amount DECIMAL(28,6)) ENGINE=InnoDB');
        await writer.execute('INSERT INTO b01_rows VALUES (?,?)', ['9007199254740995', '100000000000000000.000017']);
        assert.deepEqual(await rows(reader, 'SELECT CAST(id AS CHAR) AS id, CAST(amount AS CHAR) AS amount FROM b01_rows'),
            [{ id: '9007199254740995', amount: '100000000000000000.000017' }]);

        await rows(lock, 'LOCK INSTANCE FOR BACKUP');
        holdingBackup = true;
        await writer.execute('UPDATE b01_rows SET amount=? WHERE id=?', ['100000000000000000.000018', '9007199254740995']);
        assert.deepEqual(await rows(reader, 'SELECT CAST(amount AS CHAR) AS amount FROM b01_rows'),
            [{ amount: '100000000000000000.000018' }], 'another session commits a visible write while the backup lock is held');
        await rows(lock, 'UNLOCK INSTANCE');
        holdingBackup = false;

        await rows(lock, 'FLUSH TABLES WITH READ LOCK');
        holding = true;
        await rows(snapshot, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await rows(snapshot, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const before = (await rows(lock, 'SHOW BINARY LOG STATUS'))[0];
        assert.ok(before.File && before.Position && before.Executed_Gtid_Set);
        const insert = writer.execute('INSERT INTO b01_rows VALUES (?,?)', ['9007199254740996', '2']);
        insert.catch(() => {}); // Always release the read lock if the fixture fails first.
        let blocked = false;
        for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
            const [processes] = await reader.execute('SELECT STATE FROM information_schema.processlist WHERE ID=?', [writer.threadId]);
            blocked = /lock/i.test(processes[0]?.STATE ?? '');
            if (!blocked) await delay(25);
        }
        assert.ok(blocked, 'an independent writer must wait on the server snapshot barrier');

        await rows(lock, 'UNLOCK TABLES');
        holding = false;
        await insert;
        assert.equal(Number((await rows(snapshot, 'SELECT COUNT(*) AS n FROM b01_rows'))[0].n), 1);
        assert.equal(Number((await rows(reader, 'SELECT COUNT(*) AS n FROM b01_rows'))[0].n), 2);
        await rows(snapshot, 'COMMIT');
        const after = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const [covered] = await reader.execute('SELECT GTID_SUBSET(?,?) AS covers', [before.Executed_Gtid_Set, after.Executed_Gtid_Set]);
        assert.equal(Number(covered[0].covers), 1);
        assert.notEqual(after.Executed_Gtid_Set, before.Executed_Gtid_Set);
        assert.ok(after.File !== before.File || Number(after.Position) > Number(before.Position));

        await writer.execute('UPDATE b01_rows SET amount=? WHERE id=?', ['4.000001', '9007199254740996']);
        await rows(writer, 'START TRANSACTION');
        await writer.execute('INSERT INTO b01_rows VALUES (?,?)', ['9007199254740998', '9']);
        await rows(writer, 'ROLLBACK');
        const end = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const [gtidDelta] = await reader.execute('SELECT GTID_SUBTRACT(?, ?) AS delta', [end.Executed_Gtid_Set, before.Executed_Gtid_Set]);
        assert.match(gtidDelta[0].delta, /^[a-f0-9-]+:\d+-\d+$/i, 'fixture emits two adjacent GTIDs');
        const decoded = rowsBetween(before, end);
        const decodedGtid = decodedRows(end.File, [`--include-gtids=${gtidDelta[0].delta}`]);
        assert.deepEqual(decodedGtid, decoded, 'file and GTID discovery agree on the row image');
        const fileSelectors = ['--read-from-remote-source=BINLOG-DUMP-NON-GTIDS',
            `--start-position=${before.Position}`, `--stop-position=${end.Position}`];
        assert.deepEqual(streamedRows(end.File, fileSelectors), decoded);
        assert.deepEqual(streamedRows(end.File, ['--read-from-remote-source=BINLOG-DUMP-GTIDS',
            `--exclude-gtids=${before.Executed_Gtid_Set}`, `--stop-position=${end.Position}`]), decoded);
        assert.throws(() => streamedRows(end.File, fileSelectors, 'b01_no_replication'),
            error => error.status !== 0 && /REPLICATION SLAVE|Access denied/i.test(error.stderr));
        const updateOnly = rowsBetween(after, end);
        assert.match(updateOnly[0], /UPDATE/);
        assert.deepEqual(streamedRows(end.File, ['--read-from-remote-source=BINLOG-DUMP-NON-GTIDS',
            `--start-position=${after.Position}`, `--stop-position=${end.Position}`]), updateOnly);
        assert.deepEqual(streamedRows(end.File, ['--read-from-remote-source=BINLOG-DUMP-GTIDS',
            `--exclude-gtids=${after.Executed_Gtid_Set}`, `--stop-position=${end.Position}`]), updateOnly);
        const images = decoded.join('\n');
        assert.match(images, /INSERT INTO `monsqlize_b01`\.`b01_rows`[\s\S]+UPDATE `monsqlize_b01`\.`b01_rows`[\s\S]+WHERE[\s\S]+@1=9007199254740996[\s\S]+@2=2\.000000[\s\S]+SET[\s\S]+@1=9007199254740996[\s\S]+@2=4\.000001/);
        assert.ok(!images.includes('9007199254740998'), 'rolled back row absent from independent decoder');

        await rows(writer, 'START TRANSACTION');
        await writer.execute('INSERT INTO b01_rows VALUES (?,?)', ['9007199254740997', '3']);
        await rows(writer, 'CREATE TABLE b01_independent_ddl (id INT PRIMARY KEY) ENGINE=InnoDB');
        await rows(writer, 'ROLLBACK');
        assert.equal(Number((await rows(reader, 'SELECT COUNT(*) AS n FROM b01_rows'))[0].n), 3,
            'independent DDL commits the preceding transaction on MySQL');

        const guardName = 'monsqlize-b01-private-fixture';
        const [owner] = await writer.execute('SELECT GET_LOCK(?, 0) AS acquired', [guardName]);
        assert.equal(Number(owner[0].acquired), 1);
        await rows(writer, 'CREATE TABLE b01_named_guard_ddl (id INT PRIMARY KEY) ENGINE=InnoDB');
        const [competitor] = await reader.execute('SELECT GET_LOCK(?, 0) AS acquired', [guardName]);
        assert.equal(Number(competitor[0].acquired), 0);
        await writer.execute('SELECT RELEASE_LOCK(?)', [guardName]);
        const [next] = await reader.execute('SELECT GET_LOCK(?, 0) AS acquired', [guardName]);
        assert.equal(Number(next[0].acquired), 1);
        await reader.execute('SELECT RELEASE_LOCK(?)', [guardName]);

        await rows(writer, 'CREATE TABLE b01_parent (id INT PRIMARY KEY) ENGINE=InnoDB');
        await rows(writer, `
            CREATE TABLE b01_child (id INT PRIMARY KEY, parent_id INT NOT NULL,
                FOREIGN KEY (parent_id) REFERENCES b01_parent(id) ON DELETE CASCADE) ENGINE=InnoDB
        `);
        await rows(writer, 'INSERT INTO b01_parent VALUES (1),(2)');
        await rows(writer, 'INSERT INTO b01_child VALUES (10,1),(20,2)');
        const cascadeStart = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        await writer.execute('DELETE FROM b01_parent WHERE id=?', [1]);
        assert.deepEqual(await rows(reader, 'SELECT id FROM b01_parent ORDER BY id'), [{ id: 2 }]);
        assert.deepEqual(await rows(reader, 'SELECT id, parent_id FROM b01_child ORDER BY id'), [{ id: 20, parent_id: 2 }]);
        const cascadeEnd = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const cascadeImages = rowsBetween(cascadeStart, cascadeEnd);
        assert.ok(cascadeImages.includes('### DELETE FROM `monsqlize_b01`.`b01_parent`'));
        assert.ok(!cascadeImages.some(line => line.includes('`b01_child`')), 'the cascaded child has no separate row image');

        await writer.execute('DELETE FROM b01_child WHERE id=?', [20]);
        const directEnd = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        assert.ok(rowsBetween(cascadeEnd, directEnd).includes('### DELETE FROM `monsqlize_b01`.`b01_child`'),
            'a direct delete on the same child table must be visible to the decoder');
        const lease = await verifyLease({ writer, successor: snapshot, reader, rows });
        const publication = await verifyPublishedReceipt({ writer, reader, connect, rows });

        await rows(writer, 'CREATE TABLE b01_json (id INT PRIMARY KEY, doc JSON NOT NULL) ENGINE=InnoDB');
        const padding = 'payload '.repeat(512);
        await writer.execute('INSERT INTO b01_json VALUES (?,?)', [1, JSON.stringify({ state: 'before', padding })]);
        await rows(writer, "SET SESSION binlog_row_value_options='PARTIAL_JSON'");
        const partialStart = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        await rows(writer, `UPDATE b01_json SET doc=JSON_SET(doc,'$.state','after') WHERE id=1`);
        const partialEnd = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const partial = rowsBetween(partialStart, partialEnd);
        assert.ok(partial.some(line => /JSON_(?:REPLACE|SET)\(/.test(line)), 'source emitted a partial document update');
        const [document] = await rows(reader, `SELECT JSON_UNQUOTE(JSON_EXTRACT(doc,'$.state')) AS state,
            LENGTH(JSON_UNQUOTE(JSON_EXTRACT(doc,'$.padding'))) AS size FROM b01_json`);
        assert.equal(document.state, 'after');
        assert.equal(Number(document.size), padding.length);
        await rows(writer, "SET SESSION binlog_row_value_options=''");
        await rows(writer, `UPDATE b01_json SET doc=JSON_SET(doc,'$.state','full') WHERE id=1`);
        const fullEnd = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const full = rowsBetween(partialEnd, fullEnd);
        assert.ok(!full.some(line => /JSON_(?:REPLACE|SET)\(/.test(line)));
        assert.ok(full.some(line => line.includes(padding)), 'same operation with full row profile emits the complete document');

        const live = spawn(mysqlbinlog, streamArguments(fullEnd.File, ['--read-from-remote-source=BINLOG-DUMP-NON-GTIDS',
            `--start-position=${fullEnd.Position}`, '--stop-never', '--connection-server-id=11']),
        { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
        const closed = new Promise(resolve => live.once('close', (code, signal) => resolve({ code, signal })));
        let launchError;
        live.on('error', error => { launchError = error; });
        let lostSession;
        try {
            for (let attempt = 0; attempt < 100 && !lostSession; attempt++) {
                if (launchError) throw launchError;
                const active = await rows(reader, `SELECT ID FROM information_schema.processlist
                    WHERE USER='b01_replication' AND COMMAND LIKE 'Binlog Dump%'`);
                assert.ok(active.length <= 1);
                if (active.length) lostSession = Number(active[0].ID);
                else await delay(25);
            }
            assert.ok(Number.isSafeInteger(lostSession) && lostSession > 0, 'the live binlog session must exist');
            await rows(reader, `KILL CONNECTION ${lostSession}`);
            let disconnected = false;
            for (let attempt = 0; attempt < 80 && !disconnected; attempt++) {
                disconnected = (await rows(reader, `SELECT ID FROM information_schema.processlist WHERE ID=${lostSession}`)).length === 0;
                if (!disconnected) await delay(25);
            }
            assert.ok(disconnected, 'the old binlog session must be gone before resuming');
        } finally {
            if (live.exitCode === null && live.signalCode === null) live.kill();
            await closed;
        }
        await writer.execute('INSERT INTO b01_rows VALUES (?,?)', ['9007199254741000', '8.000010']);
        const resumed = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const afterDisconnect = rowsBetween(fullEnd, resumed);
        assert.ok(afterDisconnect.some(line => line.includes('9007199254741000')));
        assert.deepEqual(streamedRows(resumed.File, ['--read-from-remote-source=BINLOG-DUMP-NON-GTIDS',
            `--start-position=${fullEnd.Position}`, `--stop-position=${resumed.Position}`]), afterDisconnect);
        assert.deepEqual(streamedRows(resumed.File, ['--read-from-remote-source=BINLOG-DUMP-GTIDS',
            `--exclude-gtids=${fullEnd.Executed_Gtid_Set}`, `--stop-position=${resumed.Position}`]), afterDisconnect);

        await rows(writer, 'CREATE DATABASE b01_filtered_out');
        await rows(writer, 'CREATE TABLE b01_filtered_out.other_rows (id INT PRIMARY KEY) ENGINE=InnoDB');
        const filterStart = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        await rows(writer, 'INSERT INTO b01_filtered_out.other_rows VALUES (31)');
        await rows(writer, "INSERT INTO b01_rows VALUES (9007199254741001,'9')");
        const filterEnd = (await rows(reader, 'SHOW BINARY LOG STATUS'))[0];
        const allDatabases = rowsBetween(filterStart, filterEnd);
        assert.ok(allDatabases.some(line => line.includes('`b01_filtered_out`.`other_rows`')));
        assert.deepEqual(await rows(reader, 'SELECT id FROM b01_filtered_out.other_rows'), [{ id: 31 }]);
        const onlyRequested = streamedRows(filterEnd.File, ['--read-from-remote-source=BINLOG-DUMP-NON-GTIDS',
            '--database=monsqlize_b01', `--start-position=${filterStart.Position}`, `--stop-position=${filterEnd.Position}`]);
        assert.match(onlyRequested[0], /`monsqlize_b01`\.`b01_rows`/);
        assert.ok(onlyRequested.some(line => line.includes('9007199254741001')));
        assert.ok(!onlyRequested.some(line => line.includes('other_rows') || line === '###   @1=31'));

        process.stdout.write(`${JSON.stringify({
            engine: server.version,
            preparedExactKeyAndDecimal: true,
            actualSnapshotBarrierBlockedWriter: blocked,
            snapshotRows: 1,
            committedRowsAfterBarrier: 2,
            filePositionAdvanced: true,
            gtidCoverageAdvanced: true,
            fileAndGtidRowImagesAgreed: true,
            fileAndGtidReplicationSessionsAgreed: true,
            newReplicationSessionsResumedAfterCheckpoint: true,
            replicationPrivilegeRejected: true,
            fullUpdateBeforeAfterImages: true,
            abortedInsertAbsent: true,
            backupLockAllowedCommittedDml: true,
            ddlSurvivedRollback: true,
            namedGuardSurvivedDdl: true,
            namedGuardIsolatedTwoSessions: true,
            cascadeChildRemovedOnSource: true,
            cascadeChildHasSeparateBinlogRow: false,
            directChildDeleteHasSeparateBinlogRow: true,
            lease,
            publication,
            partialJson: { distinctFromFullImage: true, independentDocumentReadback: true },
            actualLiveReplicationSessionDisconnected: true,
            bothPositionsResumedAfterLiveDisconnect: true,
            nativeDatabaseFilterExcludedCommittedOtherRows: true,
        }, null, 2)}\n`);
    } finally {
        if (holding) await rows(lock, 'UNLOCK TABLES').catch(() => {});
        if (holdingBackup) await rows(lock, 'UNLOCK INSTANCE').catch(() => {});
        // Drop open fixture transactions before waiting for connections blocked on their locks.
        for (const session of sessions) session.destroy();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});

