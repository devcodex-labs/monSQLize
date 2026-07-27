# Model API documentation

The Model layer adds schema validation, custom methods, lifecycle hooks, relations, and model-scoped write helpers on top of the MongoDB runtime. It keeps collection access explicit while giving repeated document workflows a consistent Model surface.

**Features**: Schema validation · Custom methods · Lifecycle hooks · Automatic indexing · Data source binding

---

## Quick start

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//1. Define Model
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        password: 'string!',
        age: 'number:0-120'
    }),
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    })
});

//2. Use Model
const msq = new MonSQLize({ ... });
await msq.connect();
const User = msq.model('users');

//Insert
await User.insertOne({
    username: 'test',
    email: 'test@example.com',
    password: 'secret123',
    age: 25
});

//Query and use methods
const user = await User.findByUsername('test');
if (user.checkPassword('secret123')) {
    console.log('Login successful');
}
```

---

## schema-dsl runtime

Model schema callbacks receive the `s` namespace from the MonSQLize instance's isolated `schema-dsl/runtime`. `Model.define()` stores the definition only; schema compilation and validation happen when `msq.model(name)` creates a runtime-bound Model instance.

For the default path, no application import from `schema-dsl` is required:

```javascript
Model.define('users', {
    schema: (s) => s({
        email: 'email!',
        name: s.string().min(1).max(64).require()
    })
});

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' }
});
```

When the application needs custom runtime-local types, messages, locale, or shared schema-dsl state, create or inject a `schema-dsl/runtime` instance through `schemaDsl`:

```javascript
import { createRuntime } from 'schema-dsl/runtime';

const schemaRuntime = createRuntime({
    types: {
        tenantId: { type: 'string', pattern: '^tenant_[a-z0-9]+$' }
    }
});

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
    schemaDsl: { runtime: schemaRuntime }
});
```

Use `schemaDsl: { extensions }` when monSQLize should own the runtime and register extension definitions. When the application owns the schema-dsl lifecycle, configure that runtime directly, including `runtime.registerExtensions([...])`, and inject it with `schemaDsl: { runtime }`. If the default `schema-dsl/runtime` entry cannot be resolved or does not expose the required runtime APIs, monSQLize throws `INVALID_CONFIG`; validation is disabled only when `schemaDsl: false` or `schemaDsl: { enabled: false }` is set explicitly.

---

## API Reference


## Model.define(collectionName, definition)

Register the Model definition.

**Parameters**:
- `collectionName` - collection name
- `definition` - Model definition
  - `collection` - the actual MongoDB collection name; if not filled in, it will fall back to `name` and `collectionName`.
  - `name` - Model automatically loads the compatible collection name in the file; `collection` has higher priority
  - `schema` (required) - Schema definition
  - `enums` - enumeration configuration
  - `methods` - Custom method
  - `hooks` - life cycle hook
  - `indexes` - Index definition
  - `connection` - Data source binding
    - `pool` - connection pool name, must be consistent with constructor `pools[].name`
    - `database` - database name, if left blank, use instance `databaseName`
  - `options.autoIndex` - Optional Model-level automatic index control; overrides the runtime `autoIndex` option

```javascript
Model.define('users', {
    //Optional: Separate the registered name from the actual MongoDB collection name
    // collection: 'app_users',
    enums: {
        role: 'admin|user|guest'
    },
    schema: function(s) {
        return s({
            username: 'string:3-32!',
            email: 'email!',
            password: 'string!',
            role: this.enums.role.default('user')
        });
    },
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    }),
    hooks: (model) => ({
        insert: {
            before: async (ctx, docs) => {
                return { ...docs, createdAt: new Date() };
            }
        }
    }),
    indexes: [
        { key: { username: 1 }, unique: true }
    ]
});
```

---


## Model.get(collectionName)

Get the registered Model definition.

**Parameters**:
- `collectionName` (string) - Collection name

**Return**: `{ collectionName: string, definition: object } | undefined`

Returns a wrapper object containing `collectionName` and `definition`. If the specified Model is not registered, `undefined` is returned.

```javascript
//Get the registered Model definition
const userModel = Model.get('users');

if (userModel) {
    console.log(userModel.collectionName); // 'users'
    console.log(userModel.definition);     // { schema: ..., methods: ..., ... }
}

//Unregistered Model returns undefined
const notFound = Model.get('nonexistent');
console.log(notFound); // undefined
```

---


## Model.has(collectionName)

Check if the Model is registered.

**Parameters**:
- `collectionName` (string) - Collection name

**Return**: `boolean`

```javascript
//Check if the Model is registered
if (Model.has('users')) {
    console.log('users Model is registered');
}

//Conditional registration: avoid duplicate definitions
if (!Model.has('users')) {
    Model.define('users', {
        schema: (s) => s({ username: 'string!' })
    });
}
```

---


## Model.list()

Get all registered Model names.

**No parameters**

**Return**: `string[]` - array of collection names of all registered Models

```javascript
//Get all registered Model names
const models = Model.list();
console.log(models); // ['users', 'posts', 'comments']

//Traverse all registered Models
for (const name of Model.list()) {
    const model = Model.get(name);
    console.log(`${name}:`, model.definition);
}
```

---


## Model.redefine(collectionName, definition)

Redefine a registered Model. Equivalent to the combined operation of `undefine()` + `define()`.

**Parameters**:
- `collectionName` (string) - Collection name
- `definition` (object) - new Model definition

**Return**:void

If the Model does not exist, the behavior is equivalent to `define()`.

> ⚠️ **Note**: If the new definition fails verification, the old definition will be removed (will not be rolled back). Mainly used for Model hot reloading in development mode.

**Throwable**: `Error` (same verification logic as `define()`)

```javascript
//Redefine a registered Model
Model.redefine('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        avatar: 'string'   //Add new field
    })
});

