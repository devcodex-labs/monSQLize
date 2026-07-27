# Relations and Populate API Documentation

The Model layer provides relations and populate functions, allowing you to easily handle the relationships between collections.

Model schema examples on this page use the runtime-scoped `s` namespace passed by monSQLize. Application code does not need to import the root `schema-dsl` entry for these examples.

---

## Quick start


## 1 minute to get started

```javascript
//1. Define relationships
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    relations: {
        profile: {
            from: 'profiles',         //Collection name
            localField: 'profileId',  //local field
            foreignField: '_id',      //external fields
            single: true              //Return type
        }
    }
});

//2. Use populate
const user = await User.findOne({ username: 'john' }).populate('profile');

//3. Results
{
    _id: '...',
    username: 'john',
    profileId: '...',
    profile: {              //← Autofill
        _id: '...',
        bio: 'Software Engineer',
        avatar: 'https://example.com/avatar.jpg'
    }
}
```

---

## Core Features

- ✅ **MINIMAL CONFIGURATION** - Only 4 fields are needed to define the relationship
- ✅ **Close to MongoDB native** - Directly corresponds to `$lookup` operation
- ✅ **Chain Call** - Supports `.populate().populate()` chain syntax
- ✅ **Batch Optimization** - Use `$in` to avoid N+1 query issues
- ✅ **Rich options** - Support select/sort/limit/skip/match

---

## Relationship type


## one-to-one (one-to-one)

**Scenario**: User → Profile

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    relations: {
        profile: {
            from: 'profiles',
            localField: 'profileId',  // users.profileId
            foreignField: '_id',       // profiles._id
            single: true               //Returns a single document or null
        }
    }
});

//use
const user = await User.findOne({ _id }).populate('profile');

//result
{
    _id: '...',
    username: 'john',
    profileId: 'p1',
    profile: {              //a single object or null
        _id: 'p1',
        bio: 'Software Engineer',
        avatar: 'https://...'
    }
}
```


## one-to-many (one-to-many)

**Scenario**: User → Article List

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!'
    }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',         // users._id
            foreignField: 'authorId',  // posts.authorId
            single: false              //Return array
        }
    }
});

//use
const user = await User.findOne({ _id }).populate('posts');

//result
{
    _id: '...',
    username: 'john',
    posts: [                //array or []
        { _id: 'post1', title: 'Post 1', authorId: '...' },
        { _id: 'post2', title: 'Post 2', authorId: '...' }
    ]
}
```


## many-to-one (many to one)

**Scenario**: Article → Author

```javascript
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        authorId: 'objectId'
    }),
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        }
    }
});

//use
const post = await Post.findOne({ _id }).populate('author');

//result
{
    _id: '...',
    title: 'My Post',
    authorId: 'u1',
    author: {               //a single object or null
        _id: 'u1',
        username: 'john',
        email: 'john@example.com'
    }
}
```

---

## Populate options


## select - select field

```javascript
//Return only specified fields (_id is always included)
await User.find().populate('profile', { select: 'bio avatar' });

//result
user.profile = {
    _id: '...',      //automatically included
    bio: '...',      //Selected fields
    avatar: '...'    //Selected fields
    //location does not return
};
```


## sort - Sort

```javascript
//Sort by createdAt in reverse order
await User.find().populate('posts', { sort: { createdAt: -1 } });

//Sort by multiple fields
await User.find().populate('posts', {
    sort: { category: 1, createdAt: -1 }
});
```


## limit - limit quantity

```javascript
//Only the latest 5 articles are returned
await User.find().populate('posts', {
    limit: 5,
    sort: { createdAt: -1 }
});
```


## skip - skip

```javascript
//Pagination: skip first 10, return next 10
await User.find().populate('posts', {
    skip: 10,
    limit: 10,
    sort: { createdAt: -1 }
});
```


## match - additional query conditions

```javascript
//Return only published articles
await User.find().populate('posts', {
    match: { status: 'published' },
    sort: { createdAt: -1 }
});
```


## Use in combination

```javascript
await User.find().populate('posts', {
    select: 'title content status',
    match: { status: 'published' },
    sort: { createdAt: -1 },
    limit: 10
});
```

---

## Advanced usage


## Chained populate

```javascript
//Populate multiple relationships at once
const user = await User.findOne({ _id })
    .populate('profile')
    .populate('posts')
    .populate('comments');

//result
{
    _id: '...',
    username: 'john',
    profile: { bio: '...', avatar: '...' },
    posts: [{ title: '...', content: '...' }, ...],
    comments: [{ text: '...', postId: '...' }, ...]
}
```


## Batch query + populate

```javascript
//find returns an array with relations populated for each document
const users = await User.find({ active: true })
    .populate('profile')
    .populate('posts', { limit: 5 });

//result
[
    {
        _id: '...',
        username: 'john',
        profile: {...},
        posts: [...]
    },
    {
        _id: '...',
        username: 'jane',
        profile: {...},
        posts: [...]
    }
]
```


