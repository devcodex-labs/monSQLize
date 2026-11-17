/* Windows-local Q2 probe. Permissions apply only to the supplied private fixture directory. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#include <windows.h>
#include <shellapi.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

static HANDLE process_token;
static HANDLE reader_token;
static TOKEN_USER *identity;
static PSID restricted_sid;
static PSID owner_rights;
static int impersonating;

static void require(int ok, const char *message) {
    if (ok) return;
    DWORD error = GetLastError();
    if (impersonating) RevertToSelf();
    fprintf(stderr, "%s (Windows error %lu)\n", message, error);
    exit(EXIT_FAILURE);
}

static void execute(sqlite3 *db, const char *sql) {
    char *detail = NULL;
    int code = sqlite3_exec(db, sql, NULL, NULL, &detail);
    if (code != SQLITE_OK) {
        if (impersonating) RevertToSelf();
        fprintf(stderr, "%s: %s (%d)\n", sql, detail ? detail : sqlite3_errmsg(db), code);
        sqlite3_free(detail);
        exit(EXIT_FAILURE);
    }
}

static int scalar(sqlite3 *db, const char *sql) {
    sqlite3_stmt *statement = NULL;
    require(sqlite3_prepare_v2(db, sql, -1, &statement, NULL) == SQLITE_OK, sql);
    require(sqlite3_step(statement) == SQLITE_ROW, sql);
    int value = sqlite3_column_int(statement, 0);
    require(sqlite3_finalize(statement) == SQLITE_OK, sql);
    return value;
}

static wchar_t *wide(const char *input) {
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, NULL, 0);
    require(count > 0, "convert fixture path length");
    wchar_t *result = calloc((size_t)count, sizeof(*result));
    require(result && MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input, -1, result, count), "convert fixture path");
    return result;
}

static char *utf8(const wchar_t *input) {
    int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input, -1, NULL, 0, NULL, NULL);
    require(count > 0, "convert wide fixture argument length");
    char *result = calloc((size_t)count, 1);
    require(result && WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input, -1, result, count, NULL, NULL),
        "convert wide fixture argument");
    return result;
}

static char *within(const char *folder, const char *name) {
    size_t length = strlen(folder) + strlen(name) + 2;
    char *result = malloc(length);
    require(result != NULL, "allocate fixture path");
    snprintf(result, length, "%s/%s", folder, name);
    return result;
}

static void enter_reader(void) {
    require(ImpersonateLoggedOnUser(reader_token), "enter restricted reader context");
    impersonating = 1;
}

static void leave_reader(void) {
    require(RevertToSelf(), "restore writer context");
    impersonating = 0;
}

static void permission_probe(const char *file, DWORD access, DWORD disposition, const char *description) {
    wchar_t *name = wide(file);
    HANDLE opened = CreateFileW(name, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, disposition, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    DWORD error = GetLastError();
    free(name);
    if (opened != INVALID_HANDLE_VALUE) {
        CloseHandle(opened);
        require(0, description);
    }
    require(error == ERROR_ACCESS_DENIED, description);
}

static void permission_allowed(const char *file, DWORD access, const char *description) {
    wchar_t *name = wide(file);
    HANDLE opened = CreateFileW(name, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    free(name);
    require(opened != INVALID_HANDLE_VALUE, description);
    require(CloseHandle(opened), "close allowed fixture handle");
}

static void create_reader_token(void) {
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &process_token), "read process security token");
    DWORD needed = 0;
    GetTokenInformation(process_token, TokenUser, NULL, 0, &needed);
    require(needed > 0, "size current identity");
    identity = malloc(needed);
    require(identity && GetTokenInformation(process_token, TokenUser, identity, needed, &needed), "read current identity");
    require(ConvertStringSidToSidW(L"S-1-5-21-0-0-0-61001", &restricted_sid), "fixture restricting SID");
    require(ConvertStringSidToSidW(L"S-1-3-4", &owner_rights), "owner rights SID");
    SID_AND_ATTRIBUTES restriction = { restricted_sid, 0 };
    require(CreateRestrictedToken(process_token, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 1, &restriction, &reader_token),
        "create separate restricted security context");
}

static void secure_directory(const char *folder, int reader_writes) {
    EXPLICIT_ACCESSW entries[3] = {0};
    PSID trustees[] = { identity->User.Sid, restricted_sid, owner_rights };
    DWORD permissions[] = { FILE_ALL_ACCESS, reader_writes ? FILE_ALL_ACCESS : FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, READ_CONTROL };
    for (int index = 0; index < 3; index++) {
        entries[index].grfAccessPermissions = permissions[index];
        entries[index].grfAccessMode = GRANT_ACCESS;
        entries[index].grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
        BuildTrusteeWithSidW(&entries[index].Trustee, trustees[index]);
    }
    PACL acl = NULL;
    require(SetEntriesInAclW(3, entries, NULL, &acl) == ERROR_SUCCESS, "construct fixture ACL");
    wchar_t *name = wide(folder);
    DWORD code = SetNamedSecurityInfoW(name, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        NULL, NULL, acl, NULL);
    free(name);
    LocalFree(acl);
    require(code == ERROR_SUCCESS, "set isolated fixture directory permissions");
}

static void write_rejected(const char *file) {
    sqlite3 *db = NULL;
    int opened = sqlite3_open_v2(file, &db, SQLITE_OPEN_READWRITE, NULL);
    if (opened == SQLITE_OK) {
        int active;
        require(sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, &active) == SQLITE_OK && active == 0,
            "disable trigger guard in ordinary client");
        int code = sqlite3_exec(db, "UPDATE complex_rows SET amount=99", NULL, NULL, NULL);
        require((code & 0xff) == SQLITE_READONLY || (code & 0xff) == SQLITE_CANTOPEN, "restricted complex write rejected");
        code = sqlite3_exec(db, "UPDATE mixed_simple SET amount=99", NULL, NULL, NULL);
        require((code & 0xff) == SQLITE_READONLY || (code & 0xff) == SQLITE_CANTOPEN, "restricted mixed simple write rejected");
    } else {
        require((opened & 0xff) == SQLITE_READONLY || (opened & 0xff) == SQLITE_CANTOPEN, "restricted read-write open rejected");
    }
    require(sqlite3_close(db) == SQLITE_OK, "close rejected client");
}

int main(void) {
    int argc;
    wchar_t **arguments = CommandLineToArgvW(GetCommandLineW(), &argc);
    require(arguments != NULL, "read Unicode fixture arguments");
    require(argc == 3, "provide the protected and independent simple fixture directories");
    char *protected_path = utf8(arguments[1]);
    char *simple_path = utf8(arguments[2]);
    LocalFree(arguments);
    create_reader_token();
    char *legacy_file = within(protected_path, "legacy-capability.fixture");
    wchar_t *legacy_name = wide(legacy_file);
    HANDLE previous_write = CreateFileW(legacy_name, GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    free(legacy_name);
    require(previous_write != INVALID_HANDLE_VALUE, "create pre-granted write handle before establishing ACL");
    secure_directory(protected_path, 0);
    secure_directory(simple_path, 1);
    char *file = within(protected_path, "complex.sqlite");
    char *wal = within(protected_path, "complex.sqlite-wal");
    char *shm = within(protected_path, "complex.sqlite-shm");
    char *journal = within(protected_path, "complex.sqlite-journal");
    char *replacement = within(protected_path, "replacement.sqlite");
    sqlite3 *writer = NULL;
    sqlite3 *reader = NULL;
    char *simple_file = within(simple_path, "simple.sqlite");
    sqlite3 *simple = NULL;
    require(sqlite3_open(simple_file, &simple) == SQLITE_OK, "create independent simple file");
    execute(simple, "CREATE TABLE simple(id INTEGER PRIMARY KEY,amount INT); CREATE TABLE events(id INT);"
        "INSERT INTO simple VALUES(1,20); CREATE TRIGGER simple_audit AFTER UPDATE ON simple BEGIN INSERT INTO events VALUES(NEW.id); END;");
    require(sqlite3_close(simple) == SQLITE_OK, "close simple setup");
    simple = NULL;
    require(sqlite3_open(file, &writer) == SQLITE_OK, "open controlled writer");
    execute(writer, "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;"
        "CREATE TABLE complex_rows(id INTEGER PRIMARY KEY,amount INT);"
        "CREATE TABLE mixed_simple(id INTEGER PRIMARY KEY,amount INT);"
        "CREATE TABLE events(id INTEGER);"
        "INSERT INTO complex_rows VALUES(1,10); INSERT INTO mixed_simple VALUES(1,20);"
        "CREATE TRIGGER complex_audit AFTER UPDATE ON complex_rows BEGIN INSERT INTO events VALUES(NEW.id); END;"
        "UPDATE complex_rows SET amount=11;");
    const DWORD directory_rights[] = { WRITE_DAC, FILE_DELETE_CHILD, DELETE, WRITE_OWNER, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY };
    const DWORD file_rights[] = { FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_ATTRIBUTES, FILE_WRITE_EA, DELETE, WRITE_DAC, WRITE_OWNER };
    const char *assets[] = { file, wal, shm };
    for (size_t index = 0; index < sizeof(directory_rights) / sizeof(directory_rights[0]); index++) {
        permission_allowed(protected_path, directory_rights[index], "owner can acquire each tested directory permission");
    }
    for (size_t asset = 0; asset < sizeof(assets) / sizeof(assets[0]); asset++) {
        for (size_t right = 0; right < sizeof(file_rights) / sizeof(file_rights[0]); right++) {
            // Open SQLite handles deny delete sharing. Check delete permissions after both handles close.
            if (file_rights[right] != DELETE) {
                permission_allowed(assets[asset], file_rights[right], "owner can acquire each live file and sidecar permission");
            }
        }
    }

    enter_reader();
    DWORD written = 0;
    require(WriteFile(previous_write, "old", 3, &written, NULL) && written == 3,
        "pre-granted handle demonstrates the required migration drain");
    require(CloseHandle(previous_write), "drain the previous write handle before declaring protection");
    permission_probe(legacy_file, FILE_WRITE_DATA, OPEN_EXISTING, "after draining, new write capability is denied");
    require(sqlite3_open_v2(file, &reader, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK, "restricted native readonly open");
    require(scalar(reader, "SELECT amount FROM complex_rows") == 11, "restricted reader sees current committed WAL");
    require(scalar(reader, "SELECT amount FROM mixed_simple") == 20, "mixed-file simple table read preserved");
    int enabled;
    require(sqlite3_db_config(reader, SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, &enabled) == SQLITE_OK && enabled == 0,
        "ordinary reader disables persistent trigger execution");
    require(sqlite3_exec(reader, "UPDATE complex_rows SET amount=99", NULL, NULL, NULL) == SQLITE_READONLY,
        "disabled triggers cannot bypass native readonly connection");
    write_rejected(file);
    require(scalar(reader, "SELECT amount FROM complex_rows") == 11, "independent restricted reader verifies no complex effect");
    require(scalar(reader, "SELECT amount FROM mixed_simple") == 20, "independent restricted reader verifies no simple effect");
    require(scalar(reader, "SELECT count(*) FROM events") == 1, "independent restricted reader verifies no added event");
    permission_probe(file, GENERIC_WRITE, OPEN_EXISTING, "database write handle denied");
    permission_probe(wal, GENERIC_WRITE, OPEN_EXISTING, "WAL write handle denied");
    permission_probe(shm, GENERIC_WRITE, OPEN_EXISTING, "SHM write handle denied");
    permission_probe(journal, GENERIC_WRITE, CREATE_NEW, "rollback journal creation denied");
    permission_probe(replacement, GENERIC_WRITE, CREATE_NEW, "replacement file creation denied");
    permission_probe(file, WRITE_DAC, OPEN_EXISTING, "changing database permissions denied");
    permission_probe(file, WRITE_OWNER, OPEN_EXISTING, "changing database owner denied");
    permission_probe(file, DELETE, OPEN_EXISTING, "database delete handle denied");
    for (size_t index = 0; index < sizeof(directory_rights) / sizeof(directory_rights[0]); index++) {
        permission_probe(protected_path, directory_rights[index], OPEN_EXISTING, "each directory mutation permission denied separately");
    }
    for (size_t asset = 0; asset < sizeof(assets) / sizeof(assets[0]); asset++) {
        for (size_t right = 0; right < sizeof(file_rights) / sizeof(file_rights[0]); right++) {
            permission_probe(assets[asset], file_rights[right], OPEN_EXISTING, "each file and sidecar mutation permission denied separately");
        }
    }
    wchar_t *old = wide(file);
    wchar_t *next = wide(replacement);
    require(!DeleteFileW(old) && GetLastError() == ERROR_ACCESS_DENIED, "database deletion denied");
    require(!MoveFileExW(old, next, MOVEFILE_REPLACE_EXISTING) && GetLastError() == ERROR_ACCESS_DENIED, "database replacement denied");
    free(next);
    free(old);
    require(sqlite3_close(reader) == SQLITE_OK, "close restricted reader");
    reader = NULL;
    require(sqlite3_open_v2(simple_file, &simple, SQLITE_OPEN_READWRITE, NULL) == SQLITE_OK, "standard client opens independent simple file writable");
    execute(simple, "UPDATE simple SET amount=21");
    require(sqlite3_close(simple) == SQLITE_OK, "close standard simple writer");
    simple = NULL;
    leave_reader();

    require(scalar(writer, "SELECT amount FROM complex_rows") == 11, "complex business row unchanged");
    require(scalar(writer, "SELECT amount FROM mixed_simple") == 20, "mixed-file simple row unchanged");
    require(scalar(writer, "SELECT count(*) FROM events") == 1, "rejected clients left zero added events");
    execute(writer, "UPDATE complex_rows SET amount=12");
    require(scalar(writer, "SELECT amount FROM complex_rows") == 12 && scalar(writer, "SELECT count(*) FROM events") == 2,
        "controlled identity continues writing with its capture");
    require(sqlite3_close(writer) == SQLITE_OK, "close controlled writer");
    writer = NULL;
    for (size_t index = 1; index < sizeof(assets) / sizeof(assets[0]); index++) {
        wchar_t *name = wide(assets[index]);
        HANDLE sidecar = CreateFileW(name, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        free(name);
        require(sidecar != INVALID_HANDLE_VALUE && CloseHandle(sidecar), "create inherited closed sidecar fixture");
    }
    for (size_t asset = 0; asset < sizeof(assets) / sizeof(assets[0]); asset++) {
        permission_allowed(assets[asset], DELETE, "owner can acquire delete right with SQLite handles closed");
    }
    enter_reader();
    for (size_t asset = 0; asset < sizeof(assets) / sizeof(assets[0]); asset++) {
        permission_probe(assets[asset], DELETE, OPEN_EXISTING, "file and regenerated sidecar delete independently denied by ACL");
    }
    leave_reader();
    for (size_t index = 1; index < sizeof(assets) / sizeof(assets[0]); index++) {
        wchar_t *name = wide(assets[index]);
        require(DeleteFileW(name), "owner removes the closed sidecar test files");
        free(name);
    }
    require(sqlite3_open(file, &writer) == SQLITE_OK, "controlled writer reopens after checkpoint and sidecar recreation");
    execute(writer, "UPDATE complex_rows SET amount=13");
    enter_reader();
    require(sqlite3_open_v2(file, &reader, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK, "restricted reader reopens regenerated WAL");
    require(scalar(reader, "SELECT amount FROM complex_rows") == 13 && scalar(reader, "SELECT count(*) FROM events") == 3,
        "new sidecar generation remains visible under readonly permissions");
    require(sqlite3_close(reader) == SQLITE_OK, "close restricted reader after sidecar regeneration");
    reader = NULL;
    leave_reader();
    require(sqlite3_close(writer) == SQLITE_OK, "close reopened controlled writer");
    writer = NULL;
    require(sqlite3_open_v2(simple_file, &simple, SQLITE_OPEN_READONLY, NULL) == SQLITE_OK, "independent simple readback");
    require(scalar(simple, "SELECT amount FROM simple") == 21 && scalar(simple, "SELECT count(*) FROM events") == 1,
        "standard simple write and trigger capture independently visible");
    require(sqlite3_close(simple) == SQLITE_OK, "close independent simple reader");
    CloseHandle(reader_token);
    CloseHandle(process_token);
    LocalFree(restricted_sid);
    LocalFree(owner_rights);
    free(identity);
    free(file); free(wal); free(shm); free(journal); free(replacement); free(simple_file);
    free(legacy_file);
    free(protected_path); free(simple_path);
    printf("{\"sqliteSource\":\"%s\",\"windowsRestrictedContext\":true,\"nativeReadActiveWal\":true,"
        "\"disabledTriggerWriteRejectedByFilePermissions\":true,\"mixedSimpleWriteRejected\":true,"
        "\"sidecarsAndDirectoryProtected\":true,\"externalWrites\":0,\"externalEvents\":0,\"trustedWriteAfterwards\":true,"
        "\"independentSimpleFileNativeWriteAndCapture\":true,\"regeneratedWalReadonly\":true,"
        "\"preGrantedHandleRequiresDrain\":true,\"newWriteDeniedAfterDrain\":true}\n",
        sqlite3_sourceid());
    return EXIT_SUCCESS;
}
