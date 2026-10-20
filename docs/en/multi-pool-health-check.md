# Detailed explanation of the multi-connection pool health check mechanism

The manager owns health-check scheduling. A timed-out ping remains in flight until the underlying operation settles, preventing overlapping pings to the same client. Configured failure thresholds determine down status; public status reports degraded before the threshold and recovers on a completed successful check. Stop, removal and replacement fence late results. A custom ping that never settles prevents further checks for that client; shutdown revokes its update authority without waiting indefinitely.

## Overview of health check mechanism

## Working principle

The health checker (HealthChecker) regularly performs health checks on all connection pools. When problems are found, it will automatically mark the status of the connection pool and trigger failover.

```text
┌─────────────────────────────────────────────────────────┐
│ Health check loop (every 5 seconds) │
└─────────────────────────────────────────────────────────┘
                          ↓
        ┌─────────────────┴─────────────────┐
        │                                    │
[Connection Pool 1] [Connection Pool 2]
        │                                    │
        ↓                                    ↓
execute ping execute ping
        │                                    │
    ┌───┴───┐                            ┌───┴───┐
│ Success │ │ Failure │
    └───┬───┘                            └───┬───┘
        │                                    │
        ↓                                    ↓
Status: up consecutive failures +1
                                              │
≥ 3 times?
                                              │
                                              ↓
Status: down
                                              │
                                              ↓
🔔 Trigger alarm
```

## Health status

| Status | Meaning | selectPool behavior | Recovery method |
|------|------|----------------|---------|
| **up** | Health | ✅ Normal use | - |
| **degraded** | A health check failed but the pool has not crossed the down threshold | ⚠️ Still selectable, monitor closely | Restores to `up` after a successful check or becomes `down` after another failure |
| **down** | Failure | ❌ Skip this pool and use other healthy pools | Automatically recover after successful health check |

---

## Problem discovery mechanism

## 1. Health check automatic discovery

**Checking method**: Use MongoDB’s `db.admin().ping()` command

**Trigger conditions**:
- Periodic check (default every 5 seconds)
- Timeout (default 3 seconds)
- Continuous failure threshold (default 3 times)

**Public API example**:
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

## 2. Found when selectingPool

**Trigger time**: When selectPool tries to use a connection pool

**Discovery**:
```javascript
try {
    const pool = manager.selectPool('read');
    const users = await pool.collection(undefined, 'users').find({}).toArray();
    console.log(users);
} catch (error) {
    if (error.message.includes('No available connection pool')) {
        logger.error('[CRITICAL] All connection pools failed and services cannot be provided');
    }
    throw error;
}
```

## 3. Found during actual use

**Trigger timing**: Connection failed when executing query

**Processing method**:
```javascript
//Catching errors in user code
try {
    const pool = manager.selectPool('read');
    const data = await pool.collection('users').find({}).toArray();
} catch (error) {
    //🔔 Record errors and alert
    logger.error('Query failed', { error, poolName: pool?.name });

    // Query public health state and decide whether to alert or retry
    const health = manager.getPoolHealth();
    logger.warn('Current pool health', health);
}
```

---

## Problem handling process

## Automatic processing process

```text
Problem discovery
    ↓
┌──────────────┐
│ Status: down │
└──────────────┘
    ↓
┌──────────────────────────────┐
│ selectPool automatically skips the connection pool │
└──────────────────────────────┘
    ↓
┌──────────────────────────────┐
│ Choose from other health pools │
└──────────────────────────────┘
    ↓
┌──────────────────────────────┐
│ If there is no health pool, implement the downgrade strategy │
└──────────────────────────────┘
    ↓
├─ readonly: only read operations are allowed
├─ secondary: use replica pool
└─ error: throw an error
```

## Downgrade strategy example

```javascript
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly',  //Read-only is allowed when the main database fails
        retryDelay: 1000,
        maxRetries: 3
    }
});

//Behavior when the main database fails
try {
    const pool = manager.selectPool('write');  // Write operation
    // If the primary database is down:
    // - readonly strategy: throw an error (write is not allowed)
    // - secondary strategy: use replicas (possibly write to replicas)
    // - error strategy: throw an error directly
} catch (error) {
    if (error.message.includes('No available connection pool')) {
        // No eligible pool is available for this operation
        logger.warn('No eligible connection pool is available for the current operation.');

        // Trigger alarm
        sendAlert({
            level: 'critical',
            message: 'No available connection pool for the current operation.',
            time: new Date()
        });
    }
}
```

