# Installation

## What This Page Covers

This page covers the path from installing monSQLize to validating a minimal MongoDB-backed collection:

- Installation
- Initializing `MonSQLize`
- `connect()`
- `collection()`
- Basic writes and queries
- Closing the connection
- Where to continue with basic usage

## Installation

```bash
npm install monsqlize
```

### Requirements

- Node.js 18 or newer.
- A MongoDB URI, such as `mongodb://localhost:27017`.
- Optional Redis, SSH tunnel, cache, Model, and sync features are configured only when your application uses them.

## Minimal Connection Example

```typescript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
});

await msq.connect();

const users = msq.collection('users');
await users.insertOne({
    username: 'ada',
    email: 'ada@example.com',
    createdAt: new Date(),
});

const user = await users.findOne({ email: 'ada@example.com' });
console.log(user);

await msq.close();
```

## Runnable Example in This Repository

If you are validating the minimal path inside this repository, run:

```bash
npm run build
npm run test:examples
```

The current official example is [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts). During verification, it is compiled before it runs. The example:

1. Starts an in-memory MongoDB instance.
2. Creates and connects a `MonSQLize` instance.
3. Inserts one user document.
4. Reads the document back and prints the result.
5. Closes the connection and cleans up the temporary database.

## Next Steps

- Continue with common CRUD, pagination, cache, and Model entry points in [`basic-operations.md`](./basic-operations.md).
- Review all constructor options in [`configuration.md`](./configuration.md).
- Learn query details in [`find.md`](./find.md), [`findOne.md`](./findOne.md), and [`findPage.md`](./findPage.md).
- Compare runnable examples in [`examples.md`](./examples.md).
- Open the source examples on GitHub:
  - [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)
  - [`examples/quick-start/basic-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts)
  - [`examples/docs/find.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find.ts)
  - [`examples/docs/find-one.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-one.ts)
  - [`examples/docs/find-page.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-page.ts)

## Common Notes

1. Calling `collection()` before `connect()` triggers `NOT_CONNECTED`.
2. Missing `config.uri` triggers `INVALID_CONFIG`.
3. Application code should import from the package root: `import MonSQLize from 'monsqlize'` or `const MonSQLize = require('monsqlize')`.
