# 多连接池健康检查机制详解

manager 负责健康检查调度。ping 超时后，在底层操作真正 settle 前仍占用在途位置，防止对同一客户端重叠探测。达到配置失败阈值才进入 down，此前公开状态为 degraded；成功完成的检查恢复 up。停止、移除及替换均隔离迟到结果。自定义 ping 永不 settle 会阻止该客户端后续探测；关闭撤销其回写资格，不无限等待。

## 健康检查机制概述

### 工作原理

健康检查器（HealthChecker）定期对所有连接池执行健康检查，发现问题后会自动标记连接池状态，并触发故障转移。

```text
┌─────────────────────────────────────────────────────────┐
│              健康检查循环（每 5 秒）                       │
└─────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────┴─────────────────┐
        │                                    │
   [连接池1]                            [连接池2]
        │                                    │
        ↓                                    ↓
    执行 ping                             执行 ping
        │                                    │
    ┌───┴───┐                            ┌───┴───┐
    │  成功  │                            │  失败  │
    └───┬───┘                            └───┬───┘
        │                                    │
        ↓                                    ↓
   状态: up                           连续失败 +1
                                              │
                                         ≥ 3 次？
                                              │
                                              ↓
                                         状态: down
                                              │
                                              ↓
                                      🔔 触发告警
```

### 健康状态

| 状态 | 含义 | selectPool 行为 | 恢复方式 |
|------|------|----------------|---------|
| **up** | 健康 | ✅ 正常使用 | - |
| **degraded** | 健康检查失败但尚未达到 down 阈值 | ⚠️ 仍可选择，需要重点监控 | 健康检查成功后恢复为 `up`，再次失败后可能变为 `down` |
| **down** | 故障 | ❌ 跳过该池，使用其他健康池 | 健康检查成功后自动恢复 |

---

## 问题发现机制

### 1. 健康检查自动发现

**检查方法**: 使用 MongoDB 的 `db.admin().ping()` 命令

**触发条件**:
- 定期检查（默认每 5 秒）
- 超时时间（默认 3 秒）
- 连续失败阈值（默认 3 次）

**公开 API 示例**:
```javascript
const manager = new ConnectionPoolManager();

await manager.addPool({
    name: 'primary',
    uri: 'mongodb://localhost:27017/main',
    role: 'primary',
    healthCheck: {
        enabled: true,
        interval: 5000,
        timeout: 3000,
        retries: 3,
    },
});

manager.startHealthCheck('primary');

const health = manager.getHealthStatus();
console.log(health.primary.status); // 'up' | 'degraded' | 'down'
```

### 2. selectPool 时发现

**触发时机**: 当 selectPool 尝试使用某个连接池时

**发现方式**:
```javascript
try {
    const pool = manager.selectPool('read');
    const users = await pool.collection(undefined, 'users').find({}).toArray();
    console.log(users);
} catch (error) {
    if (error.message.includes('No available connection pool')) {
        logger.error('[CRITICAL] 所有连接池不可用，服务无法继续提供');
    }
    throw error;
}
```

### 3. 实际使用时发现

**触发时机**: 执行查询时连接失败

**处理方式**:
```javascript
// 用户代码中捕获错误
try {
    const pool = manager.selectPool('read');
    const data = await pool.collection('users').find({}).toArray();
} catch (error) {
    // 🔔 记录错误并告警
    logger.error('查询失败', { error, poolName: pool?.name });
    
    // 查询公开健康状态，再决定是否告警或重试
    const health = manager.getPoolHealth();
    logger.warn('当前连接池健康状态', health);
}
```

---

## 问题处理流程

### 自动处理流程

```text
问题发现
    ↓
┌──────────────┐
│ 状态: down   │
└──────────────┘
    ↓
┌──────────────────────────────┐
│ selectPool 自动跳过该连接池    │
└──────────────────────────────┘
    ↓
┌──────────────────────────────┐
│ 从其他健康池中选择             │
└──────────────────────────────┘
    ↓
┌──────────────────────────────┐
│ 如果没有健康池，执行降级策略    │
└──────────────────────────────┘
    ↓
    ├─ readonly: 只允许读操作
    ├─ secondary: 使用副本池
    └─ error: 抛出错误
```

### 降级策略示例

