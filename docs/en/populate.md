# Populate API - Related Query

When a nonempty `sort` is supplied, related documents are read sequentially per parent using MongoDB sorting, including native null/missing, BSON, array and related-collection collation rules. `skip` and `limit` apply within each parent's related query. This increases database queries compared with unsorted population; it avoids a second JavaScript ordering rule. The parent's collation is not automatically copied to related reads. Unsorted population retains batches of up to 200 distinct keys.

**Function**: Model layer related query, supports 6 methods ()

---

## 📖 Overview

Populate is the Model-layer helper for loading related documents declared in `relations`.

Model schema examples on this page use the runtime-scoped `s` namespace passed by monSQLize. Application code does not need to import the root `schema-dsl` entry for these examples.


## Core Features

- ✅ **6 methods supported** - find/findOne/findByIds/findOneById/findAndCount/findPage ()
- ✅ **Chain API** - Supports multiple populate chain calls
- ✅ **Smart Cache** - Related query results can use the configured cache; impact depends on hit rate, backend, and workload
- ✅ **Field Selection** - Only the required fields are returned, reducing data transmission
- ✅ **Sort Limit** - Support sort and limit to control related data
- ✅ **Automatic Injection** - Results are automatically injected into the document object

---

## 🚀 Quick Start


## 1. Define relationships

First configure relations in the Model definition:

```javascript
import { Model } from 'monsqlize';

//Define User Model
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'email!'
    }),
    relations: {
        //hasMany: one-to-many
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'userId',
            single: false
        },
        //hasOne: one to one
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

//Define Post Model
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!'
    }),
    relations: {
        //belongsTo: many to one
        author: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        }
    }
});
```


## 2. Use populate

```javascript
const msq = new MonSQLize({ ... });
await msq.connect();

const User = msq.model('users');

//basic populate
const users = await User.find({ age: { $gte: 18 } })
    .populate('posts');

console.log(users[0].posts);  // [{ title: '...', content: '...' }, ...]
```


## 3. Multiple populate

```javascript
//Chain multiple populate calls
const users = await User.find()
    .populate('posts')
    .populate('profile');

// users[0].posts = [...]
// users[0].profile = { avatar: '...', bio: '...' }
```


## 4. Option configuration

```javascript
//populate with options
const users = await User.find()
    .populate('posts', {
        select: ['title', 'createdAt'],  //Return only these fields
        limit: 10,                        //Up to 10 items
        sort: { createdAt: -1 }          //In descending order of creation time
    })
    .populate('profile', {
        select: ['avatar', 'bio']
    });
```

---

## 📚Supported query methods

monSQLize supports **6 query methods** of populate, leading the industry:

| Method | Return type | Populate support | Description |
|------|---------|-------------|------|
| `find()` | Array | ✅ | Query multiple documents |
| `findOne()` | Object/null | ✅ | Query a single document |
| `findByIds()` | Array | ✅ | Batch ID query |
| `findOneById()` | Object/null | ✅ | ID query single |
| `findAndCount()` | Object | ✅ | Query + Count |
| `findPage()` | Object | ✅ | Paging query |


## Example

```javascript
// find + populate
const users = await User.find().populate('posts');

// findOne + populate
const user = await User.findOne({ username: 'john' }).populate('profile');

// findByIds + populate
const users = await User.findByIds([id1, id2, id3]).populate('posts');

// findOneById + populate
const user = await User.findOneById(userId).populate('posts');

// findAndCount + populate
const result = await User.findAndCount({ age: { $gte: 18 } }).populate('posts');
// result.data[0].posts = [...]

// findPage + populate
const result = await User.findPage({ limit: 10 }).populate('posts');
// result.items[0].posts = [...]
```

---

## 🎯 API Reference


## .populate(path, options?)

Add related queries to the query chain.

**Parameters**:
- `path` (String) - relationship path, must be defined in relations of Model
- `options` (Object, optional) - Populate option

**Returns**: PopulateProxy object (supports chained calls and Promise)

