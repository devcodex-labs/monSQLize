# Function Cache (Legacy Compatibility)

The compatibility withCache wrapper exposes invalidate(...args) and invalidateAll() from the same underlying wrapper, preserving namespace, custom keyBuilder and statistics behavior.

> **Current site status**: hidden from navigation
> **Compatibility status**: exported for existing consumers

`withCache()` and `FunctionCache` remain part of the public API for compatibility, but non-database function caching is no longer an actively maintained monSQLize feature area. For new generic function-cache usage, prefer `cache-hub` directly or an application-owned cache layer. The current monSQLize docs focus on database query cache, Redis adapters, distributed invalidation, and database-runtime cache behavior.

## Overview

Function caching added cache wrappers for arbitrary asynchronous functions, not just database queries. This page is kept only as a legacy compatibility surface for existing consumers.


## Features

These capabilities remain available for compatibility. They are not the recommended starting point for new monSQLize cache usage.

- ✅ **Zero Invasion**: Through the decorator mode, the original function is not modified
- ✅ **Automatic Serialization**: Supports complex parameters (object, array, Date, ObjectId, etc.)
- ✅ **TTL Expiration**: Flexible cache time control
- ✅ **Concurrency Control**: Prevent cache penetration
- ✅ **Conditional Caching**: Determine whether to cache based on the return value
- ✅ **Namespace Isolation**: Multi-module caches do not interfere with each other
- ✅ **Statistics monitoring**: hit rate, number of calls, etc.
- ✅ **Reuse Infrastructure**: Automatically inherit monSQLize's cache configuration (local/Redis/dual-tier)

---

## Compatibility example


## Installation

```bash
npm install monsqlize
```


## Method 1: Wrapper pattern

```javascript
import MonSQLize from 'monsqlize';
import { withCache } from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
    cache: {
        multiLevel: true,
        local: { maxEntries: 10000 },
        remote: MonSQLize.createRedisCacheAdapter('redis://localhost:6379/0')
    }
});

await msq.connect();

//Business functions (including database queries)
async function getUserProfile(userId) {
    const user = await msq.collection('users').findOne({ _id: userId });
    const orders = await msq.collection('orders').find({ userId }).toArray();
    return { user, orders };
}

//application cache
const cachedGetUserProfile = withCache(getUserProfile, {
    ttl: 300000,  //5 minutes
    cache: msq.getCache()  //Reuse monSQLize cache
});

//use
const profile = await cachedGetUserProfile('user123');  //First query (~1.5ms)
const profile2 = await cachedGetUserProfile('user123'); //Hit cache (~0.003ms, 500x speedup) ⚡
```

⚠️ **IMPORTANT NOTE**: Caching is suitable for functions that **have significant overhead** (database queries, API calls, etc.). For simple calculations (such as `x => x * 2`), using cache will make performance **worse**.


## Method 2: FunctionCache class

```javascript
import { FunctionCache } from 'monsqlize';

const fnCache = new FunctionCache(msq, {
    namespace: 'myApp',
    ttl: 60000
});

//Register function
fnCache.register('getUserProfile', getUserProfileFn, {
    ttl: 300000
});
fnCache.register('getOrderStats', getOrderStatsFn, {
    ttl: 600000
});

//execute
const profile = await fnCache.execute('getUserProfile', 'user123');
const stats = await fnCache.execute('getOrderStats', 'user123', 2024);

//⚠️ Important: Manual invalidation of cache is required after data update
await msq.collection('users').updateOne({ _id: 'user123' }, { $set: { name: 'Alice' } });
await fnCache.invalidate('getUserProfile', 'user123'); //Manual invalidation of cache

//View statistics
console.log(fnCache.getStats('getUserProfile'));
// { hits: 10, misses: 2, hitRate: 0.833, avgTime: 5.2 }
```

---

## Core API


## withCache(fn, options)

Decorator function adds caching capabilities to asynchronous functions.


### Parameters

| Parameters | Type | Required | Default | Description |
|------|------|------|-------|------|
| `fn` | `Function` | ✅ | - | Asynchronous function to cache |
| `options` | `Object` | ❌ | `{}` | Cache Configuration |
| `options.ttl` | `number` | ❌ | `60000` | Cache time (milliseconds) |
| `options.keyBuilder` | `Function` | ❌ | - | Custom key generation function |
| `options.cache` | `Object` | ❌ | Memory cache | Cache instance |
| `options.namespace` | `string` | ❌ | `'fn'` | Namespace |
| `options.condition` | `Function` | ❌ | - | Conditional cache function |
| `options.enableStats` | `boolean` | ❌ | `true` | Enable Statistics |


### Return value

Returns the wrapped function with `invalidate()` / `invalidateAll()` / `stats()` methods.


### Example

```javascript
//Basic usage
const cached = withCache(originalFn, { ttl: 60000 });

//Custom key generation
const cached = withCache(originalFn, {
    ttl: 300000,
    keyBuilder: (userId) => `user:${userId}`
});

//Conditional caching
const cached = withCache(originalFn, {
    ttl: 60000,
    condition: (result) => result && result.length > 0
});
```

