# Saga 分布式事务

> **弃用兼容页**：monSQLize 仍保留 Saga API 以兼容老调用方，但 Saga 编排不再作为 monSQLize 推荐能力。新的业务流程请优先放到应用/框架层（例如 VextJS runtime）处理。

monSQLize 保留 Saga API 作为 legacy 兼容能力。新的工作流请把编排、持久化、恢复和对账放在应用/框架层。

## 什么是 Saga

Saga 是一种分布式事务模式，通过将长事务分解为多个本地事务，每个本地事务都有对应的补偿操作。当某个步骤失败时，通过逆序执行补偿操作来撤销已完成的步骤。

### 核心特性

- **步骤编排兼容**：既有代码仍可通过 legacy API 协调多个本地操作。
- **自动补偿尝试**：后续步骤失败时，会对已完成步骤逆序执行补偿。
- **不受 MongoDB 单事务时间限制**：步骤不运行在一个长 MongoDB 事务中。
- **Redis 定义共享**：Redis 模式共享 Saga 定义，不共享执行状态。
- **执行日志**：既有日志钩子仍可用于诊断。

## 超时与重试契约

- `SagaDefinition.timeout` 是每个 step 的默认超时；`step.timeout` 可覆盖当前 step。它不是整个 Saga 共用的一条总截止时间。
- step 超时后以 `OPERATION_TIMEOUT` 失败、触发 `ctx.signal` abort，并且不会重试；`retries` 只处理普通失败。
- JavaScript 无法强制终止 Promise。可取消工作必须消费 `ctx.signal`，外部副作用必须保持幂等，因为忽略 signal 的旧 step 仍可能在超时结果返回后完成。

---

## 使用场景

### 适用场景

1. **跨服务事务**
   ```
   A 服务（订单） → B 服务（库存） → C 服务（支付）
   ```

2. **第三方 API 集成**
   ```
   创建订单 → Stripe 扣款 → 发送邮件
   ```

3. **长时间流程**
   ```
   超过 60 秒的复杂业务流程
   ```

### 不适用场景

1. **单服务单库操作** → 使用 `withTransaction`
2. **外部 API 只读取** → 使用 `withTransaction`

---

## 快速开始

### 安装

Saga 功能已内置在当前 `monsqlize` 包中，无需额外安装。

```bash
npm install monsqlize
```

### 基本使用

```javascript
import MonSQLize from 'monsqlize';

// 初始化
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/mydb' }
});

await msq.connect();

// 定义 Saga
msq.defineSaga({
    name: 'create-order-with-payment',
    steps: [
        {
            name: 'create-order',
            execute: async (ctx) => {
                // 创建订单
                const order = await createOrder(ctx.data);
                ctx.set('orderId', order.id);
                return order;
            },
            compensate: async (ctx) => {
                // 取消订单
                const orderId = ctx.get('orderId');
                await cancelOrder(orderId);
            }
        },
        {
            name: 'charge-payment',
            execute: async (ctx) => {
                // 扣款
                const charge = await stripe.charges.create({
                    amount: ctx.data.amount,
                    source: ctx.data.paymentToken
                });
                ctx.set('chargeId', charge.id);
                return charge;
            },
            compensate: async (ctx) => {
                // 退款
                const chargeId = ctx.get('chargeId');
                await stripe.refunds.create({ charge: chargeId });
            }
        }
    ]
});

// 执行 Saga
try {
    const result = await msq.executeSaga('create-order-with-payment', {
        userId: 'user123',
        amount: 9900,
        paymentToken: 'tok_visa'
    });
    
    console.log('订单创建成功:', result.sagaId);
} catch (error) {
    console.error('订单创建失败:', error.message);
}
```

---

## API 文档

### defineSaga(config)

定义一个 Saga。

**参数**：
- `config.name` (string): Saga 名称，全局唯一
- `config.steps` (Array): 步骤列表
- `config.timeout` (number，可选): 每个 step 的默认超时毫秒数

**步骤配置**：
```javascript
{
    name: 'step-name',              // 步骤名称
    execute: async (ctx) => { },    // 执行函数；可取消工作需消费 ctx.signal
    compensate: async (ctx, result) => { }, // 补偿函数（可选）
    timeout: 5000,                  // 可选的当前 step 超时覆盖
    retries: 2                      // 只重试普通失败，超时不重试
}
```

