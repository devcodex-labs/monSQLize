import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemoryServerBinaryVersion } from '../../bootstrap/memory-server-policy';
import { ensureWebCryptoGlobal } from '../../bootstrap/webcrypto';
const MonSQLize = require('../../../dist/cjs/index.cjs');
const { ObjectId, MongoClient } = require('mongodb');
const { MongoMemoryServer, MongoMemoryReplSet } = require('mongodb-memory-server');
const binaryVersion = resolveMemoryServerBinaryVersion();
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
let server: any, runtime: any;
before(async () => {
  ensureWebCryptoGlobal();
  server = await MongoMemoryServer.create({ binary: { version: binaryVersion } });
  runtime = new MonSQLize({ type: 'mongodb', databaseName: 'independent_verify', config: { uri: server.getUri() }, cache: { autoInvalidate: true }, logger: { level: 'silent' } });
  await runtime.connect();
});
after(async () => { await runtime?.close(); await server?.stop({ doCleanup: true, force: true }); });

test('Partial insertMany writes invalidate cached reads for both ordered modes', async () => {
  for (const ordered of [false, true]) {
    const col = runtime.collection('partial_' + ordered);
    await col.insertOne({ _id: 'old', value: 1 });
    assert.equal((await col.find({}, { cache: 60000 })).length, 1);
    let error: any;
    try { await col.insertMany([{ _id: 'new', value: 2 }, { _id: 'old', value: 3 }], { ordered }); }
    catch (caught) { error = caught; }
    assert.equal(error?.code, 'DUPLICATE_KEY');
    const actual = await col.find({});
    const cached = await col.find({}, { cache: 60000 });
    assert.equal(actual.length, 2);
    assert.equal(cached.length, 2);
    await col.invalidate();
    assert.equal((await col.find({}, { cache: 60000 })).length, 2);
    await col.insertMany([{ _id: 'successful', value: 4 }]);
    assert.equal((await col.find({}, { cache: 60000 })).length, 3);
  }
});

test('Write waits for an in-flight asynchronous fill and removes its stale value', async () => {
  const backing = new MonSQLize.MemoryCache();
  let gate: any = null;
  const cache: any = {};
  for (const name of ['get', 'del', 'has', 'exists', 'getMany', 'setMany', 'delMany', 'delPattern', 'clear', 'keys', 'getStats', 'setLockManager']) {
    if (typeof backing[name] === 'function') cache[name] = (...args: unknown[]) => backing[name](...args);
  }
  cache.set = async (key: string, value: unknown, ttl: number) => {
    if (gate && key.startsWith('find:')) {
      const current = gate; gate = null;
      current.captured.resolve();
      await current.resume.promise;
    }
    return backing.set(key, value, ttl);
  };
  const custom = new MonSQLize({ type: 'mongodb', databaseName: 'async_cache_verify', config: { uri: server.getUri() }, cache, cacheAutoInvalidate: true, logger: { level: 'silent' } });
  try {
    await custom.connect();
    for (let iteration = 0; iteration < 3; iteration++) {
      const col = custom.collection('race_' + iteration);
      await col.insertOne({ _id: 'row', value: 1 });
      const current = { captured: deferred(), resume: deferred() }; gate = current;
      const oldRead = Promise.resolve(col.find({}, { cache: 60000 }));
      try {
        await current.captured.promise;
        let completed = false;
        const write = col.updateOne({ _id: 'row' }, { $set: { value: 2 } }).then(() => { completed = true; });
        for (let i = 0; i < 100 && (await col.raw().findOne({ _id: 'row' })).value !== 2; i++) await delay(5);
        assert.equal((await col.raw().findOne({ _id: 'row' })).value, 2);
        assert.equal(completed, false);
        current.resume.resolve();
        await write;
      } finally { current.resume.resolve(); }
      await oldRead;
      const actual = (await col.find({}))[0].value;
      const cached = (await col.find({}, { cache: 60000 }))[0].value;
      assert.equal(actual, 2); assert.equal(cached, 2);
      await col.invalidate();
      assert.equal((await col.find({}, { cache: 60000 }))[0].value, 2);
      await col.updateOne({ _id: 'row' }, { $set: { value: 3 } });
      assert.equal((await col.find({}, { cache: 60000 }))[0].value, 3);
    }
  } finally { await custom.close(); backing.close?.(); }
});