---


## FunctionCache class


### Constructor

```javascript
new FunctionCache(msq, options)
```

| Parameters | Type | Required | Description |
|------|------|------|------|
| `msq` | `MonSQLize` | ❌ | MonSQLize instance (optional) |
| `options` | `Object` | ❌ | Configuration Options |
| `options.namespace` | `string` | ❌ | namespace (default `'action'`) |
| `options.ttl` | `number` | ❌ | Default TTL (default `60000`) |


### Method


#### register(name, fn, options)

Register function.

```javascript
fnCache.register('getUserProfile', getUserProfileFn, {
    ttl: 300000,
    keyBuilder: (userId) => `profile:${userId}`
});
```


#### execute(name, ...args)

Execute function.

```javascript
const result = await fnCache.execute('getUserProfile', 'user123');
```


#### invalidate(name, ...args)

Invalid cache.

```javascript
await fnCache.invalidate('getUserProfile', 'user123');
```


#### invalidatePattern(pattern)

Batch invalidation cache.

```javascript
await fnCache.invalidatePattern('getUserProfile:*');
```


#### getStats(name?)

Get statistics.

```javascript
//single function
const stats = fnCache.getStats('getUserProfile');
// { hits: 10, misses: 2, errors: 0, hitRate: 0.833 }

//All functions
const allStats = fnCache.getStats();
```


#### list()

List all registered functions.

```javascript
const functions = fnCache.list();
// ['getUserProfile', 'getOrderStats', 'calculateScore']
```


#### resetStats(name?)

Reset statistics.

```javascript
fnCache.resetStats('getUserProfile');  //reset single
fnCache.resetStats();                   //reset all
```


#### clear()

Clear all registered functions.

```javascript
fnCache.clear();
```

---

## Usage scenarios


## Scenario 1: Complex business logic

```javascript
async function getUserDashboard(userId) {
    //Complex business logic: querying multiple collections + calculations
    const user = await msq.collection('users').findOne({ _id: userId });
    const orders = await msq.collection('orders').find({ userId }).toArray();
    const reviews = await msq.collection('reviews').find({ userId }).toArray();

    const stats = calculateStats(orders, reviews);

    return { user, orders, reviews, stats };
}

//application cache
const cached = withCache(getUserDashboard, {
    ttl: 300000,  //5 minutes
    cache: msq.getCache()
});
```

**Performance improvement:** From 50ms → 0.001ms (50000x acceleration)

---


## Scenario 2: External API call

```javascript
const axios = require('axios');

async function fetchWeatherData(city) {
    const response = await axios.get(`https://api.weather.com/current?city=${city}`);
    return response.data;
}

//application cache
const cached = withCache(fetchWeatherData, {
    ttl: 300000,  //5 minutes
    keyBuilder: (city) => `weather:${city}`,
    cache: msq.getCache()
});
```

**Performance improvement:** From 200-500ms → 0.001ms (200000-500000x acceleration)

---


## Scenario 3: Complex calculation

```javascript
async function calculateUserScore(userId) {
    const orders = await msq.collection('orders').find({ userId }).toArray();
    const reviews = await msq.collection('reviews').find({ userId }).toArray();

    //Complex calculation logic (50ms)
    return expensiveCalculation(orders, reviews);
}

//application cache
const cached = withCache(calculateUserScore, {
    ttl: 600000,  //10 minutes
    cache: msq.getCache()
});
```

**Performance improvement:** From 100ms → 0.001ms (100000x acceleration)

---


## Scenario 4: Conditional caching

```javascript
//Only cache valid results
const cached = withCache(searchProducts, {
    ttl: 60000,
    condition: (result) => result && result.length > 0,  //Only cache non-empty results
    cache: msq.getCache()
});
```

---


## Scenario 5: Namespace isolation

```javascript
//user module
const userCache = new FunctionCache(msq, { namespace: 'user' });
userCache.register('getProfile', getUserProfileFn);

//Order module
const orderCache = new FunctionCache(msq, { namespace: 'order' });
orderCache.register('getProfile', getOrderProfileFn);

//Cache key:
// - user:getProfile:...
// - order:getProfile:...
```

---

## Best Practices


## 1. Set TTL appropriately

| Data Type | Recommended TTL | Reason |
|---------|---------|------|
| **Static Configuration** | 1-24 hours | Very few changes |
| **User Profile** | 5-30 minutes | Medium change frequency |
| **External API** | 2-10 minutes | Reduce external dependencies |
| **Statistics** | 30 seconds - 5 minutes | Allow short delays |
| **Real-time data** | 0 (disable caching) | Real-time required |

---


## 2. Identify functions suitable for caching ⚠️ Important

**✅ Suitable for caching**:
- Database query (>1ms)
- External API calls (>50ms)
- Complex calculations (>10ms)
- File I/O operations

**❌ Not suitable for caching**:
- Simple calculation (< 0.01ms): such as `x => x * 2`
- Pure memory operations (< 0.01ms): such as simple array traversal
- Already fast function (< 0.01ms)

**Performance Testing Suggestions**:
```javascript
//Before adding cache, test the function execution time first
const start = process.hrtime.bigint();
await myFunction(args);
const time = Number(process.hrtime.bigint() - start) / 1000000;
console.log(`Execution time: ${time}ms`);

