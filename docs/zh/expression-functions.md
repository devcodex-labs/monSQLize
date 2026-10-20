# 表达式函数参考

嵌套 facet/lookup/unionWith pipeline 及 merge.whenMatched pipeline 保留各 stage 上下文。SUBSTR/SUBSTR_CP/SLICE/ARRAY_ELEM_AT 的数值参数支持表达式，不截断为整数。MAP/FILTER 按词法作用域处理标量变量、嵌套及引号字面量；LET 按平衡分隔符拆绑定，仍使用显式 `$$name` 引用。SWITCH 保留显式 null/false/0/空字符串 default；省略 default 时沿用 MongoDB 原生失败行为。支持 `price * 1e-3` 等科学计数，损坏数值表达式报 INVALID_EXPRESSION。

DSL 裸 lambda 名字与 MongoDB 显式 `$$` 变量分别绑定。MAP/FILTER 绑定自己的命名变量；REDUCE 只在主体内引入原生 `$$value`/`$$this`，input 与 initialValue 使用外层作用域。LET 的初始值使用外层作用域，主体使用其声明的显式变量。原生 JSON `$map`、`$filter`、`$reduce`、`$let` 遵循相同词法边界。引号文本与 `$literal` 内容保持原样。

例如，`REDUCE([10],0,(acc,item)=>SUM(MAP([1,2],value,$$value)))` 结果为 `3`。`MAP([10],value,REDUCE([1,2],0,(acc,item)=>$$value + $$this))` 中，显式引用属于内层 reducer，结果为 `[3]`；外层 lambda 的裸名字仍引用其 DSL 绑定。

## 概述

monSQLize 的统一表达式系统支持 **122个操作符（100% MongoDB支持）**，涵盖字符串、数学、数组、聚合、日期、类型转换、逻辑、条件、对象、集合等所有操作。这些函数提供类SQL的语法，让复杂的MongoDB聚合查询变得简单直观。

### 核心特性

- ✅ **类SQL语法** - CONCAT、UPPER等熟悉的函数名
- ✅ **自动编译** - 自动转换为MongoDB聚合表达式
- ✅ **类型安全** - 编译时检查参数类型
- ✅ **缓存优化** - 表达式编译结果自动缓存
- ✅ **跨数据库** - 未来支持MySQL、PostgreSQL

### 快速示例

```javascript
import { expr } from 'monsqlize';

// 字符串操作
const fullName = expr('CONCAT(firstName, " ", lastName)');

// 条件判断
const category = expr('age >= 18 ? "adult" : "minor"');

// 复杂表达式
const score = expr('(mathScore + englishScore) / 2 >= 60 ? "pass" : "fail"');

// 在聚合中使用
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

## 字符串函数 (12个)

### CONCAT - 字符串连接

**语法**: `CONCAT(str1, str2, ...)`

**说明**: 连接多个字符串

**参数**:
- `str1, str2, ...` - 要连接的字符串（可以是字段引用或字面量）

**示例**:
```javascript
import { expr } from 'monsqlize';

const fullNameExpr = expr('CONCAT(firstName, " ", lastName)');

// MongoDB等价表达式
{ $concat: ['$firstName', ' ', '$lastName'] }

// 在聚合中使用
await collection('users').aggregate([
  {
    $addFields: {
      fullName: fullNameExpr
    }
  }
]);
```

---

### UPPER - 转换为大写

**语法**: `UPPER(str)`

**说明**: 将字符串转换为大写

**参数**:
- `str` - 字符串字段或值

**示例**:
```javascript
import { expr } from 'monsqlize';

const upperNameExpr = expr('UPPER(name)');

// MongoDB等价表达式
{ $toUpper: '$name' }

// 使用
await collection('users').aggregate([
  { $project: { upperName: upperNameExpr } }
]);
```

---

### LOWER - 转换为小写

**语法**: `LOWER(str)`

**说明**: 将字符串转换为小写

**示例**:
```javascript
import { expr } from 'monsqlize';

const lowerEmailExpr = expr('LOWER(email)');