//Hot reload example in development mode
if (process.env.NODE_ENV === 'development') {
    Model.redefine('users', updatedDefinition);
}
```

---


## Model.undefine(collectionName)

Unregister a registered Model definition. Idempotent operation, no error will be thrown for non-existent Model.

**Parameters**:
- `collectionName` (string) - The name of the collection to be logged out

**Return**: `boolean` - Successful removal returns `true`, non-existence returns `false`

Already instantiated ModelInstances are not affected. Mainly used for Model hot reloading in development mode.

```javascript
//Unregister a registered Model
const removed = Model.undefine('users');
console.log(removed); // true

//Don’t throw errors for non-existent Models
const notFound = Model.undefine('nonexistent');
console.log(notFound); // false

//Can be redefined after logging out
Model.undefine('users');
Model.define('users', newDefinition);
```

---


## msq.model(collectionName)

Get the Model instance.

> **Cache Behavior**: Under the same runtime/pool/database/registration name/actual collection name/defined version, calling `msq.model()` multiple times returns the same `ModelInstance` instance.
> - Model automatic indexing is enabled by default and will be scheduled when an instance is created for the first time. The task calls `listIndexes()` first, skips matching existing indexes, creates only missing indexes, and deduplicates pending / fulfilled tasks in the same process.
> - Disable automatic model indexing globally with `new MonSQLize({ autoIndex: false })`, or per Model with `options: { autoIndex: false }`.
> - `connect()` only loads and registers the Model definition. `ModelInstance` will not be created separately, nor will it trigger index creation separately.
> - After the process is restarted, the memory task table is cleared, and the next first use of the corresponding Model runs the index preflight again and creates any still-missing indexes.
> - Automatic indexing does not drop, rename, or rebuild conflicting indexes. Conflicts and creation failures are logged; failed creation tasks may be retried later, and runtimes with events emit `model-index-error`.
> - For production rollout, prefer `autoIndex: false` plus explicit `ensureIndexes({ dryRun: true })` or `msq.ensureModelIndexes({ dryRun: true })` before creating missing indexes.
> - After `Model.redefine()` or `Model.undefine()`, the next time you call `msq.model()`, you will automatically obtain the newly defined instance.
> - After `Model.redefine()` or `Model.undefine()`, cached instances are invalidated and the next `msq.model()` call rebuilds them.
> - Clear all caches after `msq.close()`

```javascript
const User = msq.model('users');

//Inherit all collection methods
const users = await User.find({ status: 'active' });
const user = await User.findOne({ username: 'test' });

//Use custom static methods
const admin = await User.findByUsername('admin');
```

---


## validate(data, options)

Validate data.

```javascript
const result = User.validate({
    username: 'test',
    email: 'test@example.com'
});

if (!result.valid) {
    console.error('Verification failed:', result.errors);
}
```

---

## Registered name and actual collection name

The first parameter of `Model.define(collectionName, definition)` is the registration name, which is also the name used when calling `msq.model(collectionName)`. When accessing MongoDB at runtime, the actual collection names are resolved in the following order:

1. `definition.collection`
2. `definition.name`
3. `collectionName` of `Model.define()`

```javascript
Model.define('UserModel', {
    collection: 'users',
    schema: (s) => s({
        username: 'string!'
    })
});

const User = msq.model('UserModel'); //Get Model using registered name
await User.insertOne({ username: 'alice' }); //Actual writing to the MongoDB users collection
```

`definition.name` is mainly compatible with the automatic loading file format; during manual registration, `collection` is preferred to express the actual collection name. The Model instance cache key contains pool, database, registration name and actual collection name at the same time to avoid reusing the same instance for different routes or different actual collections.

Model registration is process-level, similar to Mongoose model registration. `Model.define('users', ...)` can be called only once for a given registered name in the process; a second definition with the same name throws `MODEL_ALREADY_EXISTS`. For multi-tenant or multi-database applications that need different schemas with the same MongoDB collection name, use distinct registered names and set `definition.collection`, or explicitly use `Model.redefine()` / `Model.undefine()` in test or development flows.

If `relations.from` points to a registered Model, populate will use the actual collection name of the Model; if there is no Model with the same name, `from` will be used as the original collection name. This is compatible with the common "reference relationship by model name" in v1, and also retains the method of directly writing the MongoDB collection name.

---

## Data source binding

Through the `connection` field of `Model.define()`, bind the Model to the specified connection pool and/or database to implement multi-data source routing.


## Four routing combinations

| `pool` | `database` | Routing target |
|:------:|:----------:|---------|
| — | — | Default connection pool + instance `databaseName` |
| — | ✅ | Default connection pool + specified database |
| ✅ | — | Specify connection pool + instance `databaseName` |
| ✅ | ✅ | Designated connection pool + designated database |


## Usage examples

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//1. First configure the MonSQLize instance (declare the connection pool)
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'main_db',
    config: { uri: 'mongodb://localhost:27017' },
    pools: [
        {
            name: 'analytics',
            uri: 'mongodb://analytics-host:27017'
        }
    ]
});

//2. Define Model and reference the pool name declared above in connection
//Scenario 1: Switch database only (default connection pool)
Model.define('AuditLog', {
    schema: (s) => s({ action: 'string!', userId: 'objectId' }),
    connection: { database: 'audit_db' }
});

//Scenario 2: Switch connection pool only (using instance default database main_db)
Model.define('AnalyticsEvent', {
    schema: (s) => s({ event: 'string!', ts: 'date' }),
    connection: { pool: 'analytics' }
});

//Scenario 3: Switch connection pool + database at the same time
Model.define('AnalyticsReport', {
    schema: (s) => s({ reportId: 'string!', data: 'object' }),
    connection: { pool: 'analytics', database: 'reports_db' }
});

//Ordinary Model (no connection, default logic)
Model.define('User', {
    schema: (s) => s({ name: 'string!', email: 'email!' })
});

//3. Connect
await msq.connect();

//4. Routing is automatically processed and the calling method remains unchanged.
const AuditLogModel       = msq.model('AuditLog');        //→ audit_db (default pool)
const AnalyticsEventModel = msq.model('AnalyticsEvent');  //→ main_db (analytics pool)
const ReportModel         = msq.model('AnalyticsReport'); //→ reports_db (analytics pool)
const UserModel           = msq.model('User');            //→ main_db (default pool, original logic)
```


