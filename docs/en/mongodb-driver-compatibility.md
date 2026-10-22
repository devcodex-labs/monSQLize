# MongoDB driver version compatibility guide

## Overview

This document explains how monSQLize handles version differences in the MongoDB Node.js driver and how to ensure compatibility for future driver upgrades.

**Current baseline**: monSQLize uses `mongodb@6.21.0` as the runtime dependency baseline; Driver 7.7.0 has passed extended compatibility verification. Driver 4.x / 5.x belongs to the historical compatibility background and is no longer part of the current support matrix.

---

## Currently supported driver versions


## Current support matrix

| MongoDB driver version | Support status | Test status | Description |
|-----------------|---------|---------|------|
| **6.x** (6.21.0) | Runtime Baseline | Default Verification | Package Exact Dependencies, Out of the Box |
| **7.x** (7.7.0) | Extension compatible | Matrix verification | Used to detect upstream breaking changes in advance |
| **4.x / 5.x** | Historical compatibility reference | Not in the current matrix | Old version migration background; new projects should stay on the current package dependency baseline |
| **8.x+** | To be evaluated | ⏸️ Not included in the current matrix | You need to confirm according to the verification process in this article before upgrading |


## Dependency declaration

Statement in `package.json`:
```json
{
  "dependencies": {
    "mongodb": "6.21.0"
  }
}
```

**Description**:
- Users will get `mongodb@6.21.0` by default after installing monSQLize, and there is no need to install additional MongoDB driver.
- Driver 7.7.0 passed compatibility verification, but is not the default runtime dependency of the current package.
- If the driver is unavailable due to package manager trimming, overwriting dependencies, or workspace resolution, restore the complete installation first, and then execute the verification command in this article.

---

## monSQLize's handling of version differences


## 1. Return value of findOneAnd* method

This is the most important difference. Currently monSQLize runs on MongoDB Driver 6.21.0 by default and verifies public API behavior through the Driver 7.7.0 extension matrix.


### MongoDB driver version differences

**Driver 4.x return format**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
//result format:
{
  value: { _id: ..., name: "Alice" },  //Documentation
  ok: 1,                                //operating status
  lastErrorObject: {                    //error message
    n: 1,
    updatedExisting: true
  }
}
```

**Driver 5.x return format**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
//result format:
{
  value: { _id: ..., name: "Alice" }  //Return only documents
}
```

**Driver 6.x / 7.x default return format**:
```javascript
const result = await collection.findOneAndUpdate(filter, update);
//result format:
{
  _id: ...,
  name: "Alice"
}
```


### monSQLize current behavior

**With the current monSQLize package dependency baseline, user code receives the document directly or `null`:**

```javascript
const user = await collection.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } }
);

//All versions return the same format: the document itself
console.log(user);  // { _id: ..., name: "Alice", age: 31 }

//No need to judge version:
//Not required: if (result.value) return result.value;
//Not required: if (result.ok) return result;
```

**Implementation Boundary**:

- monSQLize provides out-of-the-box behavior with `mongodb@6.21.0` exact dependency.
- Driver 7.7.0 passed `test:compatibility` and server matrix verification.
- If the application is forced to overwrite the historical Driver 4.x / 5.x, you need to verify the return value difference by yourself. This is not recommended for new projects.

**Applicable methods**:
- findOneAndUpdate
- findOneAndReplace
- findOneAndDelete

---


## 2. `includeResultMetadata` explicit control

```javascript
//Default behavior (without options)
const result = await collection.findOneAndUpdate(filter, update);

console.log(result);
//Output:
//{ _id: ..., name: "Alice" } // Return the document directly!

//Get full metadata (requires explicit specification)
const result = await collection.findOneAndUpdate(filter, update, {
  includeResultMetadata: true
});

console.log(result);
//Output:
// {
//   value: { _id: ..., name: "Alice" },
//   ok: 1,
//   lastErrorObject: {
//     updatedExisting: true,
//     n: 1
//   }
// }
```