// MongoDB等价表达式
{ $toLower: '$email' }
```

---

### TRIM - 去除首尾空格

**语法**: `TRIM(str)`

**说明**: 去除字符串首尾的空格

**示例**:
```javascript
import { expr } from 'monsqlize';

const trimmedExpr = expr('TRIM(username)');

// MongoDB等价表达式
{ $trim: { input: '$username' } }
```

---

### LTRIM - 去除左侧空格

**语法**: `LTRIM(str)`

**说明**: 去除字符串左侧的空格

**示例**:
```javascript
const result = expr('LTRIM(name)');

// MongoDB等价表达式
{ $ltrim: { input: '$name' } }
```

---

### RTRIM - 去除右侧空格

**语法**: `RTRIM(str)`

**说明**: 去除字符串右侧的空格

**示例**:
```javascript
const result = expr('RTRIM(name)');

// MongoDB等价表达式
{ $rtrim: { input: '$name' } }
```

---

### SUBSTR - 子字符串提取

**语法**: `SUBSTR(str, start, length)`

**说明**: 提取子字符串（基于字节）

**参数**:
- `str` - 源字符串
- `start` - 起始位置（从0开始）
- `length` - 提取长度

**示例**:
```javascript
const result = expr('SUBSTR(description, 0, 50)');

// MongoDB等价表达式
{ $substr: ['$description', 0, 50] }
```

---

### SUBSTR_CP - 子字符串提取（Unicode）

**语法**: `SUBSTR_CP(str, start, length)`

**说明**: 提取子字符串（基于Unicode代码点）

**示例**:
```javascript
const result = expr('SUBSTR_CP(title, 0, 20)');

// MongoDB等价表达式
{ $substrCP: ['$title', 0, 20] }
```

---

### LENGTH - 字符串长度

**语法**: `LENGTH(str)`

**说明**: 获取字符串长度（Unicode代码点数）

**示例**:
```javascript
const result = expr('LENGTH(content)');

// MongoDB等价表达式
{ $strLenCP: '$content' }
```

---

### SPLIT - 字符串分割

**语法**: `SPLIT(str, delimiter)`

**说明**: 将字符串分割为数组

**参数**:
- `str` - 要分割的字符串
- `delimiter` - 分隔符

**示例**:
```javascript
const result = expr('SPLIT(tags, ",")');

// MongoDB等价表达式
{ $split: ['$tags', ','] }
```

---

### REPLACE - 字符串替换

**语法**: `REPLACE(str, find, replacement)`

**说明**: 替换字符串中的所有匹配项

**参数**:
- `str` - 源字符串
- `find` - 要查找的字符串
- `replacement` - 替换内容

**示例**:
```javascript
const result = expr('REPLACE(content, "old", "new")');

// MongoDB等价表达式
{ 
  $replaceAll: { 
    input: '$content', 
    find: 'old', 
    replacement: 'new' 
  } 
}
```

---

### INDEX_OF_STR - 字符串查找

**语法**: `INDEX_OF_STR(str, substring)`

**说明**: 查找子字符串的位置（返回字节索引）

**示例**:
```javascript
const result = expr('INDEX_OF_STR(email, "@")');

// MongoDB等价表达式
{ $indexOfBytes: ['$email', '@'] }
```

---

## 数学函数 (6个)

### ABS - 绝对值

**语法**: `ABS(number)`

**说明**: 返回数字的绝对值

**示例**:
```javascript
const result = expr('ABS(balance)');

// MongoDB等价表达式
{ $abs: '$balance' }
```

---

### CEIL - 向上取整

**语法**: `CEIL(number)`

**说明**: 向上取整到最近的整数

**示例**:
```javascript
const result = expr('CEIL(price)');

// MongoDB等价表达式
{ $ceil: '$price' }
```

---

### FLOOR - 向下取整

**语法**: `FLOOR(number)`

**说明**: 向下取整到最近的整数

**示例**:
```javascript
const result = expr('FLOOR(score)');

// MongoDB等价表达式
{ $floor: '$score' }
```

---

### ROUND - 四舍五入

**语法**: `ROUND(number)`

**说明**: 四舍五入到最近的整数

**示例**:
```javascript
const result = expr('ROUND(rating)');

