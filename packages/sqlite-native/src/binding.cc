#include <node_api.h>
#include <sqlite3.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <variant>
#include <vector>

extern "C" const char *monsqlize_sqlite_engine_build_hash(void);

namespace {

using Bytes = std::vector<unsigned char>;
using Value = std::variant<std::nullptr_t, int64_t, double, std::string, Bytes>;
enum class Action { Open, Execute, CommitBefore, LoadExtension, Close };

struct Work;

struct Connection {
    sqlite3 *db = nullptr;
    Work *active = nullptr; // Read and changed only on the JavaScript thread.
    uint64_t lastToken = 0;

    ~Connection() {
        if (db) sqlite3_close_v2(db);
    }
};

struct Work {
    Action action;
    std::unique_ptr<Connection> opening;
    Connection *connection = nullptr;
    napi_ref handle = nullptr;
    napi_async_work async = nullptr;
    napi_deferred promise = nullptr;
    uint64_t token = 0;
    int64_t commitDeadline = 0;
    std::atomic<bool> interrupted{false};
    std::atomic<bool> progressed{false};
    std::string input;
    std::vector<Value> bindings;
    int flags = 0;
    int busyTimeout = 0;
    int code = SQLITE_OK;
    std::string error;
    std::vector<std::string> columns;
    std::vector<std::vector<Value>> rows;
    int64_t totalChanges = 0;
};

const napi_type_tag connectionTag = { 0x9e227602cc904fd5ULL, 0xb94bb570eeb968a1ULL };

void check(napi_status status) {
    if (status != napi_ok) throw std::runtime_error("Node-API bridge operation failed");
}

napi_value string(napi_env env, const std::string &input) {
    napi_value value;
    check(napi_create_string_utf8(env, input.data(), input.size(), &value));
    return value;
}

std::string readString(napi_env env, napi_value value) {
    size_t length;
    check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
    std::string input(length + 1, '\0');
    check(napi_get_value_string_utf8(env, value, input.data(), input.size(), &length));
    input.resize(length);
    return input;
}

napi_value integer(napi_env env, int64_t input) {
    napi_value value;
    check(napi_create_bigint_int64(env, input, &value));
    return value;
}

uint64_t readToken(napi_env env, napi_value input) {
    uint64_t token;
    bool exact;
    check(napi_get_value_bigint_uint64(env, input, &token, &exact));
    if (!exact || token == 0) throw std::invalid_argument("invalid SQLite operation token");
    return token;
}

Value readValue(napi_env env, napi_value input) {
    bool buffer;
    check(napi_is_buffer(env, input, &buffer));
    if (buffer) {
        void *data;
        size_t size;
        check(napi_get_buffer_info(env, input, &data, &size));
        if (size == 0) return Bytes{};
        const auto *bytes = static_cast<const unsigned char *>(data);
        return Bytes(bytes, bytes + size);
    }

    napi_valuetype type;
    check(napi_typeof(env, input, &type));
    switch (type) {
        case napi_null:
            return nullptr;
        case napi_string:
            return readString(env, input);
        case napi_bigint: {
            int64_t value;
            bool exact;
            check(napi_get_value_bigint_int64(env, input, &value, &exact));
            if (!exact) throw std::range_error("SQLite INTEGER is outside the signed 64-bit range");
            return value;
        }
        case napi_number: {
            double value;
            check(napi_get_value_double(env, input, &value));
            if (!std::isfinite(value)) throw std::range_error("SQLite REAL must be finite");
            return value;
        }
        default:
            throw std::invalid_argument("unsupported SQLite foundation binding");
    }
}

int bindValue(sqlite3_stmt *stmt, int slot, const Value &input) {
    if (const auto *value = std::get_if<int64_t>(&input)) return sqlite3_bind_int64(stmt, slot, *value);
    if (const auto *value = std::get_if<double>(&input)) return sqlite3_bind_double(stmt, slot, *value);
    if (const auto *value = std::get_if<std::string>(&input)) {
        return sqlite3_bind_text64(stmt, slot, value->data(), value->size(), SQLITE_TRANSIENT, SQLITE_UTF8);
    }
    if (const auto *value = std::get_if<Bytes>(&input)) {
        static const unsigned char empty = 0;
        const void *bytes = value->empty() ? &empty : value->data();
        return sqlite3_bind_blob64(stmt, slot, bytes, value->size(), SQLITE_TRANSIENT);
    }
    return sqlite3_bind_null(stmt, slot);
}

Value readColumn(sqlite3_stmt *stmt, int column) {
    switch (sqlite3_column_type(stmt, column)) {
        case SQLITE_INTEGER:
            return static_cast<int64_t>(sqlite3_column_int64(stmt, column));
        case SQLITE_FLOAT:
            return sqlite3_column_double(stmt, column);
        case SQLITE_TEXT: {
            const auto *data = reinterpret_cast<const char *>(sqlite3_column_text(stmt, column));
            const int size = sqlite3_column_bytes(stmt, column);
            return data ? std::string(data, size) : std::string();
        }
        case SQLITE_BLOB: {
            const auto *data = static_cast<const unsigned char *>(sqlite3_column_blob(stmt, column));
            const int size = sqlite3_column_bytes(stmt, column);
            return size ? Bytes(data, data + size) : Bytes();
        }
        default:
            return nullptr;
    }
}

napi_value writeValue(napi_env env, const Value &input) {
    if (const auto *value = std::get_if<int64_t>(&input)) return integer(env, *value);
    if (const auto *value = std::get_if<std::string>(&input)) return string(env, *value);
    napi_value output;
    if (const auto *value = std::get_if<double>(&input)) {
        check(napi_create_double(env, *value, &output));
    } else if (const auto *value = std::get_if<Bytes>(&input)) {
        static const unsigned char empty = 0;
        check(napi_create_buffer_copy(env, value->size(), value->empty() ? &empty : value->data(), nullptr, &output));
    } else {
        check(napi_get_null(env, &output));
    }
    return output;
}

void recordFailure(Work &work, int code) {
    work.code = code;
    work.error = sqlite3_errmsg(work.connection->db);
}

int progress(void *data) {
    auto &work = *static_cast<Work *>(data);
    work.progressed.store(true, std::memory_order_relaxed);
    return work.interrupted.load(std::memory_order_relaxed);
}

struct ProgressHandler {
    sqlite3 *db;
    explicit ProgressHandler(Work &work) : db(work.connection->db) {
        sqlite3_progress_handler(db, 1000, progress, &work);
    }
    ~ProgressHandler() { sqlite3_progress_handler(db, 0, nullptr, nullptr); }
};

bool onlyTrailingTrivia(const char *tail) {
    while (*tail) {
        if (std::strchr(" \t\n\r\v\f;", *tail)) {
            ++tail;
        } else if (tail[0] == '-' && tail[1] == '-') {
            while (*tail && *tail != '\n') ++tail;
        } else if (tail[0] == '/' && tail[1] == '*') {
            const char *end = std::strstr(tail + 2, "*/");
            if (!end) return true; // SQLite treats an unclosed trailing block comment as trivia.
            tail = end + 2;
        } else {
            return false;
        }
    }
    return true;
}

bool containsMultipleStatements(std::string &sql) {
    for (auto semicolon = sql.find(';'); semicolon != std::string::npos; semicolon = sql.find(';', semicolon + 1)) {
        if (semicolon + 1 == sql.size()) return false;
        char *after = sql.data() + semicolon + 1;
        const char saved = *after;
        *after = '\0';
        // SQLite recognizes quoted semicolons and the terminator of a CREATE TRIGGER body.
        const bool complete = sqlite3_complete(sql.c_str()) != 0 && !onlyTrailingTrivia(sql.c_str());
        *after = saved;
        if (complete) return !onlyTrailingTrivia(after);
    }
    return false;
}

void executeStatement(Work &work) {
    sqlite3 *db = work.connection->db;
    if (work.interrupted.load(std::memory_order_relaxed)) {
        work.code = SQLITE_INTERRUPT;
        work.error = sqlite3_errstr(SQLITE_INTERRUPT);
        return;
    }
    // Some SQLite PRAGMA statements apply changes during prepare.
    if (containsMultipleStatements(work.input)) throw std::invalid_argument("expected one SQLite statement");
    ProgressHandler progressHandler(work);
    sqlite3_stmt *raw = nullptr;
    const char *tail = nullptr;
    const int prepared = sqlite3_prepare_v3(db, work.input.c_str(), -1, 0, &raw, &tail);
    std::unique_ptr<sqlite3_stmt, decltype(&sqlite3_finalize)> stmt(raw, sqlite3_finalize);
    if (prepared != SQLITE_OK) return recordFailure(work, prepared);
    if (!stmt || !onlyTrailingTrivia(tail)) throw std::invalid_argument("expected one SQLite statement");

    const auto slots = static_cast<size_t>(sqlite3_bind_parameter_count(raw));
    if (slots != work.bindings.size()) throw std::invalid_argument("SQLite binding count does not match the statement");
    for (size_t i = 0; i < slots; ++i) {
        int code = bindValue(raw, static_cast<int>(i) + 1, work.bindings[i]);
        if (code != SQLITE_OK) return recordFailure(work, code);
    }

    const int64_t before = sqlite3_total_changes64(db);
    int step = sqlite3_step(raw);
    if (step != SQLITE_ROW && step != SQLITE_DONE) return recordFailure(work, step);
    // Column names may change when SQLite automatically recompiles a statement.
    const int count = sqlite3_column_count(raw);
    for (int i = 0; i < count; ++i) {
        const char *name = sqlite3_column_name(raw, i);
        if (!name) return recordFailure(work, SQLITE_NOMEM);
        work.columns.emplace_back(name);
    }
    while (step == SQLITE_ROW) {
        std::vector<Value> row;
        for (int i = 0; i < count; ++i) row.emplace_back(readColumn(raw, i));
        work.rows.push_back(std::move(row));
        step = sqlite3_step(raw);
    }
    if (step != SQLITE_DONE) return recordFailure(work, step);
    work.totalChanges = sqlite3_total_changes64(db) - before;
}

struct CommitDeadline {
    sqlite3_vfs *vfs;
    sqlite3_int64 unixMilliseconds;
};

int rejectExpiredCommit(void *context) {
    const auto &deadline = *static_cast<CommitDeadline *>(context);
    constexpr sqlite3_int64 unixEpochOnJulianClock = 210866760000000LL;
    sqlite3_int64 now;
    if (deadline.vfs->xCurrentTimeInt64(deadline.vfs, &now) != SQLITE_OK) return 1;
    if (now < unixEpochOnJulianClock) return 1;
    return now - unixEpochOnJulianClock >= deadline.unixMilliseconds;
}

void commitBeforeDeadline(Work &work) {
    sqlite3 *db = work.connection->db;
    if (sqlite3_txn_state(db, "main") != SQLITE_TXN_WRITE) {
        work.code = SQLITE_MISUSE;
        work.error = "SQLite commit deadline requires an active main database write transaction";
        return;
    }
    sqlite3_vfs *vfs = nullptr;
    if (sqlite3_file_control(db, "main", SQLITE_FCNTL_VFS_POINTER, &vfs) != SQLITE_OK ||
        !vfs || vfs->iVersion < 2 || !vfs->xCurrentTimeInt64) {
        work.code = SQLITE_ERROR;
        work.error = "SQLite commit deadline requires a millisecond database clock";
        return;
    }

    // The connection worker owns this commit hook. Its callback only reads the VFS clock.
    CommitDeadline deadline{vfs, work.commitDeadline};
    sqlite3_commit_hook(db, rejectExpiredCommit, &deadline);
    const int code = sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
    sqlite3_commit_hook(db, nullptr, nullptr);
    if (code != SQLITE_OK) recordFailure(work, code);
}

void runWork(napi_env, void *data) {
    auto &work = *static_cast<Work *>(data);
    auto &connection = *work.connection;
    try {
        switch (work.action) {
            case Action::Open: {
                int code = sqlite3_open_v2(work.input.c_str(), &connection.db, work.flags | SQLITE_OPEN_FULLMUTEX, nullptr);
                if (code != SQLITE_OK) return recordFailure(work, code);
                sqlite3_extended_result_codes(connection.db, 1);
                code = sqlite3_busy_timeout(connection.db, work.busyTimeout);
                if (code != SQLITE_OK) recordFailure(work, code);
                break;
            }
            case Action::Execute:
                executeStatement(work);
                break;
            case Action::CommitBefore:
                commitBeforeDeadline(work);
                break;
            case Action::LoadExtension: {
                auto *db = connection.db;
                int code = sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 1, nullptr);
                if (code != SQLITE_OK) return recordFailure(work, code);
                char *message = nullptr;
                code = sqlite3_load_extension(db, work.input.c_str(), "sqlite3_extension_init", &message);
                std::unique_ptr<char, decltype(&sqlite3_free)> detail(message, sqlite3_free);
                const int disabled = sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0, nullptr);
                if (code != SQLITE_OK) {
                    work.code = code;
                    work.error = detail ? detail.get() : sqlite3_errmsg(db);
                } else if (disabled != SQLITE_OK) {
                    recordFailure(work, disabled);
                }
                break;
            }
            case Action::Close: {
                int code = sqlite3_close(connection.db);
                if (code == SQLITE_OK) connection.db = nullptr;
                else recordFailure(work, code);
                break;
            }
        }
    } catch (const std::exception &error) {
        work.code = SQLITE_ERROR;
        work.error = error.what();
    }
}