## Automatic recovery mechanism

```javascript
// The manager continues to health-check down pools.
// Poll the public status map to observe recovery.
const before = manager.getHealthStatus().primary?.status;

setTimeout(() => {
    const after = manager.getHealthStatus().primary?.status;
    if (before === 'down' && after === 'up') {
        logger.info('[PoolManager] Connection pool restored: primary');
    }
}, 5000);
```

---

## Operation and maintenance notification method

## Method 1: Logging (Basic)

**Automatic recording**: monSQLize automatically records all health status changes

```javascript
//Pass in logger when creating the manager
const logger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
};

const manager = new ConnectionPoolManager({
    logger
});

//The following events are automatically logged:
//[HealthChecker] Connection pool check failed: primary (1/3 consecutive failures)
//[HealthChecker] Connection pool check failed: primary (consecutive failures 2/3)
//[HealthChecker] Connection pool check failed: primary (failed 3/3 consecutively)
//[HealthChecker] Connection pool marked as failed: primary
//[CRITICAL] All connection pools failed and services cannot be provided
```

**Operation and maintenance view log**:
```bash
# Monitor error logs in real time
tail -f pool-error.log | grep -i "Failure\|critical\|down"

# Count the number of failures
grep "Connection pool marked as failed" pool-combined.log | wc -l

# View recent failures
grep "Connection pool marked as failed" pool-combined.log | tail -10
```

## Method 2: Regular monitoring (recommended)

**Check your health regularly**:

```javascript
//monitor.js – Monitoring script
const manager = require('./pool-manager');

//Check every 30 seconds
setInterval(async () => {
    const health = manager.getPoolHealth();
    const stats = manager.getPoolStats();

    //Check fault pool
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

    //There is a faulty pool: send an alarm
    if (downPools.length > 0) {
        console.error('⚠️Faulty connection pool found:', downPools);

        //🔔 Send alerts (multiple ways)
        await sendAlert({
            level: 'critical',
            message: `${downPools.length} connection pool failures`,
            pools: downPools,
            timestamp: new Date().toISOString()
        });
    }

    //Check error rate
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.errorRate > 0.05) {  //Error rate > 5%
            console.warn(`⚠️ ${name} error rate is too high: ${(stat.errorRate * 100).toFixed(2)}%`);

            //🔔 Send a warning
            await sendAlert({
                level: 'warning',
                message: `Connection pool ${name} error rate is too high`,
                errorRate: stat.errorRate,
                timestamp: new Date().toISOString()
            });
        }
    }

    //Check response time
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.avgResponseTime > 100) {  //Response time > 100ms
            console.warn(`⚠️ ${name} slow response: ${stat.avgResponseTime}ms`);
        }
    }

}, 30000);  //30 seconds
```

**Run monitoring script**:
```bash
# Run in the foreground (test)
node monitor.js

# Running in the background (production)
nohup node monitor.js > monitor.log 2>&1 &

# Run with PM2 (recommended)
pm2 start monitor.js --name "pool-monitor"
pm2 logs pool-monitor
```

## Method 3: Application-level status transitions

`ConnectionPoolManager` exposes health snapshots, not public health events. If your application needs notifications, compare consecutive snapshots:

```javascript
let previous = manager.getHealthStatus();

setInterval(async () => {
    const current = manager.getHealthStatus();

    for (const [poolName, status] of Object.entries(current)) {
        const oldStatus = previous[poolName]?.status;
        if (oldStatus && oldStatus !== status.status) {
            await sendAlert({
                level: status.status === 'down' ? 'critical' : 'info',
                message: `Connection pool ${poolName}: ${oldStatus} -> ${status.status}`,
                error: status.lastError?.message,
                timestamp: new Date().toISOString()
            });
        }
    }

    previous = current;
}, 30000);
```

---