// MongoDB等价表达式
{ $round: '$rating' }
```

---

### SQRT - 平方根

**语法**: `SQRT(number)`

**说明**: 返回平方根

**示例**:
```javascript
const result = expr('SQRT(area)');

// MongoDB等价表达式
{ $sqrt: '$area' }
```

---

### POW - 幂运算

**语法**: `POW(base, exponent)`

**说明**: 返回base的exponent次幂

**参数**:
- `base` - 底数
- `exponent` - 指数

**示例**:
```javascript
const result = expr('POW(value, 2)');

// MongoDB等价表达式
{ $pow: ['$value', 2] }
```

---

## 数组函数 (10个)

### SIZE - 数组大小

**语法**: `SIZE(array)`

**说明**: 返回数组的元素个数

**示例**:
```javascript
const result = expr('SIZE(tags)');

// MongoDB等价表达式
{ $size: '$tags' }
```

---

### FIRST - 数组第一个元素

**语法**: `FIRST(array)`

**说明**: 返回数组的第一个元素

**示例**:
```javascript
const result = expr('FIRST(items)');

// MongoDB等价表达式
{ $first: '$items' }
```

---

### LAST - 数组最后一个元素

**语法**: `LAST(array)`

**说明**: 返回数组的最后一个元素

**示例**:
```javascript
const result = expr('LAST(items)');

// MongoDB等价表达式
{ $last: '$items' }
```

---

### SLICE - 数组切片

**语法**: `SLICE(array, start, length)`

**说明**: 提取数组的一部分

**参数**:
- `array` - 源数组
- `start` - 起始位置
- `length` - 提取数量

**示例**:
```javascript
const result = expr('SLICE(items, 0, 5)');

// MongoDB等价表达式
{ $slice: ['$items', 0, 5] }
```

---

### ARRAY_ELEM_AT - 获取数组元素

**语法**: `ARRAY_ELEM_AT(array, index)`

**说明**: 获取数组指定位置的元素

**参数**:
- `array` - 数组
- `index` - 索引（支持负数，-1表示最后一个）

**示例**:
```javascript
const result = expr('ARRAY_ELEM_AT(tags, 0)');

// MongoDB等价表达式
{ $arrayElemAt: ['$tags', 0] }
```

---

### IN - 数组包含检查

**语法**: `IN(value, array)`

**说明**: 检查值是否在数组中

**示例**:
```javascript
const result = expr('IN(status, ["active", "pending"])');

// MongoDB等价表达式
{ $in: ['$status', ['active', 'pending']] }
```

---

### FILTER - 数组过滤

**语法**: `FILTER(array, varName, condition)`

**说明**: 过滤数组元素

**参数**:
- `array` - 源数组
- `varName` - 循环变量名
- `condition` - 过滤条件

**示例**:
```javascript
const result = expr('FILTER(items, item, item.active === true)');

// MongoDB等价表达式
{
  $filter: {
    input: '$items',
    as: 'item',
    cond: { $eq: ['$$item.active', true] }
  }
}
```

---

### MAP - 数组映射

**语法**: `MAP(array, varName, expression)`

**说明**: 对数组每个元素应用表达式

**示例**:
```javascript
const result = expr('MAP(items, item, item.price * 1.1)');

// MongoDB等价表达式
{
  $map: {
    input: '$items',
    as: 'item',
    in: { $multiply: ['$$item.price', 1.1] }
  }
}
```

---

### INDEX_OF - 数组查找

**语法**: `INDEX_OF(array, value)`

**说明**: 查找值在数组中的索引位置

**示例**:
```javascript
const result = expr('INDEX_OF(tags, "featured")');

// MongoDB等价表达式
{ $indexOfArray: ['$tags', 'featured'] }
```

---

### CONCAT_ARRAYS - 数组连接

**语法**: `CONCAT_ARRAYS(array1, array2, ...)`

**说明**: 连接多个数组

**示例**:
```javascript
const result = expr('CONCAT_ARRAYS(tags1, tags2)');