**Options**:

| Options | Type | Default | Description |
|------|------|--------|------|
| `select` | String[] | All fields | Select returned fields |
| `skip` | Number | `0` | Skip related records per parent document (hasMany) |
| `limit` | Number | Unlimited | Limit related records per parent document (hasMany) |
| `sort` | Object | No sorting | Sorting rules |
| `cache` | Number | Inherit the main query | Cache time (milliseconds) |
| `maxDepth` | Number | `5` | Maximum nested populate depth for this branch |

**Example**:

```javascript
//Full options
const users = await User.find()
    .populate('posts', {
        select: ['title', 'createdAt'],
        limit: 5,
        sort: { createdAt: -1 },
        cache: 60000
    });
```

---

## 💡 Usage scenarios


## Scenario 1: User-Article (hasMany)

```javascript
//definition
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'userId',
            single: false  // hasMany
        }
    }
});

//use
const users = await User.find()
    .populate('posts', { limit: 10 });

users.forEach(user => {
    console.log(`${user.username} has ${user.posts.length} posts`);
});
```


## Scenario 2: Article-Author (belongsTo)

```javascript
//definition
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
    relations: {
        author: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true  // belongsTo (hasOne)
        }
    }
});

//use
const posts = await Post.find()
    .populate('author', { select: ['username', 'avatar'] });

posts.forEach(post => {
    console.log(`${post.title} Author: ${post.author.username}`);
});
```


## Scenario 3: User-Profile (hasOne)

```javascript
//definition
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true  // hasOne
        }
    }
});

//use
const user = await User.findOne({ username: 'john' })
    .populate('profile');

console.log(user.profile.bio);
```


## Scenario 4: Many-to-many (through intermediate table)

```javascript
//Define students
Model.define('students', {
    schema: (s) => s({ name: 'string!' }),
    relations: {
        enrollments: {
            from: 'student_course',
            localField: '_id',
            foreignField: 'studentId',
            single: false
        }
    }
});

//Define intermediate table
Model.define('student_course', {
    schema: (s) => s({
        studentId: 'objectId!',
        courseId: 'objectId!'
    }),
    relations: {
        course: {
            from: 'courses',
            localField: 'courseId',
            foreignField: '_id',
            single: true
        }
    }
});

//Use (requires populate twice)
const students = await Student.find()
    .populate('enrollments');

// For deeper paths, use nested populate configuration.
for (const student of students) {
    const courseIds = student.enrollments.map(e => e.courseId);
    const courses = await Course.findByIds(courseIds);
    student.courses = courses;
}
```

---

## ⚡ Performance optimization


## N+1 problem solving

**❌ Traditional method (N+1 problem)**:

```javascript
//Query users: 1 time
const users = await User.find();

//Query articles for each user: N times
for (const user of users) {
    user.posts = await Post.find({ userId: user._id });
}

//Total number of queries: 1 + N times (100 users = 101 queries)
```

**✅ monSQLize Populate (batch query)**:

```javascript
//Only 2 queries are needed
const users = await User.find().populate('posts');

//Time 1: Query users
//The 2nd time: Batch query for all users’ articles (WHERE userId IN [...])
//Total queries for this single-level relation: 2, rather than one related query per user.
```


## Smart caching

**Populate + caching**:

```javascript
//First query
const users = await User.find({}, { cache: 60000 }).populate('posts');
//2 database queries (user + article)

//Subsequent query (within 60 seconds)
const users2 = await User.find({}, { cache: 60000 }).populate('posts');
//No database query when every required entry is a valid cache hit.
```

**Performance characteristics**:

| Method | Query shape for one single-level relation | Main variables |
|------|-------|---------|
| N+1 queries | One main query plus one related query per parent | Parent count, network latency, connection-pool contention |
| Populate | One main query plus a batched related query | Relation cardinality, `$in` size, indexes, selected fields |
| Populate with valid cache hits | Cache reads can replace some or all database queries | Cache tier, serialization, payload size, hit rate, invalidation policy |

