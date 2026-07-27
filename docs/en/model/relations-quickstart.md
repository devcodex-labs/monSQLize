# relations Quick Start Guide (5 minutes)

**Prerequisite knowledge**: Understand the basics of MongoDB (collections, fields, foreign keys)

---

## ⚡ 1 minute to understand relations

**What are relations?**
- Define relationships between collections
- Use `populate()` to automatically fill in associated data
- Avoid writing multiple manual queries and merging results by hand

**Core Concepts** (only 3):
1. **from**: related collection name (such as `'profiles'`)
2. **localField**: local foreign key field (such as `'profileId'`)
3. **foreignField**: foreign primary key field (usually `'_id'`)

**Relationship with MongoDB $lookup**:
- relations configuration = simplified version of MongoDB `$lookup`
- No need to learn new concepts, just understand MongoDB

---

## ⚡ 2 minutes to complete first example


## Step 1: Define the relationship (30 seconds)

```javascript
import { Model } from 'monsqlize';

// Define User Model
Model.define('User', {
  schema: (s) => s({
    username: 'string!',
    email: 'email!',
    profileId: 'objectId'    // foreign key
  }),

  relations: {
    profile: {
      from: 'profiles',      // related profiles collection
      localField: 'profileId', // User.profileId
      foreignField: '_id',   // Profile._id
      single: true           // returns a single document, not an array
    }
  }
});

// Define Profile Model.
// First-level populate can read the collection without this Model.
// Define it when profile has its own schema, hooks, or nested relations.
Model.define('Profile', {
  schema: (s) => s({
    bio: 'string',
    avatar: 'url'
  })
});
```


## Step 2: Use populate (30 seconds)

```javascript
const User = msq.model('User');

// Query users and automatically populate profiles
const user = await User.findOne({ username: 'john' })
  .populate('profile');

console.log(user);
// {
//   _id: ObjectId('...'),
//   username: 'john',
//   email: 'john@example.com',
//   profileId: ObjectId('...'),
//   profile: { // populated data
//     _id: ObjectId('...'),
//     bio: 'Software Engineer',
//     avatar: 'https://...'
//   }
// }
```


## Step 3: Done!

It's that simple, no need to write it manually:
```javascript
//❌ No need to write this manually
const user = await User.findOne({ username: 'john' });
const profile = await Profile.findOne({ _id: user.profileId });
user.profile = profile;
```

---

## ⚡ 2 minutes to master common scenarios


## Scenario 1: one-to-one

**Example**: A user has a profile

```javascript
//Configuration
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: true           // Return a single document
  }
}

// use
const user = await User.findOne({ _id }).populate('profile');
console.log(user.profile); // { bio: '...', avatar: '...' }
```


## Scenario 2: one-to-many (one-to-many - reverse)

**Example**: A user has multiple articles (via reverse query)

```javascript
//Configuration
relations: {
  posts: {
    from: 'posts',
    localField: '_id',         // User._id
    foreignField: 'authorId',  // Post.authorId points to User._id
    single: false              // Return an array (default)
  }
}

// use
const user = await User.findOne({ _id }).populate('posts');
console.log(user.posts); // [{ title: 'Post 1' }, { title: 'Post 2' }]
```


## Scenario 3: Multiple relationships

```javascript
// Configure multiple relationships
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: true
  },
  posts: {
    from: 'posts',
    localField: '_id',
    foreignField: 'authorId',
    single: false
  }
}

// Chain populate calls
const user = await User.findOne({ _id })
  .populate('profile')
  .populate('posts');

console.log(user.profile); // single document
console.log(user.posts);   // array
```

---

## 🎯 Configuration field quick check

| Field | Type | Required | Default value | Description |
|------|------|------|--------|------|
| `from` | String | ✅ | - | The associated collection name (plural form, such as `'users'`) |
| `localField` | String | ✅ | - | Local field name (foreign key, such as `'userId'`) |
| `foreignField` | String | ✅ | - | External field name (usually `'_id'`) |
| `single` | Boolean | ❌ | `false` | `true`=returns a single document, `false`=returns an array |

---

## 💡 Quick decision-making


## Q: Should I use `single: true` or `single: false`?

**Decision Tree**:

```text
What shape does the relation return?
├─ One-to-one (one user, one profile)
│  → single: true
│
├─ One-to-many (one user has multiple articles)
│  → single: false
│
└─ Not sure?
→ Use single: false (default, returns array)
```


## Q: What should I write in `from`?

**Rule**: Write the collection name (plural form)

```javascript
//✅ Correct
from: 'users'      //Collection name
from: 'profiles'
from: 'posts'

//❌ Error
from: 'User'       //Model name (not collection name)
from: 'Profile'
```