## Error code

| Error code | Trigger condition |
|--------|---------|
| `NO_POOL_MANAGER` | Model is configured with `pool`, but the constructor is not configured with `pools` |
| `POOL_NOT_FOUND` | `pool` The specified name does not exist in the registered connection pool |
| `INVALID_MODEL_DEFINITION` | `pool` or `database` is an empty string |

---

## Model automatic loading


## Function description

monSQLize supports automatically scanning the specified directory and loading all Model definition files without manually calling `Model.define()`.


## How to use


### Simplify configuration

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: '...' },
    models: './models'  //← Autoload
});

await msq.connect();  //Automatically scan models/*.model.{js,mjs,cjs}

//Use directly (no Model.define required)
const User = msq.model('users');
```

> ⚠️ **Path parsing rules**: The relative path is based on **`process.cwd()`** (Node.js process startup directory), not the directory where the file `new MonSQLize()` is located. Usually when starting the service in the project root directory, `'./models'` is equivalent to `<project-root>/models/`. To avoid ambiguity, it is recommended to use absolute paths:
> ```javascript
> models: path.join(__dirname, 'models')
> ```


### Complete configuration

```javascript
const msq = new MonSQLize({
    models: {
        path: path.join(__dirname, 'models'), //Recommended: absolute path, based on the current file directory
        pattern: '*.model.js',               //file name pattern
        recursive: true                      //Scan subdirectories recursively
    }
});
```


## Model file format

```javascript
// models/user.model.js
module.exports = {
    name: 'users',  //Collection name (required)

    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!'
    }),

    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    }),

    hooks: (model) => ({
        insert: {
            before: async (ctx, doc) => {
                doc.createdAt = new Date();
                return doc;
            }
        }
    }),

    indexes: [
        { key: { username: 1 }, unique: true }
    ]
};
```


## Directory structure

```text
models/
├── user.model.js
├── post.model.js
├── comment.model.js
└── admin/
    ├── role.model.js
    └── permission.model.js
```


## Supported file formats

- ✅ `.js` - CommonJS
- ✅ `.mjs` - ES Module
- ✅ `.cjs` - CommonJS (explicit)
- ⚠️ `.ts` - TypeScript source files must be compiled first or loaded through a runtime loader registered by the application; the default autoloader does not require `.ts` files directly.


## Configuration options

| Options | Type | Default | Description |
|------|------|--------|------|
| `path` | string | - | Model file directory (required) |
| `pattern` | string | `*.model.{js,mjs,cjs}` | File name pattern (supports glob) |
| `recursive` | boolean | `false` | Whether to scan subdirectories recursively |


## Error handling


### Directory does not exist
```text
[Model] Models directory not found: /path/to/models
```


### File format error
```text
[Model] ❌ Failed to load models/invalid.model.js: export is null
[Model] ❌ Failed to load models/no-name.model.js: missing 'name' property
```


### Repeat registration
```text
[Model] Model 'users' already registered, skipping models/user2.model.js
```


## Best Practices

1. **Uniform naming convention**: use `{name}.model.js` format
2. **Group by function**: Use subdirectories to organize (such as `admin/`, `public/`)
3. **Export Format**: Always use `module.exports = { name, ... }`
4. **Test environment**: You can disable automatic loading and manually register the test model


## Notes

- ⚠️ File must contain `name` attribute
- ⚠️ For duplicate Model names, only the first one will be registered
- ⚠️ File syntax errors will cause loading failure (logging, no interruption)
- ⚠️ TypeScript files require runtime support (ts-node or after compilation)


## Compared with manual registration

| Method | Advantages | Disadvantages |
|------|------|------|
| Manual registration | Precise control, explicit dependencies | Duplicate code, high maintenance costs |
| Automatic loading | Automatic discovery, concise code | Implicit dependencies, uncertain loading order |

**Recommendation**: Use automatic loading for the production environment, and manual registration for the test environment.

---

## Schema validation


## Runtime behavior

monSQLize uses `schema-dsl` as the schema validation engine for Model documents. Each connected `MonSQLize` runtime owns or receives an isolated `schema-dsl/runtime` instance through the `schemaDsl` option, so application code can use the runtime-scoped `s` helper without importing the global DSL entry.

`Model.define()` stores the definition in the process-wide registry. The schema callback is compiled when `msq.model(name)` binds that definition to a runtime. Validation runs for full-document Model writes that define a schema: `insertOne()`, `insertMany()`, `insertBatch()`, `replaceOne()`, `findOneAndReplace()`, and hydrated document `save()`. It is disabled only when the Model sets `options.validate: false`, a supported write operation passes `skipValidation: true`, or the runtime explicitly disables the schema DSL with `schemaDsl: false` / `{ enabled: false }`.

When validation succeeds, those six write paths continue with schema-dsl's normalized `data`, so coercion, schema defaults, and allowed property removal reach MongoDB. The fixed order is model defaults, before hook, schema normalization, timestamps, version, then driver write; stages that do not apply to replacement or hydrated `save()` remain absent. A failed result, or a successful result whose normalized data is not an object, stops before the driver write. `Model.validate()` exposes normalized `data` without writing it.

Patch-style writes such as `updateOne()`, `updateMany()`, `findOneAndUpdate()`, `upsertOne()`, `incrementOne()`, and `updateBatch()` receive MongoDB update operators or aggregation pipelines rather than the final document. monSQLize does not run full-document schema validation for those patch writes; use hooks, `Model.validate()`, or application-side validation when a patch must be checked against a complete domain object.


## Basic usage

```javascript
import { Model } from 'monsqlize';

Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',      //Required, 3-32 characters
        email: 'email!',               //Required, email format
        password: 'string:6-!',        //Required, at least 6 characters
        age: 'number:0-120',           //Optional, range 0-120
        role: 'string?'                //optional string
    })
});

