'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

function formatLsn(lsn) {
    return `${(lsn >> 32n).toString(16)}/${(lsn & 0xffffffffn).toString(16)}`.toUpperCase();
}

function readUpdate(message) {
    assert.equal(message[0], 0x55);
    let offset = 5; // Tag and relation OID in pgoutput v1.
    function tuple() {
        const count = message.readUInt16BE(offset);
        offset += 2;
        const fields = [];
        for (let index = 0; index < count; index++) {
            const tag = String.fromCharCode(message.readUInt8(offset++));
            if (tag === 'n' || tag === 'u') {
                fields.push({ tag });
            } else {
                assert.equal(tag, 't'); // This fixture requests text format.
                const length = message.readUInt32BE(offset);
                offset += 4;
                assert.ok(offset + length <= message.length);
                fields.push({ tag, value: message.toString('utf8', offset, offset + length) });
                offset += length;
            }
        }
        return fields;
    }
    let old;
    if (message[offset] === 0x4f) {
        offset++;
        old = tuple();
    }
    assert.equal(message.readUInt8(offset++), 0x4e);
    const current = tuple();
    assert.equal(offset, message.length);
    return { oid: message.readUInt32BE(1), old, current };
}

function readRelation(message) {
    let offset = 5;
    function text() {
        const end = message.indexOf(0, offset);
        assert.ok(end >= offset);
        const value = message.toString('utf8', offset, end);
        offset = end + 1;
        return value;
    }
    const namespace = text();
    const name = text();
    const identity = String.fromCharCode(message.readUInt8(offset++));
    const count = message.readUInt16BE(offset);
    offset += 2;
    const columns = [];
    for (let index = 0; index < count; index++) {
        offset++; // Replica-key column flag.
        columns.push(text());
        offset += 8; // OID and type modifier.
    }
    assert.equal(offset, message.length);
    return { oid: message.readUInt32BE(1), namespace, name, identity, columns };
}

async function verifyRowImages({ writer, reader, escapeIdentifier }) {
    const payload = 'msq-TOAST-'.repeat(2048);
    await writer.query(`
        CREATE TABLE b01_images (id INT PRIMARY KEY, marker TEXT NOT NULL, payload TEXT);
        ALTER TABLE b01_images ALTER COLUMN payload SET STORAGE EXTERNAL;
        ALTER PUBLICATION b01_events ADD TABLE b01_images;
    `);
    await writer.query('INSERT INTO b01_images VALUES (1,$1,$2)', ['before', payload]);
    const toast = (await reader.query(`
        SELECT c.relname AS name FROM pg_class image JOIN pg_class c ON c.oid=image.reltoastrelid
        WHERE image.oid='b01_images'::regclass
    `)).rows[0].name;
    const chunks = (await reader.query(`SELECT COUNT(*)::int AS total FROM pg_toast.${escapeIdentifier(toast)}`)).rows[0].total;
    assert.ok(chunks > 1, 'the fixture must store payload out of line');
    await writer.query("SELECT pg_create_logical_replication_slot('b01_image_slot','pgoutput')");
    await writer.query("UPDATE b01_images SET marker='changed-default' WHERE id=1");
    await writer.query('ALTER TABLE b01_images REPLICA IDENTITY FULL');
    await writer.query("UPDATE b01_images SET marker='changed-full' WHERE id=1");
    await writer.query('ALTER TABLE b01_images ADD COLUMN revision INT DEFAULT 7');
    await writer.query("UPDATE b01_images SET payload=NULL, marker='changed-schema' WHERE id=1");

    const messages = (await reader.query(`
        SELECT data FROM pg_logical_slot_peek_binary_changes(
            'b01_image_slot', NULL, NULL, 'proto_version', '1', 'publication_names', 'b01_events'
        )
    `)).rows.map(row => row.data);
    const relations = messages.filter(message => message[0] === 0x52).map(readRelation);
    const updates = messages.filter(message => message[0] === 0x55).map(readUpdate);
    assert.equal(updates.length, 3);
    const [implicit, full, changed] = updates;
    assert.deepEqual(implicit.current, [{ tag: 't', value: '1' }, { tag: 't', value: 'changed-default' }, { tag: 'u' }]);
    assert.equal(implicit.old, undefined);
    assert.deepEqual(full.old, [{ tag: 't', value: '1' }, { tag: 't', value: 'changed-default' }, { tag: 't', value: payload }]);
    assert.deepEqual(changed.old[2], { tag: 't', value: payload });
    assert.deepEqual(changed.current, [{ tag: 't', value: '1' }, { tag: 't', value: 'changed-schema' }, { tag: 'n' }, { tag: 't', value: '7' }]);
    assert.ok(relations.some(item => item.oid === implicit.oid && item.identity === 'd' && item.columns.length === 3));
    assert.ok(relations.some(item => item.oid === changed.oid && item.identity === 'f' && item.columns[3] === 'revision'));
    assert.deepEqual((await reader.query('SELECT * FROM b01_images')).rows,
        [{ id: 1, marker: 'changed-schema', payload: null, revision: 7 }]);
    await writer.query("SELECT pg_drop_replication_slot('b01_image_slot')");
    return { toastChunks: chunks, unchangedDistinctFromNull: true, fullOldImage: true, relationSchemaChanged: true };
}