---

## ⚠️ 3 common mistakes


## Mistake 1: Use Model name instead of collection name

```javascript
//❌ Error
relations: {
  profile: {
    from: 'Profile',  //Model name
    // ...
  }
}

//✅ Correct
relations: {
  profile: {
    from: 'profiles',  //Collection name (plural)
    // ...
  }
}
```


## Mistake 2: Forgot to create an index

```javascript
//⚠️Performance issue: foreign keys are not indexed
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',  //← This field needs to be indexed!
    foreignField: '_id'
  }
}

//✅ Solution: Create index
Model.define('User', {
  schema: (s) => s({ profileId: 'objectId' }),
  indexes: [
    { key: { profileId: 1 } }  //← Create indexes for foreign keys
  ],
  relations: { /* ... */ }
});
```


## Mistake 3: `single` is used backwards

```javascript
//❌ Expected to return a single document, but used single: false
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: false  //← Returns an array [profile], not a single document!
  }
}

//✅ Correct
single: true  //Return single document { bio: '...' }
```

---

## 🚀 Next step


## Have you mastered the basic functions? View advanced topics

- **Select fields**: `.populate('profile', { select: 'bio avatar' })`
- **Sort and limits**: `.populate('posts', { sort: { createdAt: -1 }, limit: 10 })`
- **Nested populate**: populate relations of already populated documents
- **Performance**: add indexes for foreign keys and use `$lookup` directly for fully custom aggregation
- **Caching**: cache read queries explicitly when the relation result is safe to reuse


## Continue with the full documentation

- [Model API reference](../model.md)
- [Populate guide](../populate.md)
- [Relations guide](./relations.md)

---

## 📚 Sample Code Library


## Complete example: Blog system

```javascript
const msq = require('monsqlize');
const { Model } = msq;

// 1. Profile Model
Model.define('Profile', {
  schema: (s) => s({
    bio: 'string:0-500',
    avatar: 'url',
    location: 'string'
  })
});

// 2. Post Model
Model.define('Post', {
  schema: (s) => s({
    title: 'string:1-200!',
    content: 'string!',
    authorId: 'objectId!',
    status: 'string',
    createdAt: 'date'
  }),
  indexes: [
    { key: { authorId: 1 } }  // foreign key index
  ]
});

// 3. User Model (including relations)
Model.define('User', {
  schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!',
    profileId: 'objectId'
  }),
  indexes: [
    { key: { profileId: 1 } }  // foreign key index
  ],
  relations: {
    // one-to-one
    profile: {
      from: 'profiles',
      localField: 'profileId',
      foreignField: '_id',
      single: true
    },
    // one-to-many (reverse)
    posts: {
      from: 'posts',
      localField: '_id',
      foreignField: 'authorId',
      single: false
    }
  }
});

// 4. Usage examples
async function example() {
  const User = msq.model('User');

  // Query user + profile + posts
  const user = await User.findOne({ username: 'john' })
    .populate('profile')
    .populate('posts');

  console.log(`User: ${user.username}`);
  console.log(`Profile: ${user.profile?.bio || 'No profile'}`);
  console.log(`Number of posts: ${user.posts.length}`);

  // Output:
  // User: john
  // Profile: Full-stack Developer
  // Number of posts: 5
}

example();
```

**Complete sample file**: [populate relations runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)

---

## 💬 FAQ


## Q: Will populate affect performance?

**A**:
- Populate batches related IDs and avoids the common N+1 query pattern.
- Direct MongoDB `$lookup` is still the right tool when you need a fully custom aggregation pipeline.
- Recommendation: Create indexes for foreign keys + enable caching


## Q: Can I associate a collection without defining a Model?

**A**:
- Yes for first-level populate. `from` can point directly to a MongoDB collection name.
- Define a Model for the related collection when you need schema validation, hooks, virtuals, or nested populate on that related data.


## Q: How to deal with circular references?

**A**:
- The system automatically detects circular references and prevents infinite recursion
- Nested populate supports depth control; keep relationship graphs shallow and set explicit limits for deep branches.


## Q: What is the difference with MongoDB $lookup?

**A**:
- relations are a simplified `$lookup`-style configuration for common document references
- populate batches related IDs and avoids the common N+1 query pattern
- use MongoDB `$lookup` directly when you need a fully custom aggregation pipeline

---

## Next steps

You now have the core relation setup:
- relation fields: `from`, `localField`, `foreignField`, `single`
- one-to-one and one-to-many examples
- common mistakes around collection names, indexes, and `single`

Use the linked runnable example as the next reference when wiring relations into an application.

**Need help?**
- View the API reference
- Open an issue: https://github.com/devcodex-labs/monSQLize/issues

---