```javascript
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly',  // 主库故障时允许只读
        retryDelay: 1000,
        maxRetries: 3
    }
});

// 主库故障时的行为
try {
    const pool = manager.selectPool('write');  // 写操作
    // 如果主库 down：
    // - readonly 策略：抛出错误（不允许写）
    // - secondary 策略：使用副本（可能写入副本）
    // - error 策略：直接抛出错误
} catch (error) {
    if (error.message.includes('No available connection pool')) {
        // 当前操作没有可用候选池
        logger.warn('当前操作没有可用连接池');
        
        // 🔔 触发告警
        sendAlert({
            level: 'critical',
            message: '当前操作没有可用连接池',
            time: new Date()
        });
    }
}
```

### 自动恢复机制

```javascript
// manager 会持续检查 down 状态的连接池。
// 用公开状态快照观察恢复结果。
const before = manager.getHealthStatus().primary?.status;

setTimeout(() => {
    const after = manager.getHealthStatus().primary?.status;
    if (before === 'down' && after === 'up') {
        logger.info('[PoolManager] 连接池恢复完成: primary');
    }
}, 5000);
```

---

## 运维通知方式

### 方式1: 日志记录（基础）

**自动记录**: monSQLize 自动记录所有健康状态变化

```javascript
// 在创建管理器时传入 logger
const logger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
};

const manager = new ConnectionPoolManager({
    logger
});

// 自动记录以下事件：
// [HealthChecker] 连接池检查失败: primary (连续失败 1/3)
// [HealthChecker] 连接池检查失败: primary (连续失败 2/3)
// [HealthChecker] 连接池检查失败: primary (连续失败 3/3)
// [HealthChecker] 连接池已标记为故障: primary
// [CRITICAL] 所有连接池故障，无法提供服务
```

**运维查看日志**:
```bash
# 实时监控错误日志
tail -f pool-error.log | grep -i "故障\|critical\|down"

# 统计故障次数
grep "连接池已标记为故障" pool-combined.log | wc -l

# 查看最近的故障
grep "连接池已标记为故障" pool-combined.log | tail -10
```

### 方式2: 定期监控（推荐）

**定期检查健康状态**:

```javascript
// monitor.js - 监控脚本
const manager = require('./pool-manager');

// 每 30 秒检查一次
setInterval(async () => {
    const health = manager.getPoolHealth();
    const stats = manager.getPoolStats();
    
    // 检查故障池
    const downPools = [];
    for (const [name, status] of health.entries()) {
        if (status.status === 'down') {
            downPools.push({
                name,
                lastError: status.lastError?.message,
                lastCheckTime: status.lastCheckTime?.toISOString() ?? null
            });
        }
    }
    
    // 有故障池：发送告警
    if (downPools.length > 0) {
        console.error('⚠️ 发现故障连接池:', downPools);
        
        // 🔔 发送告警（多种方式）
        await sendAlert({
            level: 'critical',
            message: `${downPools.length} 个连接池故障`,
            pools: downPools,
            timestamp: new Date().toISOString()
        });
    }
    
    // 检查错误率
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.errorRate > 0.05) {  // 错误率 > 5%
            console.warn(`⚠️ ${name} 错误率过高: ${(stat.errorRate * 100).toFixed(2)}%`);
            
            // 🔔 发送警告
            await sendAlert({
                level: 'warning',
                message: `连接池 ${name} 错误率过高`,
                errorRate: stat.errorRate,
                timestamp: new Date().toISOString()
            });
        }
    }
    
    // 检查响应时间
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.avgResponseTime > 100) {  // 响应时间 > 100ms
            console.warn(`⚠️ ${name} 响应慢: ${stat.avgResponseTime}ms`);
        }
    }
    
}, 30000);  // 30秒
```

**运行监控脚本**:
```bash
# 前台运行（测试）
node monitor.js

# 后台运行（生产）
nohup node monitor.js > monitor.log 2>&1 &

# 使用 PM2 运行（推荐）
pm2 start monitor.js --name "pool-monitor"
pm2 logs pool-monitor
```

### 方式3: 应用层状态变化检测

`ConnectionPoolManager` 公开的是健康状态快照，不是健康事件。如果应用需要通知，可以对比连续两次快照：