//If time > 0.01ms, only consider using cache
//If time < 0.01ms, caching may worsen performance
```

---


## 3. Use namespace isolation

```javascript
//✅ Recommendation: Use different namespaces for different modules
const userCache = new FunctionCache(msq, { namespace: 'user' });
const productCache = new FunctionCache(msq, { namespace: 'product' });

//❌ Not recommended: use the same namespace for all functions
const cache = new FunctionCache(msq);
```

---


## 4. Use named functions

```javascript
//✅ Recommendation: Use named functions
async function getUserProfile(userId) { /*...*/ }
const cached = withCache(getUserProfile, { ttl: 60000 });

//❌ Not recommended: anonymous functions
const cached = withCache(async (userId) => { /*...*/ }, { ttl: 60000 });
```

---


## 5. Monitor cache hit rate

```javascript
//Regularly check cache hit ratio
setInterval(() => {
    const stats = fnCache.getStats();
    console.log('Cache statistics:', stats);

    //If hit rate is less than 80%, consider adjusting TTL
    if (stats.hitRate < 0.8) {
        console.warn('The cache hit rate is low; consider adjusting the TTL');
    }
}, 60000);
```

---


## 5. Timely invalidation of cache

```javascript
//Immediately after the data is updated, the relevant cache will be invalidated.
async function updateUserProfile(userId, data) {
    await msq.collection('users').updateOne({ _id: userId }, { $set: data });

    //Invalidation related cache
    await fnCache.invalidate('getUserProfile', userId);
    await fnCache.invalidate('getUserDashboard', userId);
}
```

---
## Legacy performance note

`withCache()` and `FunctionCache` remain available for existing consumers, but new generic function-level caching should use `cache-hub` directly or an application-owned cache layer.

For existing code, measure the real workload before keeping a wrapper:

- Cache only functions with meaningful I/O or computation cost.
- Avoid wrapping trivial synchronous calculations.
- Keep TTL and invalidation tied to the data owner.
- Prefer database query cache for monSQLize query results.
## FAQ


## Q1: How to choose the cache type?

**A:** Select according to the application scenario:

- **Single instance application** → local cache only
- **Multi-instance application** → Local + Redis double-layer cache
- **Microservice architecture** → Redis cache (shared)

---


## Q2: Will anonymous functions cause key conflicts?

**A:** Yes. Suggestions:

```javascript
//❌ Danger: Anonymous functions may conflict
const cached1 = withCache(async (x) => { /*...*/ }, { ttl: 60000 });
const cached2 = withCache(async (x) => { /*...*/ }, { ttl: 60000 });

//✅ Safe: use named functions
async function fn1(x) { /*...*/ }
async function fn2(x) { /*...*/ }
const cached1 = withCache(fn1, { ttl: 60000 });
const cached2 = withCache(fn2, { ttl: 60000 });

//✅ Security: use different namespaces
const cached1 = withCache(async (x) => { /*...*/ }, {
    namespace: 'fn1',
    ttl: 60000
});
```

---


## Q3: How to reuse monSQLize’s cache configuration?

**A:** Use `msq.getCache()`:

```javascript
const cached = withCache(fn, {
    ttl: 60000,
    cache: msq.getCache()  //Automatically inherit Redis/multi-layer cache configuration
});
```

---


## Q4: What parameter types are supported?

**A:** supports all serializable types:

- ✅ Basic types (string, number, boolean)
- ✅ Objects, arrays
- ✅ Date, RegExp
- ✅ MongoDB types (ObjectId, Decimal128, etc.)
- ❌ Function, Symbol

---


## Q5: How to deal with cache penetration?

**A:** Use conditional caching:

```javascript
const cached = withCache(fn, {
    ttl: 60000,
    condition: (result) => result !== null  //Do not cache null values
});
```

---

## TypeScript support

```typescript
import { withCache, FunctionCache, WithCacheOptions } from 'monsqlize';

//withCache automatically infers types
async function getUserProfile(userId: string) {
    return { userId, name: 'User' };
}

const cached = withCache(getUserProfile, {
    ttl: 60000
});

//type safety
const profile = await cached('user123');  // profile: { userId: string; name: string; }

// FunctionCache
const fnCache = new FunctionCache(msq);
fnCache.register('getUserProfile', getUserProfile);
const result = await fnCache.execute<{ userId: string; name: string }>('getUserProfile', 'user123');
```

---

## Related documents

- [Cache Policy Document](./cache.md)
- [Multi-tier cache configuration](./cache.md#multi-layer-caching)
- [Use an already created Redis instance](./cache.md#method-3-use-an-already-created-redis-instance)
- [Function cache key generation mechanism](./function-cache.md)

---

**End of document**