// MongoDB等价表达式
{ $concatArrays: ['$tags1', '$tags2'] }
```

---

## 聚合函数 (7个)

### SUM - 求和

**语法**: `SUM(field)` 或 `SUM()`

**说明**: 计算字段总和，无参数时返回计数

**示例**:
```javascript
// 求和
const expr1 = expr('SUM(amount)');
// { $sum: '$amount' }

// 计数
const expr2 = expr('SUM()');
// { $sum: 1 }

// 在$group中使用
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

### AVG - 平均值

**语法**: `AVG(field)`

**说明**: 计算平均值

**示例**:
```javascript
const result = expr('AVG(score)');

// MongoDB等价表达式
{ $avg: '$score' }
```

---

### MAX - 最大值

**语法**: `MAX(field)`

**说明**: 获取最大值

**示例**:
```javascript
const result = expr('MAX(price)');

// MongoDB等价表达式
{ $max: '$price' }
```

---

### MIN - 最小值

**语法**: `MIN(field)`

**说明**: 获取最小值

**示例**:
```javascript
const result = expr('MIN(age)');

// MongoDB等价表达式
{ $min: '$age' }
```

---

### COUNT - 计数

**语法**: `COUNT()`

**说明**: 计算文档数量

**示例**:
```javascript
const result = expr('COUNT()');

// MongoDB等价表达式
{ $sum: 1 }
```

---

### PUSH - 构建数组

**语法**: `PUSH(field)`

**说明**: 将字段值收集到数组中

**示例**:
```javascript
const result = expr('PUSH(item)');

// MongoDB等价表达式
{ $push: '$item' }

// 在$group中使用
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

### ADD_TO_SET - 构建唯一数组

**语法**: `ADD_TO_SET(field)`

**说明**: 将字段值收集到数组中（去重）

**示例**:
```javascript
const result = expr('ADD_TO_SET(category)');

// MongoDB等价表达式
{ $addToSet: '$category' }
```

---

## 日期函数 (6个)

### YEAR - 获取年份

**语法**: `YEAR(date)`

**说明**: 从日期中提取年份

**示例**:
```javascript
const result = expr('YEAR(createdAt)');

// MongoDB等价表达式
{ $year: '$createdAt' }
```

---

### MONTH - 获取月份

**语法**: `MONTH(date)`

**说明**: 从日期中提取月份（1-12）

**示例**:
```javascript
const result = expr('MONTH(createdAt)');

// MongoDB等价表达式
{ $month: '$createdAt' }
```

---

### DAY_OF_MONTH - 获取日期

**语法**: `DAY_OF_MONTH(date)`

**说明**: 从日期中提取日（1-31）

**示例**:
```javascript
const result = expr('DAY_OF_MONTH(createdAt)');

// MongoDB等价表达式
{ $dayOfMonth: '$createdAt' }
```

---

### HOUR - 获取小时

**语法**: `HOUR(date)`

**说明**: 从日期中提取小时（0-23）

**示例**:
```javascript
const result = expr('HOUR(createdAt)');

// MongoDB等价表达式
{ $hour: '$createdAt' }
```

---

### MINUTE - 获取分钟

**语法**: `MINUTE(date)`

**说明**: 从日期中提取分钟（0-59）

**示例**:
```javascript
const result = expr('MINUTE(createdAt)');

// MongoDB等价表达式
{ $minute: '$createdAt' }
```

---

### SECOND - 获取秒

**语法**: `SECOND(date)`

**说明**: 从日期中提取秒（0-59）

**示例**:
```javascript
const result = expr('SECOND(createdAt)');

// MongoDB等价表达式
{ $second: '$createdAt' }
```

---

### DATE_ADD - 日期加法 🆕 v1.1.0

**语法**: `DATE_ADD(date, amount, unit)`

**说明**: 对日期进行加法运算，返回新的日期

**参数**:
- `date` - 起始日期字段
- `amount` - 数量（数字或字段引用）
- `unit` - 时间单位（`"year"`, `"month"`, `"week"`, `"day"`, `"hour"`, `"minute"`, `"second"`, `"millisecond"`）

**MongoDB版本**: 需要 MongoDB 5.0+

**示例**:
```javascript
import { expr } from 'monsqlize';

// 计算7天后的日期
const deliveryDateExpr = expr('DATE_ADD(orderDate, 7, "day")');