## Monitoring integration solution

## Option 1: Integrate Prometheus + Grafana

**Exposing Prometheus Metrics**:

```javascript
// prometheus-exporter.js
const prometheus = require('prom-client');
const express = require('express');
const manager = require('./pool-manager');

//Create indicator
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

//Metrics updated every 5 seconds
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

//Expose /metrics endpoint
const app = express();
app.get('/metrics', async (req, res) => {
    res.set('Content-Type', prometheus.register.contentType);
    res.end(await prometheus.register.metrics());
});

app.listen(9090, () => {
    console.log('Prometheus exporter listening on :9090');
});
```

**Grafana Alert Rules**:
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
          summary: "Connection pool failure: {{ $labels.pool_name }}"
          description: "Connection pool {{ $labels.pool_name }} has been down for more than 1 minute"

      - alert: HighErrorRate
        expr: monsqlize_pool_error_rate > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "The connection pool error rate is too high: {{ $labels.pool_name }}"
          description: "Connection pool {{ $labels.pool_name }} error rate {{ $value }}, more than 5%"

      - alert: SlowResponse
        expr: monsqlize_pool_avg_response_time_ms > 100
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Connection pool response is slow: {{ $labels.pool_name }}"
          description: "The average response time of connection pool {{ $labels.pool_name }} is {{ $value }}ms"
```

## Solution 2: Integrate Enterprise WeChat/DingTalk

**Send alert to corporate WeChat**:

```javascript
// alert.js
const axios = require('axios');

async function sendWeChatAlert(message) {
    const webhookUrl = process.env.WECHAT_WEBHOOK_URL;

    await axios.post(webhookUrl, {
        msgtype: 'markdown',
        markdown: {
            content: `
## 🚨 Connection pool alarm

**Level**: ${message.level}
**Time**: ${message.timestamp}
**Message**: ${message.message}

${message.details ? `**Details**: ${JSON.stringify(message.details, null, 2)}` : ''}

> Please handle it in time!
            `
        }
    });
}

