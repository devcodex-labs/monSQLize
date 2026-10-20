# ObjectId 转换诊断说明

## Logger trace ID

结构化 `Logger` 默认输出当前活动 trace ID；`enableTraceId: false` 只省略该字段，不关闭 trace context 传递。`Logger.generateTraceId()` 同时支持 CJS 与纯 ESM 消费者。`new Logger(sink, options)`、`Logger.create(sink, options)` 接收相同日志选项。

`insertMany` 在驱动写入成功后，即使诊断 warning 失败，也不会替换成功结果或跳过写缓存失效。慢查询存储的错误处理策略是另一项契约。

## 当前行为

当前运行时默认按值转换 ObjectId。查询条件、写入载荷和聚合管道在递归遍历到合法 24 位十六进制字符串时，都可能转换为 ObjectId。

请把 `autoConvertObjectId` 作为实例级转换开关使用：

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017' },
  autoConvertObjectId: true
});
```

如果某条路径必须保留任意 24 位十六进制字符串，可以设置为 `false`，也可以使用 `{ enabled: false }`。如果只是特定字段需要保留字符串，可以使用 `excludeFields`、`{ fieldName: false }` 或 `maxDepth`。

## 如何验证转换

因为转换器不会输出转换日志，建议通过以下方式验证：

1. 编写集成测试，写入或查询已知值后检查实际存储或匹配结果。
2. 在应用测试环境使用 MongoDB command monitoring，检查发送给驱动的命令。
3. 在适配器单元测试中直接调用转换器验证行为。

聚焦检查示例：

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

## 配置参考

| 值 | 行为 |
| --- | --- |
| `true` | 启用自动转换。MongoDB 适配器默认启用。 |
| `false` | 禁用当前实例的自动转换。 |
| `{ enabled: true }` | 显式启用自动转换。 |
| `{ enabled: false }` | 显式禁用自动转换。 |
| `{ excludeFields: ['token'] }` | 让匹配的字段路径或字段名保持字符串。 |
| `{ token: false }` | 让指定字段名或路径保持字符串，同时保留其他位置的按值转换。 |
| `{ maxDepth: 3 }` | 超过指定递归深度后停止转换。 |

## 常见问题

### 可以启用 ObjectId 转换日志吗？

不可以。当前转换器没有转换日志输出，也没有 `silent` / `verbose` 控制项。

### 可以排除特定字段不转换吗？

可以。如果交易哈希、幂等键、签名、外部支付单号等业务值可能长得像 ObjectId，请使用 `excludeFields` 或 `{ fieldName: false }`。只有当整个实例都必须完全保留字符串时，才使用 `autoConvertObjectId: false`。

### 转换是否基于字段白名单？

不是。当前稳定行为按值判断。只要递归遍历到合法 ObjectId 形态的字符串，它就可能被转换，不论字段名是什么。
