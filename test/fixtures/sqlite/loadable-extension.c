#include <sqlite3ext.h>

SQLITE_EXTENSION_INIT1

static void probe_value(sqlite3_context *context, int argc, sqlite3_value **argv) {
    (void)argc;
    (void)argv;
    sqlite3_result_int(context, 54);
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db, char **message, const sqlite3_api_routines *api) {
    (void)message;
    SQLITE_EXTENSION_INIT2(api);
    return sqlite3_create_function(db, "b01_probe_value", 0, SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS,
                                   0, probe_value, 0, 0);
}