// MongoDB等价表达式
{
  $dateAdd: {
    startDate: '$orderDate',
    unit: 'day',
    amount: 7
  }
}

// 在聚合中使用
await collection('orders').aggregate([
  {
    $addFields: {
      deliveryDate: deliveryDateExpr,
      nextMonth: expr('DATE_ADD(createdAt, 1, "month")')
    }
  }
]);
```

**使用场景**:
- 计算交货日期
- 计算续费日期
- 计算到期时间
- 计算提醒时间

---

### DATE_SUBTRACT - 日期减法 🆕 v1.1.0

**语法**: `DATE_SUBTRACT(date, amount, unit)`

**说明**: 对日期进行减法运算，返回新的日期

**参数**:
- `date` - 起始日期字段
- `amount` - 数量（数字或字段引用）
- `unit` - 时间单位（同DATE_ADD）

**MongoDB版本**: 需要 MongoDB 5.0+

**示例**:
```javascript
import { expr } from 'monsqlize';

// 计算30天前的日期
const reminderDateExpr = expr('DATE_SUBTRACT(vipExpireAt, 30, "day")');

// MongoDB等价表达式
{
  $dateSubtract: {
    startDate: '$vipExpireAt',
    unit: 'day',
    amount: 30
  }
}

// 查询即将到期的会员
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

**使用场景**:
- 计算提前提醒日期
- 计算退款截止日期
- 计算历史时间点

---

### DATE_DIFF - 日期差值计算 🆕 v1.1.0

**语法**: `DATE_DIFF(endDate, startDate, unit)`

**说明**: 计算两个日期之间的差值

**参数**:
- `endDate` - 结束日期
- `startDate` - 开始日期
- `unit` - 返回值单位（同DATE_ADD）

**MongoDB版本**: 需要 MongoDB 5.0+

**示例**:
```javascript
import { expr } from 'monsqlize';

// 计算订单处理时长（天）
const processingDaysExpr = expr('DATE_DIFF(completedAt, createdAt, "day")');

// MongoDB等价表达式
{
  $dateDiff: {
    startDate: '$createdAt',
    endDate: '$completedAt',
    unit: 'day'
  }
}

// 统计订单处理时长
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

**使用场景**:
- 计算订单处理时长
- 计算用户活跃天数
- 计算会员剩余天数
- 性能分析和统计

---

### DATE_TO_STRING - 日期格式化 🆕 v1.1.0

**语法**: `DATE_TO_STRING(date, format)`

**说明**: 将日期格式化为字符串

**参数**:
- `date` - 日期字段
- `format` - 格式模板（使用MongoDB格式符）

**支持的格式符**:
- `%Y` - 年（4位，如2026）
- `%m` - 月（01-12）
- `%d` - 日（01-31）
- `%H` - 时（00-23）
- `%M` - 分（00-59）
- `%S` - 秒（00-59）

**MongoDB版本**: 支持 MongoDB 3.6+

**示例**:
```javascript
import { expr } from 'monsqlize';

// 格式化为标准日期时间
const dateStrExpr = expr('DATE_TO_STRING(createdAt, "%Y-%m-%d %H:%M:%S")');

// MongoDB等价表达式
{
  $dateToString: {
    date: '$createdAt',
    format: '%Y-%m-%d %H:%M:%S'
  }
}

// 格式化日期显示
await collection('articles').aggregate([
  {
    $addFields: {
      publishDateStr: dateStrExpr,
      publishDateCN: expr('DATE_TO_STRING(publishAt, "%Y年%m月%d日")'),
      timeOnly: expr('DATE_TO_STRING(createdAt, "%H:%M:%S")')
    }
  }
]);
```

**使用场景**:
- 格式化日期显示
- 生成报表
- 导出数据
- API返回格式化日期

---

### DATE_FROM_STRING - 字符串解析 🆕 v1.1.0

**语法**: `DATE_FROM_STRING(dateString [, format])`

**说明**: 将字符串解析为日期对象

**参数**:
- `dateString` - 日期字符串字段或字面量
- `format` - 可选，格式模板（默认ISO 8601）

**MongoDB版本**: 支持 MongoDB 3.6+

**示例**:
```javascript
import { expr } from 'monsqlize';

