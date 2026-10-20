# Expression function reference

Quoted DSL strings are literals: `expr('"$price"')` and `expr('LITERAL("$price")')` return the text `$price`; unquoted `expr('$price')` references the field. `LITERAL` preserves literal objects and arrays without interpreting their contents as DSL.

For `$match`, place an expression at the stage root (`{ $match: expr('price > 10') }`) or inside native `$expr`. A DSL marker used as a field-query value throws `INVALID_EXPRESSION`; native predicates, BSON/Date/RegExp values and `$literal` data remain native. Quoted strings use backslash parity when locating delimiters; escaping does not create an extra expression scope.

Nested facet/lookup/unionWith pipelines and merge whenMatched pipelines retain their stage context. Numeric arguments to SUBSTR/SUBSTR_CP/SLICE/ARRAY_ELEM_AT accept expressions without integer truncation. MAP/FILTER variables resolve lexically, including scalar variables, nesting and quoted literals; LET bindings use balanced separators and still require explicit `$$name` references. SWITCH preserves an explicit null/false/0/empty-string default; omitting a default keeps native MongoDB failure behavior. Scientific notation such as `price * 1e-3` is supported; malformed numeric expressions fail with INVALID_EXPRESSION.

DSL lambda names and explicit MongoDB `$$` variables have separate scopes. MAP/FILTER bind their named variable; REDUCE exposes native `$$value`/`$$this` only inside its body, while input and initial value use the outer scope. LET initializers use the outer scope and its body uses the declared explicit variables. Native JSON `$map`, `$filter`, `$reduce` and `$let` follow these lexical boundaries. Quoted text and `$literal` payloads remain unchanged.

For example, `REDUCE([10],0,(acc,item)=>SUM(MAP([1,2],value,$$value)))` evaluates to `3`. In `MAP([10],value,REDUCE([1,2],0,(acc,item)=>$$value + $$this))`, the explicit references belong to the inner reducer and the result is `[3]`; a bare outer lambda name still refers to its DSL binding.

## Overview

monSQLize's unified expression system supports **122 operators (100% MongoDB support)**, covering all operations such as strings, mathematics, arrays, aggregations, dates, type conversions, logic, conditions, objects, collections, etc. These functions provide SQL-like syntax, making complex MongoDB aggregation queries simple and intuitive.


## Core Features

- ✅ **SQL-like syntax** - Familiar function names such as CONCAT and UPPER
- ✅ **AUTO COMPILATION** - Automatically converted to MongoDB aggregate expressions
- ✅ **Type Safety** - Check parameter types at compile time
- ✅ **Cache Optimization** - Expression compilation results are automatically cached
- ✅ **Cross-database** - Support MySQL, PostgreSQL in the future


## Quick example

```javascript
import { expr } from 'monsqlize';

//String operations
const fullName = expr('CONCAT(firstName, " ", lastName)');

//Conditional judgment
const category = expr('age >= 18 ? "adult" : "minor"');

//complex expression
const score = expr('(mathScore + englishScore) / 2 >= 60 ? "pass" : "fail"');

//used in aggregation
await collection('users').aggregate([
  {
    $addFields: {
      fullName: fullName,
      category: category,
      result: score
    }
  }
]);
```

---

## String functions (12)


## CONCAT - String concatenation

**Syntax**: `CONCAT(str1, str2, ...)`

**Description**: Concatenate multiple strings

**Parameters**:
- `str1, str2, ...` - the string to concatenate (can be a field reference or a literal)

**Example**:
```javascript
import { expr } from 'monsqlize';

const fullNameExpr = expr('CONCAT(firstName, " ", lastName)');

//MongoDB equivalent expression
{ $concat: ['$firstName', ' ', '$lastName'] }

//used in aggregation
await collection('users').aggregate([
  {
    $addFields: {
      fullName: fullNameExpr
    }
  }
]);
```

---


## UPPER - Convert to uppercase

**Syntax**: `UPPER(str)`

**Description**: Convert string to uppercase

**Parameters**:
- `str` - string field or value

**Example**:
```javascript
import { expr } from 'monsqlize';

const upperNameExpr = expr('UPPER(name)');

//MongoDB equivalent expression
{ $toUpper: '$name' }

//use
await collection('users').aggregate([
  { $project: { upperName: upperNameExpr } }
]);
```

---


## LOWER - Convert to lowercase

**Syntax**: `LOWER(str)`

**Description**: Convert string to lowercase

