/* B01 fixture. Verifies the Node-API boundary with a real SQLite handle. */
#include <node_api.h>
#include <stdlib.h>

#include "sqlite3.h"

typedef struct {
    sqlite3 *db;
} ProbeHandle;

static const napi_type_tag handle_tag = { UINT64_C(0xbdad032d879a4593), UINT64_C(0xa31b455f191fc037) };

static napi_value fail(napi_env env, const char *message) {
    napi_throw_error(env, NULL, message);
    return NULL;
}

static void dispose(napi_env env, void *data, void *hint) {
    ProbeHandle *handle = data;
    (void)env;
    (void)hint;
    if (handle->db) sqlite3_close_v2(handle->db);
    free(handle);
}

static napi_value open_handle(napi_env env, napi_callback_info info) {
    (void)info;
    ProbeHandle *handle = calloc(1, sizeof(*handle));
    napi_value result;
    if (!handle) return fail(env, "could not allocate probe handle");
    if (sqlite3_open(":memory:", &handle->db) != SQLITE_OK ||
        napi_create_object(env, &result) != napi_ok ||
        napi_wrap(env, result, handle, dispose, NULL, NULL) != napi_ok) {
        dispose(env, handle, NULL);
        return fail(env, "could not open SQLite probe");
    }
    if (napi_type_tag_object(env, result, &handle_tag) != napi_ok) {
        return fail(env, "could not tag SQLite probe handle");
    }
    return result;
}

static ProbeHandle *unwrap_handle(napi_env env, napi_value object) {
    napi_valuetype type;
    bool matches = false;
    void *data = NULL;

    if (napi_typeof(env, object, &type) != napi_ok ||
        type != napi_object ||
        napi_check_object_type_tag(env, object, &handle_tag, &matches) != napi_ok ||
        !matches ||
        napi_unwrap(env, object, &data) != napi_ok ||
        !data) {
        fail(env, "invalid SQLite probe handle");
        return NULL;
    }
    return data;
}

static ProbeHandle *read_handle(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value object;
    if (napi_get_cb_info(env, info, &count, &object, NULL, NULL) != napi_ok || count != 1) {
        fail(env, "invalid SQLite probe handle");
        return NULL;
    }
    return unwrap_handle(env, object);
}

static napi_value roundtrip(napi_env env, napi_callback_info info) {
    ProbeHandle *handle = read_handle(env, info);
    if (!handle) return NULL;
    if (!handle->db) return fail(env, "SQLite probe handle is closed");

    if (sqlite3_exec(handle->db,
            "CREATE TABLE IF NOT EXISTS fixture(value INTEGER);"
            "DELETE FROM fixture;"
            "INSERT INTO fixture VALUES (42);",
            NULL, NULL, NULL) != SQLITE_OK) {
        return fail(env, "failed to write probe row");
    }

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(handle->db, "SELECT value FROM fixture", -1, &stmt, NULL) != SQLITE_OK) {
        return fail(env, "failed to prepare probe read");
    }
    const int step = sqlite3_step(stmt);
    const int value = step == SQLITE_ROW ? sqlite3_column_int(stmt, 0) : 0;
    const int finalize = sqlite3_finalize(stmt);
    napi_value result;
    if (step != SQLITE_ROW || finalize != SQLITE_OK || napi_create_int32(env, value, &result) != napi_ok) {
        return fail(env, "failed to read probe row");
    }
    return result;
}

static napi_value close_handle(napi_env env, napi_callback_info info) {
    ProbeHandle *handle = read_handle(env, info);
    if (!handle) return NULL;
    if (handle->db) {
        if (sqlite3_close(handle->db) != SQLITE_OK) return fail(env, "could not close SQLite probe");
        handle->db = NULL;
    }
    napi_value result;
    if (napi_get_undefined(env, &result) != napi_ok) return fail(env, "could not finish closing SQLite probe");
    return result;
}

static int cancel_query(void *data) {
    (void)data;
    return 1;
}

static napi_value interrupt_query(napi_env env, napi_callback_info info) {
    ProbeHandle *handle = read_handle(env, info);
    if (!handle) return NULL;
    if (!handle->db) return fail(env, "SQLite probe handle is closed");

    sqlite3_progress_handler(handle->db, 1, cancel_query, NULL);
    int rc = sqlite3_exec(handle->db, "SELECT value FROM fixture", NULL, NULL, NULL);
    sqlite3_progress_handler(handle->db, 0, NULL, NULL);
    napi_value interrupted;
    if (napi_get_boolean(env, rc == SQLITE_INTERRUPT, &interrupted) != napi_ok) {
        return fail(env, "could not report probe cancellation");
    }
    return interrupted;
}

static napi_value load_extension(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2];
    char path[4096];
    size_t length = 0;
    if (napi_get_cb_info(env, info, &count, args, NULL, NULL) != napi_ok || count != 2 ||
        napi_get_value_string_utf8(env, args[1], NULL, 0, &length) != napi_ok ||
        length == 0 || length >= sizeof(path) ||
        napi_get_value_string_utf8(env, args[1], path, sizeof(path), &length) != napi_ok) {
        return fail(env, "invalid SQLite probe extension path");
    }
    ProbeHandle *handle = unwrap_handle(env, args[0]);
    if (!handle) return NULL;
    if (!handle->db) return fail(env, "SQLite probe handle is closed");
    if (sqlite3_db_config(handle->db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1, NULL) != SQLITE_OK) {
        return fail(env, "could not enable SQLite probe extension");
    }
    const int loaded = sqlite3_load_extension(handle->db, path, "sqlite3_extension_init", NULL);
    const int disabled = sqlite3_db_config(handle->db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0, NULL);
    sqlite3_stmt *statement = NULL;
    if (loaded != SQLITE_OK || disabled != SQLITE_OK ||
        sqlite3_prepare_v2(handle->db, "SELECT b01_probe_value()", -1, &statement, NULL) != SQLITE_OK) {
        return fail(env, "could not load SQLite probe extension");
    }
    const int step = sqlite3_step(statement);
    const int value = step == SQLITE_ROW ? sqlite3_column_int(statement, 0) : 0;
    const int finalized = sqlite3_finalize(statement);
    napi_value result;
    if (step != SQLITE_ROW || finalized != SQLITE_OK || napi_create_int32(env, value, &result) != napi_ok) {
        return fail(env, "could not call SQLite probe extension");
    }
    return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
    napi_property_descriptor api[] = {
        { "open", NULL, open_handle, NULL, NULL, NULL, napi_default, NULL },
        { "roundtrip", NULL, roundtrip, NULL, NULL, NULL, napi_default, NULL },
        { "interrupt", NULL, interrupt_query, NULL, NULL, NULL, napi_default, NULL },
        { "loadExtension", NULL, load_extension, NULL, NULL, NULL, napi_default, NULL },
        { "close", NULL, close_handle, NULL, NULL, NULL, napi_default, NULL },
    };
    napi_value version;
    if (napi_create_string_utf8(env, sqlite3_libversion(), NAPI_AUTO_LENGTH, &version) != napi_ok ||
        napi_set_named_property(env, exports, "sqliteVersion", version) != napi_ok ||
        napi_define_properties(env, exports, sizeof(api) / sizeof(api[0]), api) != napi_ok) {
        return fail(env, "could not initialize SQLite probe");
    }
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)