// 解析ISO格式日期字符串
const parsedDateExpr = expr('DATE_FROM_STRING(dateString)');

// MongoDB等价表达式
{
  $dateFromString: {
    dateString: '$dateString'
  }
}

// 解析自定义格式
const customDateExpr = expr('DATE_FROM_STRING(dateStr, "%Y-%m-%d")');

// MongoDB等价表达式
{
  $dateFromString: {
    dateString: '$dateStr',
    format: '%Y-%m-%d'
  }
}

// 数据导入场景
await collection('imports').aggregate([
  {
    $addFields: {
      parsedDate: parsedDateExpr,
      birthDate: expr('DATE_FROM_STRING(birthDateStr, "%Y-%m-%d")')
    }
  }
]);
```

**使用场景**:
- 数据导入
- 解析文本日期
- 日期字段标准化
- 数据清洗

---

## 类型与逻辑函数 (5个)

### TYPE - 获取类型

**语法**: `TYPE(value)`

**说明**: 返回值的BSON类型

**示例**:
```javascript
const result = expr('TYPE(field)');

// MongoDB等价表达式
{ $type: '$field' }
```

---

### NOT - 逻辑非

**语法**: `NOT(expression)`

**说明**: 对表达式结果取反

**示例**:
```javascript
const result = expr('NOT(active)');

// MongoDB等价表达式
{ $not: ['$active'] }
```

---

### EXISTS - 存在性检查

**语法**: `EXISTS(field)`

**说明**: 检查字段是否存在（非null）

**示例**:
```javascript
const result = expr('EXISTS(email)');

// MongoDB等价表达式
{ $ne: ['$email', null] }
```

---

### IS_NUMBER - 数字类型检查

**语法**: `IS_NUMBER(value)`

**说明**: 检查值是否为数字类型

**示例**:
```javascript
const result = expr('IS_NUMBER(field)');

// MongoDB等价表达式
{ $eq: [{ $type: '$field' }, 'number'] }
```

---

### IS_ARRAY - 数组类型检查

**语法**: `IS_ARRAY(value)`

**说明**: 检查值是否为数组

**示例**:
```javascript
const result = expr('IS_ARRAY(tags)');

// MongoDB等价表达式
{ $isArray: '$tags' }
```

---

## 高级操作函数 (7个)

### REGEX - 正则匹配

**语法**: `REGEX(field, pattern)`

**说明**: 使用正则表达式匹配字符串

**参数**:
- `field` - 字段名
- `pattern` - 正则表达式模式

**示例**:
```javascript
const result = expr('REGEX(email, ".*@gmail\\\\.com$")');

// MongoDB等价表达式
{
  $regexMatch: {
    input: '$email',
    regex: '.*@gmail\\.com$'
  }
}
```

---

### MERGE_OBJECTS - 合并对象

**语法**: `MERGE_OBJECTS(obj1, obj2, ...)`

**说明**: 合并多个对象

**示例**:
```javascript
const result = expr('MERGE_OBJECTS(profile, settings)');

// MongoDB等价表达式
{ $mergeObjects: ['$profile', '$settings'] }
```

---

### TO_INT - 转换为整数

**语法**: `TO_INT(value)`

**说明**: 将值转换为整数

**示例**:
```javascript
const result = expr('TO_INT(stringValue)');

// MongoDB等价表达式
{ $toInt: '$stringValue' }
```

---

### TO_STRING - 转换为字符串

**语法**: `TO_STRING(value)`

**说明**: 将值转换为字符串

**示例**:
```javascript
const result = expr('TO_STRING(numericValue)');

// MongoDB等价表达式
{ $toString: '$numericValue' }
```

---

### OBJECT_TO_ARRAY - 对象转数组

**语法**: `OBJECT_TO_ARRAY(obj)`

**说明**: 将对象转换为键值对数组

**示例**:
```javascript
const result = expr('OBJECT_TO_ARRAY(metadata)');

// MongoDB等价表达式
{ $objectToArray: '$metadata' }

