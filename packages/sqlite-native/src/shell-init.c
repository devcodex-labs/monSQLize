#include <stdio.h>
#include <stdlib.h>
#include <sqlite3.h>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#endif

extern const char *monsqlize_sqlite_engine_build_hash(void);

static void read_engine_hash(sqlite3_context *context, int argc, sqlite3_value **argv) {
    (void)argc;
    (void)argv;
    sqlite3_result_text(context, monsqlize_sqlite_engine_build_hash(), -1, SQLITE_STATIC);
}

static int initialize_connection(sqlite3 *db, char **error, const sqlite3_api_routines *api) {
    (void)error;
    (void)api;
    return sqlite3_create_function_v2(db, "monsqlize_engine_build_hash", 0,
        SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_DIRECTONLY, NULL,
        read_engine_hash, NULL, NULL, NULL);
}

void monsqlize_sqlite_shell_init(void) {
    int rc = sqlite3_auto_extension((void (*)(void))initialize_connection);
    if (rc != SQLITE_OK) {
        fprintf(stderr, "Could not register SQLite build diagnostics: %s\n", sqlite3_errstr(rc));
        exit(EXIT_FAILURE);
    }
}

#ifdef _WIN32
extern int monsqlize_sqlite_shell_main(int argc, char **argv);

static char *utf8_argument(const wchar_t *value) {
    const int flags = WC_ERR_INVALID_CHARS;
    int size = WideCharToMultiByte(CP_UTF8, flags, value, -1, NULL, 0, NULL, NULL);
    if (size == 0) return NULL;
    char *converted = malloc((size_t)size);
    if (converted && WideCharToMultiByte(CP_UTF8, flags, value, -1, converted, size, NULL, NULL) == 0) {
        free(converted);
        return NULL;
    }
    return converted;
}

int main(void) {
    // The MinGW shell entry receives ANSI argv. SQLite needs UTF-8 paths and SQL.
    int argc = 0;
    wchar_t **wide = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!wide) {
        fputs("Could not read SQLite command-line arguments\n", stderr);
        return EXIT_FAILURE;
    }
    char **argv = calloc((size_t)argc + 1, sizeof(*argv));
    int converted = 0;
    while (argv && converted < argc) {
        argv[converted] = utf8_argument(wide[converted]);
        if (!argv[converted]) break;
        converted++;
    }
    LocalFree(wide);
    int rc = EXIT_FAILURE;
    if (argv && converted == argc) rc = monsqlize_sqlite_shell_main(argc, argv);
    else fputs("Could not convert SQLite command-line arguments to UTF-8\n", stderr);
    for (int i = 0; i < converted; i++) free(argv[i]);
    free(argv);
    return rc;
}
#endif
