# ObjectId Cross-version Compatibility - Frequently Asked Questions (FAQ)

## Q1: Will automatically converting the old version ObjectId to bson@6.x affect the old version of mongoose?


## Problem description

Worry that after monSQLize converts ObjectId, mongoose will have problems reading data.


## Short answer

**There will be no impact! Fully backwards compatible. ** ✅


## Detailed explanation


### 1. Timing and direction of conversion

```text
┌─────────────┐                   ┌─────────────┐
│  mongoose   │ ─────────────────→│  MongoDB    │
│ (bson@4.x) │ Write (no conversion required) │ Database │
└─────────────┘                   └─────────────┘
                                        ↑  ↓
       ┌────────────────────────────────┘  └────────────────────────────────┐
       │                                                                     │
Read (automatic) Write (convert)
       │                                                                     │
       ↓                                                                     ↓
┌─────────────┐                                                    ┌─────────────┐
│  mongoose   │ ←──────────────────────────────────────────────── │ monSQLize   │
│ (bson@4.x) │ ✅ Normal reading without monSQLize intervention │ (bson@6.x) │
└─────────────┘                                                    └─────────────┘
```

**Key Points**:
- ✅ **Conversion is one-way**: only happens when monSQLize writes
- ✅ **Database Storage Unification**: The BSON binary format of ObjectId is standard (12 bytes)
- ✅ **mongoose reads automatically**: mongoose will automatically convert BSON to its own ObjectId when reading


### 2. Storage format of ObjectId

Whether it is bson@4.x, 5.x or 6.x, the storage format of ObjectId in MongoDB is the same:

```text
BSON binary format (12 bytes):
┌─────────────┬─────────┬─────────┬─────────┐
│  Timestamp  │ Machine │ Process │ Counter │
│  (4 bytes)  │(3 bytes)│(2 bytes)│(3 bytes)│
└─────────────┴─────────┴─────────┴─────────┘
```

**Key Points**:
- All BSON versions follow the same specification
- MongoDB does not care which BSON version the ObjectId was created from
- When reading, each library will convert BSON into its own ObjectId instance


### 3. Actual test verification

Currently ObjectId compatibility is covered by `npm run test:examples` in conjunction with the ObjectId converter unit/integration tests:

**Testing process**:
1. ✅ monSQLize insert data (including old version ObjectId, automatically converted to bson@6.x)
2. ✅ Native driver reading (simulating mongoose), verifying ObjectId value and type
3. ✅ Native driver update data (simulate mongoose writing)
4. ✅ monSQLize reads the updated data and verifies the consistency

**Test conclusion**:
```text
✅ The data written by monSQLize can be read normally by the native driver
✅ The ObjectId values are exactly the same (the hexadecimal strings are the same)
✅ The ObjectId type is correct (all are ObjectId instances)
✅ Data written by the native driver (mongoose) can be read normally by monSQLize
✅ Mixing monSQLize and mongoose without any problem
```


### 4. Why doesn’t it affect mongoose?

**Core Principle**:

1. **Conversion only affects writing**
   - monSQLize when writing: old version ObjectId → new version ObjectId → BSON (12 bytes)
   - mongoose when writing: old version ObjectId → BSON (12 bytes)
   - **The storage results are the same**: both are in standard BSON format

2. **Convert each when reading**
   - mongoose reads: BSON (12 bytes) → mongoose's ObjectId (bson@4.x/5.x)
   - monSQLize reads: BSON (12 bytes) → monSQLize's ObjectId (bson@6.x)
   - **Independent**: do not interfere with each other

3. **ObjectId value is always consistent**
   ```javascript
   //monSQLize write
   const legacyId = mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
   await msq.collection('users').insertOne({ userId: legacyId });
   //Store to MongoDB: BSON(507f1f77bcf86cd799439011)

   //mongoose read
   const user = await User.findOne({ _id: ... });
   console.log(user.userId.toString());  // "507f1f77bcf86cd799439011" ✅

   //monSQLize read
   const user2 = await msq.collection('users').findOne({ _id: ... });
   console.log(user2.userId.toString());  // "507f1f77bcf86cd799439011" ✅
   ```