const User = msq.model('users');

// Full-document writes validate automatically for runtime-bound Models with a schema.
await User.insertOne({
    username: 'john',
    email: 'john@example.com',
    password: 'secret123',
    age: 25
});

//❌ Verification failed
try {
    await User.insertOne({
        username: 'ab',        //too short
        email: 'invalid',      //Email format error
        password: '123'        //too short
    });
} catch (err) {
    console.error(err.code);    // 'VALIDATION_ERROR'
    console.error(err.message); // 'Schema validation failed: ...'
    console.error(err.errors);  //Detailed error array
}
```


## Schema syntax

| Type | Syntax | Example |
|------|------|------|
| String | `string` | `'string!'` Required string |
| String range | `string:min-max` | `'string:3-32!'` 3-32 characters |
| Number | `number` | `'number!'` Required number |
| Numeric range | `number:min-max` | `'number:0-120'` 0-120 range |
| Email | `email` | `'email!'` Email format |
| URL | `url` | `'url!'` URL format |
| Array | `array` | `'array!'` Required Array |
| Object | `object` | `'object!'` Required Object |
| Boolean | `boolean` | `'boolean!'` Required Boolean |
| Date | `date` | `'date!'` Date object |
| Optional | `type?` | `'string?'` optional string |
| Required | `type!` | `'string!'` Required string |

See [schema-dsl documentation](https://github.com/devcodex-labs/schema-dsl) for more syntax.


## Verification error details

```javascript
try {
    await User.insertOne({ username: 'ab', email: 'invalid' });
} catch (err) {
    console.log(err.code);     // 'VALIDATION_ERROR'
    console.log(err.message);  // 'Schema validation failed: ...'
    console.log(err.errors);   //Detailed error array
    /*
    [
        {
            field: 'username',
            message: 'username must be 3-32 characters'
        },
        {
            field: 'email',
            message: 'email must be a valid email address'
        }
    ]
    */
}
```

The public monSQLize error boundary is `{ field, message }`. `field` is mapped from schema-dsl's canonical `path`; deprecated upstream aliases such as `field`, `type`, and `expected` are not part of the monSQLize contract.


## Disable verification


### Disable globally (not recommended)

```javascript
Model.define('users', {
    schema: (s) => s({ ... }),
    options: { validate: false }  //Disable validation globally
});
```


### Single operation skip

```javascript
//Skip verification (special scenarios, such as data migration)
await User.insertOne(doc, { skipValidation: true });
```


## Performance impact

- **Validation overhead**: about 5-10% overhead on typical schema-heavy full-document write paths.
- **Cache optimization**: schemas are compiled when the Model binds to a runtime and then reused.
- **Skip option**: validation can be skipped with `skipValidation` for controlled migration or repair jobs.


## Best Practices

1. **Always define Schema**: Ensure data quality
2. **Use optional fields appropriately**: Avoid being overly strict
3. **Custom verification**: Use hooks to add complex verification logic
4. **Error handling**: Capture `VALIDATION_ERROR` and return a friendly error


## FAQ

**Q: How to validate nested objects?**

A: Use the nested syntax of schema-dsl:

```javascript
schema: (s) => s({
    profile: s({
        name: 'string!',
        age: 'number!'
    })
})
```

**Q: How to customize the verification logic?**

A: Use hooks to add complex validation:

```javascript
hooks: (model) => ({
    insert: {
        before: async (ctx, doc) => {
            if (doc.age < 18) {
                throw new Error('Must be 18+');
            }
            return doc;
        }
    }
})
```

**Q: How to optimize performance-sensitive scenarios?**

A: You can choose to skip verification when inserting in batches (at your own risk):

```javascript
await User.insertMany(docs, { skipValidation: true });
```

---

## Configuration instructions


## 1. schema - data validation

Define field validation rules.

```javascript
//Recommendation: Use function to reference enums
schema: function(s) {
    return s({
        username: 'string:3-32!',
        email: 'email!',
        age: 'number:0-120',
        role: this.enums.role.default('user')  //Reference enums
    });
}

//Or use object directly
schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!'
})
```

**Common Rules**:
- `string!` - required string
- `string:3-32` - length 3-32
- `number:0-120` - Number range
- `email!` - Email format
- `.default('value')` - Default value
- `.pattern(/regex/)` - Regular verification

---


## 2. methods - custom methods


### instance method

Injected into the document object returned by the query.

```javascript
methods: (model) => ({
    instance: {
        checkPassword(password) {
            return this.password === password;  //this = document object
        },
        isAdmin() {
            return this.role === 'admin';
        }
    }
})

//use
const user = await User.findOne({ username: 'test' });
user.checkPassword('secret123');  // ✅
user.isAdmin();                   // ✅
```

**Note**:
- ⚠️ Must use ordinary functions, not arrow functions
- ⚠️ To avoid conflicting method names with field names, use verb prefixes: `is*`, `check*`, `get*`
- ⚠️ Modification of `this` will not be automatically saved to the database


### static method

Mount to the Model instance.

```javascript
methods: (model) => ({
    static: {
        async findByUsername(username) {
            return await model.findOne({ username });
        },
        async findAdmins() {
            return await model.find({ role: 'admin' });
        }
    }
})

