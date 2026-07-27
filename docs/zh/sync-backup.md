# Change Stream 同步

## 概述

Change Stream 同步基于 MongoDB 原生 Change Stream 机制，把通过过滤的变更事件分发给一个或多个 target。它适合备份库、投影表、缓存失效回调和其他异步 CDC 工作流。

### 核心特性

- ✅ **异步 CDC**：基于 MongoDB Change Stream，延迟取决于 MongoDB、网络与 target 负载
- ✅ **解耦设计**：主库写入不会等待 target apply 回调
- ✅ **断点续传**：匹配的目标全部同步成功后保存 Resume Token，重启后从最近一次成功持久化的 token 继续
- ✅ **多目标支持**：同时同步到多个备份库
- ✅ **数据过滤**：自定义过滤逻辑
- ✅ **数据转换**：支持脱敏、字段转换
- ✅ **生命周期可观测**：同步统计暴露运行状态与错误计数，便于监控和重启
- ✅ **健康检查**：为托管 target 配置健康检查

---

## ⚠️ 前提条件

### 必须满足

1. **MongoDB Replica Set** 🔴
   ```bash
   # 检查是否为 Replica Set
   rs.status()
   ```

2. **MongoDB 版本 >= 4.0** 🔴

3. **用户权限** 🔴
   ```javascript
   // 需要 changeStream 权限
   {
       resource: { db: "dbName", collection: "" },
       actions: ["changeStream", "find"]
   }
   ```

---

## 🚀 快速开始

### 基础配置

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    config: {
        uri: 'mongodb://localhost:27017/main',
        replicaSet: 'rs0'  // 🔴 必须
    },
    
    // 🆕 同步配置
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-main',
                uri: 'mongodb://backup:27017/backup',
                collections: ['users', 'orders']
            }
        ]
    }
});

await msq.connect();

// 正常使用，自动同步
await msq.collection('users').insertOne({ name: 'Alice' });
// ✅ 自动同步到 backup-main

await msq.close();
```

---

## 📖 配置选项

### sync 配置

| 选项 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | boolean | ✅ | - | 是否启用同步 |
| `targets` | Array | ✅ | - | 备份目标数组 |
| `resumeToken` | Object | ❌ | - | Resume Token 配置 |
| `idempotency` | Object | ❌ | disabled | 可选的 per-target 重放幂等门禁 |
| `filter` | Function | ❌ | - | 事件过滤函数 |
| `transform` | Function | ❌ | - | 数据转换函数 |

`transform` 是 manager 级转换钩子。每个通过过滤的 change event 只会在分发到匹配 targets 前执行一次，因此所有 target 会收到同一个转换后的 document。Delete 事件通常没有 `fullDocument`；自定义 target 应能处理 `document === undefined`，并使用 `event.documentKey` 完成删除处理。

### targets[].配置

| 选项 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 目标名称（唯一） |
| `uri` | string | 条件必需 | MongoDB URI；每个 target 必须提供 `uri`、`pool` 或 `apply` 之一 |
| `pool` | string | 条件必需 | 命名连接池 target |
| `apply` | Function | 条件必需 | 自定义 target 回调 `(event, document, context) => Promise<void>` |
| `collections` | Array | ❌ | 同步的集合，`['*']` 表示全部 |
| `healthCheck` | Object | ❌ | 健康检查配置 |

### resumeToken 配置

| 选项 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| `storage` | string | ❌ | `'file'` | 存储类型：`'file'` 或 `'redis'` |
| `path` | string | ❌ | `./.sync-resume-token` | 文件路径（文件模式） |
| `redis` | Object | ❌ | - | Redis 实例（Redis 模式） |
| `strictLoad` | boolean | ❌ | 同 `strictSave` | 将不可读取或损坏的已保存 token 视为致命错误，而不是按无 token 启动 |
| `strictSave` | boolean | ❌ | `true` | 将 token 保存失败视为致命错误，避免 CDC 在 token 未持久化时继续推进 |
| `saveRetries` | number | ❌ | `0` | strict token save 失败前的重试次数 |
| `saveRetryDelayMs` | number | ❌ | `100` | token 保存重试间隔（毫秒） |

Resume Token 持久化默认是 strict。文件模式会先写入同目录临时文件、fsync、把上一份 token 备份为 `<path>.bak`，再通过原子 rename 替换正式文件。启动时也会校验已保存 token：`strictLoad` 为 true 时，损坏 token 会快速失败，而不是静默按无 resume token 启动。匹配的 target 全部成功应用事件后，monSQLize 会先保存该事件的 resume token；只有保存成功后才推进 `syncedCount`。如果 token 保存在配置的重试后仍失败，或任一匹配 target 应用事件失败，manager 会记录错误、关闭当前 change stream、将 `isRunning` 标记为 `false`，并停止处理后续排队事件。这是 at-least-once 契约，不是 exactly-once：target apply 成功但 token 保存前崩溃时，同一事件可能重放。只有兼容旧 best-effort token 存储行为时才设置 `strictSave: false` 与 `strictLoad: false`；此时进程重启后可能重放已应用事件，或在旧 token 损坏时按无 token 启动。内置 MongoDB target 是幂等的（`replaceOne(..., { upsert: true })` / `deleteOne()`）；自定义 `apply` target 仍建议按 change event `_id` 做幂等或去重。

### idempotency 配置

`sync.idempotency` 是可选能力，默认关闭。启用后，manager 默认根据 change event `_id` 为每个 target 生成幂等 key；也可以通过 `keyBuilder` 自定义。key 已存在时，该 target 会被跳过，并在所有 eligible targets 都被处理后继续保存 resume token。跨进程重启保护需要传入 durable `store`；未传 store 时的内存 fallback 只能保护同进程内重复投递。`markMode: 'success'` 在 `apply` 成功后记录；`markMode: 'start'` 会在 `apply` 前记录，它能降低 unknown-success 重复写风险，但 marker 写入后若 apply 失败，runtime replay 可能会跳过该 target，因此只适用于 target 自身有 durable 幂等与恢复路径的场景。

---

## 💡 使用示例

### 示例1：多备份目标

```javascript
{
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-asia',
                uri: 'mongodb://asia:27017/backup',
                collections: ['*']
            },
            {
                name: 'backup-us',
                uri: 'mongodb://us:27017/backup',
                collections: ['*']
            }
        ]
    }
}
```

### 示例2：数据过滤

```javascript
{
    sync: {
        enabled: true,
        targets: [...],
        
        // 只同步 active 用户
        filter: (event) => {
            if (event.ns?.coll === 'users') {
                return event.fullDocument?.status === 'active';
            }
            return true;
        }
    }
}
```

### 示例3：数据脱敏

```javascript
{
    sync: {
        enabled: true,
        targets: [...],
        
        // 删除敏感字段
        transform: (doc) => {
            delete doc.password;
            delete doc.ssn;
            return doc;
        }
    }
}
```

### 示例4：Redis Resume Token

```javascript
const Redis = require('ioredis');
const redis = new Redis();