Query-count reduction is structural; latency is workload-dependent. Measure it using the [performance evidence contract](./performance-evidence.md).


## Caching strategy

```javascript
//The main query and populate use the same cache time
const users = await User.find({}, { cache: 60000 }).populate('posts');

//Main query and populate use different cache times
const users = await User.find({}, { cache: 60000 })
    .populate('posts', { cache: 300000 });  //Article cache for 5 minutes

//Only cache populate, not the main query
const users = await User.find()
    .populate('posts', { cache: 60000 });
```

---

## 🆚Comparison with Mongoose


## Support method comparison

| Features | monSQLize | Mongoose | Advantages |
|------|-----------|----------|------|
| **Supported Methods** | **6** | find only | ✅ **Industry Leading** |
| findOne populate | ✅ | ❌ Manual required | ✅ Ready to use out of the box |
| findPage populate | ✅ | ❌ | ✅ Exclusive features |
| findByIds populate | ✅ | ❌ | ✅ Batch query |
| Chain API | ✅ | ✅ | Equivalent |
| Field Selection | ✅ | ✅ | Equal |
| **Smart Cache** | **✅ Built-in** | **❌ Need to be implemented by yourself** | Workload-dependent; measure cache hit rate and latency |


## Performance measurement example

```javascript
// Mongoose
const users = await User.find().populate('posts');
const users2 = await User.find().populate('posts'); // Queries again unless the application adds caching.

// monSQLize
const users = await User.find({}, { cache: 60000 }).populate('posts');  // Cold path for this key.
const users2 = await User.find({}, { cache: 60000 }).populate('posts'); // Potential warm-cache path.
```

Record cold and warm distributions for the same dataset rather than inferring a multiplier from this control-flow example; see [Performance evidence](./performance-evidence.md).


## API comparison

```javascript
// Mongoose
User.find()
    .populate('posts')
    .populate({ path: 'profile', select: 'avatar bio' });

//monSQLize (more concise)
User.find()
    .populate('posts')
    .populate('profile', { select: ['avatar', 'bio'] });
```

---

## ❓ FAQ


## Q1: Can it be cached after populate?

**A**: ✅ Yes! This is a unique advantage of monSQLize.

```javascript
//populate results will be cached
const users = await User.find({}, { cache: 60000 }).populate('posts');

//Subsequent queries read directly from the cache, including populate data
const users2 = await User.find({}, { cache: 60000 }).populate('posts');
//0 database queries ⚡
```


## Q2: How to avoid the N+1 problem?

**A**: monSQLize automatically solves the N+1 problem.

Populate batches relation lookups:
```javascript
// Automatically converted to WHERE userId IN [id1, id2, id3, ...]
const users = await User.find().populate('posts');
// Only 2 queries are required (user + batch query articles)
```


## Q3: Can populate be nested?

**A**: The current version supports nested populate, and the next-level relationship can be declared directly in the populate configuration.

```javascript
const students = await Student.find()
    .populate({ path: 'enrollments', populate: 'course' });
```

Nested populate is capped by `maxDepth` (default `5`) to protect self-referencing relations from unbounded recursion:

```javascript
const categories = await Category.find()
    .populate({ path: 'children', populate: 'children', maxDepth: 3 });
```


## Q4: Will populate affect performance?

**A**: No, on the contrary, the performance is better.

- ✅ Batch query (avoid N+1)
- ✅ Smart caching (measure hit rate, backend latency, and invalidation cost for the target workload)
- ✅ Field selection (reduce data transfer)


## Q5: Is it necessary to populate after the relationship is defined?

**A**: No, populate is optional.

```javascript
//No populate, only query users
const users = await User.find();
// users[0].posts = undefined

//There is related data only after populate
const users = await User.find().populate('posts');
// users[0].posts = [...]
```


## Q6: Does populate support conditional filtering?

**A**: Supported. Use options such as `match`, `skip`, and `limit` to constrain the populated data. For has-many relations, `skip` and `limit` are applied per parent document after related records are grouped.