async function sendDingTalkAlert(message) {
    const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;

    await axios.post(webhookUrl, {
        msgtype: 'markdown',
        markdown: {
            title: 'Connection pool alarm',
            text: `
## 🚨 Connection pool alarm

- **Level**: ${message.level}
- **Time**: ${message.timestamp}
- **Message**: ${message.message}

${message.details ? `\n**Details**:\n\`\`\`\n${JSON.stringify(message.details, null, 2)}\n\`\`\`` : ''}
            `
        },
        at: {
            isAtAll: message.level === 'critical'
        }
    });
}

//use
await sendWeChatAlert({
    level: 'critical',
    message: 'Connection pool primary failure',
    timestamp: new Date().toISOString(),
    details: { error: 'Connection timeout' }
});
```

## Option 3: Integrate email alerts

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
        subject: `🚨 [${message.level.toUpperCase()}] Connection pool alarm: ${message.message}`,
        html: `
<h2>Connection pool alarm</h2>
            <p><strong>Level</strong>: ${message.level}</p>
            <p><strong>Time</strong>: ${message.timestamp}</p>
            <p><strong>Message</strong>: ${message.message}</p>
            ${message.details ? `<pre>${JSON.stringify(message.details, null, 2)}</pre>` : ''}
            <hr>
<p>Please log in to the system in time to check the details and process it. </p>
        `
    };

    await transporter.sendMail(mailOptions);
}
```

---

## Alarm configuration example

## Complete production environment alarm system

```javascript
// alert-system.js
const manager = require('./pool-manager');
const { sendWeChatAlert } = require('./alert');

//Alarm configuration
const alertConfig = {
    //Minimum alarm interval (to avoid alarm bombing)
    minInterval: 5 * 60 * 1000,  //5 minutes

    //Alarm recipient
    receivers: {
        critical: ['ops@example.com', 'cto@example.com'],
        warning: ['ops@example.com'],
        info: ['dev@example.com']
    },

    //Alert rules
    rules: {
        poolDown: {
            level: 'critical',
            enabled: true,
            message: (poolName) => `Connection pool ${poolName} failure`
        },
        allPoolsDown: {
            level: 'critical',
            enabled: true,
            message: () => 'All connection pools fail and the system is unavailable'
        },
        highErrorRate: {
            level: 'warning',
            enabled: true,
            threshold: 0.05,  // 5%
            message: (poolName, rate) => `Connection pool ${poolName} error rate is too high (${(rate * 100).toFixed(2)}%)`
        },
        slowResponse: {
            level: 'warning',
            enabled: true,
            threshold: 100,  // 100ms
            message: (poolName, time) => `Connection pool ${poolName} responds slowly (${time}ms)`
        }
    }
};

//Alarm history (to avoid repeated alarms)
const alertHistory = new Map();

function shouldSendAlert(key) {
    const lastAlert = alertHistory.get(key);
    if (!lastAlert) return true;

    return Date.now() - lastAlert > alertConfig.minInterval;
}

function recordAlert(key) {
    alertHistory.set(key, Date.now());
}

//monitoring loop
setInterval(async () => {
    const health = manager.getPoolHealth();
    const stats = manager.getPoolStats();

    //Rule 1: Check the fault pool
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

    //Rule 2: All pools fail
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

    //Rule 3: High error rate
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

    //Rule 4: Slow response
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

}, 30000);  //Check every 30 seconds

//Send alarms uniformly (supports multiple methods)
async function sendAlert(message) {
    console.log(`📢 Send alert: ${message.message}`);

    //Send to corporate WeChat
    if (process.env.WECHAT_WEBHOOK_URL) {
        await sendWeChatAlert(message);
    }

    //Send email
    if (message.level === 'critical') {
        await sendEmailAlert(message);
    }

    //Record to alarm log
    alertLogger.log(message);
}
```

---

## FAQ

## Q1: Will health checks affect performance?

**A**: The impact is minimal.

- Only one lightweight `ping` command is executed for each check
- The check interval defaults to 5 seconds and can be adjusted to 10-30 seconds
- Asynchronous execution, does not block business requests

**Performance overhead**:
- CPU: < 0.1%
- Network: ~100 bytes per check
- Response time: 1-3ms

## Q2: How to customize health check logic?

**A**: The public health-check contract exposes configuration for enabling checks, interval, timeout, and retry threshold. It does not expose a custom health-check callback.

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

// If you need replication-lag or domain-specific checks, run them in
// application monitoring and combine the result with getHealthStatus().
async function checkReplicationLag(client) {
    const status = await client.db().admin().command({ replSetGetStatus: 1 });
    return calculateReplicationLag(status);
}
```

## Q3: How to ensure that no data is lost after the main database fails?

**A**: Use the correct failover strategy:

```javascript
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly',  // Do not allow writes to replicas
        // Or use the 'error' strategy to report errors directly without downgrading
    }
});

// Business-level processing
try {
    const pool = manager.selectPool('write');
    await pool.collection('orders').insertOne(order);
} catch (error) {
    //Main database failure, save to queue
    await saveToQueue(order);

    //Alarm
    await sendAlert({
        level: 'critical',
        message: 'Main database failure, orders are written to the queue',
        order: order.id
    });
}
```

## Q4: How to test the alarm system?

**A**: Manual trigger fault:

```bash
# Method 1: Stop MongoDB
sudo systemctl stop mongod

# Method 2: Firewall blocking
sudo iptables -A INPUT -p tcp --dport 27017 -j DROP

# Method 3: Unit test your alert function with a synthetic health snapshot
testAlert({ poolName: 'primary', status: 'down', error: new Error('Test') });

# Observe logs and alarms
tail -f pool-error.log
```

---

**Summary**:

1. ✅ **Automatic Discovery**: Health check automatically detects issues every 5 seconds
2. ✅ **Automatic processing**: selectPool automatically skips the fault pool
3. ✅ **Multiple notifications**: logs, monitoring scripts, events, Prometheus, Enterprise WeChat/DingTalk, emails
4. ✅ **Automatic recovery**: The connection pool is automatically marked as up after recovery.

**Recommended plan**:
- Basics: Regular monitoring script + Enterprise WeChat/DingTalk
- Advanced: Prometheus + Grafana + Alert Rules