test('Cursor pagination crosses null and missing sort boundaries', async () => {
  for (const nullable of [null, undefined]) {
    const col = runtime.collection(nullable === null ? 'null_page' : 'missing_page');
    await col.insertMany([{ _id: 'a', ...(nullable === null ? { rank: null } : {}) }, { _id: 'b', rank: 1 }, { _id: 'c', rank: 2 }]);
    const native = await col.raw().find({}).sort({ rank: 1, _id: 1 }).toArray();
    const first = await col.findPage({ sort: { rank: 1 }, limit: 1 });
    const next = await col.findPage({ sort: { rank: 1 }, limit: 1, after: first.pageInfo.endCursor });
    assert.deepEqual(native.map((x: any) => x._id), ['a', 'b', 'c']);
    assert.equal(first.pageInfo.hasNext, true);
    assert.equal(next.items[0]._id, 'b');
  }
  const col = runtime.collection('numeric_page');
  await col.insertMany([{ _id: 'a', rank: 0 }, { _id: 'b', rank: 1 }, { _id: 'c', rank: 2 }]);
  const first = await col.findPage({ sort: { rank: 1 }, limit: 1 });
  const next = await col.findPage({ sort: { rank: 1 }, limit: 1, after: first.pageInfo.endCursor });
  assert.equal(next.items[0]._id, 'b');
});

test('Versioned cursor normalizers isolate cached BSON boundaries', async () => {
  const col = runtime.collection('normalizer_types');
  const one = '000000000000000000000001', two = '000000000000000000000002';
  // Native seeding preserves explicit BSON types without automatic ObjectId conversion.
  await col.raw().insertMany([{ _id: 'str1', token: one }, { _id: 'str2', token: two }, { _id: 'oid1', token: new ObjectId(one) }, { _id: 'oid2', token: new ObjectId(two) }]);
  const first = await col.findPage({ sort: { token: 1 }, limit: 1 });
  assert.equal(first.items[0]._id, 'str1');
  const identity = (_field: string, value: unknown) => value;
  const objectId = (field: string, value: unknown) => field === 'token' ? new ObjectId(String(value)) : value;
  const base = { sort: { token: 1 }, limit: 1, after: first.pageInfo.endCursor, cache: 60000 };
  const a = await col.findPage({ ...base, cursorValueNormalizer: identity, cursorValueNormalizerVersion: 'identity:v1' });
  const cached = await col.findPage({ ...base, cursorValueNormalizer: objectId, cursorValueNormalizerVersion: 'objectId:v1' });
  const fresh = await col.findPage({ ...base, cache: 0, cursorValueNormalizer: objectId, cursorValueNormalizerVersion: 'objectId:v1' });
  assert.equal(a.items[0]._id, 'str2');
  assert.equal(cached.items[0]._id, 'oid2');
  assert.equal(fresh.items[0]._id, 'oid2');
  await col.invalidate();
  const recovered = await col.findPage({ ...base, cursorValueNormalizer: objectId, cursorValueNormalizerVersion: 'objectId:v1' });
  assert.equal(recovered.items[0]._id, 'oid2');
});

test('CountQueue reserves a slot during microtask handoff', async () => {
  let breaches = 0;
  for (let iteration = 0; iteration < 100; iteration++) {
    const queue = new MonSQLize.CountQueue({ concurrency: 1, timeout: 5000 });
    const first = deferred(), hold = deferred();
    let active = 0, maxActive = 0, third: Promise<unknown> | undefined;
    // Return the controlled promise directly; adding an async wrapper changes microtask ordering.
    const heldTask = () => { active++; maxActive = Math.max(maxActive, active); return hold.promise.then(() => { active--; }); };
    const a = queue.execute(() => first.promise);
    const b = queue.execute(heldTask);
    first.promise.then(() => { third = queue.execute(heldTask); });
    first.resolve();
    await new Promise(resolve => setImmediate(resolve));
    if (maxActive === 2) breaches++;
    hold.resolve(); await Promise.all([a, b, third]);
    assert.equal(queue.getStats().running, 0);
  }
  assert.equal(breaches, 0);
  // Ordinary handoff control, without a new arrival in the same microtask batch.
  const queue = new MonSQLize.CountQueue({ concurrency: 1 });
  let active = 0, maxActive = 0;
  await Promise.all([1, 2, 3].map(() => queue.execute(async () => { active++; maxActive = Math.max(maxActive, active); await delay(1); active--; })));
  assert.equal(maxActive, 1);
});