```javascript
let previous = manager.getHealthStatus();

setInterval(async () => {
    const current = manager.getHealthStatus();

    for (const [poolName, status] of Object.entries(current)) {
        const oldStatus = previous[poolName]?.status;
        if (oldStatus && oldStatus !== status.status) {
            await sendAlert({
                level: status.status === 'down' ? 'critical' : 'info',
                message: `连接池 ${poolName}: ${oldStatus} -> ${status.status}`,
                error: status.lastError?.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    previous = current;
}, 30000);
```

---

## 监控集成方案

### 方案1: 集成 Prometheus + Grafana

**暴露 Prometheus 指标**:

```javascript
// prometheus-exporter.js
const prometheus = require('prom-client');
const express = require('express');
const manager = require('./pool-manager');

// 创建指标
const poolHealthGauge = new prometheus.Gauge({
    name: 'monsqlize_pool_health',
    help: 'Pool health status (1=up, 0.5=degraded, 0=down)',
    labelNames: ['pool_name']
});

const poolConnectionsGauge = new prometheus.Gauge({
    name: 'monsqlize_pool_connections',
    help: 'Current number of connections',
    labelNames: ['pool_name']
});

const poolErrorRate = new prometheus.Gauge({
    name: 'monsqlize_pool_error_rate',
    help: 'Pool error rate (0-1)',
    labelNames: ['pool_name']
});

const poolResponseTime = new prometheus.Gauge({
    name: 'monsqlize_pool_avg_response_time_ms',
    help: 'Average response time in milliseconds',
    labelNames: ['pool_name']
});

// 每 5 秒更新指标
setInterval(() => {
    const health = manager.getPoolHealth();
    const stats = manager.getPoolStats();
    
    for (const [name, status] of health.entries()) {
        const value = status.status === 'up' ? 1 : status.status === 'degraded' ? 0.5 : 0;
        poolHealthGauge.set({ pool_name: name }, value);
    }
    
    for (const [name, stat] of Object.entries(stats)) {
        poolConnectionsGauge.set({ pool_name: name }, stat.connections ?? 0);
        poolErrorRate.set({ pool_name: name }, stat.errorRate);
        poolResponseTime.set({ pool_name: name }, stat.avgResponseTime);
    }
}, 5000);

// 暴露 /metrics 端点
const app = express();
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', prometheus.register.contentType);
    res.end(await prometheus.register.metrics());
});

app.listen(9090, () => {
    console.log('Prometheus exporter listening on :9090');
});
```

**Grafana 告警规则**:
```yaml
# alert-rules.yml
groups:
  - name: monsqlize_alerts
    interval: 30s
    rules:
      - alert: PoolDown
        expr: monsqlize_pool_health == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "连接池故障: {{ $labels.pool_name }}"
          description: "连接池 {{ $labels.pool_name }} 已故障超过 1 分钟"
      
      - alert: HighErrorRate
        expr: monsqlize_pool_error_rate > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "连接池错误率过高: {{ $labels.pool_name }}"
          description: "连接池 {{ $labels.pool_name }} 错误率为 {{ $value }}，超过 5%"
      
      - alert: SlowResponse
        expr: monsqlize_pool_avg_response_time_ms > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "连接池响应慢: {{ $labels.pool_name }}"
          description: "连接池 {{ $labels.pool_name }} 平均响应时间为 {{ $value }}ms"
```

### 方案2: 集成企业微信/钉钉

**发送告警到企业微信**:

```javascript
// alert.js
const axios = require('axios');

async function sendWeChatAlert(message) {
    const webhookUrl = process.env.WECHAT_WEBHOOK_URL;
    
    await axios.post(webhookUrl, {
        msgtype: 'markdown',
        markdown: {
            content: `
## 🚨 连接池告警

**级别**: ${message.level}
**时间**: ${message.timestamp}
**消息**: ${message.message}

${message.details ? `**详情**: ${JSON.stringify(message.details, null, 2)}` : ''}

> 请及时处理！
            `
        }
    });
}

async function sendDingTalkAlert(message) {
    const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
    
    await axios.post(webhookUrl, {
        msgtype: 'markdown',
        markdown: {
            title: '连接池告警',
            text: `
### 🚨 连接池告警

- **级别**: ${message.level}
- **时间**: ${message.timestamp}
- **消息**: ${message.message}

