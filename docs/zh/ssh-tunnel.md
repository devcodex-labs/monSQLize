# SSH 隧道功能详细文档

## 功能概述

`ssh.hostHash` 与 `ssh.hostVerifier` 是可选的 ssh2 主机密钥校验配置。设置 `hostHash: 'sha256'` 时，校验函数收到十六进制 SHA-256 指纹；返回 `false` 会拒绝握手并关闭隧道监听端口。未配置校验函数时保持原有 ssh2 默认行为。

### 什么是SSH隧道？

SSH隧道（SSH Tunneling）也称为SSH端口转发，是一种通过SSH协议在本地和远程服务器之间建立加密通道的技术。

### 应用场景

1. **连接防火墙后的数据库**
   - 数据库位于内网，无法直接访问
   - 通过跳板机（Bastion Host）访问内网MongoDB

2. **加密不安全的网络连接**
   - 在公网环境下安全访问MongoDB
   - 防止数据传输被窃听

3. **统一安全访问入口**
   - 所有数据库访问都通过SSH隧道
   - 集中管理访问权限

### 工作原理

```text
你的应用 → SSH隧道（本地端口） → SSH服务器 → 内网MongoDB
  (本地)      (加密传输)          (跳板机)      (目标数据库)
```

---

## 快速开始

### 1. 启用 SSH 隧道

安装 `monsqlize` 后，在 MongoDB `config` 中添加 `ssh` 配置即可。monSQLize 会在 `connect()` 时打开隧道，并在 `close()` 时关闭隧道。

### 2. 基础配置（密码认证）

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: {
        // SSH隧道配置
        ssh: {
            host: 'bastion.example.com',
            port: 22,
            username: 'deploy',
            password: 'your-password',  // SSH密码
        },
        // MongoDB连接配置（自动从URI解析remoteHost和remotePort）
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/mydb'
    }
});

await msq.connect();  // 自动建立SSH隧道
// ... 使用MongoDB
await msq.close();    // 自动关闭SSH隧道
```

### 3. 基础配置（私钥认证，推荐）

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',  // 私钥路径
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/mydb'
    }
});
```

---

## 配置说明

### SSH配置项

| 配置项 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `host` | string | ✅ 是 | - | SSH服务器地址 |
| `port` | number | ❌ 否 | 22 | SSH端口 |
| `username` | string | ✅ 是 | - | SSH用户名 |
| `password` | string | ⚠️ 二选一 | - | SSH密码（密码认证） |
| `privateKey` | string | ⚠️ 二选一 | - | 私钥内容（私钥认证） |
| `privateKeyPath` | string | ⚠️ 二选一 | - | 私钥文件路径（私钥认证） |
| `passphrase` | string | ❌ 否 | - | 私钥密码（如果私钥有密码保护） |
| `localPort` | number | ❌ 否 | 随机 | 本地监听端口 |
| `readyTimeout` | number | ❌ 否 | 20000 | SSH连接超时（毫秒） |
| `keepaliveInterval` | number | ❌ 否 | 30000 | 心跳间隔（毫秒） |

### MongoDB配置项

| 配置项 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `uri` | string | ✅ 是 | MongoDB连接URI（内网地址） |
| `remoteHost` | string | ⚠️ 可选 | MongoDB服务器地址（可从URI自动解析） |
| `remotePort` | number | ⚠️ 可选 | MongoDB端口（可从URI自动解析） |
| `options` | object | ❌ 否 | MongoDB连接选项 |

**自动解析规则**：
- ✅ **推荐**：只配置`uri`，系统会自动从URI中解析`remoteHost`和`remotePort`
- ⚠️ **特殊情况**：如果URI中的地址与实际MongoDB服务器地址不同，才需要显式指定

**示例对比**：

```javascript
// ✅ 推荐：自动解析（99%的场景）
config: {
    ssh: { host: 'bastion', username: 'user', password: 'pass' },
    uri: 'mongodb://user:pass@internal-mongo:27017/mydb'
    // remoteHost和remotePort自动从URI解析为：internal-mongo:27017
}

// ⚠️ 显式指定（特殊场景：URI与实际地址不同）
config: {
    ssh: { host: 'bastion', username: 'user', password: 'pass' },
    uri: 'mongodb://user:pass@loadbalancer:27017/mydb',  // 使用负载均衡地址
    remoteHost: 'actual-mongo-server',  // 实际MongoDB服务器
    remotePort: 27017
}
```

---

## 使用示例