test('Expired lock handles do not report ownership after transfer', async () => {
  const manager = new MonSQLize.LockManager({ lockKeyPrefix: 'verify:' });
  try {
    const first = await manager.tryAcquireLock('key', { ttl: 40 });
    assert.equal(first.isHeld(), true);
    await delay(80);
    const next = await manager.tryAcquireLock('key', { ttl: 1000 });
    assert.ok(next); assert.notEqual(next.lockId, first.lockId);
    const expiredHeld = first.isHeld(), renew = await first.renew(1000);
    assert.equal(renew, false); assert.equal(expiredHeld, false);
    assert.equal(await next.release(), true); assert.equal(next.isHeld(), false);
  } finally { manager.close(); }
});

test('findPage honors string and Map sort inputs', async () => {
  const col = runtime.collection('sort_forms');
  await col.insertMany([{ _id: 'a', rank: 3 }, { _id: 'b', rank: 1 }, { _id: 'c', rank: 2 }]);
  for (const sort of ['rank', new Map([['rank', 1]])]) {
    const native = await col.raw().find({}).sort(sort).toArray();
    const actual = await col.findPage({ sort, limit: 3 });
    assert.deepEqual(native.map((x: any) => x.rank), [1, 2, 3]);
    assert.deepEqual(actual.items.map((x: any) => x.rank), [1, 2, 3]);
  }
  const control = await col.findPage({ sort: { rank: 1 }, limit: 3 });
  assert.deepEqual(control.items.map((x: any) => x.rank), [1, 2, 3]);
  const nullable = await col.findPage({ sort: null, limit: 3 });
  assert.deepEqual(nullable.items.map((x: any) => x._id), ['a', 'b', 'c']);
});

test('Excluding only _id retains business fields and cursor anchors', async () => {
  const col = runtime.collection('projection_cases');
  await col.insertOne({ _id: 'a', value: 42, label: 'visible', hidden: 9 });
  const native = await col.raw().findOne({}, { projection: { _id: 0 } });
  const broken = await col.findPage({ projection: { _id: 0 }, limit: 1 });
  const control = await col.findPage({ projection: { _id: 0, hidden: 0 }, limit: 1 });
  assert.equal(native.value, 42); assert.equal(native.label, 'visible');
  assert.equal(broken.items[0].value, 42); assert.equal(broken.items[0].label, 'visible');
  assert.equal(control.items[0].value, 42); assert.equal(control.items[0].label, 'visible');
  for (const options of [{ projection: { _id: false } }, { options: { projection: { _id: 0 } } }]) {
    const result = await col.findPage({ ...options, limit: 1 });
    assert.equal(result.items[0].value, 42);
    assert.equal(result.items[0].label, 'visible');
  }
  const include = await col.findPage({ projection: { value: 1, _id: 0 }, limit: 1 });
  assert.equal(include.items[0].value, 42);
  assert.equal(include.items[0].label, undefined);
});

test('Dedicated tenant pools isolate their query caches', async () => {
  const other = await MongoMemoryServer.create({ binary: { version: binaryVersion } });
  const multi = new MonSQLize({ type: 'mongodb', databaseName: 'dedicated_tenants', config: { uri: server.getUri() }, pools: [
    { name: 'tenantA', uri: server.getUri(), role: 'primary', healthCheck: { enabled: false } },
    { name: 'tenantB', uri: other.getUri(), role: 'primary', healthCheck: { enabled: false } },
  ], logger: { level: 'silent' } });
  try {
    await multi.connect();
    const a = multi.pool('tenantA').collection('customers'), b = multi.pool('tenantB').collection('customers');
    await a.insertOne({ _id: 'same', tenant: 'A' }); await b.insertOne({ _id: 'same', tenant: 'B' });
    assert.equal((await a.findOne({ _id: 'same' })).tenant, 'A');
    assert.equal((await b.findOne({ _id: 'same' })).tenant, 'B');
    await a.findOne({ _id: 'same' }, { cache: 60000 });
    const cachedB = await b.findOne({ _id: 'same' }, { cache: 60000 });
    assert.equal(cachedB.tenant, 'B');
    await b.invalidate();
    const recoveredB = await b.findOne({ _id: 'same' }, { cache: 60000 });
    const nowCachedA = await a.findOne({ _id: 'same' }, { cache: 60000 });
    assert.equal(recoveredB.tenant, 'B'); assert.equal(nowCachedA.tenant, 'A');
  } finally { await multi.close(); await other.stop({ doCleanup: true, force: true }); }
});