**Features**:
- Metadata is not returned by default, but the document or `null` is returned directly.
- When `includeResultMetadata: true` is required, explicitly pass in the native MongoDB Driver option.
- When migrating from old Driver metadata return values, avoid continuing to read `result.lastErrorObject` unconditionally.


## Other affected methods

| Methods | Driver 5.x Historical Defaults | Driver 6.21.0 / 7.7.0 Defaults | Current Recommendations |
|------|---------|---------|---------|
| **findOneAndUpdate** | `{ value, ok, lastErrorObject }` | Document object or `null` | Use the current dependency baseline; no need to extract `value` |
| **findOneAndReplace** | `{ value, ok, lastErrorObject }` | Document object or `null` | Use the current dependency baseline; no need to extract `value` |
| **findOneAndDelete** | `{ value, ok, lastErrorObject }` | Document object or `null` | Use the current dependency baseline; no need to extract `value` |
| **updateOne** | `{ acknowledged, matchedCount, ... }` | Same | Process as native results |
| **updateMany** | `{ acknowledged, matchedCount, ... }` | Same | Process as native results |
| **deleteOne** | `{ acknowledged, deletedCount }` | Same | Process as native results |
| **deleteMany** | `{ acknowledged, deletedCount }` | Same | Process as native results |
| **replaceOne** | `{ acknowledged, matchedCount, ... }` | Same | Process as native result |

**Note**: Driver 4.x / 5.x is only used as a reference for historical migration. The current documentation no longer lists them as the normal user verification path.

---

## monSQLize compatibility guarantee


## Core strategy: precise dependency + thin packaging + matrix verification

monSQLize does not require users to manually install or select a MongoDB Driver. The current package reduces usage burden in the following ways:

- `package.json` declares exactly `mongodb@6.21.0` and is ready to use after installation.
- The writing and querying API maintains thin encapsulation and transparently transmits the stable behavior of the current driver by default.
- `test:compatibility` with server matrix covers the current baseline and Driver 7.7.0 extended validation.
- Historical Driver 4.x / 5.x is only used as a migration reference, not as a current user path commitment.


## Key implementation locations

**Location**: `src/adapters/mongodb/writes/`

**Responsibilities**:
1. Call native `collection.findOneAndUpdate` / `findOneAndReplace` / `findOneAndDelete`
2. Keep the current Driver’s default behavior of returning documents or `null`
3. Provide monSQLize’s own encapsulation for extension methods such as batch writing, upsert, and increment.
4. Discover upstream driver behavior drift through the test matrix

**Core functions**:

```javascript
findOneAndUpdateDocument(collection, filter, update, options)
findOneAndReplaceDocument(collection, filter, replacement, options)
findOneAndDeleteDocument(collection, filter, options)
```


## Version management mechanism

- Normal monSQLize usage does not require users to declare `mongodb` directly.
- Compatibility verification temporarily overwrites the driver version and restores `mongodb@6.21.0` after verification.
- CI compatibility checks should use `npm ls mongodb` and `npm run test:compatibility` as evidence.


## Exception handling

- When there is no matching document, `findOneAnd*` returns `null`.
- If the caller explicitly passes in `includeResultMetadata: true`, the return value follows the MongoDB Driver native metadata structure.
- If the application is overwritten as a historical driver and gets `{ value, ok, lastErrorObject }`, you should first restore the package dependency baseline or complete migration verification at the application layer.

---

## Future driver upgrade guide


## Pre-upgrade checklist

When MongoDB releases a new major driver version (such as 8.x in the future), please follow these steps:


### Step 1: Read the official documentation ✅

- [ ] Read the MongoDB driven CHANGELOG
- [ ] Focus on changes to the `findOneAnd*` method
- [ ] Check for other breaking changes

