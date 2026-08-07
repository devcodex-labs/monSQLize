# Relations API - Relationship Definition

**Function**: Model layer relationship definition, supports hasOne/hasMany/belongsTo

---

## 📖 Overview

Relations define how Model documents point to related collections and provide the configuration used by `populate()`.

Model schema examples on this page use the runtime-scoped `s` namespace passed by monSQLize. Application code does not need to import the root `schema-dsl` entry for these examples.


## Core Features

- ✅ **hasOne** - one-to-one relationship (user-profile)
- ✅ **hasMany** - one-to-many relationship (user-article)
- ✅ **belongsTo** - many-to-one relationship (article - author)
- ✅ **Many to Many** - implemented through intermediate tables
- ✅ **Self-reference** - Supports self-association (tree structure)
- ✅ **Flexible Configuration** - Custom field mapping

---

## 🚀 Quick Start


## Basic definition

```javascript
import { Model } from 'monsqlize';

Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        //Relationship name: configuration
        posts: {
            from: 'posts',          //associated collections
            localField: '_id',      //local field
            foreignField: 'userId', //foreign key field
            single: false           // false = hasMany, true = hasOne
        }
    }
});
```

---

## 📚Relationship type


## hasOne (one-to-one)

One document corresponds to **one** document from another collection.

**Example**: User-Profile

```javascript
// User hasOne Profile
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true  //One to one
        }
    }
});

//use
const user = await User.findOne({ username: 'john' })
    .populate('profile');

console.log(user.profile);  // { userId: '...', bio: '...', avatar: '...' }
```

**Data structure**:
```text
users collection:
{ _id: '1', username: 'john' }

profiles collection:
{ _id: 'p1', userId: '1', bio: 'Hello', avatar: 'avatar.jpg' }

After populate:
{
  _id: '1',
  username: 'john',
  profile: { _id: 'p1', userId: '1', bio: 'Hello', avatar: 'avatar.jpg' }
}
```


## hasMany (one-to-many)

One document corresponds to **multiple** documents from another collection.

**Example**: User-Post

```javascript
// User hasMany Posts
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'userId',
            single: false  //one to many
        }
    }
});

//use
const user = await User.findOne({ username: 'john' })
    .populate('posts');

console.log(user.posts);  // [{ title: '...', userId: '1' }, ...]
```

**Data structure**:
```text
users collection:
{ _id: '1', username: 'john' }

posts collection:
{ _id: 'post1', userId: '1', title: 'Post 1' }
{ _id: 'post2', userId: '1', title: 'Post 2' }

After populate:
{
  _id: '1',
  username: 'john',
  posts: [
    { _id: 'post1', userId: '1', title: 'Post 1' },
    { _id: 'post2', userId: '1', title: 'Post 2' }
  ]
}
```


## belongsTo (many to one)

Multiple documents correspond to **one** document of another collection (the reverse of hasOne).

**Example**: Article-Author

```javascript
// Post belongsTo User
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
    relations: {
        author: {
            from: 'users',
            localField: 'userId',  //Locally stored foreign keys
            foreignField: '_id',    //The primary key of the associated collection
            single: true            //belongsTo is also essentially hasOne
        }
    }
});

//use
const post = await Post.findOne({ title: 'Hello World' })
    .populate('author');

console.log(post.author);  // { _id: '1', username: 'john' }
```

**Data structure**:
```text
posts collection:
{ _id: 'post1', userId: '1', title: 'Hello World' }

users collection:
{ _id: '1', username: 'john' }

After populate:
{
  _id: 'post1',
  userId: '1',
  title: 'Hello World',
  author: { _id: '1', username: 'john' }
}
```

---

## 🎯 Configuration options


## RelationDefinition

| Options | Type | Required | Description |
|------|------|------|------|
| `from` | String | ✅ | Associated collection name |
| `localField` | String | ✅ | Local field (usually _id) |
| `foreignField` | String | ✅ | Foreign key field |
| `single` | Boolean | ✅ | true=hasOne, false=hasMany |
| `select` | String \| String[] | ❌ | Default top-level inclusion fields; call-site select takes precedence |

`localField` may be a scalar or an array of IDs. For an array, populate flattens values, ignores `null`/`undefined`, fetches all unique keys in one `$in` query, and then rebuilds each parent result in its original local-ID order. Duplicate IDs and missing target documents are omitted. A supplied `sort` overrides that order.

Both relation-level and call-site `select` use inclusion-only top-level fields. Call-site `select` wins; `_id` remains available. Empty values, exclusions such as `-secret`, prefixes, and dot paths are rejected with `INVALID_RELATION_SELECT`. Selection is pushed down to MongoDB; temporary join keys needed for matching or nested populate are removed from the final result unless explicitly selected.