async function verifyAcknowledgement({ reader, writer, connect, Query }) {
    const slot = 'b01_live_slot';
    const checkSlot = async () => (await reader.query(
        'SELECT active, confirmed_flush_lsn::text AS confirmed FROM pg_replication_slots WHERE slot_name=$1', [slot],
    )).rows[0];
    const awaitSlot = async (expected, message) => {
        for (let attempt = 0; attempt < 80; attempt++) {
            if (expected(await checkSlot())) return;
            await delay(25);
        }
        assert.fail(message);
    };

    async function receiveOne(client) {
        const messages = [];
        const query = new Query(`START_REPLICATION SLOT ${slot} LOGICAL 0/0 (proto_version '1', publication_names 'b01_events')`);
        const commit = new Promise((resolve, reject) => {
            query.on('error', reject);
            client.on('error', reject);
            query.handleCopyData = ({ chunk }) => {
                if (chunk[0] !== 0x77 || chunk.length <= 25) return;
                const message = chunk.subarray(25);
                try {
                    if (message[0] === 0x49) messages.push(Buffer.from(message));
                    if (message[0] === 0x43) {
                        assert.equal(message.length, 26);
                        resolve({ end: message.readBigUInt64BE(10), inserts: messages });
                    }
                } catch (error) {
                    reject(error);
                }
            };
        });
        client.query(query);
        let deadline;
        try {
            return await Promise.race([commit, new Promise((_, reject) => {
                deadline = setTimeout(() => reject(new Error('logical stream did not deliver a commit')), 7000);
            })]);
        } finally {
            clearTimeout(deadline);
        }
    }

    const root = await fs.realpath(os.tmpdir());
    const work = await fs.mkdtemp(path.join(root, 'monsqlize-pg-wal-'));
    const receipt = path.join(work, 'committed.json');
    try {
        const original = await connect({ replication: 'database' });
        const created = (await original.query(`CREATE_REPLICATION_SLOT ${slot} LOGICAL pgoutput (SNAPSHOT 'nothing')`)).rows[0];
        const initial = (await checkSlot()).confirmed;
        assert.equal(initial, created.consistent_point);
        await writer.query("INSERT INTO b01_rows VALUES (4, 'fixture-live-stream')");
        const unacknowledged = await receiveOne(original);
        assert.equal(unacknowledged.inserts.length, 1);
        assert.ok(unacknowledged.inserts[0].includes(Buffer.from('fixture-live-stream')));
        assert.equal((await checkSlot()).confirmed, initial);
        await original.end();
        await awaitSlot(row => !row.active, 'disconnect must release the active logical slot');

        const successor = await connect({ replication: 'database' });
        const replayed = await receiveOne(successor);
        assert.deepEqual(replayed, unacknowledged);
        assert.equal((await checkSlot()).confirmed, initial);
        const end = formatLsn(replayed.end);
        const records = { end, inserts: replayed.inserts.map(value => value.toString('base64')) };
        const journal = await fs.open(receipt, 'wx');
        try {
            await journal.writeFile(JSON.stringify(records));
            await journal.sync();
        } finally {
            await journal.close();
        }
        assert.deepEqual(JSON.parse(await fs.readFile(receipt, 'utf8')), records);
        assert.notEqual(end, initial);
        const status = Buffer.alloc(34);
        status[0] = 0x72;
        for (const offset of [1, 9, 17]) status.writeBigUInt64BE(replayed.end, offset);
        status.writeBigInt64BE(BigInt(Date.now() - Date.UTC(2000, 0, 1)) * 1000n, 25);
        successor.connection.sendCopyFromChunk(status);
        await awaitSlot(row => row.confirmed === end, 'server must observe durable feedback');
        await successor.end();
        await awaitSlot(row => !row.active, 'acknowledged logical slot must be released');
        await reader.query('SELECT pg_drop_replication_slot($1)', [slot]);
        return { replayAfterDisconnect: true, independentFsyncBeforeFeedback: true, acknowledgedPosition: end };
    } finally {
        assert.equal(path.dirname(work), root);
        await fs.rm(work, { recursive: true, force: true });
    }
}