**Example**:
```javascript
import { expr } from 'monsqlize';

const lowerEmailExpr = expr('LOWER(email)');

//MongoDB equivalent expression
{ $toLower: '$email' }
```

---


## TRIM - remove leading and trailing spaces

**Syntax**: `TRIM(str)`

**Description**: Remove spaces from the beginning and end of the string

**Example**:
```javascript
import { expr } from 'monsqlize';

const trimmedExpr = expr('TRIM(username)');

//MongoDB equivalent expression
{ $trim: { input: '$username' } }
```

---


## LTRIM - Remove left spaces

**Syntax**: `LTRIM(str)`

**Description**: Remove spaces on the left side of the string

**Example**:
```javascript
const result = expr('LTRIM(name)');

//MongoDB equivalent expression
{ $ltrim: { input: '$name' } }
```

---


## RTRIM - remove spaces on the right

**Syntax**: `RTRIM(str)`

**Description**: Remove spaces on the right side of the string

**Example**:
```javascript
const result = expr('RTRIM(name)');

//MongoDB equivalent expression
{ $rtrim: { input: '$name' } }
```

---


## SUBSTR - substring extraction

**Syntax**: `SUBSTR(str, start, length)`

**Description**: Extract substring (based on bytes)

**Parameters**:
- `str` - source string
- `start` - starting position (starting from 0)
- `length` - Extract length

**Example**:
```javascript
const result = expr('SUBSTR(description, 0, 50)');

//MongoDB equivalent expression
{ $substr: ['$description', 0, 50] }
```

---


## SUBSTR_CP - Substring extraction (Unicode)

**Syntax**: `SUBSTR_CP(str, start, length)`

**Description**: Extract substring (based on Unicode code points)

**Example**:
```javascript
const result = expr('SUBSTR_CP(title, 0, 20)');

//MongoDB equivalent expression
{ $substrCP: ['$title', 0, 20] }
```

---


## LENGTH - String length

**Syntax**: `LENGTH(str)`

**Description**: Get the string length (Unicode code points)

**Example**:
```javascript
const result = expr('LENGTH(content)');

//MongoDB equivalent expression
{ $strLenCP: '$content' }
```

---


## SPLIT - String splitting

**Syntax**: `SPLIT(str, delimiter)`

**Description**: Split the string into an array

**Parameters**:
- `str` - the string to split
- `delimiter` - delimiter

**Example**:
```javascript
const result = expr('SPLIT(tags, ",")');

//MongoDB equivalent expression
{ $split: ['$tags', ','] }
```

---


## REPLACE - string replacement

**Syntax**: `REPLACE(str, find, replacement)`

**Description**: Replace all matches in a string

**Parameters**:
- `str` - source string
- `find` - the string to find
- `replacement` - Replacement content

**Example**:
```javascript
const result = expr('REPLACE(content, "old", "new")');

//MongoDB equivalent expression
{
  $replaceAll: {
    input: '$content',
    find: 'old',
    replacement: 'new'
  }
}
```

---


## INDEX_OF_STR - String search

**Syntax**: `INDEX_OF_STR(str, substring)`

**Description**: Find the position of the substring (returns the byte index)

**Example**:
```javascript
const result = expr('INDEX_OF_STR(email, "@")');

//MongoDB equivalent expression
{ $indexOfBytes: ['$email', '@'] }
```

---

## Math functions (6)


## ABS - Absolute value

**Syntax**: `ABS(number)`

**Description**: Returns the absolute value of the number

**Example**:
```javascript
const result = expr('ABS(balance)');

//MongoDB equivalent expression
{ $abs: '$balance' }
```

---


## CEIL - Round up

**Syntax**: `CEIL(number)`

**Description**: Round up to the nearest integer

**Example**:
```javascript
const result = expr('CEIL(price)');

//MongoDB equivalent expression
{ $ceil: '$price' }
```

---


## FLOOR - round down

**Syntax**: `FLOOR(number)`

**Description**: Round down to the nearest integer

**Example**:
```javascript
const result = expr('FLOOR(score)');

//MongoDB equivalent expression
{ $floor: '$score' }
```

---


## ROUND - round up

**Syntax**: `ROUND(number)`

**Description**: Round to the nearest whole number

**Example**:
```javascript
const result = expr('ROUND(rating)');

//MongoDB equivalent expression
{ $round: '$rating' }
```

---


## SQRT - square root

**Syntax**: `SQRT(number)`

