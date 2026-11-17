'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { checkBoundaries } = require('../../scripts/validation/check-backend-boundaries.cjs');

test('permits core consumption and the pinned legacy Mongo type import', () => {
    const files = new Map([
        ['src/core/cache-scope.ts', "import type { MongoClient } from 'mongodb'"],
        ['src/core/runtime/scope.ts', "import { randomUUID } from 'node:crypto'"],
        ['src/adapters/postgresql/client.ts', "import { Client } from 'pg'; export * from '../../core/runtime/scope'"],
    ]);
    assert.deepEqual(checkBoundaries(files), []);
});

test('rejects driver injection into core and static or literal lazy cross-adapter imports', () => {
    const files = new Map([
        ['src/core/runtime/lease.ts', "const driver = require('mysql2/promise')"],
        ['src/core/query/compile.ts', "export * from '../../adapters/sqlite/compiler'"],
        ['src/adapters/mysql/client.ts', "const other = import('../postgresql/client.js')"],
    ]);
    const errors = checkBoundaries(files);
    assert.equal(errors.length, 3);
    const directoryImport = new Map([
        ['src/adapters/mysql/client.ts', "import '../postgresql'"],
    ]);
    assert.equal(checkBoundaries(directoryImport).length, 1);
    assert.ok(errors.some(error => error.includes('mysql2/promise')));
    assert.ok(errors.some(error => error.includes('../../adapters/sqlite/compiler')));
    assert.ok(errors.some(error => error.includes('../postgresql/client.js')));
});

test('reports execution cycles but permits type-only back references', () => {
    const files = new Map([
        ['src/core/runtime/a.ts', "import { value } from './b.js'; export const local = value"],
        ['src/core/runtime/b.ts', "import type { Input } from './a.js'; export const value = 1"],
    ]);
    assert.deepEqual(checkBoundaries(files), []);
    files.set('src/core/runtime/b.ts', "export { local } from './a.js'");
    assert.deepEqual(checkBoundaries(files), [
        'backend boundary cycle: src/core/runtime/a.ts -> src/core/runtime/b.ts -> src/core/runtime/a.ts',
    ]);
});

test('rejects template literal, inline type and capability backend dependencies', () => {
    assert.deepEqual(checkBoundaries(new Map([
        ['src/adapters/mysql/a.ts', 'import(`../postgresql/client.js`)'],
    ])), ['src/adapters/mysql/a.ts imports another adapter ../postgresql/client.js']);
    assert.deepEqual(checkBoundaries(new Map([
        ['src/core/runtime/types.ts', "type Driver = import('pg').Client"],
    ])), ['src/core/runtime/types.ts imports backend-specific module pg']);
    assert.deepEqual(checkBoundaries(new Map([
        ['src/capabilities/model/bridge.ts', "import 'pg'; import '../../adapters/postgresql'"],
    ])), [
        'src/capabilities/model/bridge.ts imports backend-specific module ../../adapters/postgresql',
        'src/capabilities/model/bridge.ts imports backend-specific module pg',
    ]);
});

test('rejects foreign drivers in adapters and reverse imports into entry', () => {
    assert.deepEqual(checkBoundaries(new Map([
        ['src/adapters/postgresql/client.ts', "import '@monsqlize/sqlite-native'"],
        ['src/core/runtime/source.ts', "export * from '../../entry/index'"],
        ['src/entry/index.ts', "export * from '../core/runtime/source'"],
    ])), [
        "src/adapters/postgresql/client.ts imports another adapter's driver @monsqlize/sqlite-native",
        'src/core/runtime/source.ts imports from entry ../../entry/index',
    ]);
});