async function verifyCancellation({ writer, reader, connect }) {
    await writer.query('CREATE TABLE b01_cancel_effects (id INT PRIMARY KEY)');
    const interrupted = await connect();
    const { pid } = (await interrupted.query('SELECT pg_backend_pid() AS pid')).rows[0];
    const pending = interrupted.query('INSERT INTO b01_cancel_effects SELECT 1 FROM pg_sleep(5)');
    const rejected = assert.rejects(pending, error => error.code === '57014');
    rejected.catch(() => {});
    let sleeping = false;
    for (let attempt = 0; attempt < 80 && !sleeping; attempt++) {
        const activity = (await reader.query('SELECT wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        sleeping = activity?.wait_event === 'PgSleep';
        if (!sleeping) await delay(25);
    }
    assert.ok(sleeping, 'server must be running the exact statement before cancellation');
    assert.equal((await reader.query('SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0].cancelled, true);
    await rejected;
    assert.deepEqual((await reader.query('SELECT id FROM b01_cancel_effects')).rows, []);
    await interrupted.query('INSERT INTO b01_cancel_effects VALUES (2)');
    assert.deepEqual((await reader.query('SELECT id FROM b01_cancel_effects')).rows, [{ id: 2 }]);
    return { runningStatementCancelled: true, failedWriteAbsent: true, successorWriteVisible: true };
}

async function verifyLostCommitReply({ writer, reader, connect }) {
    await writer.query(`
        CREATE TABLE b01_lost_receipts (op TEXT PRIMARY KEY);
        CREATE TABLE b01_lost_effects (op TEXT PRIMARY KEY REFERENCES b01_lost_receipts);
    `);
    const interrupted = await connect();
    await interrupted.query(`
        BEGIN;
        INSERT INTO b01_lost_receipts VALUES ('lost-reply');
        INSERT INTO b01_lost_effects VALUES ('lost-reply');
    `);
    assert.deepEqual((await reader.query('SELECT op FROM b01_lost_receipts')).rows, []);

    const socket = interrupted.connection.stream;
    const fault = new Error('fixture dropped the COMMIT response before SQL client delivery');
    let observedCommandComplete = false;
    let received = Buffer.alloc(0);
    interrupted.on('error', () => {});
    // This connection belongs to the fault fixture. Stop forwarding its final response to pg.
    socket.removeAllListeners('data');
    socket.on('data', bytes => {
        received = Buffer.concat([received, bytes]);
        if (received.length < 5) return;
        const frameLength = received.readUInt32BE(1) + 1;
        if (received.length < frameLength) return;
        observedCommandComplete = received[0] === 0x43 && received.toString('ascii', 5, frameLength) === 'COMMIT\0';
        socket.destroy(observedCommandComplete ? fault : new Error('fixture received an unexpected COMMIT response'));
    });
    const deadline = setTimeout(() => socket.destroy(new Error('fixture did not reach the COMMIT response')), 4000);
    try {
        await assert.rejects(interrupted.query('COMMIT'), error => error === fault);
    } finally {
        clearTimeout(deadline);
    }
    assert.ok(observedCommandComplete);
    const expected = [{ op: 'lost-reply' }];
    assert.deepEqual((await reader.query('SELECT op FROM b01_lost_receipts')).rows, expected);
    assert.deepEqual((await reader.query('SELECT op FROM b01_lost_effects')).rows, expected);
    return { commandResponseDroppedBeforeClientDelivery: true, receiptAndEffectRecoveredByIndependentSession: true };
}

async function verifyFileReceipt({ writer, reader }) {
    await writer.query('CREATE TABLE b01_file_receipts (op TEXT PRIMARY KEY, sha CHAR(64) NOT NULL)');
    const root = await fs.realpath(os.tmpdir());
    const work = await fs.mkdtemp(path.join(root, 'monsqlize-pg-file-'));
    const staging = path.join(work, 'fixture.stage');
    const publish = path.join(work, 'published.json');
    const content = Buffer.from('{"source":"postgresql","fixture":"published"}\n');
    const digest = createHash('sha256').update(content).digest('hex');
    try {
        const file = await fs.open(staging, 'wx');
        try {
            await file.writeFile(content);
            await file.sync();
        } finally {
            await file.close();
        }
        await assert.rejects(fs.stat(publish), { code: 'ENOENT' });
        await writer.query('BEGIN');
        await writer.query('INSERT INTO b01_file_receipts VALUES ($1,$2)', ['fixture', digest]);
        assert.deepEqual((await reader.query('SELECT op FROM b01_file_receipts')).rows, []);
        await fs.rename(staging, publish);
        assert.deepEqual(await fs.readFile(publish), content);
        await writer.query('COMMIT');
        const expected = [{ op: 'fixture', sha: digest }];
        assert.deepEqual((await reader.query('SELECT op, sha FROM b01_file_receipts')).rows, expected);
        const replay = await writer.query('INSERT INTO b01_file_receipts VALUES ($1,$2) ON CONFLICT DO NOTHING', ['fixture', digest]);
        assert.equal(replay.rowCount, 0);
        assert.equal(createHash('sha256').update(await fs.readFile(publish)).digest('hex'), digest);
        return { fileSyncedAndRenamedBeforeCommit: true, receiptIndependentlyObserved: true, duplicateReceiptWrites: 0 };
    } finally {
        assert.equal(path.dirname(work), root);
        await fs.rm(work, { recursive: true, force: true });
    }
}

/**
 * Exercises an isolated PostgreSQL 18 fixture. The replication session owns
 * the exported snapshot until the reader has imported it.
 */
async function main() {
    const [driverRoot, host, portArgument, fixtureNonce] = process.argv.slice(2);
    const port = Number(portArgument);
    const loopback = host === '127.0.0.1';
    const isolatedAddress = loopback ? /^[a-f0-9]{32}$/.test(fixtureNonce ?? '') : path.isAbsolute(host ?? '');
    assert.ok(driverRoot && isolatedAddress && Number.isInteger(port) && port > 0 && port <= 65535,
        'Usage: node probe-postgresql.cjs <node_modules> <private socket directory or 127.0.0.1> <port> [fixture nonce for loopback]');

    const { Client, Query, escapeLiteral, escapeIdentifier } = require(path.resolve(driverRoot, 'pg'));
    const sessions = [];
    async function connect(options = {}) {
        const client = new Client({
            host, port, database: 'monsqlize_b01', user: 'b01', connectionTimeoutMillis: 4000,
            statement_timeout: 8000, ...options,
        });
        await client.connect();
        sessions.push(client);
        return client;
    }

    try {
        const writer = await connect();
        const reader = await connect();
        const server = (await reader.query("SELECT current_setting('server_version_num')::int AS number, version() AS version, current_setting('wal_level') AS wal")).rows[0];
        assert.equal(Math.floor(server.number / 10000), 18);
        assert.equal(server.wal, 'logical');
        if (loopback) {
            const identity = (await reader.query("SELECT current_setting('monsqlize.b01_nonce', true) AS nonce")).rows[0];
            assert.ok(identity.nonce === fixtureNonce, 'loopback server is not the dedicated B01 fixture');
        }
        await writer.query(`
            CREATE TABLE b01_rows (id integer PRIMARY KEY, marker text NOT NULL);
            ALTER TABLE b01_rows REPLICA IDENTITY FULL;
            CREATE PUBLICATION b01_events FOR TABLE b01_rows;
            INSERT INTO b01_rows VALUES (1, 'fixture-before');
        `);

        const replication = await connect({ replication: 'database' });
        const slot = (await replication.query("CREATE_REPLICATION_SLOT b01_slot LOGICAL pgoutput (SNAPSHOT 'export')")).rows[0];
        assert.ok(slot.snapshot_name && slot.consistent_point);
        const snapshot = await connect();
        await snapshot.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await snapshot.query('SET TRANSACTION SNAPSHOT ' + escapeLiteral(slot.snapshot_name));

        await writer.query("INSERT INTO b01_rows VALUES (2, 'fixture-after')");
        await writer.query("BEGIN; INSERT INTO b01_rows VALUES (3, 'fixture-rolledback'); ROLLBACK");
        assert.deepEqual((await snapshot.query('SELECT id FROM b01_rows ORDER BY id')).rows.map(r => r.id), [1]);
        await snapshot.query('COMMIT');
        assert.deepEqual((await reader.query('SELECT id FROM b01_rows ORDER BY id')).rows.map(r => r.id), [1, 2]);

        const messages = (await reader.query(`
            SELECT data FROM pg_logical_slot_peek_binary_changes(
                'b01_slot', NULL, NULL, 'proto_version', '1', 'publication_names', 'b01_events'
            );
        `)).rows.map(r => r.data);
        const inserts = messages.filter(row => row[0] === 0x49);
        assert.equal(inserts.length, 1, 'the slot includes just the committed change after the snapshot');
        assert.ok(inserts[0].includes(Buffer.from('fixture-after')));
        assert.ok(!messages.some(row => row.includes(Buffer.from('fixture-rolledback'))));
        const liveStream = await verifyAcknowledgement({ reader, writer, connect, Query });
        const rowImages = await verifyRowImages({ writer, reader, escapeIdentifier });
        const cancellation = await verifyCancellation({ writer, reader, connect });
        const unknown = await verifyLostCommitReply({ writer, reader, connect });
        const fileReceipt = await verifyFileReceipt({ writer, reader });

        await writer.query(`
            CREATE TABLE b01_lease (id integer PRIMARY KEY, epoch integer NOT NULL, expires timestamptz NOT NULL);
            CREATE TABLE b01_receipts (operation_id text PRIMARY KEY, applied_by integer NOT NULL);
            CREATE TABLE b01_effects (operation_id text PRIMARY KEY REFERENCES b01_receipts, applied_by integer NOT NULL);
            INSERT INTO b01_lease VALUES (1, 1, clock_timestamp() + interval '1 minute');
        `);
        const successor = await connect();
        const backend = (await successor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const fencedInsert = `
            WITH guard AS (
                SELECT epoch FROM b01_lease
                WHERE id=1 AND epoch=$1 AND clock_timestamp() < expires FOR UPDATE
            ), receipt AS (
                INSERT INTO b01_receipts SELECT $2, epoch FROM guard
                ON CONFLICT (operation_id) DO NOTHING RETURNING operation_id, applied_by
            )
            INSERT INTO b01_effects SELECT operation_id, applied_by FROM receipt
        `;

        await writer.query('BEGIN');
        assert.equal((await writer.query(fencedInsert, [1, 'before-handoff'])).rowCount, 1);
        await successor.query('BEGIN');
        const pendingLock = successor.query('SELECT epoch FROM b01_lease WHERE id=1 FOR UPDATE');
        pendingLock.catch(() => {}); // The cleanup path may terminate a pending server query.
        let seenWait = false;
        for (let attempt = 0; attempt < 40 && !seenWait; attempt++) {
            const status = (await reader.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [backend])).rows[0];
            seenWait = status?.wait_event_type === 'Lock';
            if (!seenWait) await delay(25);
        }
        assert.ok(seenWait, 'takeover must wait while the authorized write and its receipt are uncommitted');
        assert.deepEqual((await reader.query('SELECT * FROM b01_effects')).rows, []);
        assert.deepEqual((await reader.query('SELECT * FROM b01_receipts')).rows, []);
        await writer.query("UPDATE b01_lease SET expires=clock_timestamp() - interval '1 second' WHERE id=1");
        await writer.query('COMMIT');
        assert.equal((await pendingLock).rows[0].epoch, 1);
        const takeover = await successor.query(`
            UPDATE b01_lease SET epoch=2, expires=clock_timestamp() + interval '1 minute'
            WHERE id=1 AND expires < clock_timestamp() RETURNING epoch
        `);
        assert.equal(takeover.rows[0].epoch, 2);
        await successor.query('COMMIT');

        assert.equal((await writer.query(fencedInsert, [1, 'stale-attempt'])).rowCount, 0);
        assert.equal((await successor.query(fencedInsert, [2, 'after-handoff'])).rowCount, 1);
        assert.equal((await successor.query(fencedInsert, [2, 'after-handoff'])).rowCount, 0);
        const expected = [
            { operation_id: 'after-handoff', applied_by: 2 },
            { operation_id: 'before-handoff', applied_by: 1 },
        ];
        assert.deepEqual((await reader.query('SELECT * FROM b01_effects ORDER BY operation_id')).rows, expected);
        assert.deepEqual((await reader.query('SELECT * FROM b01_receipts ORDER BY operation_id')).rows, expected);

        process.stdout.write(`${JSON.stringify({
            engine: server.version,
            safeSnapshotPosition: slot.consistent_point,
            importedSnapshotIds: [1],
            visibleCommittedIds: [1, 2],
            decodedInsertsAfterSnapshot: inserts.length,
            abortedInsertAbsent: true,
            actualLeaseLockWaitObserved: seenWait,
            staleOwnerWrites: 0,
            staleOwnerReceipts: 0,
            successorWrites: 1,
            duplicateSuccessorWrites: 0,
            liveStream,
            rowImages,
            cancellation,
            unknown,
            fileReceipt,
        }, null, 2)}\n`);
    } finally {
        await Promise.allSettled(sessions.map(client => client.end()));
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});