**Description**: Returns the square root

**Example**:
```javascript
const result = expr('SQRT(area)');

//MongoDB equivalent expression
{ $sqrt: '$area' }
```

---


## POW - Exponentiation

**Syntax**: `POW(base, exponent)`

**Description**: Returns the exponent power of base

**Parameters**:
- `base` - base
- `exponent` - Index

**Example**:
```javascript
const result = expr('POW(value, 2)');

//MongoDB equivalent expression
{ $pow: ['$value', 2] }
```

---

## Array functions (10)


## SIZE - array size

**Syntax**: `SIZE(array)`

**Description**: Returns the number of elements in the array

**Example**:
```javascript
const result = expr('SIZE(tags)');

//MongoDB equivalent expression
{ $size: '$tags' }
```

---


## FIRST - the first element of the array

**Syntax**: `FIRST(array)`

**Description**: Returns the first element of the array

**Example**:
```javascript
const result = expr('FIRST(items)');

//MongoDB equivalent expression
{ $first: '$items' }
```

---


## LAST - the last element of the array

**Syntax**: `LAST(array)`

**Description**: Returns the last element of the array

**Example**:
```javascript
const result = expr('LAST(items)');

//MongoDB equivalent expression
{ $last: '$items' }
```

---


## SLICE - array slice

**Syntax**: `SLICE(array, start, length)`

**Description**: Extract part of the array

**Parameters**:
- `array` - source array
- `start` - starting position
- `length` - Extract quantity

**Example**:
```javascript
const result = expr('SLICE(items, 0, 5)');

//MongoDB equivalent expression
{ $slice: ['$items', 0, 5] }
```

---


## ARRAY_ELEM_AT - Get array elements

**Syntax**: `ARRAY_ELEM_AT(array, index)`

**Description**: Get the element at the specified position in the array

**Parameters**:
- `array` - array
- `index` - index (supports negative numbers, -1 indicates the last one)

**Example**:
```javascript
const result = expr('ARRAY_ELEM_AT(tags, 0)');

//MongoDB equivalent expression
{ $arrayElemAt: ['$tags', 0] }
```

---


## IN - Array contains check

**Syntax**: `IN(value, array)`

**Description**: Check if the value is in the array

**Example**:
```javascript
const result = expr('IN(status, ["active", "pending"])');

//MongoDB equivalent expression
{ $in: ['$status', ['active', 'pending']] }
```

---


## FILTER - Array filtering

**Syntax**: `FILTER(array, varName, condition)`

**Description**: Filter array elements

**Parameters**:
- `array` - source array
- `varName` - loop variable name
- `condition` - filter conditions

**Example**:
```javascript
const result = expr('FILTER(items, item, item.active === true)');

//MongoDB equivalent expression
{
  $filter: {
    input: '$items',
    as: 'item',
    cond: { $eq: ['$$item.active', true] }
  }
}
```

---


## MAP - Array mapping

**Syntax**: `MAP(array, varName, expression)`

**Description**: Apply an expression to each element of the array

**Example**:
```javascript
const result = expr('MAP(items, item, item.price * 1.1)');

//MongoDB equivalent expression
{
  $map: {
    input: '$items',
    as: 'item',
    in: { $multiply: ['$$item.price', 1.1] }
  }
}
```

---


## INDEX_OF - array search

**Syntax**: `INDEX_OF(array, value)`

**Description**: Find the index position of the value in the array

**Example**:
```javascript
const result = expr('INDEX_OF(tags, "featured")');

//MongoDB equivalent expression
{ $indexOfArray: ['$tags', 'featured'] }
```

---


## CONCAT_ARRAYS - Array concatenation

**Syntax**: `CONCAT_ARRAYS(array1, array2, ...)`

**Description**: Connect multiple arrays

**Example**:
```javascript
const result = expr('CONCAT_ARRAYS(tags1, tags2)');

//MongoDB equivalent expression
{ $concatArrays: ['$tags1', '$tags2'] }
```

---

## Aggregation functions (7)


## SUM - Sum

**Syntax**: `SUM(field)` or `SUM()`

**Description**: Calculate the sum of fields, and return the count if there are no parameters.

**Example**:
```javascript
//Sum
const expr1 = expr('SUM(amount)');
// { $sum: '$amount' }

//count
const expr2 = expr('SUM()');
// { $sum: 1 }

//Used in $group
await collection('orders').aggregate([
  {
    $group: {
      _id: '$userId',
      totalAmount: expr1,
      orderCount: expr2
    }
  }
]);
```

