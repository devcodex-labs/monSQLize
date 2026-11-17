/* Isolated B01 probe for SQLite's native statement and transaction boundaries. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sqlite3.h"

typedef struct {
    unsigned parent;
    unsigned cascadedChild;
    unsigned triggeredAudit;
} Changes;

static void require(int condition, const char *message) {
    if (!condition) {
        fprintf(stderr, "SQLite probe failed: %s\n", message);
        exit(EXIT_FAILURE);
    }
}

static void execute(sqlite3 *db, const char *sql) {
    char *error = NULL;
    if (sqlite3_exec(db, sql, NULL, NULL, &error) != SQLITE_OK) {
        fprintf(stderr, "SQLite statement failed: %s (%s)\n", sql, error);
        sqlite3_free(error);
        exit(EXIT_FAILURE);
    }
}

static int scalar(sqlite3 *db, const char *sql) {
    sqlite3_stmt *stmt = NULL;
    require(sqlite3_prepare_v2(db, sql, -1, &stmt, NULL) == SQLITE_OK, sql);
    require(sqlite3_step(stmt) == SQLITE_ROW, sql);
    const int value = sqlite3_column_int(stmt, 0);
    require(sqlite3_step(stmt) == SQLITE_DONE, sql);
    require(sqlite3_finalize(stmt) == SQLITE_OK, sql);
    return value;
}

static void observe(void *data, sqlite3 *db, int op, const char *schema,
                    const char *table, sqlite3_int64 oldRow, sqlite3_int64 newRow) {
    Changes *changes = data;
    const int depth = sqlite3_preupdate_depth(db);
    (void)oldRow;
    (void)newRow;

    if (strcmp(schema, "main") != 0) return;
    if (op == SQLITE_DELETE && depth == 0 && strcmp(table, "parent") == 0) {
        changes->parent++;
    } else if (op == SQLITE_DELETE && depth > 0 && strcmp(table, "child") == 0) {
        changes->cascadedChild++;
    } else if (op == SQLITE_INSERT && depth > 0 && strcmp(table, "audit") == 0) {
        changes->triggeredAudit++;
    }
}

static void expectConstraint(sqlite3 *db, const char *sql) {
    const int result = sqlite3_exec(db, sql, NULL, NULL, NULL);
    require((result & 0xff) == SQLITE_CONSTRAINT, sql);
    require(sqlite3_get_autocommit(db) == 0, "uniqueness failure must leave transaction active");
}

int main(int argc, char **argv) {
    sqlite3 *writer = NULL;
    sqlite3 *reader = NULL;
    Changes seen = {0};

    require(argc == 2, "pass an unused database path in a disposable directory");
    FILE *existing = fopen(argv[1], "rb");
    if (existing != NULL) {
        fclose(existing);
        require(0, "the fixture database already exists");
    }
    require(sqlite3_open_v2(argv[1], &writer, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL) == SQLITE_OK,
            "open fixture writer");
    execute(writer,
        "PRAGMA journal_mode=WAL;"
        "PRAGMA foreign_keys=ON;"
        "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
        "CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);"
        "CREATE TABLE audit(child_id INTEGER NOT NULL);"
        "CREATE TRIGGER record_child AFTER DELETE ON child BEGIN INSERT INTO audit VALUES(old.id); END;"
        "CREATE TABLE unique_sample(id INTEGER PRIMARY KEY);"
        "INSERT INTO parent VALUES(1), (2);"
        "INSERT INTO child VALUES(10, 1), (20, 2);"
        "INSERT INTO unique_sample VALUES(2);");

    require(sqlite3_open_v2(argv[1], &reader, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK, "open independent reader");
    require(sqlite3_compileoption_used("ENABLE_PREUPDATE_HOOK") != 0, "pre-update hook must be compiled in");
    sqlite3_preupdate_hook(writer, observe, &seen);

    execute(writer, "BEGIN IMMEDIATE; SAVEPOINT change_window; DELETE FROM parent WHERE id = 1;");
    require(seen.parent == 1 && seen.cascadedChild == 1 && seen.triggeredAudit == 1, "observe direct, cascade and trigger");
    require(scalar(reader, "SELECT count(*) FROM parent") == 2, "uncommitted parent change visible");
    require(scalar(reader, "SELECT count(*) FROM audit") == 0, "uncommitted trigger side effect visible");
    execute(writer, "ROLLBACK TO change_window; RELEASE change_window; COMMIT;");
    require(scalar(reader, "SELECT count(*) FROM child") == 2, "savepoint rollback did not restore child");
    require(scalar(reader, "SELECT count(*) FROM audit") == 0, "savepoint rollback left audit entry");
    require(seen.triggeredAudit == 1, "observer callback has no persisted rollback information by itself");

    execute(writer, "BEGIN IMMEDIATE; DELETE FROM parent WHERE id = 1;");
    require(scalar(reader, "SELECT count(*) FROM audit") == 0, "reader saw uncommitted second trigger");
    execute(writer, "COMMIT;");
    require(seen.parent == 2 && seen.cascadedChild == 2 && seen.triggeredAudit == 2, "committed operation hook depths");
    require(scalar(reader, "SELECT count(*) FROM parent WHERE id=1") == 0, "committed parent was not removed");
    require(scalar(reader, "SELECT count(*) FROM child WHERE id=10") == 0, "committed cascade was not applied");
    require(scalar(reader, "SELECT child_id FROM audit") == 10, "exactly one committed trigger event");

    execute(writer, "BEGIN IMMEDIATE;");
    expectConstraint(writer, "INSERT OR FAIL INTO unique_sample VALUES(1), (2), (3)");
    expectConstraint(writer, "INSERT OR ABORT INTO unique_sample VALUES(4), (2), (5)");
    require(scalar(reader, "SELECT count(*) FROM unique_sample") == 1, "reader saw statement prefix before commit");
    execute(writer, "COMMIT;");
    require(scalar(reader, "SELECT count(*) FROM unique_sample WHERE id=1") == 1, "FAIL must keep successful statement prefix");
    require(scalar(reader, "SELECT count(*) FROM unique_sample WHERE id IN (3,4,5)") == 0,
            "FAIL tail and entire ABORT statement must leave no rows");

    require(sqlite3_close(reader) == SQLITE_OK, "close independent reader");
    require(sqlite3_close(writer) == SQLITE_OK, "close fixture writer");
    printf("{\"sqlite\":\"%s\",\"sourceId\":\"%s\",\"cascadeDepthObserved\":true,"
           "\"rollbackToRemovedTriggerEffect\":true,\"committedAuditRows\":1,"
           "\"failKeepsPrefix\":true,\"abortRemovesWholeStatement\":true}\n",
           sqlite3_libversion(), sqlite3_sourceid());
    return EXIT_SUCCESS;
}

