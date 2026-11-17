'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = fs.realpathSync(os.tmpdir());
const scratch = fs.mkdtempSync(path.join(root, 'monsqlize-stock-capture-'));
const file = path.join(scratch, 'captures.sqlite');
let writer;
let reader;

try {
    writer = new DatabaseSync(file);
    writer.exec(`
        CREATE TABLE simple_rows (id INTEGER PRIMARY KEY, body TEXT);
        CREATE TABLE simple_presence (id INTEGER PRIMARY KEY, present INTEGER NOT NULL);
        CREATE TABLE simple_events (id INTEGER NOT NULL, old_present INTEGER NOT NULL, new_present INTEGER NOT NULL);
        INSERT INTO simple_rows VALUES (1, NULL);
        INSERT INTO simple_presence VALUES (1, 0);
        CREATE TRIGGER simple_body AFTER UPDATE OF body ON simple_rows BEGIN
            INSERT INTO simple_events
                SELECT NEW.id, present, 1 FROM simple_presence
                WHERE id = NEW.id AND (present = 0 OR OLD.body IS NOT NEW.body);
            UPDATE simple_presence SET present = 1 WHERE id = NEW.id;
        END;

        CREATE TABLE complex_rows (id INTEGER PRIMARY KEY, body TEXT);
        CREATE TABLE complex_child_writes (id INTEGER NOT NULL);
        INSERT INTO complex_rows VALUES (1, 'before');
        CREATE TRIGGER complex_needs_observer BEFORE UPDATE ON complex_rows BEGIN
            SELECT monsqlize_observer_guard();
        END;
        CREATE TRIGGER complex_user_after AFTER UPDATE ON complex_rows BEGIN
            INSERT INTO complex_child_writes VALUES (NEW.id);
        END;
    `);
    reader = new DatabaseSync(file, { readOnly: true });
    const simple = reader.prepare('SELECT typeof(body) AS type, present FROM simple_rows JOIN simple_presence USING (id)');
    const events = reader.prepare('SELECT old_present, new_present FROM simple_events ORDER BY rowid');
    assert.deepEqual({ ...simple.get() }, { type: 'null', present: 0 });

    writer.exec('UPDATE simple_rows SET body=body WHERE id=1');
    assert.deepEqual({ ...simple.get() }, { type: 'null', present: 1 });
    assert.deepEqual(events.all().map(row => ({ ...row })), [{ old_present: 0, new_present: 1 }]);
    writer.exec('UPDATE simple_rows SET body=body WHERE id=1');
    assert.equal(events.all().length, 1);

    writer.exec("BEGIN; SAVEPOINT inner_write; UPDATE simple_rows SET body='transient' WHERE id=1");
    assert.equal(writer.prepare('SELECT count(*) AS n FROM simple_events').get().n, 2);
    assert.equal(events.all().length, 1);
    writer.exec('ROLLBACK TO inner_write; RELEASE inner_write; COMMIT');
    assert.equal(events.all().length, 1);
    assert.deepEqual({ ...simple.get() }, { type: 'null', present: 1 });

    const readComplex = reader.prepare('SELECT body FROM complex_rows WHERE id=1');
    assert.equal(readComplex.get().body, 'before');
    assert.throws(() => writer.exec("UPDATE complex_rows SET body='changed' WHERE id=1"), /no such function: monsqlize_observer_guard/);
    assert.equal(readComplex.get().body, 'before');
    assert.equal(reader.prepare('SELECT count(*) AS n FROM complex_child_writes').get().n, 0);

    console.log(JSON.stringify({
        kind: 'P04 stock SQLite SQL and missing guard-function control',
        host: `${process.platform}-${process.arch}`,
        engine: reader.prepare('SELECT sqlite_source_id() AS id').get().id,
        sameValueAssignmentChangedOnlyPresence: true,
        redundantAssignmentWroteNoEvent: true,
        savepointRolledBackBusinessAndEvent: true,
        stockReadPermitted: true,
        missingGuardFunctionLeftBothTablesUnchanged: true,
    }));
} finally {
    reader?.close();
    writer?.close();
    assert.equal(path.dirname(scratch), root);
    fs.rmSync(scratch, { recursive: true, force: true });
}