---


## AVG - Average

**Syntax**: `AVG(field)`

**Description**: Calculate the average

**Example**:
```javascript
const result = expr('AVG(score)');

//MongoDB equivalent expression
{ $avg: '$score' }
```

---


## MAX - Maximum value

**Syntax**: `MAX(field)`

**Description**: Get the maximum value

**Example**:
```javascript
const result = expr('MAX(price)');

//MongoDB equivalent expression
{ $max: '$price' }
```

---


## MIN - Minimum value

**Syntax**: `MIN(field)`

**Description**: Get the minimum value

**Example**:
```javascript
const result = expr('MIN(age)');

//MongoDB equivalent expression
{ $min: '$age' }
```

---


## COUNT - count

**Syntax**: `COUNT()`

**Description**: Calculate the number of documents

**Example**:
```javascript
const result = expr('COUNT()');

//MongoDB equivalent expression
{ $sum: 1 }
```

---


## PUSH - Build an array

**Syntax**: `PUSH(field)`

**Description**: Collect field values into an array

**Example**:
```javascript
const result = expr('PUSH(item)');

//MongoDB equivalent expression
{ $push: '$item' }

//Used in $group
await collection('orders').aggregate([
  {
    $group: {
      _id: '$userId',
      items: result
    }
  }
]);
```

---


## ADD_TO_SET - Construct a unique array

**Syntax**: `ADD_TO_SET(field)`

**Description**: Collect field values into an array (remove duplication)

**Example**:
```javascript
const result = expr('ADD_TO_SET(category)');

//MongoDB equivalent expression
{ $addToSet: '$category' }
```

---

## Date functions (6)


## YEAR - Get the year

**Syntax**: `YEAR(date)`

**Description**: Extract year from date

**Example**:
```javascript
const result = expr('YEAR(createdAt)');

//MongoDB equivalent expression
{ $year: '$createdAt' }
```

---


## MONTH - Get the month

**Syntax**: `MONTH(date)`

**Description**: Extract the month (1-12) from the date

**Example**:
```javascript
const result = expr('MONTH(createdAt)');

//MongoDB equivalent expression
{ $month: '$createdAt' }
```

---


## DAY_OF_MONTH - Get the date

**Syntax**: `DAY_OF_MONTH(date)`

**Description**: Extract the day (1-31) from the date

**Example**:
```javascript
const result = expr('DAY_OF_MONTH(createdAt)');

//MongoDB equivalent expression
{ $dayOfMonth: '$createdAt' }
```

---


## HOUR - Get the hour

**Syntax**: `HOUR(date)`

**Description**: Extract the hour (0-23) from the date

**Example**:
```javascript
const result = expr('HOUR(createdAt)');

//MongoDB equivalent expression
{ $hour: '$createdAt' }
```

---


## MINUTE - Get minutes

**Syntax**: `MINUTE(date)`

**Description**: Extract minutes (0-59) from date

**Example**:
```javascript
const result = expr('MINUTE(createdAt)');

//MongoDB equivalent expression
{ $minute: '$createdAt' }
```

---


## SECOND - Get seconds

**Syntax**: `SECOND(date)`

**Description**: Extract seconds (0-59) from date

**Example**:
```javascript
const result = expr('SECOND(createdAt)');

//MongoDB equivalent expression
{ $second: '$createdAt' }
```

---


## DATE_ADD - Date addition 🆕 v1.1.0

**Syntax**: `DATE_ADD(date, amount, unit)`

**Description**: Add the date and return the new date

**Parameters**:
- `date` - start date field
- `amount` - quantity (number or field reference)
- `unit` - time unit (`"year"`, `"month"`, `"week"`, `"day"`, `"hour"`, `"minute"`, `"second"`, `"millisecond"`)

**MongoDB Version**: Requires MongoDB 5.0+

**Example**:
```javascript
import { expr } from 'monsqlize';

//Calculate the date 7 days later
const deliveryDateExpr = expr('DATE_ADD(orderDate, 7, "day")');

//MongoDB equivalent expression
{
  $dateAdd: {
    startDate: '$orderDate',
    unit: 'day',
    amount: 7
  }
}

//used in aggregation
await collection('orders').aggregate([
  {
    $addFields: {
      deliveryDate: deliveryDateExpr,
      nextMonth: expr('DATE_ADD(createdAt, 1, "month")')
    }
  }
]);
```