**Official Source**:
- [MongoDB Node.js Driver Release Notes](https://github.com/mongodb/node-mongodb-native/releases)
- [Migration Guide](https://www.mongodb.com/docs/drivers/node/current/whats-new/)


### Step 2: Local Test ✅

```bash
# 1. Create a test branch
git checkout -b test/mongodb-driver-upgrade

# 2. Temporarily overwrite to the version to be verified
npm install mongodb@next --no-save --package-lock=false

# 3. Run compatibility verification
npm run test:compatibility
npm run test:server-matrix

# 4. Restore the current runtime dependency baseline
npm install mongodb@6.21.0 --no-save --package-lock=false
```


### Step 3: Check the log output ✅

```bash
# View the currently resolved driver version
npm ls mongodb

# View Compatibility Matrix Results
npm run test:compatibility
```


### Step 4: Fix compatibility issues ✅

**If the test fails**:

1. **Positioning problem**:
   ```bash
   #Run a specific test suite
   npm run test:compatibility -- --grep "findOneAnd"
   ```

2. **Analysis error**:
   - Is the format of the return value changed?
   - Is it a new/deleted field?
   - Is it a logical change in behavior?

3. **Modify the encapsulation layer or matrix**:
   - Check `src/adapters/mongodb/writes/` and `src/adapters/mongodb/common/` first
   - Keep the public API unchanged
   - If only the verification range changes, update `test/compatibility/matrix.json` first

4. **Update documentation**:
   - Updated "Supported driver versions" of this document
   - Update CHANGELOG.md
   - Updated compatibility notes in API documentation


### Step 5: Regression Testing ✅

```bash
# Complete test suite
npm test

# coverage check
npm run test:coverage

# Make sure there are no regression issues
```


## Fix example: How to adapt driver 7.x (assumed)

Assume that MongoDB driver 7.x changes the return value format again:

**Scenario**: Driver 7.x returns `{ document, metadata }` format

```javascript
// src/adapters/mongodb/writes/index.ts

function handleFindOneAndResult(result, options = {}, logger = null) {
    const driverVersion = detectDriverVersion();

    //New format for driver 7.x
    if (driverVersion >= 7) {
        //Adapt to new formats
        if (result && result.document !== undefined) {
            //Convert to unified format
            result = {
                value: result.document,
                ok: 1,
                lastErrorObject: result.metadata || { n: result.document ? 1 : 0 }
            };
        }
    }

    //Processing logic that drives 6.x (remains unchanged)
    // ...existing code...

    //Return uniformly
    if (options.includeResultMetadata) {
        return result;
    } else {
        return result.value !== undefined ? result.value : null;
    }
}
```

**Key Points**:
- First use temporary driver coverage to verify public API behavior.
- If a breaking change is found, priority is given to repairing it on the thin encapsulation layer of `src/adapters/mongodb/`.
- The public API remains unchanged and user code does not need to be modified.

---

## Test Strategy


## Test coverage

| Test Type | Command/Entrance | Description |
|---------|-----------|------|
| **Compatibility Matrix** | `npm run test:compatibility` | Covers current baseline and extended driver combinations |
| **Service Matrix** | `npm run test:server-matrix` | Covering real MongoDB / memory server scenarios |
| **Historical Verification Progress** | `test/validation/VERIFICATION-PROGRESS.md` | Earlier Driver 7.5.0 records; the current sample is in `test/compatibility/matrix.json` |
| **Real service results** | `test/validation/REAL-SERVER-MATRIX.md` | Record real service matrix acceptance |
| **Matrix Configuration** | `test/compatibility/matrix.json` | Maintain version combinations to be verified |


## Key test scenarios

**Required test scenarios**:
1. Find the document and modify it
2. Document not found (returns null)
3. upsert inserts a new document
4. Return to the document before update (`returnDocument: "before"`)
5. Return to the updated document (`returnDocument: "after"`)
6. Contains complete metadata (`includeResultMetadata: true`)
7. Cache automatically expires
8. Concurrency safety


## Automated test commands

```bash
# Run the current compatibility matrix
npm run test:compatibility

# Run MongoDB server matrix
npm run test:server-matrix

# View the currently resolved driver
npm ls mongodb
```

---

## Developer Guide


## Add new findOneAnd* style methods

If you need to add a similar method in the future (such as a custom `findOneAndModify`), please follow this pattern:

```javascript
// src/adapters/mongodb/writes/custom-find-one-and-modify.ts

async function customFindOneAndModify(filter, modification, options = {}) {
    try {
        // 1. Pass through supported native driver options explicitly.
        const driverOptions = { ...options };

        // 2. Call the native driver method.
        const result = await nativeCollection.customMethod(filter, modification, driverOptions);

        // 3. Invalidate cache only after a confirmed write path.
        if (cache) {
            // cache invalidation logic
        }

        // 4. Return the native document/null shape for the current driver baseline.
        return result;
    } catch (error) {
        throw error;
    }
}
```

**Key Points**:
- Keep TypeScript types consistent with `Collection<TSchema>` method signature.
- No new hidden version detection logic is added; version differences are discovered using matrix testing.
- `includeResultMetadata: true` is explicitly passed in by the caller when metadata is required.
- Synchronously update `test/compatibility/` and verification documents after modification.

---

## Related resources


## Internal documentation

- **Verification Entry**:
  - `test/validation/VERIFICATION-PROGRESS.md` - Current verification progress
  - `test/validation/REAL-SERVER-MATRIX.md` - Real service matrix results
  - `test/compatibility/matrix.json` - Driver/server version matrix configuration

- **API Documentation**:
  - `docs/find-one-and-update.md` - Contains compatibility notes
  - `docs/find-one-and-replace.md` - Contains compatibility notes
  - `docs/find-one-and-delete.md` - Contains compatibility notes


## External resources

- [MongoDB Node.js Driver Documentation](https://www.mongodb.com/docs/drivers/node/current/)
- [MongoDB Node.js Driver GitHub](https://github.com/mongodb/node-mongodb-native)
- [MongoDB Driver Release Notes](https://github.com/mongodb/node-mongodb-native/releases)

---

## FAQ


## Q1: Will there be any problems if I am using MongoDB driver 5.x?

**A**: The current dependency baseline does not resolve to Driver 5.x. If the application is forcibly replaced with 5.x through package manager overrides, please restore the package dependency baseline first:

```bash
npm install mongodb@6.21.0
```

If you must use 5.x, run compatibility verification yourself and handle differences between `{ value, ok, lastErrorObject }` and document objects at the application layer.


## Q2: How to know the driver version currently used?

**A**: Check for `package-lock.json` or run:

```bash
npm list mongodb
```

or in code:

```javascript
const mongodb = require("mongodb");
console.log("MongoDB Driver Version:", mongodb.version);
```


## Q3: What should I do if the test fails after upgrading to a future driver major version?

**A**: Follow the "Future Driver Upgrade Guide":

1. Look at the failed test suite (specifically `findOneAnd*`)
2. Analyze error logs
3. Evaluate whether compatibility processing is required for the corresponding thin packaging layer of `src/adapters/mongodb/`
4. Keep the public API unchanged

If you need help, please attach `test:compatibility` and server matrix output to submit an Issue.


## Q4: Why are only the findOneAnd* methods affected?

**A**: Because the return value format of these methods is more complex (including metadata), while the return value format of other methods (such as `updateOne`) is simple and unchanged.


## Q5: Will multiple driver versions be supported in the future?

**A**: There are currently no plans to support multiple versions. Reason:

- Increased maintenance costs
- Increase test complexity
- MongoDB driver follows semantic versioning, and the differences between major versions are clear

Recommended practice: Upgrade monSQLize with the major version upgrade of the MongoDB driver.