```javascript
const users = await User.find()
    .populate('posts', {
        match: { status: 'published' },  //Populate only published articles
        limit: 10
    });
```

---

## 📝 Complete example


## Blog system example

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

//1. Define Models
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        avatar: 'url'
    }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'authorId',
            single: false
        },
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        status: 'string'
    }),
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        },
        comments: {
            from: 'comments',
            localField: '_id',
            foreignField: 'postId',
            single: false
        }
    }
});

Model.define('comments', {
    schema: (s) => s({
        content: 'string!',
        postId: 'objectId!',
        userId: 'objectId!'
    }),
    relations: {
        user: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        }
    }
});

Model.define('profiles', {
    schema: (s) => s({
        bio: 'string',
        website: 'url',
        userId: 'objectId!'
    })
});

//2. Connect to the database
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/blog' },
    cache: { ttl: 60000, max: 1000 }  //Enable caching
});

await msq.connect();

const User = msq.model('users');
const Post = msq.model('posts');
const Comment = msq.model('comments');

//3. Usage scenarios

//Scenario A: Get users and their articles
const users = await User.find({}, { cache: 60000 })
    .populate('posts', {
        select: ['title', 'createdAt', 'status'],
        limit: 5,
        sort: { createdAt: -1 }
    })
    .populate('profile');

console.log('User list:');
users.forEach(user => {
    console.log(`- ${user.username}`);
    console.log(`Profile: ${user.profile?.bio || 'No profile'}`);
    console.log(`Number of posts: ${user.posts.length}`);
    user.posts.forEach(post => {
        console.log(`    - ${post.title}`);
    });
});

//Scenario B: Get articles, authors and comments
const posts = await Post.find(
    { status: 'published' },
    { cache: 60000 }
).populate('author', {
    select: ['username', 'avatar']
}).populate('comments', {
    limit: 10
});

console.log('\nArticle list:');
posts.forEach(post => {
    console.log(`- ${post.title}`);
    console.log(`Author: ${post.author.username}`);
    console.log(`Number of comments: ${post.comments.length}`);
});

//Scenario C: Query users by page
const result = await User.findPage({
    limit: 10,
    page: 1
}).populate('posts', { limit: 3 });

console.log(`\nTotal number of users: ${result.pageInfo.totalCount}`);
console.log(`Current page: ${result.pageInfo.currentPage}/${result.pageInfo.totalPages}`);
result.items.forEach(user => {
    console.log(`- ${user.username}: ${user.posts.length} latest posts`);
});
```

---

## 🔗 Related documents

- [Relations API](./relations.md) - Detailed explanation of relationship definition
- [Model API](./model.md) - Model layer complete documentation
- [Cache API](./cache.md) - cache configuration
- [FindPage API](./findPage.md) - paging query

---

## 📌 Best Practices


## 1. Reasonable use of field selection

```javascript
//❌ Bad: returns all fields (wasted bandwidth)
const users = await User.find().populate('posts');

//✅ Good: only return required fields
const users = await User.find().populate('posts', {
    select: ['title', 'createdAt']
});
```


## 2. Limit the amount of associated data

```javascript
//❌ Bad: May return thousands of reviews
const posts = await Post.find().populate('comments');

//✅ Good: limited quantity
const posts = await Post.find().populate('comments', {
    limit: 10,
    sort: { createdAt: -1 }
});
```


## 3. Enable smart caching

```javascript
//❌ Bad: Query the database every time
const users = await User.find().populate('posts');

//✅ Good: Enable caching (suitable for reading more data and writing less data)
const users = await User.find({}, { cache: 60000 }).populate('posts');
```


## 4. Populate on demand

```javascript
//❌ Bad: always populate (even if not needed)
const users = await User.find()
    .populate('posts')
    .populate('profile')
    .populate('comments');

//✅ Good: only populate required relationships
const users = await User.find()
    .populate('profile');  //Just need information
```