**返回值**：SagaDefinition 实例

**示例**：
```javascript
msq.defineSaga({
    name: 'my-saga',
    steps: [
        {
            name: 'step1',
            execute: async (ctx) => {
                // 正向操作
                return { success: true };
            },
            compensate: async (ctx, result) => {
                // 补偿操作
            }
        }
    ]
});
```

---

### executeSaga(name, data)

执行 Saga。

**参数**：
- `name` (string): Saga 名称
- `data` (Object): 执行数据，可通过 `ctx.data` 访问

**返回值**：Promise<Object>

**成功返回**：
```javascript
{
    success: true,
    executionId: 'saga_xxx',
    sagaId: 'saga_xxx',
    sagaName: 'my-saga',
    completedSteps: ['reserve-inventory', 'create-payment', 'create-order'],
    completedStepCount: 3,
    completedStepNames: ['reserve-inventory', 'create-payment', 'create-order'],
    compensatedSteps: [],
    result: { orderId: 'order_123' },
    duration: 123  // 毫秒
}
```

**失败返回**：
```javascript
{
    success: false,
    executionId: 'saga_xxx',
    sagaId: 'saga_xxx',
    sagaName: 'my-saga',
    completedSteps: ['reserve-inventory', 'create-payment'],
    completedStepCount: 2,
    completedStepNames: ['reserve-inventory', 'create-payment'],
    compensatedSteps: ['create-payment', 'reserve-inventory'],
    error: new Error('Error message'),
    errorMessage: 'Error message',
    duration: 123,
    compensation: {
        success: true,
        results: [...]
    }
}
```

---

### listSagas()

列出所有已定义的 Saga。

**返回值**：string[]

```javascript
const sagas = msq.listSagas();
console.log('已定义的 Saga:', sagas);
// ['create-order', 'update-inventory', ...]
```

---

### getSagaStats()

获取 Saga 统计信息。

**返回值**：Object

```javascript
const stats = msq.getSagaStats();
console.log(stats);
// {
//   totalExecutions: 100,
//   successfulExecutions: 95,
//   failedExecutions: 5,
//   compensatedExecutions: 5,
//   successRate: '95.00%',
//   storageMode: 'Redis'  // 或 '内存'
// }
```

---

## SagaContext API

在 `execute` 和 `compensate` 函数中可以访问 SagaContext。

### ctx.data

获取执行数据（只读）。

```javascript
execute: async (ctx) => {
    const userId = ctx.data.userId;
    const amount = ctx.data.amount;
}
```

### ctx.set(key, value)

保存自定义数据，用于步骤间传递。**支持任何类型的值**（字符串、对象、数组、数字等）。

```javascript
execute: async (ctx) => {
    // ✅ 字符串
    ctx.set('orderId', 'ORDER123');
    
    // ✅ 对象
    ctx.set('orderData', {
        orderId: 'ORDER123',
        amount: 9900,
        items: [{ sku: 'SKU001', quantity: 2 }]
    });
    
    // ✅ 数组
    ctx.set('itemIds', ['id1', 'id2', 'id3']);
    
    // ✅ 数字
    ctx.set('totalAmount', 9900);
}
```

### ctx.get(key)

获取自定义数据。返回值类型与存入时一致。

```javascript
compensate: async (ctx) => {
    // 获取字符串
    const orderId = ctx.get('orderId');
    await cancelOrder(orderId);
    
    // 获取对象
    const orderData = ctx.get('orderData');
    console.log('订单金额:', orderData.amount);
    
    // 获取数组
    const itemIds = ctx.get('itemIds');
    for (const id of itemIds) {
        await releaseItem(id);
    }
}
    await cancelOrder(orderId);
}
```

### ctx.executionId

获取 Saga 唯一标识。

```javascript
execute: async (ctx) => {
    console.log('Saga ID:', ctx.executionId);
}
```

---

## 最佳实践

### 1. 明确定义补偿操作

每个有副作用的步骤都应该有补偿操作。

```javascript
// ✅ 推荐
{
    name: 'create-order',
    execute: async (ctx) => {
        const order = await createOrder(ctx.data);
        ctx.set('orderId', order.id);
        return order;
    },
    compensate: async (ctx) => {
        const orderId = ctx.get('orderId');
        await cancelOrder(orderId);
    }
}

// ❌ 不推荐：有副作用但没有补偿
{
    name: 'create-order',
    execute: async (ctx) => {
        return await createOrder(ctx.data);
    }
    // 没有 compensate
}
```