### 示例1：密码认证（简单测试）

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            password: 'your-password',
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});

await msq.connect();
const users = msq.collection('users');
const count = await users.count({});
console.log('用户总数:', count);
await msq.close();
```

### 示例2：私钥认证（推荐生产环境）

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            port: 22,
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',  // 支持 ~ 符号
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@10.0.1.100:27017/production'
    }
});
```

### 示例3：使用私钥内容

```javascript
const fs = require('fs');

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKey: fs.readFileSync('/path/to/id_rsa', 'utf8'),  // 直接传私钥内容
        },
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

### 示例4：使用加密私钥

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            passphrase: 'your-key-password',  // 私钥密码
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

### 示例5：指定本地端口

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            localPort: 27018,  // 固定本地端口
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});

// MongoDB将通过 localhost:27018 连接
```

### 示例6：自定义SSH端口

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            port: 2222,  // 自定义SSH端口
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

### 示例7：调整超时设置

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            readyTimeout: 30000,        // SSH连接超时30秒
            keepaliveInterval: 60000,   // 心跳间隔60秒
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production',
        options: {
            serverSelectionTimeoutMS: 10000,  // MongoDB选择服务器超时
            connectTimeoutMS: 10000,          // MongoDB连接超时
        }
    }
});
```

---

## 故障排查

### 问题1：SSH连接超时

**错误信息**：
```text
Error: Timed out while waiting for handshake
```

**可能原因**：
1. SSH服务器地址错误或无法访问
2. SSH端口被防火墙阻止
3. 网络不稳定

**解决方案**：
```javascript
// 1. 检查SSH服务器是否可访问
// 在终端运行：ssh user@host -p port

// 2. 增加超时时间
config: {
    ssh: {
        // ... 其他配置
        readyTimeout: 60000,  // 增加到60秒
    }
}
```

### 问题2：SSH认证失败

**错误信息**：
```text
Error: All configured authentication methods failed
```

**可能原因**：
1. 用户名或密码错误
2. 私钥路径错误或权限不正确
3. SSH服务器不允许该认证方式

**解决方案**：
```bash
# 1. 测试SSH登录
ssh user@host -p port

# 2. 检查私钥权限
chmod 600 ~/.ssh/id_rsa

# 3. 使用密码认证测试
config: {
    ssh: {
        host: 'bastion.example.com',
        username: 'deploy',
        password: 'your-password',  // 测试密码认证
    }
}
```

### 问题3：MongoDB连接失败

**错误信息**：
```text
MongoServerSelectionError: Server selection timed out
```

**可能原因**：
1. MongoDB地址或端口错误
2. MongoDB认证失败
3. MongoDB服务未运行

**解决方案**：
```javascript
// 1. 确认MongoDB地址和端口
// 在SSH服务器上运行：nc -zv internal-mongo 27017

// 2. 检查MongoDB URI
config: {
    // 自动从URI解析remoteHost和remotePort
    uri: 'mongodb://user:pass@host:port/db?authSource=admin'
}

// 3. 添加directConnection选项（如果是副本集）
config: {
    uri: 'mongodb://user:pass@host:port/db?directConnection=true',
    options: {
        directConnection: true,
    }
}
```

内置 SSH 隧道只支持 URI 中包含一个 MongoDB host。多 host 副本集 URI 和 `mongodb+srv://` SRV URI 会以 `INVALID_CONFIG` 拒绝；这类拓扑请使用外部 SSH 隧道、跳板代理，或在 MongoDB 网络层开放对应访问。

### 问题4：端口冲突

**错误信息**：
```text
Error: listen EADDRINUSE: address already in use
```

**解决方案**：
```javascript
// 指定不同的本地端口
config: {
    ssh: {
        // ... 其他配置
        localPort: 27019,  // 使用其他端口
    }
}

// 或者不指定（自动分配随机端口）
config: {
    ssh: {
        // ... 其他配置
        // localPort 不设置
    }
}
```

---

## 最佳实践

### 1. 使用私钥认证

✅ **推荐**：
```javascript
ssh: {
    username: 'deploy',
    privateKeyPath: '~/.ssh/id_rsa',
}
```

❌ **不推荐**：
```javascript
ssh: {
    username: 'deploy',
    password: 'plain-text-password',  // 明文密码不安全
}
```