${message.details ? `\n**详情**:\n\`\`\`\n${JSON.stringify(message.details, null, 2)}\n\`\`\`` : ''}
            `
        },
        at: {
            isAtAll: message.level === 'critical'
        }
    });
}

// 使用
await sendWeChatAlert({
    level: 'critical',
    message: '连接池 primary 故障',
    timestamp: new Date().toISOString(),
    details: { error: 'Connection timeout' }
});
```

### 方案3: 集成邮件告警

```javascript
// email-alert.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransporter({
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

async function sendEmailAlert(message) {
    const mailOptions = {
        from: 'alerts@example.com',
        to: 'ops@example.com',
        subject: `🚨 [${message.level.toUpperCase()}] 连接池告警: ${message.message}`,
        html: `
            <h2>连接池告警</h2>
            <p><strong>级别</strong>: ${message.level}</p>
            <p><strong>时间</strong>: ${message.timestamp}</p>
            <p><strong>消息</strong>: ${message.message}</p>
            ${message.details ? `<pre>${JSON.stringify(message.details, null, 2)}</pre>` : ''}
            <hr>
            <p>请及时登录系统查看详情并处理。</p>
        `
    };
    
    await transporter.sendMail(mailOptions);
}
```

---

## 告警配置示例

### 完整的生产环境告警系统

```javascript
// alert-system.js
const manager = require('./pool-manager');
const { sendWeChatAlert } = require('./alert');

// 告警配置
const alertConfig = {
    // 最小告警间隔（避免告警轰炸）
    minInterval: 5 * 60 * 1000,  // 5分钟
    
    // 告警接收人
    receivers: {
        critical: ['ops@example.com', 'cto@example.com'],
        warning: ['ops@example.com'],
        info: ['dev@example.com']
    },
    
    // 告警规则
    rules: {
        poolDown: {
            level: 'critical',
            enabled: true,
            message: (poolName) => `连接池 ${poolName} 故障`
        },
        allPoolsDown: {
            level: 'critical',
            enabled: true,
            message: () => '所有连接池故障，系统不可用'
        },
        highErrorRate: {
            level: 'warning',
            enabled: true,
            threshold: 0.05,  // 5%
            message: (poolName, rate) => `连接池 ${poolName} 错误率过高 (${(rate * 100).toFixed(2)}%)`
        },
        slowResponse: {
            level: 'warning',
            enabled: true,
            threshold: 100,  // 100ms
            message: (poolName, time) => `连接池 ${poolName} 响应慢 (${time}ms)`
        }
    }
};

// 告警历史（避免重复告警）
const alertHistory = new Map();

function shouldSendAlert(key) {
    const lastAlert = alertHistory.get(key);
    if (!lastAlert) return true;
    
    return Date.now() - lastAlert > alertConfig.minInterval;
}

function recordAlert(key) {
    alertHistory.set(key, Date.now());
}

// 监控循环
setInterval(async () => {
    const health = manager.getPoolHealth();
    const stats = manager.getPoolStats();
    
    // 规则1: 检查故障池
    const downPools = [];
    for (const [name, status] of health.entries()) {
        if (status.status === 'down') {
            downPools.push(name);
            
            if (alertConfig.rules.poolDown.enabled && shouldSendAlert(`poolDown:${name}`)) {
                await sendAlert({
                    level: alertConfig.rules.poolDown.level,
                    message: alertConfig.rules.poolDown.message(name),
                    details: {
                        error: status.lastError?.message,
                        lastCheckTime: status.lastCheckTime?.toISOString() ?? null
                    },
                    timestamp: new Date().toISOString()
                });
                recordAlert(`poolDown:${name}`);
            }
        }
    }
    
    // 规则2: 所有池故障
    if (downPools.length === health.size && alertConfig.rules.allPoolsDown.enabled) {
        if (shouldSendAlert('allPoolsDown')) {
            await sendAlert({
                level: alertConfig.rules.allPoolsDown.level,
                message: alertConfig.rules.allPoolsDown.message(),
                details: { downPools },
                timestamp: new Date().toISOString()
            });
            recordAlert('allPoolsDown');
        }
    }
    
    // 规则3: 高错误率
    if (alertConfig.rules.highErrorRate.enabled) {
        for (const [name, stat] of Object.entries(stats)) {
            if (stat.errorRate > alertConfig.rules.highErrorRate.threshold) {
                if (shouldSendAlert(`highErrorRate:${name}`)) {
                    await sendAlert({
                        level: alertConfig.rules.highErrorRate.level,
                        message: alertConfig.rules.highErrorRate.message(name, stat.errorRate),
                        details: { 
                            errorRate: stat.errorRate,
                            totalRequests: stat.totalRequests
                        },
                        timestamp: new Date().toISOString()
                    });
                    recordAlert(`highErrorRate:${name}`);
                }
            }
        }
    }
    
    // 规则4: 响应慢
    if (alertConfig.rules.slowResponse.enabled) {
        for (const [name, stat] of Object.entries(stats)) {
            if (stat.avgResponseTime > alertConfig.rules.slowResponse.threshold) {
                if (shouldSendAlert(`slowResponse:${name}`)) {
                    await sendAlert({
                        level: alertConfig.rules.slowResponse.level,
                        message: alertConfig.rules.slowResponse.message(name, stat.avgResponseTime),
                        details: { 
                            avgResponseTime: stat.avgResponseTime,
                            totalRequests: stat.totalRequests
                        },
                        timestamp: new Date().toISOString()
                    });
                    recordAlert(`slowResponse:${name}`);
                }
            }
        }
    }
    
}, 30000);  // 30秒检查一次

// 统一发送告警（支持多种方式）
async function sendAlert(message) {
    console.log(`📢 发送告警: ${message.message}`);
    
    // 发送到企业微信
    if (process.env.WECHAT_WEBHOOK_URL) {
        await sendWeChatAlert(message);
    }
    
    // 发送邮件
    if (message.level === 'critical') {
        await sendEmailAlert(message);
    }
    
    // 记录到告警日志
    alertLogger.log(message);
}
```