// 结果示例
// { key: 'name', value: 'John' }
// { key: 'age', value: 30 }
```

---

### ARRAY_TO_OBJECT - 数组转对象

**语法**: `ARRAY_TO_OBJECT(array)`

**说明**: 将键值对数组转换为对象

**示例**:
```javascript
const result = expr('ARRAY_TO_OBJECT(pairs)');

// MongoDB等价表达式
{ $arrayToObject: '$pairs' }
```

---

### SET_UNION - 集合并集

**语法**: `SET_UNION(array1, array2, ...)`

**说明**: 返回多个数组的并集（去重）

**示例**:
```javascript
const result = expr('SET_UNION(tags1, tags2)');

// MongoDB等价表达式
{ $setUnion: ['$tags1', '$tags2'] }
```

---

## 条件函数 (1个)

### SWITCH - 多条件判断

**语法**: `SWITCH(case1, result1, case2, result2, ..., default)`

**说明**: 类似switch-case的多条件判断

**示例**:
```javascript
const result = expr(`
  SWITCH(
    level === 1, "Bronze",
    level === 2, "Silver",
    level === 3, "Gold",
    "Unknown"
  )
`);

// MongoDB等价表达式
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

## 函数索引表

| 函数名 | 分类 | 说明 | 参数数量 |
|--------|------|------|---------|
| **字符串函数** ||||
| CONCAT | 字符串 | 字符串连接 | 2+ |
| UPPER | 字符串 | 转大写 | 1 |
| LOWER | 字符串 | 转小写 | 1 |
| TRIM | 字符串 | 去除首尾空格 | 1 |
| LTRIM | 字符串 | 去除左侧空格 | 1 |
| RTRIM | 字符串 | 去除右侧空格 | 1 |
| SUBSTR | 字符串 | 子字符串提取 | 3 |
| SUBSTR_CP | 字符串 | 子字符串提取（Unicode） | 3 |
| LENGTH | 字符串 | 字符串长度 | 1 |
| SPLIT | 字符串 | 字符串分割 | 2 |
| REPLACE | 字符串 | 字符串替换 | 3 |
| INDEX_OF_STR | 字符串 | 字符串查找 | 2 |
| **数学函数** ||||
| ABS | 数学 | 绝对值 | 1 |
| CEIL | 数学 | 向上取整 | 1 |
| FLOOR | 数学 | 向下取整 | 1 |
| ROUND | 数学 | 四舍五入 | 1 |
| SQRT | 数学 | 平方根 | 1 |
| POW | 数学 | 幂运算 | 2 |
| **数组函数** ||||
| SIZE | 数组 | 数组大小 | 1 |
| FIRST | 数组 | 第一个元素 | 1 |
| LAST | 数组 | 最后一个元素 | 1 |
| SLICE | 数组 | 数组切片 | 3 |
| ARRAY_ELEM_AT | 数组 | 获取数组元素 | 2 |
| IN | 数组 | 包含检查 | 2 |
| FILTER | 数组 | 数组过滤 | 3 |
| MAP | 数组 | 数组映射 | 3 |
| INDEX_OF | 数组 | 数组查找 | 2 |
| CONCAT_ARRAYS | 数组 | 数组连接 | 2+ |
| **聚合函数** ||||
| SUM | 聚合 | 求和/计数 | 0-1 |
| AVG | 聚合 | 平均值 | 1 |
| MAX | 聚合 | 最大值 | 1 |
| MIN | 聚合 | 最小值 | 1 |
| COUNT | 聚合 | 计数 | 0 |
| PUSH | 聚合 | 构建数组 | 1 |
| ADD_TO_SET | 聚合 | 构建唯一数组 | 1 |
| **日期函数** ||||
| YEAR | 日期 | 获取年份 | 1 |
| MONTH | 日期 | 获取月份 | 1 |
| DAY_OF_MONTH | 日期 | 获取日 | 1 |
| HOUR | 日期 | 获取小时 | 1 |
| MINUTE | 日期 | 获取分钟 | 1 |
| SECOND | 日期 | 获取秒 | 1 |
| DATE_ADD 🆕 | 日期 | 日期加法 | 3 |
| DATE_SUBTRACT 🆕 | 日期 | 日期减法 | 3 |
| DATE_DIFF 🆕 | 日期 | 日期差值 | 3 |
| DATE_TO_STRING 🆕 | 日期 | 日期格式化 | 2 |
| DATE_FROM_STRING 🆕 | 日期 | 字符串解析 | 1-2 |
| **类型/逻辑** ||||
| TYPE | 类型 | 获取类型 | 1 |
| NOT | 逻辑 | 逻辑非 | 1 |
| EXISTS | 逻辑 | 存在性检查 | 1 |
| IS_NUMBER | 类型 | 数字类型检查 | 1 |
| IS_ARRAY | 类型 | 数组类型检查 | 1 |
| **高级操作** ||||
| REGEX | 高级 | 正则匹配 | 2 |
| MERGE_OBJECTS | 高级 | 合并对象 | 2+ |
| TO_INT | 高级 | 转整数 | 1 |
| TO_STRING | 高级 | 转字符串 | 1 |
| OBJECT_TO_ARRAY | 高级 | 对象转数组 | 1 |
| ARRAY_TO_OBJECT | 高级 | 数组转对象 | 1 |
| SET_UNION | 高级 | 集合并集 | 2+ |
| **条件** ||||
| SWITCH | 条件 | 多条件判断 | 3+ |