{
    sync: {
        enabled: true,
        targets: [...],
        resumeToken: {
            storage: 'redis',
            redis: redis,
            strictSave: true,
            saveRetries: 3,
            saveRetryDelayMs: 100
        }
    }
}
```

---

## 📊 性能影响

| 写入 QPS | 主库 CPU | 主库内存 | 网络带宽 | 同步延迟 |
|---------|---------|---------|---------|---------|
| 100 | +0.5% | +10MB | 1MB/s | 10-50ms |
| 1000 | +1% | +20MB | 10MB/s | 50-200ms |
| 5000 | +2% | +50MB | 50MB/s | 200-500ms |

---

## 🔧 API

### 获取统计信息

```javascript
const stats = msq.getSyncStats();
console.log(stats);
// {
//   isRunning: true,
//   eventCount: 1234,
//   syncedCount: 1230,
//   errorCount: 4,
//   startTime: 2026-01-17T...,
//   lastEventTime: 2026-01-17T...,
//   lastError: null,
//   tokenSaveErrorCount: 0,
//   lastTokenSaveError: null,
//   targets: [...]
// }
```

### 手动停止同步

```javascript
await msq.stopSync();
```

### 手动启动同步

```javascript
await msq.startSync();
```

---

## ❓ 常见问题

### Q1: 提示 "Change Stream 不可用"

**原因**: MongoDB 不是 Replica Set

**解决**:
```bash
# 1. 检查拓扑
rs.status()

# 2. 如果是单节点，转为 Replica Set
rs.initiate()
```

### Q2: 同步有延迟？

**原因**: 网络延迟、备份库性能

**解决**:
1. 检查网络延迟：`ping backup-host`
2. 检查备份库性能：`db.serverStatus()`
3. 减少同步的集合数量

### Q3: Resume Token 丢失怎么办？

**影响**: 重启后从当前时间开始同步，丢失中间数据

**解决**:
1. 使用 Redis 存储 Resume Token
2. 定期备份 Resume Token 文件
3. 手动全量同步一次

### Q4: 如何处理同步失败？

**自动处理**:
- 已经成功应用该事件的 target 不会回滚，但任一 target 失败都会在 resume token 推进前停止 manager
- Resume Token 保存失败会在推进 token 前停止 sync manager
- Change Stream driver 错误与意外 stream close 会记录日志并体现在 stats 中；生产应监控 `isRunning`、`errorCount` 与 `lastError`，必要时由进程管理器或应用重启 manager/runtime

**手动处理**:
```javascript
// 查看错误统计
const stats = msq.getSyncStats();
console.log(stats.errorCount);
console.log(stats.lastError);
console.log(stats.targets[0].lastError);
```

---

## 🛡️ 最佳实践

### 1. 生产环境配置

```javascript
{
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-main',
                uri: 'mongodb://backup:27017/backup',
                collections: ['*'],
                healthCheck: {
                    enabled: true,
                    interval: 30000,  // 30秒
                    timeout: 5000,
                    retries: 3
                }
            }
        ],
        resumeToken: {
            storage: 'redis',  // 使用 Redis
            redis: redisInstance
        }
    }
}
```

### 2. 监控和告警

```javascript
// 定期检查统计
setInterval(() => {
    const stats = msq.getSyncStats();
    
    if (stats.errorCount > 100) {
        // 发送告警
        sendAlert('同步错误过多');
    }
    
    if (!stats.isRunning) {
        // 发送告警
        sendAlert('同步已停止');
    }
}, 60000);
```

### 3. 优雅关闭

```javascript
process.on('SIGTERM', async () => {
    console.log('收到 SIGTERM，优雅关闭...');
    await msq.close();
    process.exit(0);
});
```

---

## 更多资源

- [示例代码](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync.ts)
- [MongoDB Change Streams 官方文档](https://www.mongodb.com/docs/manual/changeStreams/)
- [多连接池配置文档](./multi-pool.md)