## Dynamic relationship (array form)

```javascript
//Select relationships to fill based on criteria
const relations = ['profile'];
if (includePosts) relations.push('posts');

const user = await User.findOne({ _id }).populate(relations);
```


## Object form (complete configuration)

```javascript
await User.find().populate({
    path: 'posts',
    select: 'title content',
    match: { status: 'published' },
    sort: { createdAt: -1 },
    limit: 10,
    skip: 0
});
```

---

## Performance optimization


## Automatic batch query

```javascript
//monSQLize automatically uses $in for batch queries to avoid the N+1 problem

//Query 100 users and populate profiles
const users = await User.find({ active: true }).populate('profile');

//Actual executed query (automatically optimized):
//1. Query 100 users: db.users.find({ active: true })
//2. Collect all profileId: [id1, id2, id3, ...]
//3. Batch query profiles: db.profiles.find({ _id: { $in: [id1, id2, ...] } })
//4. Populate to each user
//Total queries: 2 (instead of 101)
```


## Index suggestions

```javascript
//Create indexes for foreign key fields to improve populate performance

Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    indexes: [
        { key: { profileId: 1 } }  //← Foreign key index
    ],
    relations: {
        profile: {
            from: 'profiles',
            localField: 'profileId',
            foreignField: '_id',
            single: true
        }
    }
});

//The _id field of the profiles collection is indexed by default
```


## Performance comparison

| Scenario | Number of queries | Performance |
|------|---------|------|
| Without populate | 1 time | Fastest |
| populate (N documents) | 2 times | fast (use $in) |
| Loop query (N times) | N+1 times | Slow (N+1 problem) |

---

## Edge case handling


## Foreign key is null

```javascript
//User has no profileId
const user = await User.findOne({ _id }).populate('profile');

//single: true - returns null
user.profile === null

//single: false - returns an empty array
user.posts === []
```


## No associated data found

```javascript
//profileId exists, but there is no corresponding document in the profiles collection
const user = await User.findOne({ _id }).populate('profile');

//single: true - returns null
user.profile === null

//single: false - returns an empty array
user.posts === []
```


## Foreign key array

```javascript
//If you need a foreign key array, use the reverse relationship (one-to-many)
//Not recommended: user.tagIds = [id1, id2, id3]
//Recommended: tags.userId = userId (store userId in tags)

relations: {
    tags: {
        from: 'tags',
        localField: '_id',
        foreignField: 'userId',  //Store userId in tags
        single: false
    }
}
```

---

## Comparison with Mongoose

| Features | Mongoose | monSQLize |
|------|----------|-----------|
| **Configuration method** | `ref: 'ModelName'` | `from: 'collectionName'` |
| **Learning Cost** | Need to learn Schema/Model concepts | Only need to understand MongoDB $lookup |
| **Flexibility** | Model must be defined | Can be associated with any collection |
| **Performance** | Abstraction layer overhead | Can be directly optimized to $lookup |
| **How to use** | `.populate('path')` | `.populate('path')` |

**Why choose `from` instead of `ref`? **

1. **Close to MongoDB native** - `from` is the native field of `$lookup`
2. **More flexible** - Does not depend on whether the Model is defined or not, and can be associated with any collection
3. **More intuitive** - `from: 'profiles'` clearly knows the query profiles collection

---

## Complete example

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//Define User Model
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        profileId: 'objectId',
        createdAt: 'date'
    }),
    indexes: [
        { key: { username: 1 }, unique: true },
        { key: { profileId: 1 } }
    ],
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
});

//Define Post Model
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        authorId: 'objectId!',
        status: ['draft', 'published'],
        createdAt: 'date'
    }),
    indexes: [
        { key: { authorId: 1 } },
        { key: { status: 1, createdAt: -1 } }
    ],
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        }
    }
});

//use
const msq = new MonSQLize({
    type: 'mongodb',
    config: { url: 'mongodb://localhost:27017/mydb' }
});
await msq.connect();

const User = msq.model('users');
const Post = msq.model('posts');

//Query users and populate relationships
const user = await User.findOne({ username: 'john' })
    .populate('profile')
    .populate('posts', {
        select: 'title status createdAt',
        match: { status: 'published' },
        sort: { createdAt: -1 },
        limit: 10
    });

console.log(user);
// {
//     _id: '...',
//     username: 'john',
//     email: 'john@example.com',
//     profileId: '...',
//     profile: {
//         _id: '...',
//         bio: 'Software Engineer',
//         avatar: 'https://...'
//     },
//     posts: [
//         { _id: '...', title: 'Post 1', status: 'published', createdAt: ... },
//         { _id: '...', title: 'Post 2', status: 'published', createdAt: ... }
//     ]
// }