**Usage Scenario**:
- Calculate delivery date
- Calculate renewal date
- Calculate expiry time
- Calculate reminder time

---


## DATE_SUBTRACT - Date subtraction 🆕 v1.1.0

**Syntax**: `DATE_SUBTRACT(date, amount, unit)`

**Description**: Subtract the date and return the new date

**Parameters**:
- `date` - start date field
- `amount` - quantity (number or field reference)
- `unit` - time unit (same as DATE_ADD)

**MongoDB Version**: Requires MongoDB 5.0+

**Example**:
```javascript
import { expr } from 'monsqlize';

//Calculate date 30 days ago
const reminderDateExpr = expr('DATE_SUBTRACT(vipExpireAt, 30, "day")');

//MongoDB equivalent expression
{
  $dateSubtract: {
    startDate: '$vipExpireAt',
    unit: 'day',
    amount: 30
  }
}

//Check for expiring memberships
await collection('users').aggregate([
  {
    $addFields: {
      reminderDate: reminderDateExpr
    }
  },
  {
    $match: {
      reminderDate: { $lte: new Date() }
    }
  }
]);
```

**Usage Scenario**:
- Calculate advance reminder date
- Calculate refund deadline
- Calculate historical time points

---


## DATE_DIFF - Date difference calculation 🆕 v1.1.0

**Syntax**: `DATE_DIFF(endDate, startDate, unit)`

**Description**: Calculate the difference between two dates

**Parameters**:
- `endDate` - end date
- `startDate` - start date
- `unit` - return value unit (same as DATE_ADD)

**MongoDB Version**: Requires MongoDB 5.0+

**Example**:
```javascript
import { expr } from 'monsqlize';

//Calculate order processing time (days)
const processingDaysExpr = expr('DATE_DIFF(completedAt, createdAt, "day")');

//MongoDB equivalent expression
{
  $dateDiff: {
    startDate: '$createdAt',
    endDate: '$completedAt',
    unit: 'day'
  }
}

//Statistical order processing time
await collection('orders').aggregate([
  {
    $addFields: {
      processingDays: processingDaysExpr,
      processingHours: expr('DATE_DIFF(completedAt, createdAt, "hour")')
    }
  },
  {
    $group: {
      _id: null,
      avgDays: { $avg: '$processingDays' },
      maxDays: { $max: '$processingDays' }
    }
  }
]);
```

**Usage Scenario**:
- Calculate order processing time
- Calculate the number of days a user is active
- Calculate the remaining days of membership
- Performance analysis and statistics

---


## DATE_TO_STRING - Date formatting 🆕 v1.1.0

**Syntax**: `DATE_TO_STRING(date, format)`

**Description**: Format date into string

**Parameters**:
- `date` - Date field
- `format` - format template (using MongoDB format characters)

**Supported format characters**:
- `%Y` - year (4 digits, such as 2026)
- `%m` - Month (01-12)
- `%d` - Day (01-31)
- `%H` - hour (00-23)
- `%M` - points (00-59)
- `%S` - seconds (00-59)

**MongoDB version**: Support MongoDB 3.6+

**Example**:
```javascript
import { expr } from 'monsqlize';

//Format to standard datetime
const dateStrExpr = expr('DATE_TO_STRING(createdAt, "%Y-%m-%d %H:%M:%S")');

//MongoDB equivalent expression
{
  $dateToString: {
    date: '$createdAt',
    format: '%Y-%m-%d %H:%M:%S'
  }
}

//Format date display
await collection('articles').aggregate([
  {
    $addFields: {
      publishDateStr: dateStrExpr,
      publishDateCN: expr('DATE_TO_STRING(publishAt, "%Y year %m month %d day")'),
      timeOnly: expr('DATE_TO_STRING(createdAt, "%H:%M:%S")')
    }
  }
]);
```

**Usage Scenario**:
- Formatted date display
- Generate reports
- Export data
- API returns formatted date

---


## DATE_FROM_STRING - String parsing 🆕 v1.1.0

**Syntax**: `DATE_FROM_STRING(dateString [, format])`

**Description**: Parse a string into a date object

**Parameters**:
- `dateString` - date string field or literal
- `format` - optional, format template (default ISO 8601)

**MongoDB version**: Support MongoDB 3.6+