//use
const User = msq.model('users');
const user = await User.findByUsername('test');  // ✅
const admins = await User.findAdmins();          // ✅
```

---


## 3. hooks - life cycle hooks

Execute custom logic before and after operations.

```javascript
hooks: (model) => ({
    insert: {
        before: async (ctx, docs) => {
            //Automatically add timestamp
            return { ...docs, createdAt: new Date() };
        },
        after: async (ctx, result) => {
            console.log('Insertion completed');
        }
    },
    update: {
        before: async (ctx, filter, update) => {
            if (!update.$set) update.$set = {};
            update.$set.updatedAt = new Date();
            return [filter, update];
        }
    }
})
```

**Supported operations**: `find`, `insert`, `update`, `delete`

**ctx context**: used to pass data between before and after

```javascript
before: async (ctx, docs) => {
    ctx.timestamp = Date.now();
},
after: async (ctx, result) => {
    console.log('Time taken:', Date.now() - ctx.timestamp);
}
```

---


## 4. indexes - Automatically create indexes

```javascript
indexes: [
    { key: { username: 1 }, unique: true },      //unique index
    { key: { status: 1, createdAt: -1 } },       //composite index
    { key: { expireAt: 1 }, expireAfterSeconds: 0 }  //TTL index
]
```

Automatic indexes are only scheduled when `ModelInstance` is created and will not be re-created for every query or every request. Within the same process, monSQLize records an index ensure task according to the runtime / pool / database / collection / declared-index-set fingerprint: repeated scheduling is skipped while the task is pending or fulfilled; creation failures are allowed to be rescheduled next time.

Automatic indexing is enabled by default for backward compatibility. Production services can disable it globally or per Model:

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    autoIndex: false
});

Model.define('users', {
    schema: (s) => s({ email: 'email!' }),
    options: { autoIndex: false },
    indexes: [
        { key: { email: 1 }, unique: true, name: 'users_email_unique' }
    ]
});
```

Use the explicit ensure APIs for release preflight and controlled execution:

```javascript
const User = msq.model('users');

const plan = await User.ensureIndexes({ dryRun: true });
console.log(plan.missing, plan.conflicts);

if (plan.conflicts.length === 0) {
    await User.ensureIndexes({ throwOnError: true });
}

const summary = await msq.ensureModelIndexes({
    models: ['users'],
    dryRun: true
});
console.log(summary.totals);
```

`ensureIndexes()` and `ensureModelIndexes()` call `listIndexes()` first and classify declared indexes as `existing`, `missing`, or `conflicts`. Dry-run mode never calls `createIndex()`. Execution creates only `missing` indexes; it does not drop, rename, or rebuild conflicting indexes. Set `throwOnError: true` to fail the explicit ensure call with a MonSQLize `MONGODB_ERROR` when conflicts or creation failures are found.

Automatic indexing uses the same preflight classification before it creates indexes. It skips `existing`, creates `missing`, and reports `conflicts` through warning logs and `model-index-error` events without changing those indexes.

---


## 5. enums - enumeration configuration

```javascript
enums: {
    role: 'admin|user|guest',
    status: 'active|inactive'
}

//Referenced in schema
schema: function(s) {
    return s({
        role: this.enums.role.default('user')
    });
}
```

---

## Complete example

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//Define User Model
Model.define('users', {
    enums: {
        role: 'admin|user|guest',
        status: 'active|inactive|banned'
    },
    schema: function(s) {
        return s({
            username: 'string:3-32!',
            email: 'email!',
            password: 'string!'.pattern(/^[a-zA-Z0-9]{6,30}$/),
            role: this.enums.role.default('user'),
            status: this.enums.status.default('active'),
            loginCount: 'number'.default(0),
            lastLoginAt: 'date',
            createdAt: 'date!',
            updatedAt: 'date!'
        });
    },
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            },
            isAdmin() {
                return this.role === 'admin';
            },
            async incrementLogin() {
                return await model.updateOne(
                    { _id: this._id },
                    {
                        $inc: { loginCount: 1 },
                        $set: { lastLoginAt: new Date() }
                    }
                );
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            },
            async findActive() {
                return await model.find({ status: 'active' });
            },
            async countAdmins() {
                return await model.count({ role: 'admin' });
            }
        }
    }),
    hooks: (model) => ({
        insert: {
            before: async (ctx, docs) => {
                const now = new Date();
                return {
                    ...docs,
                    createdAt: now,
                    updatedAt: now
                };
            }
        },
        update: {
            before: async (ctx, filter, update) => {
                if (!update.$set) update.$set = {};
                update.$set.updatedAt = new Date();
                return [filter, update];
            }
        }
    }),
    indexes: [
        { key: { username: 1 }, unique: true },
        { key: { email: 1 }, unique: true },
        { key: { status: 1, createdAt: -1 } }
    ]
});

//use
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/mydb' }
});
await msq.connect();

const User = msq.model('users');

//Create user
const result = User.validate({
    username: 'admin',
    email: 'admin@example.com',
    password: 'secret123',
    role: 'admin'
});

if (result.valid) {
    await User.insertOne(result.data);
}

//Login verification
const user = await User.findByUsername('admin');
if (user && user.checkPassword('secret123')) {
    if (user.isAdmin()) {
        console.log('Administrator login');
    }
    await user.incrementLogin();
}

//Query active users
const activeUsers = await User.findActive();

//Count the number of administrators
const adminCount = await User.countAdmins();
```

---

## Notes (Model API documentation)


## ⚠️ Method naming to avoid conflicts

The method name should not be the same as the field name, use a verb prefix.

```javascript
//❌ Error
methods: { instance: { status() {} } }

//✅ Correct
methods: {
    instance: {
        isActive() {},      //is* judgment
        checkStatus() {},   //check* Verify
        getFullName() {}    //get* get
    }
}
```


## ⚠️ Must use ordinary functions

Arrow functions cannot be used, otherwise `this` points to an error.

```javascript
//❌ Error
checkPassword: (password) => this.password === password