---

### 2. 保存关键信息到上下文

补偿操作需要的信息应该在 execute 中保存。**支持保存完整对象，简化代码。**

```javascript
// ✅ 推荐：保存完整对象
execute: async (ctx) => {
    const result = await createOrder(ctx.data);
    
    // 保存完整的订单对象，补偿时可以访问所有信息
    ctx.set('order', result);
    
    return result;
},
compensate: async (ctx) => {
    // 使用保存的完整对象
    const order = ctx.get('order');
    await cancelOrder(order.id, {
        reason: 'saga-compensation',
        amount: order.amount,
        items: order.items
    });
}

// ✅ 也可以：保存单个字段
execute: async (ctx) => {
    const result = await doSomething();
    
    ctx.set('resourceId', result.id);
    ctx.set('amount', result.amount);
    
    return result;
},
compensate: async (ctx) => {
    const resourceId = ctx.get('resourceId');
    const amount = ctx.get('amount');
    
    await revertOperation(resourceId, amount);
}
```

---

### 3. 幂等性设计

补偿操作应该是幂等的（可重复执行）。

```javascript
compensate: async (ctx) => {
    const orderId = ctx.get('orderId');
    
    // ✅ 推荐：检查状态
    const order = await getOrder(orderId);
    if (order.status !== 'cancelled') {
        await cancelOrder(orderId);
    }
    
    // ❌ 不推荐：直接执行
    // await cancelOrder(orderId);  // 可能重复取消
}
```

---

### 4. 错误处理

补偿失败应该记录详细日志。

```javascript
compensate: async (ctx) => {
    try {
        await doCompensation();
    } catch (error) {
        // Saga 会自动记录错误
        // 但你可以添加额外的日志
        console.error('[Compensation Error]', {
            sagaId: ctx.sagaId,
            error: error.message
        });
        throw error;  // 重新抛出
    }
}
```

---

### 5. 单进程模式 vs Redis 模式

**单进程模式**（默认）：

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: '...' },
    cache: { enabled: false }  // 或不配置 cache
});
```

**Redis 模式**（多进程）：

```javascript
const MonSQLize = require('monsqlize');

const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: '...' },
    cache: MonSQLize.createRedisCacheAdapter('redis://localhost:6379')
});

// ⚠️ 重要：每个进程启动时都需要调用 defineSaga()
msq.defineSaga({
    name: 'my-saga',
    steps: [...]
});
```

---

## 常见问题

### Q1: Saga 和 withTransaction 有什么区别？

| 维度 | withTransaction | Saga |
|------|----------------|------|
| **适用场景** | 单库操作 | 跨服务操作 |
| **回滚方式** | MongoDB 自动回滚 | 手动补偿 |
| **时间限制** | 60秒 | 无限制 |
| **外部 API** | 不支持回滚 | 支持补偿 |

---

### Q2: 补偿失败怎么办？

补偿失败会被记录在返回结果中：

```javascript
const result = await msq.executeSaga('my-saga', data);

if (!result.success && !result.compensation.success) {
    console.error('补偿失败，需要人工介入');
    console.error('失败的步骤:', result.compensation.results);
}
```

---

### Q3: 如何调试 Saga？

启用日志：

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: '...' },
    logger: console  // 传入 LoggerLike 实现
});
```

---

### Q4: 可以嵌套 Saga 吗？

可以，但不推荐。建议将复杂流程拆分为多个独立的 Saga。

---

### Q5: 如何测试 Saga？

使用模拟服务：

```javascript
// 模拟外部服务
const mockOrderService = {
    create: async (data) => ({ orderId: 'TEST_ORDER' }),
    cancel: async (orderId) => ({ cancelled: true })
};

// 定义测试 Saga
msq.defineSaga({
    name: 'test-saga',
    steps: [
        {
            name: 'create-order',
            execute: async (ctx) => {
                return await mockOrderService.create(ctx.data);
            },
            compensate: async (ctx) => {
                const orderId = ctx.get('orderId');
                await mockOrderService.cancel(orderId);
            }
        }
    ]
});

// 执行测试
const result = await msq.executeSaga('test-saga', {});
assert(result.success === true);
```

---

## 示例

完整示例请参考：
- [Saga 可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/saga.ts)