## Complete configuration example

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        //Full configuration
        posts: {
            from: 'posts',          //Required: associated collection
            localField: '_id',      //Required: local field
            foreignField: 'userId', //Required: foreign key field
            single: false,          //Required: Whether it is single
            select: 'title createdAt', // Optional: default public fields
        },

        //Minimal configuration
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

//Use the as option
const user = await User.findOne().populate('posts');
console.log(user.articles);  //Use the name specified by as
```

---

## 💡 Usage scenarios


## Scenario 1: User-Profile (hasOne)

**Requirement**: One user only has one profile

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'email!'
    }),
    relations: {
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

Model.define('profiles', {
    schema: (s) => s({
        userId: 'objectId!',
        bio: 'string',
        avatar: 'url',
        website: 'url'
    })
});

//use
const user = await User.findOne({ email: 'john@example.com' })
    .populate('profile');

console.log(`${user.username}: ${user.profile.bio}`);
```


## Scenario 2: User-Article (hasMany)

**Requirement**: A user can publish multiple articles

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'authorId',
            single: false
        }
    }
});

Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        authorId: 'objectId!'
    })
});

//use
const users = await User.find()
    .populate('posts', { limit: 5 });

users.forEach(user => {
    console.log(`${user.username} posted ${user.posts.length} posts`);
});
```


## Scenario 3: Article-Author (belongsTo)

**Requirement**: An article belongs to one author

```javascript
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
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
const posts = await Post.find({ status: 'published' })
    .populate('author', { select: ['username', 'avatar'] });

posts.forEach(post => {
    console.log(`${post.title} - by ${post.author.username}`);
});
```


## Scenario 4: Many-to-many (student-course)

**Requirements**: Students can take multiple courses and courses have multiple students

**Option**: Use intermediate table

```javascript
//1. Define students
Model.define('students', {
    schema: (s) => s({
        name: 'string!',
        studentNo: 'string!'
    }),
    relations: {
        enrollments: {
            from: 'student_course',
            localField: '_id',
            foreignField: 'studentId',
            single: false
        }
    }
});

//2. Define the curriculum
Model.define('courses', {
    schema: (s) => s({
        name: 'string!',
        code: 'string!'
    }),
    relations: {
        enrollments: {
            from: 'student_course',
            localField: '_id',
            foreignField: 'courseId',
            single: false
        }
    }
});

//3. Define intermediate tables
Model.define('student_course', {
    schema: (s) => s({
        studentId: 'objectId!',
        courseId: 'objectId!',
        enrolledAt: 'date'
    }),
    relations: {
        student: {
            from: 'students',
            localField: 'studentId',
            foreignField: '_id',
            single: true
        },
        course: {
            from: 'courses',
            localField: 'courseId',
            foreignField: '_id',
            single: true
        }
    }
});

//use
const students = await Student.find()
    .populate('enrollments');

for (const student of students) {
    console.log(`${student.name} has taken ${student.enrollments.length} courses:`);

    //Get course details
    const courseIds = student.enrollments.map(e => e.courseId);
    const courses = await Course.findByIds(courseIds);

    courses.forEach(course => {
        console.log(`  - ${course.name}`);
    });
}

//The current version also supports nested populates:
const studentsWithCourses = await Student.find()
    .populate({ path: 'enrollments', populate: 'course' });
```


## Scenario 5: Self-reference (tree structure)

**Requirement**: Comment reply to comment (father-son relationship)

```javascript
Model.define('comments', {
    schema: (s) => s({
        content: 'string!',
        parentId: 'objectId'  //Parent comment ID (null means top-level comment)
    }),
    relations: {
        //Subcomment (reply)
        replies: {
            from: 'comments',
            localField: '_id',
            foreignField: 'parentId',
            single: false
        },
        //parent comment
        parent: {
            from: 'comments',
            localField: 'parentId',
            foreignField: '_id',
            single: true
        }
    }
});

//use
const topComments = await Comment.find({ parentId: null })
    .populate('replies', { limit: 10 });

topComments.forEach(comment => {
    console.log(`Comment: ${comment.content}`);
    comment.replies.forEach(reply => {
        console.log(`└─ Reply: ${reply.content}`);
    });
});
```

---

## 🎨 Best Practices


## 1. Relationship naming

```javascript
//✅ Good: use plural for hasMany
relations: {
    posts: { ... },      // hasMany
    comments: { ... }    // hasMany
}

//✅ Good: use singular hasOne/belongsTo
relations: {
    profile: { ... },    // hasOne
    author: { ... }      // belongsTo
}