void disposeConnection(napi_env, void *data, void *) {
    delete static_cast<Connection *>(data);
}

napi_value resultValue(napi_env env, Work &work) {
    napi_value value;
    if (work.action == Action::Open) {
        check(napi_create_object(env, &value));
        check(napi_type_tag_object(env, value, &connectionTag));
        check(napi_wrap(env, value, work.opening.get(), disposeConnection, nullptr, nullptr));
        work.opening.release();
        return value;
    }
    if (work.action != Action::Execute) {
        check(napi_get_undefined(env, &value));
        return value;
    }
    napi_value columns, rows;
    check(napi_create_object(env, &value));
    check(napi_create_array_with_length(env, work.columns.size(), &columns));
    check(napi_create_array_with_length(env, work.rows.size(), &rows));
    for (size_t i = 0; i < work.columns.size(); ++i) {
        check(napi_set_element(env, columns, i, string(env, work.columns[i])));
    }
    for (size_t i = 0; i < work.rows.size(); ++i) {
        const auto &cells = work.rows[i];
        napi_value row;
        check(napi_create_array_with_length(env, cells.size(), &row));
        for (size_t j = 0; j < cells.size(); ++j) check(napi_set_element(env, row, j, writeValue(env, cells[j])));
        check(napi_set_element(env, rows, i, row));
    }
    check(napi_set_named_property(env, value, "columns", columns));
    check(napi_set_named_property(env, value, "rows", rows));
    check(napi_set_named_property(env, value, "totalChanges", integer(env, work.totalChanges)));
    return value;
}