---

## 常见问题

### Q1: 健康检查会影响性能吗？

**A**: 影响很小。

- 每次检查只执行一个轻量级的 `ping` 命令
- 检查间隔默认 5 秒，可以调整到 10-30 秒
- 异步执行，不阻塞业务请求

**性能开销**:
- CPU: < 0.1%
- 网络: 每次检查约 100 字节
- 响应时间: 1-3ms

### Q2: 如何自定义健康检查逻辑？

**A**: 公开健康检查契约支持配置是否启用、检查间隔、超时时间和重试阈值，不暴露自定义 health-check callback。

```javascript
const manager = new ConnectionPoolManager();

await manager.addPool({
    name: 'primary',
    uri: 'mongodb://localhost:27017/main',
    healthCheck: {
        enabled: true,
        interval: 10000,
        timeout: 3000,
        retries: 3,
    },
});

// 如果需要复制延迟或业务专属检查，请在应用监控层执行，
// 再与 getHealthStatus() 的结果组合判断。
async function checkReplicationLag(client) {
    const status = await client.db().admin().command({ replSetGetStatus: 1 });
    return calculateReplicationLag(status);
}
```

### Q3: 主库故障后如何确保不丢数据？

**A**: 使用正确的故障转移策略：

```javascript
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly',  // 不允许写入副本
        // 或使用 'error' 策略，直接报错而不降级
    }
});

// 业务层面处理
try {
    const pool = manager.selectPool('write');
    await pool.collection('orders').insertOne(order);
} catch (error) {
    // 主库故障，保存到队列
    await saveToQueue(order);
    
    // 告警
    await sendAlert({
        level: 'critical',
        message: '主库故障，订单写入队列',
        order: order.id
    });
}
```

### Q4: 如何测试告警系统？

**A**: 手动触发故障：

```bash
# 方法1: 停止 MongoDB
sudo systemctl stop mongod

# 方法2: 防火墙阻断
sudo iptables -A INPUT -p tcp --dport 27017 -j DROP

# 方法3: 使用合成健康状态单测告警函数
testAlert({ poolName: 'primary', status: 'down', error: new Error('Test') });

# 观察日志和告警
tail -f pool-error.log
```

---

**总结**:

1. ✅ **自动发现**: 健康检查每 5 秒自动检测问题
2. ✅ **自动处理**: selectPool 自动跳过故障池
3. ✅ **多种通知**: 日志、监控脚本、事件、Prometheus、企业微信/钉钉、邮件
4. ✅ **自动恢复**: 连接池恢复后自动标记为 up

**推荐方案**: 
- 基础：定期监控脚本 + 企业微信/钉钉
- 高级：Prometheus + Grafana + 告警规则