//❌ Bad: Unclear naming
relations: {
    postList: { ... },   //should use posts
    userProfile: { ... } //should use profile
}
```


## 2. Foreign key design

```javascript
//✅ Good: Use standard naming
{
    userId: ObjectId,     //Point to users._id
    authorId: ObjectId,   //Point to users._id
    postId: ObjectId      //Points to posts._id
}

//❌ Bad: inconsistent naming
{
    user: ObjectId,       //UserId should be used
    author_id: ObjectId,  //should use authorId
    post: ObjectId        //should use postId
}
```


## 3. Performance considerations

```javascript
//❌ Bad: Excessive populate
const users = await User.find()
    .populate('posts')
    .populate('comments')
    .populate('likes')
    .populate('followers');  //May return large amounts of data

//✅ Good: populate on demand + limit quantity
const users = await User.find()
    .populate('posts', { limit: 5 });  //Only populate requires
```


## 4. Index optimization

```javascript
//✅ Good: Add index for foreign keys
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        userId: 'objectId!'
    }),
    indexes: [
        { key: { userId: 1 } }  //Add indexes to foreign keys to speed up populate
    ],
    relations: {
        author: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        }
    }
});
```

---

## 🆚 Comparison with SQL


## SQL JOIN vs Populate

| Features | SQL JOIN | monSQLize Populate |
|------|----------|-------------------|
| **Number of queries** | 1 time (JOIN) | 2 times (batch query) |
| **Performance** | Complex JOIN is slow | Simple query is fast |
| **Caching** | Difficult to cache | ✅ Easy to cache |
| **Flexibility** | Subject to JOIN | ✅ Flexible |
| **N+1 questions** | None | ✅ Automatically solved |


## Example comparison

**SQL**:
```sql
-- Users and articles
SELECT u.*, p.*
FROM users u
LEFT JOIN posts p ON u.id = p.user_id;

-- Complex and difficult to cache
```

**monSQLize**:
```javascript
//Users and articles
const users = await User.find()
    .populate('posts');

//Simple and easy to cache
//The 1st time: SELECT * FROM users
//2nd time: SELECT * FROM posts WHERE userId IN [...]
```

---

## ❓ FAQ


## Q1: Can it be many-to-many?

**A**: ✅ Yes, it can be achieved through an intermediate table.

```javascript
//Student-Course many-to-many
Student → student_course ← Course
```

See [Scenario 4: Many-to-many](#scenario-4-many-to-many-student-course)

## Q2: Can it be self-referenced?

**A**: ✅ Yes, self-association is supported.

```javascript
Model.define('comments', {
    relations: {
        replies: {
            from: 'comments',  //Point to yourself
            localField: '_id',
            foreignField: 'parentId',
            single: false
        }
    }
});
```

See [Scenario 5: Self-reference](#scenario-5-self-reference-tree-structure)

## Q3: Can conditional filtering be used?

**A**: Supported. The current version can use `match` in the populate option to filter related data.

```javascript
const users = await User.find().populate('posts', {
    match: { status: 'published' }
});
```


## Q4: Can there be a two-way relationship?

**A**: ✅ Yes, the relationship can be defined in both directions.

```javascript
// User hasMany Posts
Model.define('users', {
    relations: {
        posts: { from: 'posts', localField: '_id', foreignField: 'userId', single: false }
    }
});

// Post belongsTo User
Model.define('posts', {
    relations: {
        author: { from: 'users', localField: 'userId', foreignField: '_id', single: true }
    }
});

//Two-way use
const user = await User.findOne().populate('posts');
const post = await Post.findOne().populate('author');
```


## Q5: How to determine localField and foreignField?

**A**: Look in the direction of the arrow.

```javascript
// User (localField: _id) → Posts (foreignField: userId)
//Points from User's _id to Posts' userId

Model.define('users', {
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',      //Which field of User
            foreignField: 'userId', //Which field of Posts corresponds to
            single: false
        }
    }
});
```

**Memory method**:
- **localField**: local (own collection) field
- **foreignField**: foreign (associated collection) field


## Q6: Can multiple relationships point to the same collection?

**A**: ✅ Yes, use different relationship names.

```javascript
Model.define('posts', {
    schema: (s) => s({
        authorId: 'objectId!',
        reviewerId: 'objectId'
    }),
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        },
        reviewer: {
            from: 'users',
            localField: 'reviewerId',
            foreignField: '_id',
            single: true
        }
    }
});

//use
const post = await Post.findOne()
    .populate('author')
    .populate('reviewer');