//Query articles and fill in the author
const post = await Post.findOne({ _id: postId }).populate('author', {
    select: 'username email'
});

console.log(post);
// {
//     _id: '...',
//     title: 'My Post',
//     content: '...',
//     authorId: '...',
//     author: {
//         _id: '...',
//         username: 'john',
//         email: 'john@example.com'
//     }
// }
```

---

## FAQ

**Q: How many queries will populate execute? **
A: For N documents + 1 relationship, execute 2 queries:
1. Query the main documents (N)
2. Query related documents in batches (use `$in`, 1 time)

**Q: How to implement nested populate? **
A: The current version supports nested populate. It is recommended to use object configuration to express the next-level relationship:

```javascript
const user = await User.findOne({ username: 'john' })
    .populate({ path: 'posts', populate: 'comments' });
```

**Q: Will populate affect performance? **
A: Use `$in` batch query, which has less impact on performance. Suggestions:
1. Create an index for the foreign key field
2. Use `select` to return only the required fields
3. Use `limit` to limit the amount of associated data

**Q: How to implement many-to-many? **
A: Use an intermediate collection when a relationship needs extra fields or many-to-many ownership:
```javascript
// users ←→ user_roles ←→ roles
relations: {
    userRoles: {
        from: 'user_roles',
        localField: '_id',
        foreignField: 'userId',
        single: false
    }
}
//Then manually query the roles
```

**Q: What options does populate support? **
A: The following options are supported:
- `select` - field selection
- `sort` - Sort
- `limit` - limited quantity
- `skip` - Skip
- `match` - Additional query conditions

**Q: Why does my populate return null? **
A: Possible reasons:
1. The foreign key field value is null/undefined
2. There is no matching document in the associated collection
3. `foreignField` field value does not match

**Q: How to debug populate? **
A:
```javascript
//1. Check the relationship definition
console.log(User.getRelations().profile);

//2. Check foreign key values
const user = await User.findOne({ _id });
console.log('profileId:', user.profileId);

//3. Manually query related documents
const profile = await msq.collection('profiles').findOne({ _id: user.profileId });
console.log('profile:', profile);
```

---

## Support populate query method

All six query methods of monSQLize support populate:


## 1. find() + populate

Batch query returns document array.

```javascript
const users = await User.find({ active: true }).populate('profile');

//Result: [{ _id, username, profile: {...} }, ...]
```


## 2. findOne() + populate

Single document query, returns a single document or null.

```javascript
const user = await User.findOne({ username: 'john' }).populate('profile');

//Result: { _id, username, profile: {...} } or null
```


## 3. findByIds() + populate

Batch ID query, returns document array.

```javascript
const users = await User.findByIds([id1, id2, id3]).populate('profile');

//Result: [{ _id, username, profile: {...} }, ...]
```


## 4. findOneById() + populate

Single ID query, returns a single document or null.

```javascript
const user = await User.findOneById(id).populate('profile');

//Result: { _id, username, profile: {...} } or null
```


## 5. findAndCount() + populate

Query with count, returns `{ data, total }` structure.

```javascript
const result = await User.findAndCount({
  filter: { active: true },
  limit: 10
}).populate('profile');

//Result: { data: [...], total: 100 }
//Each document in data will be populate
```


## 6. findPage() + populate

Paging query returns the complete paging structure.

```javascript
const page = await User.findPage({
  page: 1,
  pageSize: 10
}).populate('profile');

//Result: {
//data: [...], // Filled document
//   page: 1,
//   pageSize: 10,
//   total: 100,
//   hasNext: true
// }
```

**Special Instructions**:
- `findAndCount` and `findPage` only populate the `data` part
- Other fields (`total`, `page`, `pageSize`, `hasNext`) remain unchanged
- All methods support chained populate

---

## API Reference


## Model.define() relations configuration

```typescript
relations: {
    [relationName: string]: {
        from: string;           //Associated collection name (required)
        localField: string;     //Local field name (required)
        foreignField: string;   //External field name (required)
        single?: boolean;       //Whether to return a single document, default false
    }
}
```


## .populate() method

```typescript
//string form
.populate(path: string)
.populate(path: string, options: PopulateOptions)

//Array form
.populate(paths: string[])

//object form
.populate(config: {
    path: string;
    select?: string;
    sort?: object;
    limit?: number;
    skip?: number;
    match?: object;
})
```


## PopulateOptions

```typescript
interface PopulateOptions {
    select?: string;    //Field selection, space separated
    sort?: object;      //Sorting rules
    limit?: number;     //limited quantity
    skip?: number;      //skip quantity
    match?: object;     //Additional query conditions
}
```

---

## More resources

- [Model API Documentation](../model.md)
- [Sample code](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)
- [GitHub Issues](https://github.com/devcodex-labs/monSQLize/issues)