test('Pool close attempts every client and retries failures', async () => {
  let healthyClosed = 0, badAttempts = 0;
  const manager = new MonSQLize.ConnectionPoolManager({ clientFactory: async (config: any) => ({ close: async () => {
    if (config.name === 'bad') { badAttempts++; throw Error('injected close error'); }
    healthyClosed++;
  } }) });
  try {
    await manager.addPool({ name: 'bad', uri: 'mongodb://localhost:27017' });
    await manager.addPool({ name: 'healthy', uri: 'mongodb://localhost:27017' });
    await assert.rejects(() => manager.close(), /injected close error/);
    await assert.rejects(() => manager.close(), /injected close error/);
    assert.equal(healthyClosed, 1); assert.equal(badAttempts, 2);
  } finally { /* mock clients have no sockets; manager timers were stopped by close */ }
});

test('Pagination matches native BSON sort order in both directions', async () => {
  const col = runtime.collection('bson_boundaries');
  await col.raw().insertMany([
    { _id: 'a', rank: null }, { _id: 'b' }, { _id: 'c', rank: -2 }, { _id: 'd', rank: 3 },
    { _id: 'e', rank: '$literal' }, { _id: 'f', rank: 'z' },
    { _id: 'g', rank: new ObjectId('000000000000000000000001') },
    { _id: 'h', rank: false }, { _id: 'i', rank: true }, { _id: 'j', rank: new Date('2024-01-01') },
  ]);
  for (const direction of [1, -1]) {
    const sort = { rank: direction, _id: direction };
    const expected = (await col.raw().find({}).sort(sort).toArray()).map((x: any) => x._id);
    const forward: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await col.findPage({ sort, limit: 2, after: cursor });
      forward.push(...page.items.map((x: any) => x._id));
      if (!page.pageInfo.hasNext) break;
      cursor = page.pageInfo.endCursor;
    }
    assert.deepEqual(forward, expected);
    const last = await col.findPage({ sort, limit: 2, page: 5 });
    const backward: string[] = last.items.map((x: any) => x._id);
    cursor = last.pageInfo.startCursor;
    for (let i = 0; i < 20; i++) {
      const page = await col.findPage({ sort, limit: 2, before: cursor });
      if (!page.items.length) break;
      backward.unshift(...page.items.map((x: any) => x._id));
      cursor = page.pageInfo.startCursor;
    }
    assert.deepEqual(backward, expected);
  }
});

test('Versioned bookmarks accelerate jumps and remain isolated after strategy changes', async () => {
  const col = runtime.collection('versioned_bookmarks');
  await col.insertMany(Array.from({ length: 40 }, (_, index) => ({ _id: `row-${index}`, rank: index })));
  const cursorValueNormalizer = (_field: string, value: unknown) => value;
  const dims = { sort: { rank: 1 }, limit: 1, cursorValueNormalizer, cursorValueNormalizerVersion: 'identity:v1' };
  assert.equal((await col.prewarmBookmarks(dims, [10])).warmed, 1);
  const result = await col.findPage({ ...dims, page: 12, jump: { maxHops: 2 } });
  assert.equal(result.items[0].rank, 11);
  assert.equal((await col.listBookmarks(dims)).count, 1);
  const changed = { ...dims, cursorValueNormalizerVersion: 'identity:v2' };
  await assert.rejects(col.findPage({ ...changed, page: 12, jump: { maxHops: 2 } }), { code: 'JUMP_TOO_FAR' });
  assert.equal((await col.prewarmBookmarks(changed, [10])).warmed, 1);
  assert.equal((await col.findPage({ ...changed, page: 12, jump: { maxHops: 2 } })).items[0].rank, 11);
  await col.updateOne({ rank: 0 }, { $set: { extra: true } });
  assert.equal((await col.listBookmarks()).count, 0);
  await assert.rejects(col.prewarmBookmarks({ ...dims, cursorValueNormalizerVersion: undefined }, [10]), { code: 'INVALID_ARGUMENT' });
});

test('Unversioned query normalizers safely bypass result caching', async () => {
  const col = runtime.collection('normalizer_types');
  const first = await col.findPage({ sort: { token: 1 }, limit: 1 });
  const base = { sort: { token: 1 }, limit: 1, after: first.pageInfo.endCursor, cache: 60000 };
  const stringResult = await col.findPage({ ...base, cursorValueNormalizer: (_field: string, value: unknown) => value });
  const oidResult = await col.findPage({ ...base, cursorValueNormalizer: (field: string, value: unknown) => field === 'token' ? new ObjectId(String(value)) : value });
  assert.equal(stringResult.items[0]._id, 'str2');
  assert.equal(oidResult.items[0]._id, 'oid2');
  await assert.rejects(col.findPage({ ...base, cursorValueNormalizerVersion: '' }), { code: 'INVALID_ARGUMENT' });
});