console.log(`Author: ${post.author.username}`);
console.log(`Reviewer: ${post.reviewer.username}`);
```

---

## 📝 Complete example


## E-commerce system example

```javascript
import { Model } from 'monsqlize';

//1. User
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'email!'
    }),
    relations: {
        orders: {
            from: 'orders',
            localField: '_id',
            foreignField: 'userId',
            single: false
        },
        cart: {
            from: 'carts',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

//2. Goods
Model.define('products', {
    schema: (s) => s({
        name: 'string!',
        price: 'number!',
        categoryId: 'objectId!'
    }),
    relations: {
        category: {
            from: 'categories',
            localField: 'categoryId',
            foreignField: '_id',
            single: true
        },
        reviews: {
            from: 'reviews',
            localField: '_id',
            foreignField: 'productId',
            single: false
        }
    }
});

//3. Order
Model.define('orders', {
    schema: (s) => s({
        orderNo: 'string!',
        userId: 'objectId!',
        status: 'string!'
    }),
    relations: {
        user: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        },
        items: {
            from: 'order_items',
            localField: '_id',
            foreignField: 'orderId',
            single: false
        }
    }
});

//4. Line items
Model.define('order_items', {
    schema: (s) => s({
        orderId: 'objectId!',
        productId: 'objectId!',
        quantity: 'number!',
        price: 'number!'
    }),
    relations: {
        product: {
            from: 'products',
            localField: 'productId',
            foreignField: '_id',
            single: true
        }
    }
});

//5. Classification
Model.define('categories', {
    schema: (s) => s({
        name: 'string!',
        parentId: 'objectId'
    }),
    relations: {
        products: {
            from: 'products',
            localField: '_id',
            foreignField: 'categoryId',
            single: false
        },
        //Self-referencing: subcategory
        children: {
            from: 'categories',
            localField: '_id',
            foreignField: 'parentId',
            single: false
        },
        //Self-reference: parent category
        parent: {
            from: 'categories',
            localField: 'parentId',
            foreignField: '_id',
            single: true
        }
    }
});

//Usage example

//Scenario 1: Get user order details
const user = await User.findOne({ username: 'john' })
    .populate('orders');

for (const order of user.orders) {
    const orderDetail = await Order.findOneById(order._id)
        .populate('items');

    console.log(`Order ${orderDetail.orderNo}:`);
    for (const item of orderDetail.items) {
        const itemWithProduct = await OrderItem.findOneById(item._id)
            .populate('product');
        console.log(`  - ${itemWithProduct.product.name} x ${item.quantity}`);
    }
}

//Scenario 2: Get products and categories
const products = await Product.find({}, { cache: 60000 })
    .populate('category')
    .populate('reviews', { limit: 5 });

products.forEach(product => {
    console.log(`${product.name} - ${product.category.name}`);
    console.log(`Number of reviews: ${product.reviews.length}`);
});

//Scenario 3: Get the category and its subcategories
const category = await Category.findOne({ name: 'electronic products' })
    .populate('children')
    .populate('products', { limit: 10 });

console.log(`${category.name}:`);
console.log(`Subcategory: ${category.children.map(c => c.name).join(', ')}`);
console.log(`Number of items: ${category.products.length}`);
```

---

## 🔗 Related documents

- [Populate API](./populate.md) - Detailed explanation of related queries
- [Model API](./model.md) - Model layer complete documentation
- [Schema API](./model.md) - Schema definition

---

## 📌 Design principles


## 1. One-way vs two-way relationship

```javascript
//Unidirectional: only one side is defined
Model.define('users', {
    relations: { posts: { ... } }
});

//Bidirectional: defined on both sides
Model.define('users', {
    relations: { posts: { ... } }
});
Model.define('posts', {
    relations: { author: { ... } }
});
```

**Suggestion**: Define as needed, not all relationships need to be bidirectional.


## 2. Foreign key storage location

```javascript
//✅ Good: Store foreign keys on the "many" side
//User hasMany Posts → Post stores userId
posts collection: { userId, title, content }

//✅ Good: Store foreign keys on the "belongsTo" side
//Post belongsTo User → Post stores userId
posts collection: { userId, title, content }
```


## 3. Relationship vs Embedding

| Scenarios | Using relationships | Using embeddings |
|------|---------|---------|
| Data updated independently | ✅ | ❌ |
| Data Sharing | ✅ | ❌ |
| Data is fixed | ❌ | ✅ |
| Small data size | ❌ | ✅ |

**Example**:
```javascript
//✅ Usage relationship: users and articles (independent management)
User → Posts

//✅ Use embed: orders and line items (not query separately)
Order { items: [ { productId, quantity }, ... ] }
```