//✅ Correct
checkPassword(password) { return this.password === password; }
```


## ⚠️ Modifications will not be automatically saved

Modifying `this` in the method only changes the memory and will not be saved to the database.

```javascript
//❌ Error: only change memory
updatePassword(pwd) { this.password = pwd; }

//✅ Correct: Call the update method
async changePassword(pwd) {
    return await model.updateOne(
        { _id: this._id },
        { $set: { password: pwd } }
    );
}
```

---

## Automatic timestamp

Automatically manage `createdAt` and `updatedAt` fields.


## Basic usage

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        timestamps: true  //Enable automatic timestamps
    }
});

//Automatically added when inserting
await User.insertOne({ username: 'john' });
// => { _id, username: 'john', createdAt: Date, updatedAt: Date }

//Automatically updated when updated updatedAt
await User.updateOne({ username: 'john' }, { $set: { status: 'active' } });
//=> updatedAt automatically updates to the current time
```


## Custom field name

```javascript
Model.define('users', {
    options: {
        timestamps: {
            createdAt: 'created_time',  //Customize creation time field name
            updatedAt: 'updated_time'   //Custom update time field name
        }
    }
});
```


## Partially enabled

```javascript
//Enable only createdAt
Model.define('users', {
    options: {
        timestamps: {
            createdAt: true,
            updatedAt: false
        }
    }
});

//Enable only updatedAt
Model.define('users', {
    options: {
        timestamps: {
            createdAt: false,
            updatedAt: true
        }
    }
});
```


## Supported operations

| Operation | createdAt | updatedAt | Description |
|------|-----------|-----------|------|
| insertOne | ✅ | ✅ | Add two fields at the same time |
| insertMany | ✅ | ✅ | Each document added |
| updateOne | ❌ | ✅ | Update only updatedAt |
| updateMany | ❌ | ✅ | All matching documents updated |
| replaceOne | ❌ | ✅ | Update when replacing |
| upsertOne | ✅/❌ | ✅ | Add createdAt when inserting, but not when updating |
| findOneAndUpdate | ❌ | ✅ | Only updates updatedAt |
| findOneAndReplace | ❌ | ✅ | Update when replacing |
| incrementOne | ❌ | ❌ | ⚠️ Not supported yet |


## Notes (automatic timestamp)


### ⚠️ User manual settings will be overwritten

```javascript
await User.insertOne({
    username: 'john',
    createdAt: new Date('2020-01-01')  //will be overwritten
});
//=> createdAt will be the current time, not 2020-01-01
```

To retain user-set values, temporarily disable timestamps or handle them in a before hook.


### ⚠️ incrementOne is not supported yet

```javascript
//incrementOne does not automatically update updatedAt
await User.incrementOne({ _id }, { score: 10 });
```

**Temporary solution**: Manually add updatedAt

```javascript
await User.updateOne(
    { _id },
    {
        $inc: { score: 10 },
        $set: { updatedAt: new Date() }
    }
);
```


### ✅ Works with schema validation

The fields automatically added by timestamps will pass schema validation (if defined in the schema).

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        createdAt: 'date',    //Optional: Define validation rules
        updatedAt: 'date'
    }),
    options: {
        timestamps: true       //Automatically added values will pass validation
    }
});
```


### ✅ Works with hooks

Timestamps are executed after user hooks and will not affect the user's before hook.

```javascript
Model.define('users', {
    options: { timestamps: true },
    hooks: (model) => ({
        insert: {
            before: (ctx, docs) => {
                //User hook is executed first
                return { ...docs, customField: 'value' };
            }
        }
    })
});

//Execution order: user before hook → timestamps → database operation → user after hook
```

---

## Soft delete (softDelete)


Soft deletion marks documents as deleted rather than physically deleted, supporting data recovery and auditing.


## Enable soft delete

```javascript
//Simple mode
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        softDelete: true  //Use default configuration
    }
});

//Full configuration
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
    options: {
        softDelete: {
            enabled: true,           //Enable soft delete
            field: 'deletedAt',      //Field name (customizable)
            type: 'timestamp',       // 'timestamp' | 'boolean'
            ttl: 86400 * 30          //TTL index (automatically cleaned after 30 days)
        }
    }
});
```


## Configuration items

| Options | Type | Default | Description |
|------|------|--------|------|
| `enabled` | boolean | true | enable soft delete |
| `field` | string | 'deletedAt' | Deletion mark field name |
| `type` | string | 'timestamp' | Delete tag type ('timestamp' or 'boolean') |
| `ttl` | number | null | TTL index (seconds), automatically clean deleted data |


## Soft delete operation

When soft delete is enabled, `deleteOne` and `deleteMany` are automatically converted to update operations:

```javascript
const User = msq.model('users');

//Soft delete (marked as deleted)
await User.deleteOne({ _id });
//Actual execution: updateOne({ _id }, { $set: { deletedAt: new Date() } })

//Batch soft delete
await User.deleteMany({ status: 'inactive' });
//Actual execution: updateMany({ status: 'inactive' }, { $set: { deletedAt: new Date() } })
```


## Query automatic filtering

When soft deletion is enabled, standard read operations automatically filter deleted documents. This includes `find`, `findOne`, `findOneById`, `findByIds`, `findPage`, `findAndCount`, `count`, `distinct`, `aggregate`, `stream`, and `explain`.

```javascript
//Default query does not return deleted data
const users = await User.find({});
//Actual execution: find({ deletedAt: null })

const user = await User.findOne({ username: 'john' });
//Actual execution: findOne({ username: 'john', deletedAt: null })

const count = await User.count({ status: 'active' });
//Actual execution: count({ status: 'active', deletedAt: null })

const page = await User.findPage({ limit: 20 });
//Actual execution adds the soft-delete filter to the page query
```

For aggregation, monSQLize prepends a soft-delete `$match` stage, or places it after a leading `$geoNear` stage. Soft-delete filtering inside custom `$lookup` pipelines must be added by the application.


## Query deleted data

Use specialized methods to query for data that contains or only deleted data:

```javascript
//Query contains all deleted data
const allUsers = await User.findWithDeleted({});
const john = await User.findOneWithDeleted({ username: 'john' });
const totalCount = await User.countWithDeleted({});