void reject(napi_env env, Work &work, const char *message) {
    napi_value error;
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) {
        if (napi_get_and_clear_last_exception(env, &error) == napi_ok) napi_reject_deferred(env, work.promise, error);
        return;
    }
    napi_value description, code, extended;
    if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &description) != napi_ok ||
        napi_create_error(env, nullptr, description, &error) != napi_ok) return;
    if (napi_create_int32(env, work.code & 0xff, &code) == napi_ok) napi_set_named_property(env, error, "code", code);
    if (napi_create_int32(env, work.code, &extended) == napi_ok) napi_set_named_property(env, error, "extendedCode", extended);
    napi_reject_deferred(env, work.promise, error);
}

void complete(napi_env env, napi_status status, void *data) {
    std::unique_ptr<Work> work(static_cast<Work *>(data));
    work->connection->active = nullptr;
    try {
        if (status != napi_ok) throw std::runtime_error("SQLite async work did not complete");
        if (work->code == SQLITE_OK) check(napi_resolve_deferred(env, work->promise, resultValue(env, *work)));
        else reject(env, *work, work->error.c_str());
    } catch (const std::exception &error) {
        reject(env, *work, error.what());
    }
    if (work->handle) napi_delete_reference(env, work->handle);
    napi_delete_async_work(env, work->async);
}