---

## 使用示例

### 示例1：用户分类

```javascript
import { expr } from 'monsqlize';

// 根据年龄分类用户
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

### 示例2：计算折扣价格

```javascript
// 复杂价格计算
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

### 示例3：数据聚合

```javascript
// 按月统计订单
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

### 示例4：数组处理

```javascript
// 过滤活跃标签
const activeTagsExpr = expr(
  'FILTER(tags, tag, tag.active === true)'
);

// 映射标签名称
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

### 示例5：字符串处理

```javascript
// 清理和格式化email
const cleanEmailExpr = expr(
  'LOWER(TRIM(email))'
);

// 提取域名
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

## 性能建议

### 1. 使用索引

```javascript
// 创建索引支持表达式查询
await collection('users').createIndex({ age: 1, status: 1 });

// 使用表达式时尽量利用索引字段
const result = expr('age >= 18 && status === "active"');
```

### 2. 避免复杂嵌套

```javascript
// ❌ 过度嵌套
const bad = expr(
  'UPPER(CONCAT(SUBSTR(name, 0, 1), LOWER(SUBSTR(name, 1, LENGTH(name)))))'
);

// ✅ 分步处理
await collection('users').aggregate([
  { $addFields: { firstChar: expr('SUBSTR(name, 0, 1)') } },
  { $addFields: { restChars: expr('LOWER(SUBSTR(name, 1, LENGTH(name)))') } },
  { $addFields: { formatted: expr('CONCAT(firstChar, restChars)') } }
]);
```

### 3. 利用缓存

```javascript
// 表达式编译结果会自动缓存
const cachedExpr = expr('UPPER(name)');

// 相同表达式会使用缓存结果
for (let i = 0; i < 1000; i++) {
  await collection('users').aggregate([
    { $addFields: { upperName: cachedExpr } }
  ]);
}
```

### 4. 合理使用 $match

```javascript
// ✅ 先$match再$addFields，减少处理量
await collection('orders').aggregate([
  { $match: { status: 'completed' } },  // 先过滤
  {
    $addFields: {
      discount: expr('ROUND(amount * 0.1)')
    }
  }
]);
```

---

## 相关文档

- [聚合操作文档](./aggregate.md)
- [统一表达式系统](./chaining-api.md)
- [查询优化指南](./explain.md)

---

## 补充说明

### API 别名

`expr` 是 `createExpression` 的简写别名。两者完全等价，推荐使用简短的 `expr`：

```javascript
import { expr, createExpression } from 'monsqlize';

// ✅ 推荐：简洁明了
const shortForm = expr('UPPER(name)');

// ✅ 也支持：完整名称（为了向后兼容）
const longForm = createExpression('UPPER(name)');

// 两者完全等价
console.log(shortForm === longForm);  // false（不同实例）
// 但编译结果相同
```