### 2. 使用环境变量存储敏感信息

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: process.env.SSH_HOST,
            username: process.env.SSH_USER,
            privateKeyPath: process.env.SSH_KEY_PATH,
        },
        // 自动从URI解析remoteHost和remotePort
        uri: process.env.MONGO_URI
    }
});
```

### 3. 正确管理SSH密钥

```bash
# 生成SSH密钥对
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_mongo

# 设置私钥权限
chmod 600 ~/.ssh/id_rsa_mongo

# 复制公钥到SSH服务器
ssh-copy-id -i ~/.ssh/id_rsa_mongo.pub user@bastion.example.com
```

### 4. 连接池和超时配置

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            readyTimeout: 30000,
            keepaliveInterval: 30000,
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://user:pass@internal-mongo:27017/production',
        options: {
            maxPoolSize: 10,              // 最大连接数
            minPoolSize: 2,               // 最小连接数
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        }
    }
});
```

### 5. 错误处理

```javascript
try {
    await msq.connect();
    // 使用MongoDB
} catch (err) {
    if (err.message.includes('Authentication')) {
        console.error('SSH认证失败，请检查用户名和密码/私钥');
    } else if (err.message.includes('Timed out')) {
        console.error('SSH连接超时，请检查网络和服务器状态');
    } else if (err.message.includes('MongoServerSelectionError')) {
        console.error('MongoDB连接失败，请检查MongoDB地址和认证信息');
    } else {
        console.error('未知错误:', err);
    }
} finally {
    await msq.close();
}
```

### 6. 日志记录

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    logger: {
        info: (msg, meta) => console.log('[INFO]', msg, meta),
        warn: (msg, meta) => console.warn('[WARN]', msg, meta),
        error: (msg, meta) => console.error('[ERROR]', msg, meta),
        debug: (msg, meta) => console.debug('[DEBUG]', msg, meta),
    },
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
        },
        // 自动从URI解析remoteHost和remotePort
        uri: 'mongodb://user:pass@internal-mongo:27017/production'
    }
});

// 输出示例：
// [INFO] 🔐 Establishing SSH tunnel for MongoDB...
// [INFO] ✅ SSH connection established [MongoDB]
// [INFO] ✅ SSH tunnel ready [MongoDB] { localPort: 56789, remote: 'internal-mongo:27017' }
```

---

## 常见问题

### Q1: SSH隧道是否影响性能？

**A**: 有轻微影响，但通常可忽略不计。

- SSH 隧道建立和传输开销取决于密钥交换、网络路径、加密算法、代理跳数和负载
- 设置超时或容量预算前，应在部署环境测量连接和稳态吞吐
- 适用于大部分应用场景

### Q2: 是否支持多个SSH隧道？

**A**: 支持。每个MonSQLize实例可以建立独立的SSH隧道。

```javascript
const msq1 = new MonSQLize({ config: { ssh: { host: 'bastion1' } } });
const msq2 = new MonSQLize({ config: { ssh: { host: 'bastion2' } } });

await msq1.connect();  // SSH隧道1
await msq2.connect();  // SSH隧道2（独立）
```

### Q3: SSH隧道断开后会自动重连吗？

**A**: 不会。需要手动重连。如果 SSH 连接在 ready 之后断开，monSQLize 会将隧道标记为未连接并关闭本地转发服务，让后续使用快速失败，而不是静默继续使用已经失效的隧道。

建议实现重连逻辑：

```javascript
async function connectWithRetry(msq, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await msq.connect();
            return;
        } catch (err) {
            if (i === maxRetries - 1) throw err;
            console.log(`连接失败，${3-i}秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}
```

### Q4: 是否支持跳板机链（多级SSH）？

**A**: 不直接支持。需要在SSH服务器上配置ProxyJump。

SSH配置示例（~/.ssh/config）：
```text
Host final-server
    HostName internal-mongo.local
    User mongouser
    ProxyJump bastion1,bastion2
```

### Q5: Windows上是否支持SSH隧道？

**A**: 完全支持。monSQLize使用ssh2库（纯JavaScript实现），无需系统SSH客户端。

### Q6: 密码认证和私钥认证哪个更好？

**A**: 私钥认证更安全且推荐。

| 认证方式 | 安全性 | 便利性 | 推荐场景 |
|---------|--------|--------|---------|
| 密码认证 | ⚠️ 中 | ✅ 高 | 开发/测试环境 |
| 私钥认证 | ✅ 高 | ⚠️ 中 | 生产环境 |

---

## 相关文档

- [monSQLize主文档](../../README.md)
- [API文档](./api-index.md)
- [连接配置文档](./connection.md)
