# Database operation API

Database-level management operations, including listing databases, deleting databases, listing collections, etc.

## listDatabases()

List all databases on the MongoDB server.


## Syntax

```javascript
const databases = await db.listDatabases(options);
```


## Parameters

- **options** (Object, optional):
  - `nameOnly` (boolean): only returns the database name, default `false`


## Return value

- **Do not use nameOnly**: `Promise<Array<Object>>`
  - `name` (string): database name
  - `sizeOnDisk` (number): Disk usage (bytes)
  - `empty` (boolean): whether it is empty
- **Use nameOnly**: `Promise<Array<string>>`


## Example

```javascript
//Get details
const databases = await db.listDatabases();
console.log(databases);
// [
//   { name: 'admin', sizeOnDisk: 83886080, empty: false },
//   { name: 'mydb', sizeOnDisk: 167772160, empty: false }
// ]

//Get name only
const dbNames = await db.listDatabases({ nameOnly: true });
console.log(dbNames); // ['admin', 'config', 'local', 'mydb']
```

---

## dropDatabase()

**⚠️ Dangerous operation**: delete the entire database and cannot recover!


## Security mechanism

1. **Must be explicitly confirmed**: `{ confirm: true }` must be passed in
2. **Production environment protection**: `NODE_ENV=production`, `prod`, or `live` is blocked by default and requires `{ allowProduction: true }`
3. **Audit Log**: All deletion attempts will be logged


## Syntax (dropDatabase())

```javascript
const result = await db.db(databaseName).dropDatabase(options);
```


## Parameters (dropDatabase())

- **databaseName** (string, required): database name
- **options** (Object, required):
  - `confirm` (boolean, required): must be `true`
  - `allowProduction` (boolean): Whether to allow execution in the production environment, default `false`
  - `user` (string): operating user (for auditing)


## Return value (dropDatabase())

- **Type**: `Promise<Object>`
- **Properties**:
  - `dropped` (boolean): Whether the deletion was successful
  - `database` (string): deleted database name
  - `timestamp` (Date): deletion time


## Example (dropDatabase())


### ❌ Error: No confirmation provided

```javascript
try {
    await db.db('test_db').dropDatabase({ confirm: false });
} catch (error) {
    console.error(error.message);
    // "dropDatabase requires explicit confirmation..."
}
```


### ✅ Correct: Provide confirmation

```javascript
const result = await db.db('test_db').dropDatabase({
    confirm: true,
    user: 'admin@example.com'
});

console.log('Database dropped:', result.database);
console.log('Timestamp:', result.timestamp);
```


### ⚠️ Production environment: additional confirmation required

```javascript
// In a production-like environment (NODE_ENV=production, prod, or live)
const result = await db.db('prod_db').dropDatabase({
    confirm: true,
    allowProduction: true,
    user: 'admin@example.com'
});
```


## Error handling

```javascript
try {
    await db.db('my_database').dropDatabase({
        confirm: true,
        user: 'admin@example.com'
    });
} catch (error) {
    if (error.code === 'CONFIRMATION_REQUIRED') {
        console.error('❌ Missing confirmation parameters');
    } else if (error.code === 'PRODUCTION_BLOCKED') {
        console.error('❌ Production environment blocked');
    } else {
        console.error('❌ Delete failed:', error.message);
    }
}
```

---

## listCollections()

List all collections in the current database.


## Syntax (listCollections())

```javascript
const collections = await db.listCollections(filter, options);
```


## Parameters (listCollections())

- **filter** (Object, optional): MongoDB collection-list filter
- **options** (Object, optional): MongoDB listCollections options


## Return value (listCollections())

- `Promise<Array<Object>>`


## Example (listCollections())

```javascript
//Get details
const collections = await db.listCollections();
console.log(collections);
// [
//   { name: 'users', type: 'collection', options: {}, info: {...} },
//   { name: 'orders', type: 'collection', options: {}, info: {...} }
// ]

//Get name only from the public return value
const names = collections.map((collection) => collection.name);
console.log(names); // ['users', 'orders', 'products']
```

---

## runCommand()

Execute any MongoDB command.


## Syntax (runCommand())

```javascript
const result = await db.runCommand(command, options);
```


## Parameters (runCommand())

- **command** (Object, required): MongoDB command object
- **options** (Object, optional): command options


## Example (runCommand())

```javascript
//Execute ping command
const ping = await db.runCommand({ ping: 1 });
console.log(ping.ok); // 1

//Execute dbStats command
const stats = await db.runCommand({ dbStats: 1, scale: 1024 });
console.log('Collections:', stats.collections);
console.log('Data size (KB):', stats.dataSize);

//Execute collStats command
const collStats = await db.runCommand({
    collStats: 'users',
    scale: 1048576 // MB
});
console.log('Count:', collStats.count);
console.log('Size (MB):', collStats.size);
```

---

## Related documents

- [Operation and Maintenance Monitoring](./admin.md) - ping, buildInfo, serverStatus, stats
- [Collection Management](./collection-management.md) - Collection level operations
- [Collection Management Example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts)
