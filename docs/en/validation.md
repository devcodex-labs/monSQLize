# Schema Validation API

Collection-level document verification capabilities ensure data quality.

## setValidator()

Set Schema validation rules for a collection.


## Syntax

```javascript
await collection.setValidator(validator, [options]);
```


## Parameters

- **validator** (Object, required): Validation rules
- **options** (Object, optional):
  - `validationLevel` (string): Authentication level
  - `validationAction` (string): Verification behavior


## Validation rule format


### 1. JSON Schema (recommended)

```javascript
await collection.setValidator({
    $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'email'],
        properties: {
            name: {
                bsonType: 'string',
                description: 'must be a string'
            },
            email: {
                bsonType: 'string',
                pattern: '^.+@.+$',
                description: 'must be a valid email'
            },
            age: {
                bsonType: 'int',
                minimum: 0,
                maximum: 120
            }
        }
    }
});
```


### 2. Query expression

```javascript
await collection.setValidator({
    $and: [
        { name: { $type: 'string' } },
        { email: { $regex: /@/ } },
        { age: { $gte: 0, $lte: 120 } }
    ]
});
```


## Example

```javascript
await msq.connect();
const users = msq.collection('users');

//Set validation rules
await users.setValidator({
    $jsonSchema: {
        bsonType: 'object',
        required: ['username', 'email'],
        properties: {
            username: {
                bsonType: 'string',
                minLength: 3,
                maxLength: 30
            },
            email: {
                bsonType: 'string',
                pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
            },
            age: {
                bsonType: 'int',
                minimum: 18
            },
            role: {
                enum: ['user', 'admin', 'moderator']
            }
        }
    }
}, {
    validationLevel: 'strict',
    validationAction: 'error'
});

//Test verification
try {
    await users.insertOne({ username: 'ab' }); //Too short, failure
} catch (error) {
    console.error('Verification failed:', error.message);
}

await users.insertOne({
    username: 'alice',
    email: 'alice@example.com',
    age: 25,
    role: 'user'
}); //success
```

---

## setValidationLevel()

Set the verification level.


## Verification level

- **`strict`**: Validate all inserts and updates (default)
- **`moderate`**: Only valid updates to valid documents are verified, existing invalid documents are not verified
- **`off`**: Disable verification


## Syntax (setValidationLevel())

```javascript
await collection.setValidationLevel(level);
```


## Example (setValidationLevel())

```javascript
//Strict validation (all documents)
await collection.setValidationLevel('strict');

//Moderate verification (only valid documents are verified)
await collection.setValidationLevel('moderate');

//Disable verification
await collection.setValidationLevel('off');
```

---

## setValidationAction()

Set the behavior when validation fails.


## Verify behavior

- **`error`**: Reject documents that do not comply with the rules (default)
- **`warn`**: Allow writing but log warning


## Syntax (setValidationAction())

```javascript
await collection.setValidationAction(action);
```


## Example (setValidationAction())

```javascript
//Reject invalid documents
await collection.setValidationAction('error');

//Allow but warn
await collection.setValidationAction('warn');
```

---

## getValidator()

Get the current authentication configuration.


## Syntax (getValidator())

```javascript
const validation = await collection.getValidator();
```


## Return value

- **Type**: `Promise<Object>`
- **Properties**:
  - `validator` (Object|null): Validation rules
  - `validationLevel` (string): Authentication level
  - `validationAction` (string): Verification behavior


## Example (getValidator())

```javascript
const validation = await collection.getValidator();

console.log('Validation rules:', validation.validator);
console.log('Verification level:', validation.validationLevel); // 'strict'
console.log('Verification behavior:', validation.validationAction); // 'error'
```

---

## Complete example

```javascript
import MonSQLize from 'monsqlize';

async function setupValidation() {
    const msq = new MonSQLize({
        type: 'mongodb',
        config: { uri: 'mongodb://localhost:27017/mydb' }
    });

    await msq.connect();
    const users = msq.collection('users');

    //1. Set validation rules
    await users.setValidator({
        $jsonSchema: {
            bsonType: 'object',
            required: ['name', 'email', 'age'],
            properties: {
                name: {
                    bsonType: 'string',
                    minLength: 2,
                    maxLength: 50
                },
                email: {
                    bsonType: 'string',
                    pattern: '^.+@.+\\..+$'
                },
                age: {
                    bsonType: 'int',
                    minimum: 0,
                    maximum: 120
                },
                status: {
                    enum: ['active', 'inactive', 'suspended']
                }
            }
        }
    });

    //2. Set the verification level to strict
    await users.setValidationLevel('strict');

    //3. Throw an error when setting verification fails
    await users.setValidationAction('error');

    //4. Verify configuration
    const validation = await users.getValidator();
    console.log('✅ Verify that the configuration has taken effect');

    //5. Test to insert valid data
    const result = await users.insertOne({
        name: 'Alice',
        email: 'alice@example.com',
        age: 30,
        status: 'active'
    });
    console.log('✅ Valid data inserted successfully:', result.insertedId);

    //6. Test inserting invalid data
    try {
        await users.insertOne({
            name: 'A', //too short
            email: 'invalid-email', //Format error
            age: 150 //out of range
        });
    } catch (error) {
        console.log('❌ Invalid data is rejected:', error.message);
    }

    await msq.close();
}

setupValidation().catch(console.error);
```

---

## Related documents

- [Collection Management](./collection-management.md) - collMod, stats
- [Collection Management Example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts)