### 5. Actual usage scenarios

**Scenario 1: mongoose service → monSQLize service (cross-service call)**

```javascript
//Service A (using mongoose)
const user = await User.findOne({ username: 'john' }).lean();
//user.userId is the ObjectId of mongoose (bson@4.x/5.x)

//Call service B (using monSQLize)
await axios.post('http://service-b/api/orders', { userId: user.userId });

//Service B receives data
app.post('/api/orders', async (req, res) => {
    const { userId } = req.body;  //Old version ObjectId

    //✅ monSQLize automatic conversion
    await msq.collection('orders').insertOne({
        userId,  //Automatically converted to bson@6.x
        productId: new ObjectId(),
        status: 'pending'
    });
});
```

**Scenario 2: mongoose and monSQLize use the same database**

```javascript
//mongoose write
await User.create({ username: 'alice', age: 25 });

//monSQLize read
const users = await msq.collection('users').find({ age: { $gte: 18 } });
//✅ completely normal

//monSQLize write
await msq.collection('users').insertOne({ username: 'bob', age: 30 });

//mongoose read
const bob = await User.findOne({ username: 'bob' });
//✅ completely normal
```


## Summary

| Question | Answer |
|------|------|
| Will it affect mongoose reading? | ❌ No, mongoose will automatically convert when reading |
| Will it affect the data in the database? | ❌ No, the storage format is exactly the same |
| Need to modify the mongoose code? | ❌ No need, completely transparent |
| Can I mix mongoose and monSQLize? | ✅ Yes, fully compatible |
| Does conversion have a performance impact? | ✅ Extremely small (~0.01ms/ObjectId) |
| Will data be lost? | ❌ No, the ObjectId values are exactly the same |

---

## Q2: Why are there so many conversion logs? How to close?


## Solved ✅

ObjectId conversion is silent by default and does not emit per-value conversion logs.

```javascript
//Default configuration (no logs)
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' }
});

await msq.collection('users').insertOne(dataWithObjectIds);
//✅ No log output
```


## Why is it silent by default?

Based on user feedback, ObjectId conversion log:
- ❌ Has no practical effect (conversion is automatic)
- ❌ Pollution log output
- ❌ Increase log storage overhead

The converter keeps these logs off by default.


## How to verify conversion in the current v3 runtime

The current converter does not expose `silent` or `verbose` logging controls. If you need to debug conversion, use integration tests, MongoDB command monitoring, or focused converter unit tests.

**Detailed description**: [ObjectId conversion diagnostics](./objectid-logging-optimization.md)

---

## Q3: How to verify whether my project has compatibility issues?

Run the following test script:

```bash
# Run the official sample suite containing the ObjectId sample
npm run test:examples

# Run the default test suite containing the ObjectId converter regression case
npm test
```

---

## Q4: If I don’t want automatic conversion, can I disable it?

Yes. Automatic conversion is enabled by default for MongoDB, but you can disable it globally or narrow it for specific fields.

```javascript
// Disable ObjectId auto conversion globally.
const msq = new MonSQLize({
  type: 'mongodb',
  autoConvertObjectId: false,
  config: { uri: 'mongodb://localhost:27017' }
});

// Or keep conversion enabled but preserve selected business fields as strings.
const msq2 = new MonSQLize({
  type: 'mongodb',
  autoConvertObjectId: {
    enabled: true,
    excludeFields: ['transactionHash', 'idempotencyKey'],
    signature: false
  },
  config: { uri: 'mongodb://localhost:27017' }
});
```

Use these options for fields that can legitimately contain 24-character hexadecimal strings but are not MongoDB ObjectId values.

---

## Q5: How to deal with conflicts with other BSON types?

Currently, only cross-version compatibility of ObjectId is handled. If you encounter conflicts with other types (such as Decimal128, Binary, etc.), please:

1. Submit Issue: https://github.com/devcodex-labs/monSQLize/issues
2. Provide reproduction steps and error information
3. We will prioritize

---

## Related documents

- [ObjectId Cross-version Compatibility Guide](./objectid-cross-version.md)
- [CHANGELOG](../../CHANGELOG.md)
