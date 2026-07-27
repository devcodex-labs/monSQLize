# 失败恢复示例

这些示例展示 monSQLize 在常见运行时失败与恢复路径中的行为。你可以先运行这些示例，确认事务回滚、同步失败恢复、锁超时和连接池 fallback 的实际效果，再把同类模式用于自己的应用。

## 示例总览

| 场景 | 示例 | 关注点 |
|------|------|--------|
| 事务回滚 | [transaction-rollback.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction-rollback.ts) | 事务中途抛错后，数据保持回滚后的状态 |
| Sync target 失败恢复 | [sync-target-failure.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync-target-failure.ts) | `errorCount`、`syncedCount` 和 target stats 展示失败与恢复 |
| 锁竞争 / 超时 | [lock-timeout.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/lock-timeout.ts) | `tryAcquireLock()` 返回 `null`、`acquireLock()` 超时，释放后可再次获得锁 |
| Pool fallback / recovery | [pool-fallback.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool-fallback.ts) | analytics 池不可用时回退到 primary，恢复后重新接管 analytics 读流量 |

## 运行示例

```bash
npm run test:examples
```

`npm run test:examples` 会构建包、编译 TypeScript 示例、启动需要的本地 MongoDB memory server，并运行当前示例清单。

示例编译完成后，也可以单独运行某个恢复示例：

```bash
node .generated/examples-dist/examples/docs/transaction-rollback.js
node .generated/examples-dist/examples/docs/sync-target-failure.js
node .generated/examples-dist/examples/docs/lock-timeout.js
node .generated/examples-dist/examples/docs/pool-fallback.js
```

## 观察重点

- **事务回滚**：失败事务中的写入不会在回滚后可见。
- **同步恢复**：失败计数上升，恢复后同步继续推进，target stats 更新。
- **锁超时**：锁被占用时按预期失败，释放后后续尝试成功。
- **连接池 fallback**：analytics 不可用时读请求切到 fallback，恢复后重新使用 analytics。