napi_value queue(napi_env env, std::unique_ptr<Work> work, napi_value handle = nullptr) {
    Connection &connection = *work->connection;
    if (connection.active) throw std::logic_error("SQLite connection already has native work");
    napi_value promise;
    check(napi_create_promise(env, &work->promise, &promise));
    try {
        if (handle) check(napi_create_reference(env, handle, 1, &work->handle));
        napi_value name = string(env, "monsqlize:sqlite");
        check(napi_create_async_work(env, nullptr, name, runWork, complete, work.get(), &work->async));
        check(napi_queue_async_work(env, work->async));
    } catch (const std::exception &error) {
        if (work->handle) napi_delete_reference(env, work->handle);
        if (work->async) napi_delete_async_work(env, work->async);
        work->code = SQLITE_ERROR;
        reject(env, *work, error.what());
        return promise;
    }
    connection.active = work.release();
    return promise;
}

Connection *readConnection(napi_env env, napi_value value) {
    bool matches = false;
    void *control = nullptr;
    if (napi_check_object_type_tag(env, value, &connectionTag, &matches) != napi_ok || !matches ||
        napi_unwrap(env, value, &control) != napi_ok || !control) {
        throw std::invalid_argument("invalid SQLite native connection");
    }
    return static_cast<Connection *>(control);
}

