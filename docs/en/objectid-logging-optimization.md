# ObjectId Conversion Diagnostics

## Logger trace IDs

Structured `Logger` output includes an active trace ID by default. `enableTraceId: false` omits that field without disabling trace-context propagation. `Logger.generateTraceId()` works in both CJS and pure ESM consumers. `new Logger(sink, options)` and `Logger.create(sink, options)` accept the same logger options.

An `insertMany` diagnostic warning failure after a successful driver write does not replace the successful result or skip write-cache invalidation. Slow-query storage error policies remain a separate contract.

## Current Behavior

In the current runtime, ObjectId conversion is value-based by default. Valid 24-character hex strings can be converted in query filters, write payloads, and aggregation pipelines when traversal reaches them.

Use `autoConvertObjectId` as an instance-level conversion switch:

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' },
  autoConvertObjectId: true
});
```

Set it to `false`, or use `{ enabled: false }`, when a code path must preserve arbitrary 24-character hexadecimal strings. When only selected fields must remain strings, use `excludeFields`, `{ fieldName: false }`, or `maxDepth`.

## How to Verify Conversion

Because the converter does not emit conversion logs, verify behavior through one of these routes:

1. Add an integration test that writes or queries a known value and inspects the stored or matched value.
2. Use MongoDB command monitoring in the application test harness to inspect the command sent to the driver.
3. Call the converter in a focused unit test when validating adapter behavior.

Example focused check:

```javascript
import { ObjectId } from 'mongodb';
import { convertObjectIdStrings } from '../src/adapters/mongodb/utils/objectid-converter';

const converted = convertObjectIdStrings({
  _id: '507f1f77bcf86cd799439011',
  code: '1234567890abcdef12345678'
});

console.log(converted._id instanceof ObjectId);  // true
console.log(converted.code instanceof ObjectId); // true
```

## Configuration Reference

| Value | Behavior |
| --- | --- |
| `true` | Enable automatic conversion. This is the default for MongoDB adapters. |
| `false` | Disable automatic conversion for the instance. |
| `{ enabled: true }` | Enable automatic conversion explicitly. |
| `{ enabled: false }` | Disable automatic conversion explicitly. |
| `{ excludeFields: ['token'] }` | Keep matching field paths or field names as strings. |
| `{ token: false }` | Keep a specific field name or path as a string while preserving default value-based conversion elsewhere. |
| `{ maxDepth: 3 }` | Stop recursive conversion beyond the configured depth. |

## FAQ

### Can I enable ObjectId conversion logs?

No. The current converter does not provide conversion log output or `silent` / `verbose` controls.

### Can I exclude specific fields from conversion?

Yes. If a workload contains values such as transaction hashes, idempotency keys, signatures, or external payment numbers that can look like ObjectIds, use `excludeFields` or `{ fieldName: false }`. Use `autoConvertObjectId: false` only when the whole instance should preserve every string exactly.

### Is conversion field-whitelist based?

No. Current stable behavior is value-based. A valid ObjectId-looking string can be converted regardless of the field name when traversal reaches it.