**Example**:
```javascript
import { expr } from 'monsqlize';

//Parse ISO format date string
const parsedDateExpr = expr('DATE_FROM_STRING(dateString)');

//MongoDB equivalent expression
{
  $dateFromString: {
    dateString: '$dateString'
  }
}

//Parse custom formats
const customDateExpr = expr('DATE_FROM_STRING(dateStr, "%Y-%m-%d")');

//MongoDB equivalent expression
{
  $dateFromString: {
    dateString: '$dateStr',
    format: '%Y-%m-%d'
  }
}

//Data import scenario
await collection('imports').aggregate([
  {
    $addFields: {
      parsedDate: parsedDateExpr,
      birthDate: expr('DATE_FROM_STRING(birthDateStr, "%Y-%m-%d")')
    }
  }
]);
```

**Usage Scenario**:
- Data import
- Parse text date
- Date field standardization
- Data cleaning

---

## Types and logical functions (5)


## TYPE - Get the type

**Syntax**: `TYPE(value)`

**Description**: BSON type of return value

**Example**:
```javascript
const result = expr('TYPE(field)');

//MongoDB equivalent expression
{ $type: '$field' }
```

---


## NOT - logical negation

**Syntax**: `NOT(expression)`

**Description**: Negate the expression result

**Example**:
```javascript
const result = expr('NOT(active)');

//MongoDB equivalent expression
{ $not: ['$active'] }
```

---


## EXISTS - Existence check

**Syntax**: `EXISTS(field)`

**Description**: Check whether the field exists (not null)

**Example**:
```javascript
const result = expr('EXISTS(email)');

//MongoDB equivalent expression
{ $ne: ['$email', null] }
```

---


## IS_NUMBER - Numeric type check

**Syntax**: `IS_NUMBER(value)`

**Description**: Check whether the value is a numeric type

**Example**:
```javascript
const result = expr('IS_NUMBER(field)');

//MongoDB equivalent expression
{ $eq: [{ $type: '$field' }, 'number'] }
```

---


## IS_ARRAY - Array type check

**Syntax**: `IS_ARRAY(value)`

**Description**: Check whether the value is an array

**Example**:
```javascript
const result = expr('IS_ARRAY(tags)');

//MongoDB equivalent expression
{ $isArray: '$tags' }
```

---

## Advanced operation functions (7)


## REGEX - regular matching

**Syntax**: `REGEX(field, pattern)`

**Description**: Use regular expressions to match strings

**Parameters**:
- `field` - field name
- `pattern` - Regular expression pattern

**Example**:
```javascript
const result = expr('REGEX(email, ".*@gmail\\\\.com$")');

//MongoDB equivalent expression
{
  $regexMatch: {
    input: '$email',
    regex: '.*@gmail\\.com$'
  }
}
```

---


## MERGE_OBJECTS - Merge objects

**Syntax**: `MERGE_OBJECTS(obj1, obj2, ...)`

**Description**: Merge multiple objects

**Example**:
```javascript
const result = expr('MERGE_OBJECTS(profile, settings)');

//MongoDB equivalent expression
{ $mergeObjects: ['$profile', '$settings'] }
```

---


## TO_INT - Convert to integer

**Syntax**: `TO_INT(value)`

**Description**: Convert value to integer

**Example**:
```javascript
const result = expr('TO_INT(stringValue)');

//MongoDB equivalent expression
{ $toInt: '$stringValue' }
```

---


## TO_STRING - Convert to string

**Syntax**: `TO_STRING(value)`

**Description**: Convert value to string

**Example**:
```javascript
const result = expr('TO_STRING(numericValue)');

//MongoDB equivalent expression
{ $toString: '$numericValue' }
```

---


## OBJECT_TO_ARRAY - object to array

**Syntax**: `OBJECT_TO_ARRAY(obj)`

**Description**: Convert the object to an array of key-value pairs

**Example**:
```javascript
const result = expr('OBJECT_TO_ARRAY(metadata)');

//MongoDB equivalent expression
{ $objectToArray: '$metadata' }

//Example of results
// { key: 'name', value: 'John' }
// { key: 'age', value: 30 }
```

---


## ARRAY_TO_OBJECT - Array to object

**Syntax**: `ARRAY_TO_OBJECT(array)`

**Description**: Convert an array of key-value pairs to an object

**Example**:
```javascript
const result = expr('ARRAY_TO_OBJECT(pairs)');

//MongoDB equivalent expression
{ $arrayToObject: '$pairs' }
```

---


## SET_UNION - Set union

**Syntax**: `SET_UNION(array1, array2, ...)`