//Only query deleted data
const deletedUsers = await User.findOnlyDeleted({});
const deletedJohn = await User.findOneOnlyDeleted({ username: 'john' });
const deletedCount = await User.countOnlyDeleted({});
```


## Add new method

| Method | Description |
|------|------|
| `findWithDeleted(filter, options)` | Query contains deleted documents |
| `findOneWithDeleted(filter, options)` | Query a single document (including deleted) |
| `countWithDeleted(filter, options)` | Statistics of documents (including deleted) |
| `findOnlyDeleted(filter, options)` | Only query deleted documents |
| `findOneOnlyDeleted(filter, options)` | Query a single deleted document |
| `countOnlyDeleted(filter, options)` | Count the number of deleted documents |
| `restore(filter, options)` | Recover deleted documents |
| `restoreMany(filter, options)` | Batch recovery of deleted documents |
| `forceDelete(filter, options)` | Forced physical deletion (unrecoverable) |
| `forceDeleteMany(filter, options)` | Batch forced physical deletion |


## Recover deleted data

```javascript
//Restore a single document
const result = await User.restore({ _id });
//Actual execution: updateOne({ _id, deletedAt: { $ne: null } }, { $unset: { deletedAt: 1 } })

//Batch recovery
const result = await User.restoreMany({ status: 'active' });
//Actual execution: updateMany({ status: 'active', deletedAt: { $ne: null } }, { $unset: { deletedAt: 1 } })
```


## Forced physical deletion

Bypass the soft deletion mechanism and perform a real physical deletion (unrecoverable):

```javascript
//Force physical deletion of individual documents
await User.forceDelete({ _id });
//Actual execution: real deleteOne (data is permanently deleted)

//Forced deletion in batches
await User.forceDeleteMany({ deletedAt: { $lt: thirtyDaysAgo } });
//Actual execution: real deleteMany (batch permanent deletion)
```


## Delete type


### timestamp type (default)

```javascript
Model.define('users', {
    options: {
        softDelete: { type: 'timestamp' }  //Default
    }
});

//Record deletion time when deleting
{ _id, username: 'john', deletedAt: new Date('2026-01-05T10:30:00Z') }

//Advantages: Record deletion time and support auditing
//Disadvantages: takes up storage space
```


### boolean type

```javascript
Model.define('posts', {
    options: {
        softDelete: { type: 'boolean' }
    }
});

//Marked as true when deleted
{ _id, title: 'Hello', deletedAt: true }

//Advantages: Saves storage space
//Disadvantages: Does not record deletion time
```


## Custom field name (softDelete)

```javascript
Model.define('comments', {
    options: {
        softDelete: {
            enabled: true,
            field: 'removed_at'  //Custom field name
        }
    }
});

//Use the removed_at field when removing
await Comment.deleteOne({ _id });
// { _id, content: 'Nice!', removed_at: new Date() }
```


## TTL index automatic cleaning

Configure TTL index, MongoDB will automatically delete expired deleted data:

```javascript
Model.define('logs', {
    options: {
        softDelete: {
            enabled: true,
            ttl: 86400 * 30  //Automatically clean up after 30 days
        }
    }
});

//Automatically create indexes:
// db.logs.createIndex({ deletedAt: 1 }, { expireAfterSeconds: 2592000 })

//MongoDB will automatically delete documents whose deletedAt is older than 30 days
```

In production, TTL index creation can cause a large cleanup wave when many existing documents are already expired. Use `autoIndex: false`, run `ensureIndexes({ dryRun: true })`, clean old data in batches if needed, and create the TTL index during a low-traffic window with database monitoring enabled.


## Works with timestamps

Soft delete and timestamps can be enabled at the same time:

```javascript
Model.define('products', {
    schema: (s) => s({ name: 'string!' }),
    options: {
        timestamps: true,   //Automatically manage createdAt/updatedAt
        softDelete: true    //soft delete
    }
});

//Automatically add timestamp when inserting
await Product.insertOne({ name: 'iPhone' });
// { _id, name: 'iPhone', createdAt: Date, updatedAt: Date }

//Automatically updated when soft deleted updatedAt
await Product.deleteOne({ _id });
//{ _id, name: 'iPhone', createdAt: Date, updatedAt: Date(update), deletedAt: Date }
```


## Unique index processing

⚠️ **Note**: After soft deletion, the unique index may become invalid.

```javascript
//Problem: After user john is soft deleted
{ username: 'john', deletedAt: new Date() }

//Creating new user john will fail (unique index conflict)
await User.insertOne({ username: 'john' });  //❌ Conflict
```

**Solution**: Use a composite unique index

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        softDelete: true
    },
    indexes: [
        {
            key: { username: 1, deletedAt: 1 },  //composite index
            unique: true
        }
    ]
});

//It is now possible to create users with the same name (because deletedAt is different)
```

---

## Optimistic lock version control (Version)


## What is optimistic locking?

Optimistic locking is a concurrency control mechanism that detects data conflicts through version numbers:
- Automatically increment the version number every time it is updated
- Verify version numbers match when updating
- A mismatch in version numbers indicates that the data has been modified by other requests (concurrency conflict)

**Usage Scenario**:
- Multiple users editing the same data at the same time
- Prevent dirty writes (Lost Update)
- Scenarios that require concurrency security guarantees


## Basic configuration

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'string!',
        status: 'string'
    }),
    options: {
        version: true  //Enable versioning (default field name version)
    }
});
```


## Complete configuration (optimistic lock versioning (Version))

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'string!'
    }),
    options: {
        version: {
            enabled: true,      //Whether to enable
            field: '__v',       // Custom field name (default 'version')
            updateMany: 'counter' // 'counter' | 'strict' | 'off'
        }
    }
});
```