template <Action action, size_t expected>
napi_value start(napi_env env, napi_callback_info info) {
    napi_value args[expected];
    size_t count = expected;
    check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != expected) throw std::invalid_argument("invalid SQLite bridge arguments");
    auto work = std::make_unique<Work>();
    work->action = action;
    if constexpr (action == Action::Open) {
        work->opening = std::make_unique<Connection>();
        work->connection = work->opening.get();
        work->input = readString(env, args[0]);
        check(napi_get_value_int32(env, args[1], &work->flags));
        check(napi_get_value_int32(env, args[2], &work->busyTimeout));
    } else {
        work->connection = readConnection(env, args[0]);
        if (work->connection->active) throw std::logic_error("SQLite connection already has native work");
        if (!work->connection->db) throw std::logic_error("SQLite connection is closed");
        if constexpr (action == Action::Execute || action == Action::LoadExtension) {
            work->input = readString(env, args[1]);
        }
        if constexpr (action == Action::CommitBefore) {
            bool exact;
            check(napi_get_value_bigint_int64(env, args[1], &work->commitDeadline, &exact));
            if (!exact || work->commitDeadline <= 0) throw std::invalid_argument("invalid SQLite commit deadline");
        }
        if constexpr (action == Action::Execute) {
            work->token = readToken(env, args[3]);
            if (work->token <= work->connection->lastToken) throw std::invalid_argument("SQLite operation token was already used");
            uint32_t length;
            check(napi_get_array_length(env, args[2], &length));
            work->bindings.reserve(length);
            for (uint32_t i = 0; i < length; ++i) {
                napi_value value;
                check(napi_get_element(env, args[2], i, &value));
                work->bindings.emplace_back(readValue(env, value));
            }
            work->connection->lastToken = work->token;
        }
    }
    if (work->input.find('\0') != std::string::npos) throw std::invalid_argument("embedded NUL in SQLite path or statement");
    return queue(env, std::move(work), action == Action::Open ? nullptr : args[0]);
}

napi_value interrupt(napi_env env, napi_callback_info info) {
    size_t count = 2;
    napi_value args[2], result;
    check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2) throw std::invalid_argument("expected a SQLite connection and operation token");
    auto &connection = *readConnection(env, args[0]);
    const uint64_t token = readToken(env, args[1]);
    const bool active = connection.active && connection.active->action == Action::Execute && connection.active->token == token;
    if (active) {
        connection.active->interrupted.store(true, std::memory_order_relaxed);
        sqlite3_interrupt(connection.db);
    }
    check(napi_get_boolean(env, active, &result));
    return result;
}

napi_value hasProgressed(napi_env env, napi_callback_info info) {
    size_t count = 1;
    napi_value input, result;
    check(napi_get_cb_info(env, info, &count, &input, nullptr, nullptr));
    if (count != 1) throw std::invalid_argument("missing SQLite native connection");
    auto &connection = *readConnection(env, input);
    const bool progressed = connection.active && connection.active->progressed.load(std::memory_order_relaxed);
    check(napi_get_boolean(env, progressed, &result));
    return result;
}

template <napi_callback fn>
napi_value wrap(napi_env env, napi_callback_info info) {
    try {
        return fn(env, info);
    } catch (const std::exception &error) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (!pending) napi_throw_error(env, nullptr, error.what());
        return nullptr;
    }
}

napi_value init(napi_env env, napi_value exports) {
    const napi_property_descriptor methods[] = {
        { "open", nullptr, wrap<start<Action::Open, 3>>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "execute", nullptr, wrap<start<Action::Execute, 4>>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "commitBefore", nullptr, wrap<start<Action::CommitBefore, 2>>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "loadExtension", nullptr, wrap<start<Action::LoadExtension, 2>>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "close", nullptr, wrap<start<Action::Close, 1>>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "interrupt", nullptr, wrap<interrupt>, nullptr, nullptr, nullptr, napi_default, nullptr },
        { "hasProgressed", nullptr, wrap<hasProgressed>, nullptr, nullptr, nullptr, napi_default, nullptr },
    };
    try {
        check(napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods));
        check(napi_set_named_property(env, exports, "sourceId", string(env, sqlite3_sourceid())));
        check(napi_set_named_property(env, exports, "engineBuildHash", string(env, monsqlize_sqlite_engine_build_hash())));
        napi_value options;
        check(napi_create_array(env, &options));
        for (int i = 0; const char *option = sqlite3_compileoption_get(i); ++i) {
            check(napi_set_element(env, options, i, string(env, option)));
        }
        check(napi_set_named_property(env, exports, "compileOptions", options));
        return exports;
    } catch (const std::exception &error) {
        napi_throw_error(env, nullptr, error.what());
        return nullptr;
    }
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