**Description**: Return the union of multiple arrays (remove duplication)

**Example**:
```javascript
const result = expr('SET_UNION(tags1, tags2)');

//MongoDB equivalent expression
{ $setUnion: ['$tags1', '$tags2'] }
```

---

## Conditional function (1)


## SWITCH - Multi-condition judgment

**Syntax**: `SWITCH(case1, result1, case2, result2, ..., default)`

**Description**: Multi-condition judgment similar to switch-case

**Example**:
```javascript
const result = expr(`
  SWITCH(
    level === 1, "Bronze",
    level === 2, "Silver",
    level === 3, "Gold",
    "Unknown"
  )
`);

//MongoDB equivalent expression
{
  $switch: {
    branches: [
      { case: { $eq: ['$level', 1] }, then: 'Bronze' },
      { case: { $eq: ['$level', 2] }, then: 'Silver' },
      { case: { $eq: ['$level', 3] }, then: 'Gold' }
    ],
    default: 'Unknown'
  }
}
```

---

## Function index table

| Function name | Category | Description | Number of parameters |
|--------|------|------|---------|
| **String function** ||||
| CONCAT | String | String Concatenation | 2+ |
| UPPER | String | Convert to uppercase | 1 |
| LOWER | String | Convert to lowercase | 1 |
| TRIM | String | Remove leading and trailing spaces | 1 |
| LTRIM | String | Remove left spaces | 1 |
| RTRIM | String | Remove right spaces | 1 |
| SUBSTR | String | Substring extraction | 3 |
| SUBSTR_CP | String | Substring extraction (Unicode) | 3 |
| LENGTH | String | String length | 1 |
| SPLIT | string | string split | 2 |
| REPLACE | string | string replacement | 3 |
| INDEX_OF_STR | String | String search | 2 |
| **Mathematical functions** ||||
| ABS | Mathematics | Absolute Value | 1 |
| CEIL | Mathematics | Round Up | 1 |
| FLOOR | MATH | ROUND DOWN | 1 |
| ROUND | Mathematics | Rounding | 1 |
| SQRT | Math | Square Root | 1 |
| POW | Mathematics | Exponentiation | 2 |
| **array function** ||||
| SIZE | array | array size | 1 |
| FIRST | array | first element | 1 |
| LAST | array | last element | 1 |
| SLICE | Array | Array slice | 3 |
| ARRAY_ELEM_AT | Array | Get array elements | 2 |
| IN | array | contains check | 2 |
| FILTER | Array | Array filter | 3 |
| MAP | Array | Array Map | 3 |
| INDEX_OF | Array | Array search | 2 |
| CONCAT_ARRAYS | Array | Array concatenation | 2+ |
| **Aggregation function** ||||
| SUM | Aggregation | Sum/Count | 0-1 |
| AVG | Aggregation | Average | 1 |
| MAX | Aggregation | Maximum value | 1 |
| MIN | Aggregation | Minimum value | 1 |
| COUNT | Aggregation | Count | 0 |
| PUSH | Aggregation | Build Array | 1 |
| ADD_TO_SET | Aggregation | Build unique array | 1 |
| **Date Function** ||||
| YEAR | Date | Get year | 1 |
| MONTH | Date | Get month | 1 |
| DAY_OF_MONTH | Date | Get day | 1 |
| HOUR | Date | Get hour | 1 |
| MINUTE | Date | Get Minutes | 1 |
| SECOND | date | get seconds | 1 |
| DATE_ADD 🆕 | Date | Date addition | 3 |
| DATE_SUBTRACT 🆕 | Date | Date Subtraction | 3 |
| DATE_DIFF 🆕 | Date | Date difference | 3 |
| DATE_TO_STRING 🆕 | Date | Date Formatting | 2 |
| DATE_FROM_STRING 🆕 | Date | String parsing | 1-2 |
| **Type/Logic** ||||
| TYPE | type | get type | 1 |
| NOT | Logical | Logical NOT | 1 |
| EXISTS | Logic | Existence Check | 1 |
| IS_NUMBER | Type | Numeric type check | 1 |
| IS_ARRAY | Type | Array type check | 1 |
| **Advanced Operations** ||||
| REGEX | Advanced | Regular matching | 2 |
| MERGE_OBJECTS | Advanced | Merge Objects | 2+ |
| TO_INT | Advanced | Convert to integer | 1 |
| TO_STRING | Advanced | Convert to string | 1 |
| OBJECT_TO_ARRAY | Advanced | Convert object to array | 1 |
| ARRAY_TO_OBJECT | Advanced | Array to object | 1 |
| SET_UNION | Advanced | Set Union | 2+ |
| **Conditions** ||||
| SWITCH | Conditions | Multi-condition judgment | 3+ |