test('Same-source pool writes invalidate default-route caches', async () => {
  const multi = new MonSQLize({ type: 'mongodb', databaseName: 'alias_routes', config: { uri: server.getUri() }, cache: { autoInvalidate: true }, pools: [
    { name: 'alias', uri: server.getUri(), role: 'primary', healthCheck: { enabled: false } },
  ], logger: { level: 'silent' } });
  try {
    await multi.connect();
    const base = multi.collection('items'), alias = multi.pool('alias').collection('items');
    await base.insertOne({ _id: 'row', value: 1 });
    await base.findOne({ _id: 'row' }, { cache: 60000 });
    await alias.findOne({ _id: 'row' }, { cache: 60000 });
    await alias.updateOne({ _id: 'row' }, { $set: { value: 2 } });
    assert.equal((await base.findOne({ _id: 'row' }, { cache: 60000 })).value, 2);
    assert.equal((await alias.findOne({ _id: 'row' }, { cache: 60000 })).value, 2);
  } finally { await multi.close(); }
});

test('Cached page totals finish and invalidate after writes', { timeout: 5000 }, async () => {
  const col = runtime.collection('coordinated_totals');
  await col.insertOne({ _id: 'first' });
  for (const mode of ['sync', 'approx', 'async']) {
    const opts = { limit: 1, cache: 60000, totals: { mode, ttlMs: 60000 } };
    let result = await col.findPage(opts);
    const deadline = Date.now() + 2000;
    while (result.totals.total === null && Date.now() < deadline) { await delay(10); result = await col.findPage(opts); }
    assert.equal(result.totals.total, 1);
  }
  await col.insertOne({ _id: 'second' });
  const result = await col.findPage({ limit: 1, cache: 60000, totals: { mode: 'sync', ttlMs: 60000 } });
  assert.equal(result.totals.total, 2);
});

test('A real delayed MongoDB commit cannot overlap timeout rollback', async () => {
  // This failpoint belongs only to this owned test replica set.
  const repl = await MongoMemoryReplSet.create({ binary: { version: binaryVersion }, replSet: {
    count: 1, storageEngine: 'wiredTiger', args: ['--setParameter', 'enableTestCommands=1'],
  } });
  let real: any, admin: any;
  try {
    admin = await MongoClient.connect(repl.getUri());
    real = new MonSQLize({ type: 'mongodb', databaseName: 'delayed_commit', config: { uri: repl.getUri(), options: { monitorCommands: true } }, cache: { autoInvalidate: true }, logger: { level: 'silent' } });
    await real.connect();
    const col = real.collection('accounts');
    await col.insertOne({ _id: 'row', value: 1 });
    for (const delayAbort of [false, true]) {
      await col.updateOne({ _id: 'row' }, { $set: { value: 1 } });
      await col.findOne({ _id: 'row' }, { cache: 60000 });
      const tx = await real.startSession({ timeout: 500 });
      const commands: string[] = [];
      const started = (event: any) => { if (['commitTransaction', 'abortTransaction'].includes(event.commandName)) commands.push(event.commandName); };
      tx.session.client.on('commandStarted', started);
      try {
        await tx.start();
        await col.updateOne({ _id: 'row' }, { $set: { value: 2 } }, { session: tx.session });
        await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'alwaysOn', data: {
          failCommands: delayAbort ? ['commitTransaction', 'abortTransaction'] : ['commitTransaction'], blockConnection: true, blockTimeMS: 800,
        } });
        await tx.commit();
        await delay(50);
        assert.deepEqual(commands, ['commitTransaction']);
        assert.equal(tx.state, 'committed');
        assert.equal((await col.findOne({ _id: 'row' })).value, 2);
        assert.equal((await col.findOne({ _id: 'row' }, { cache: 60000 })).value, 2);
      } finally {
        await admin.db('admin').command({ configureFailPoint: 'failCommand', mode: 'off' });
        tx.session.client.off('commandStarted', started);
        await tx.end();
      }
    }
  } finally { await real?.close(); await admin?.close(); await repl.stop({ doCleanup: true, force: true }); }
});