## Automatically initialize when inserting

```javascript
//Insert document
const result = await User.insertOne({
    username: 'john',
    email: 'john@example.com'
});

//Query documents
const user = await User.findOne({ _id: result.insertedId });
console.log(user);
// { _id: '...', username: 'john', email: 'john@example.com', version: 0 }
```


## Automatic version handling when updating

```javascript
const user = await User.findOne({ _id });

//first update
await User.updateOne(
    { _id },
    { $set: { status: 'active' } }
);
//Actual execution includes { _id, version: 0 } and { $inc: { version: 1 } }

const updated = await User.findOne({ _id });
console.log(updated.version);  // 1

//second update
await User.updateOne(
    { _id },
    { $set: { status: 'inactive' } },
    { expectedVersion: updated.version }
);
```

Versioned `save`, `updateOne`, `replaceOne`, `findOneAndUpdate`, and `findOneAndReplace` use true optimistic concurrency control. When the filter contains a direct `_id`, monSQLize reads the current version automatically. Explicit `expectedVersion`, `version`, or a version field in the filter still wins over automatic lookup.

For `updateMany` and `updateBatch`, choose the batch version behavior with `versionMode`:

```javascript
await User.updateMany(
    { status: 'pending' },
    { $set: { status: 'active' } },
    { versionMode: 'strict' } // 'counter' | 'strict' | 'off'
);
```

- `counter` (default): native batch update plus version increment. This is a version counter, not optimistic locking.
- `strict`: pre-read matching `_id` and version values, update each document with `{ _id, version }`, and return `conflictCount` / `conflictedIds`.
- `off`: skip version handling for this batch update.


## Concurrency conflict detection

```javascript
//User A reads data
const userA = await User.findOne({ _id });
console.log(userA.version);  // 0

//User B reads data
const userB = await User.findOne({ _id });
console.log(userB.version);  // 0

//User A updated successfully first
const resultA = await User.updateOne(
    { _id },
    { $set: { status: 'active' } }
);
console.log(resultA.modifiedCount);  // 1

//User B update fails with WRITE_CONFLICT
try {
    await User.updateOne(
        { _id, version: userB.version },  //Version number has expired
        { $set: { status: 'inactive' } }
    );
} catch (error) {
    console.log(error.code);  // WRITE_CONFLICT
}
```


## Collaborate with other functions

```javascript
Model.define('users', {
    options: {
        timestamps: true,  //Automatic timestamp
        softDelete: true,  //soft delete
        version: true      //version control
    }
});

//All features work together
await User.insertOne({ username: 'john' });
// { _id, username, version: 0, createdAt, updatedAt }

await User.deleteOne({ _id, version: 0 });
//The version number is incremented when soft deleting
```


## Best Practices (Optimistic Locking Versioning (Version))

```javascript
//Concurrent update scenario
async function updateUserStatus(userId, newStatus) {
    let maxRetries = 3;

    for (let i = 0; i < maxRetries; i++) {
        const user = await User.findOne({ _id: userId });
        if (!user) throw new Error('User not found');

        try {
            await User.updateOne(
                { _id: userId },
                { $set: { status: newStatus } },
                { expectedVersion: user.version }
            );
            return { success: true };
        } catch (error) {
            if (error.code !== 'WRITE_CONFLICT') throw error;
            console.log(`Retry ${i + 1}/${maxRetries} (version conflict)`);
        }
    }

    throw new Error('Update failed due to concurrent modification');
}
```

---


## Complete example (optimistic lock versioning (Version))

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//Define Model (enable soft deletion and timestamps)
Model.define('articles', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        author: 'string!'
    }),
    options: {
        timestamps: true,
        softDelete: {
            enabled: true,
            type: 'timestamp',
            ttl: 86400 * 30  //Automatically clean up after 30 days
        }
    },
    indexes: [
        { key: { author: 1 } },
        { key: { title: 1, deletedAt: 1 }, unique: true }  //Composite unique index
    ]
});

async function example() {
    const msq = new MonSQLize({ type: 'mongodb', databaseName: 'blog' });
    await msq.connect();

    const Article = msq.model('articles');

    //1. Insert article
    const article = await Article.insertOne({
        title: 'Hello World',
        content: 'This is my first post',
        author: 'john'
    });
    console.log('Created:', article);
    // { _id, title, content, author, createdAt, updatedAt }

    //2. Soft delete articles
    await Article.deleteOne({ _id: article._id });
    console.log('Article soft deleted');

    //3. Query (automatic filtering has been deleted)
    const articles = await Article.find({ author: 'john' });
    console.log('Active articles:', articles.length);  // 0

    //4. Query contains deleted
    const allArticles = await Article.findWithDeleted({ author: 'john' });
    console.log('All articles:', allArticles.length);  // 1

    //5. Restore article
    await Article.restore({ _id: article._id });
    console.log('Article restored');

    //6. Query (can be found after recovery)
    const restoredArticle = await Article.findOne({ _id: article._id });
    console.log('After restore:', restoredArticle.title);  // 'Hello World'

    //7. Forced physical deletion
    await Article.forceDelete({ _id: article._id });
    console.log('Article permanently deleted');

    await msq.close();
}

example().catch(console.error);
```

---

## Frequently Asked Questions (Model API Documentation)

**Q: Where does `this.password` come from? **
A: From database query results, not schema. The schema only defines validation rules.

**Q: How to reference enums? **
A: Use function to define schema: `schema: function(s) { return s({ role: this.enums.role }) }`

**Q: What is the difference between instance and static? **
A: instance is injected into the document object, and static is mounted to the Model instance.

---

## More examples

Check out current TypeScript examples:
- [Model basic runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts) - Basic use of Model
- [relations and populate runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts) - Relations and populate example