---

## Usage example


## Example 1: User classification

```javascript
import { expr } from 'monsqlize';

//Classify users by age
const categoryExpr = expr(`
  age < 18 ? "minor" : (age < 60 ? "adult" : "senior")
`);

await collection('users').aggregate([
  {
    $addFields: {
      category: categoryExpr
    }
  }
]);
```


## Example 2: Calculate discount price

```javascript
//Complex price calculations
const discountPriceExpr = expr(`
  ROUND(price * (100 - discount) / 100)
`);

await collection('products').aggregate([
  {
    $addFields: {
      finalPrice: discountPriceExpr
    }
  }
]);
```


## Example 3: Data aggregation

```javascript
//Order statistics by month
await collection('orders').aggregate([
  {
    $group: {
      _id: {
        year: expr('YEAR(createdAt)'),
        month: expr('MONTH(createdAt)')
      },
      totalAmount: expr('SUM(amount)'),
      orderCount: expr('COUNT()'),
      avgAmount: expr('AVG(amount)')
    }
  }
]);
```


## Example 4: Array processing

```javascript
//Filter active tags
const activeTagsExpr = expr(
  'FILTER(tags, tag, tag.active === true)'
);

//Map tag name
const tagNamesExpr = expr(
  'MAP(tags, tag, tag.name)'
);

await collection('posts').aggregate([
  {
    $addFields: {
      activeTags: activeTagsExpr,
      tagNames: tagNamesExpr
    }
  }
]);
```


## Example 5: String processing

```javascript
//Clean and format emails
const cleanEmailExpr = expr(
  'LOWER(TRIM(email))'
);

//Extract domain name
const domainExpr = expr(
  'SUBSTR(email, INDEX_OF_STR(email, "@") + 1, LENGTH(email))'
);

await collection('users').aggregate([
  {
    $addFields: {
      cleanEmail: cleanEmailExpr,
      emailDomain: domainExpr
    }
  }
]);
```

---

## Performance recommendations


## 1. Use index

```javascript
//Create index to support expression query
await collection('users').createIndex({ age: 1, status: 1 });

//Try to make use of index fields when using expressions
const result = expr('age >= 18 && status === "active"');
```


## 2. Avoid complex nesting

```javascript
//❌ Excessive nesting
const bad = expr(
  'UPPER(CONCAT(SUBSTR(name, 0, 1), LOWER(SUBSTR(name, 1, LENGTH(name)))))'
);

//✅ Step by step processing
await collection('users').aggregate([
  { $addFields: { firstChar: expr('SUBSTR(name, 0, 1)') } },
  { $addFields: { restChars: expr('LOWER(SUBSTR(name, 1, LENGTH(name)))') } },
  { $addFields: { formatted: expr('CONCAT(firstChar, restChars)') } }
]);
```


## 3. Use cache

```javascript
//Expression compilation results are automatically cached
const cachedExpr = expr('UPPER(name)');

//The same expression will use cached results
for (let i = 0; i < 1000; i++) {
  await collection('users').aggregate([
    { $addFields: { upperName: cachedExpr } }
  ]);
}
```


## 4. Reasonable use of $match

```javascript
//✅ $match first and then $addFields to reduce processing volume
await collection('orders').aggregate([
  { $match: { status: 'completed' } },  //filter first
  {
    $addFields: {
      discount: expr('ROUND(amount * 0.1)')
    }
  }
]);
```

---

## Related documents

- [Aggregation operation document](./aggregate.md)
- [Unified Expression System](./chaining-api.md)
- [Query Optimization Guide](./explain.md)

---

## Supplementary instructions


## API alias

`expr` is the abbreviated alias of `createExpression`. The two are completely equivalent, and it is recommended to use the short `expr`:

```javascript
import { expr, createExpression } from 'monsqlize';

//✅ Recommendation: concise and clear
const shortForm = expr('UPPER(name)');

//✅ Also supported: Full name (for backwards compatibility)
const longForm = createExpression('UPPER(name)');

//Both are completely equivalent
console.log(shortForm === longForm);  //false (different instance)
//But the compilation result is the same
```
