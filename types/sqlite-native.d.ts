declare const sqliteNativeConnectionBrand: unique symbol;

/** Opaque identity for a native SQLite connection. */
export interface SQLiteNativeConnection {
    readonly [sqliteNativeConnectionBrand]: never;
    readonly closed: boolean;
    close(): Promise<void>;
}
