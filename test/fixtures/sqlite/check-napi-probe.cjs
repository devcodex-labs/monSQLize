'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const [artifact, extension] = process.argv.slice(2);
assert.ok(artifact && extension, 'pass the built .node probe and extension paths');

const native = require(path.resolve(artifact));
assert.equal(native.sqliteVersion, '3.54.1');
assert.throws(() => native.roundtrip({}), /invalid SQLite probe handle/);
const handle = native.open();
try {
    assert.equal(native.roundtrip(handle), 42);
    assert.equal(native.interrupt(handle), true);
    assert.equal(native.roundtrip(handle), 42);
    assert.equal(native.loadExtension(handle, path.resolve(extension)), 54);
    assert.throws(() => native.roundtrip(Object.create(handle)), /invalid SQLite probe handle/);
} finally {
    native.close(handle);
}
native.close(handle);
assert.throws(() => native.roundtrip(handle), /SQLite probe handle is closed/);
process.stdout.write(`${JSON.stringify({ node: process.version, hostNapi: process.versions.napi, targetNapi: 8,
    platform: process.platform, arch: process.arch, sqlite: native.sqliteVersion, realHandleRoundtrip: true,
    progressHandlerInterrupt: true, connectionReusableAfterInterrupt: true,
    loadedNativeExtension: true,
    rejectsImpersonation: true, closeIdempotent: true })}\n`);

