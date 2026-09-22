# Detailed documentation of SSH tunnel function

## Function Overview

`ssh.hostHash` and `ssh.hostVerifier` are optional ssh2 host-key verification settings. With `hostHash: 'sha256'`, the verifier receives a hexadecimal SHA-256 fingerprint; returning `false` rejects the handshake and closes the tunnel listener. If no verifier is configured, the previous ssh2 default behavior is retained.

## What is an SSH tunnel?

SSH Tunneling, also known as SSH port forwarding, is a technology that establishes an encrypted channel between local and remote servers through the SSH protocol.

## Application scenarios

1. **Connect to the database behind the firewall**
   - The database is located on the intranet and cannot be accessed directly
   - Access intranet MongoDB through Bastion Host

2. **Encrypt unsecured network connections**
   - Securely access MongoDB in a public network environment
   - Prevent data transmission from being eavesdropped

3. **Unified secure access portal**
   - All database access is through SSH tunnel
   - Centrally manage access rights

## Working principle

```text
Your application → SSH tunnel (local port) → SSH server → Intranet MongoDB
(Local) (Encrypted transmission) (Springboard) (Target database)
```

---

## Quick start

## 1. Enable SSH tunneling

Install `monsqlize`, then add an `ssh` block under the MongoDB `config`. monSQLize opens the tunnel during `connect()` and closes it during `close()`.

## 2. Basic configuration (password authentication)

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: {
        //SSH tunnel configuration
        ssh: {
            host: 'bastion.example.com',
            port: 22,
            username: 'deploy',
            password: 'your-password',  //SSH password
        },
        //MongoDB connection configuration (automatically resolves remoteHost and remotePort from URI)
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/mydb'
    }
});

await msq.connect();  //Automatically establish SSH tunnel
//... using MongoDB
await msq.close();    //Automatically close SSH tunnel
```

## 3. Basic configuration (private key authentication, recommended)

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',  //private key path
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/mydb'
    }
});
```

---

## Configuration instructions

## SSH configuration items

| Configuration item | Type | Required | Default value | Description |
|--------|------|------|--------|------|
| `host` | string | ✅ Yes | - | SSH server address |
| `port` | number | ❌ no | 22 | SSH port |
| `username` | string | ✅ Yes | - | SSH username |
| `password` | string | ⚠️ Choose one of the two | - | SSH password (password authentication) |
| `privateKey` | string | ⚠️ Choose one of the two | - | Private key content (private key authentication) |
| `privateKeyPath` | string | ⚠️ Choose one of the two | - | Private key file path (private key authentication) |
| `passphrase` | string | ❌ No | - | Private key password (if the private key is password protected) |
| `localPort` | number | ❌ no | random | local listening port |
| `readyTimeout` | number | ❌ No | 20000 | SSH connection timeout (ms) |
| `keepaliveInterval` | number | ❌ No | 30000 | Heartbeat interval (milliseconds) |

## MongoDB configuration items

| Configuration item | Type | Required | Description |
|--------|------|------|------|
| `uri` | string | ✅ Yes | MongoDB connection URI (intranet address) |
| `remoteHost` | string | ⚠️ Optional | MongoDB server address (can be automatically resolved from URI) |
| `remotePort` | number | ⚠️ Optional | MongoDB port (can be automatically resolved from URI) |
| `options` | object | ❌ No | MongoDB connection options |

**Automatic parsing rules**:
- ✅ **Recommendation**: Only configure `uri`, the system will automatically parse `remoteHost` and `remotePort` from the URI
- ⚠️ **Special case**: If the address in the URI is different from the actual MongoDB server address, you only need to specify it explicitly

**Example comparison**:

```javascript
//✅ Recommended: Automatic analysis (99% of scenarios)
config: {
    ssh: { host: 'bastion', username: 'user', password: 'pass' },
    uri: 'mongodb://user:pass@internal-mongo:27017/mydb'
    //remoteHost and remotePort automatically resolve from URI to: internal-mongo:27017
}

//⚠️ Explicitly specified (special scenario: URI is different from the actual address)
config: {
    ssh: { host: 'bastion', username: 'user', password: 'pass' },
    uri: 'mongodb://user:pass@loadbalancer:27017/mydb', // Use the load balancing address
    remoteHost: 'actual-mongo-server',  //Actual MongoDB server
    remotePort: 27017
}
```

---

## Usage example

## Example 1: Password authentication (simple test)

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
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});

await msq.connect();
const users = msq.collection('users');
const count = await users.count({});
console.log('Total number of users:', count);
await msq.close();
```

## Example 2: Private key authentication (recommended for production environment)

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            port: 22,
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',  //Supports ~ symbol
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@10.0.1.100:27017/production'
    }
});
```

## Example 3: Using private key content

```javascript
const fs = require('fs');

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKey: fs.readFileSync('/path/to/id_rsa', 'utf8'),  //Directly transfer the private key content
        },
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

## Example 4: Using an encrypted private key

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            passphrase: 'your-key-password',  //Private key password
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

## Example 5: Specify local port

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            localPort: 27018,  //Fixed local port
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});

//MongoDB will connect via localhost:27018
```

## Example 6: Custom SSH port

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            port: 2222,  //Custom SSH port
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production'
    }
});
```

## Example 7: Adjust timeout settings

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'production',
    config: {
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
            readyTimeout: 30000,        //SSH connection timeout 30 seconds
            keepaliveInterval: 60000,   //Heartbeat interval 60 seconds
        },
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://mongouser:mongopass@internal-mongo:27017/production',
        options: {
            serverSelectionTimeoutMS: 10000,  //MongoDB select server timeout
            connectTimeoutMS: 10000,          //MongoDB connection timeout
        }
    }
});
```

---

## Troubleshooting

## Problem 1: SSH connection timeout

**Error message**:
```text
Error: Timed out while waiting for handshake
```

**Possible reasons**:
1. The SSH server address is wrong or inaccessible
2. SSH port blocked by firewall
3. The network is unstable

**Solution**:
```javascript
//1. Check whether the SSH server is accessible
//Run in terminal: ssh user@host -p port

//2. Increase the timeout period
config: {
    ssh: {
        //... other configurations
        readyTimeout: 60000,  //increase to 60 seconds
    }
}
```

## Problem 2: SSH authentication failed

**Error message**:
```text
Error: All configured authentication methods failed
```

**Possible reasons**:
1. Incorrect username or password
2. The private key path is wrong or the permissions are incorrect.
3. The SSH server does not allow this authentication method

**Solution**:
```bash
# 1. Test SSH login
ssh user@host -p port

# 2. Check private key permissions
chmod 600 ~/.ssh/id_rsa

# 3. Use password authentication testing
config: {
    ssh: {
        host: 'bastion.example.com',
        username: 'deploy',
        password: 'your-password',  //Test password authentication
    }
}
```

## Problem 3: MongoDB connection failed

**Error message**:
```text
MongoServerSelectionError: Server selection timed out
```

**Possible reasons**:
1. MongoDB address or port error
2. MongoDB authentication failed
3. MongoDB service is not running

**Solution**:
```javascript
//1. Confirm MongoDB address and port
//Run on SSH server: nc -zv internal-mongo 27017

//2. Check the MongoDB URI
config: {
    //Automatically resolve remoteHost and remotePort from URI
    uri: 'mongodb://user:pass@host:port/db?authSource=admin'
}

//3. Add directConnection option (if it is a replica set)
config: {
    uri: 'mongodb://user:pass@host:port/db?directConnection=true',
    options: {
        directConnection: true,
    }
}
```

The built-in SSH tunnel supports one MongoDB host in the URI. Multi-host replica set URIs and `mongodb+srv://` SRV URIs are rejected with `INVALID_CONFIG`; use an external SSH tunnel, bastion proxy, or MongoDB-side network access for those topologies.

## Problem 4: Port conflict

**Error message**:
```text
Error: listen EADDRINUSE: address already in use
```

**Solution**:
```javascript
//Specify a different local port
config: {
    ssh: {
        //... other configurations
        localPort: 27019,  //Use another port
    }
}

//Or do not specify (automatically assign a random port)
config: {
    ssh: {
        //... other configurations
        //localPort is not set
    }
}
```

---

## Best Practices

## 1. Use private key authentication

✅ **Recommended**:
```javascript
ssh: {
    username: 'deploy',
    privateKeyPath: '~/.ssh/id_rsa',
}
```

❌ **Not recommended**:
```javascript
ssh: {
    username: 'deploy',
    password: 'plain-text-password',  //Clear text passwords are not safe
}
```

## 2. Use environment variables to store sensitive information

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
        //Automatically resolve remoteHost and remotePort from URI
        uri: process.env.MONGO_URI
    }
});
```

## 3. Properly manage SSH keys

```bash
# Generate SSH key pair
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_mongo

# Set private key permissions
chmod 600 ~/.ssh/id_rsa_mongo

# Copy the public key to the SSH server
ssh-copy-id -i ~/.ssh/id_rsa_mongo.pub user@bastion.example.com
```

## 4. Connection pool and timeout configuration

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
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://user:pass@internal-mongo:27017/production',
        options: {
            maxPoolSize: 10,              //Maximum number of connections
            minPoolSize: 2,               //Minimum number of connections
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        }
    }
});
```

## 5. Error handling

```javascript
try {
    await msq.connect();
    //Using MongoDB
} catch (err) {
    if (err.message.includes('Authentication')) {
        console.error('SSH authentication failed, please check username and password/private key');
    } else if (err.message.includes('Timed out')) {
        console.error('SSH connection timed out, please check network and server status');
    } else if (err.message.includes('MongoServerSelectionError')) {
        console.error('MongoDB connection failed, please check the MongoDB address and authentication information');
    } else {
        console.error('Unknown error:', err);
    }
} finally {
    await msq.close();
}
```

## 6. Logging

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
        //Automatically resolve remoteHost and remotePort from URI
        uri: 'mongodb://user:pass@internal-mongo:27017/production'
    }
});

//Output example:
// [INFO] 🔐 Establishing SSH tunnel for MongoDB...
// [INFO] ✅ SSH connection established [MongoDB]
// [INFO] ✅ SSH tunnel ready [MongoDB] { localPort: 56789, remote: 'internal-mongo:27017' }
```

---

## FAQ

## Q1: Does SSH tunneling affect performance?

**A**: There is a slight effect, but it is usually negligible.

- SSH tunnel establishment and transfer overhead depend on key exchange, network path, cipher, proxy hops, and workload
- Measure connect and steady-state throughput in the deployment environment before setting timeouts or capacity budgets
- Suitable for most application scenarios

## Q2: Are multiple SSH tunnels supported?

**A**: Supported. Each MonSQLize instance can establish an independent SSH tunnel.

```javascript
const msq1 = new MonSQLize({ config: { ssh: { host: 'bastion1' } } });
const msq2 = new MonSQLize({ config: { ssh: { host: 'bastion2' } } });

await msq1.connect();  //SSH tunnel 1
await msq2.connect();  //SSH Tunnel 2 (standalone)
```

## Q3: Will the SSH tunnel automatically reconnect after it is disconnected?

**A**: No. Requires manual reconnection. If the SSH connection closes after it was ready, monSQLize marks the tunnel as disconnected and closes the local forwarding server so subsequent use fails fast instead of silently using a dead tunnel.

It is recommended to implement reconnection logic:

```javascript
async function connectWithRetry(msq, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await msq.connect();
            return;
        } catch (err) {
            if (i === maxRetries - 1) throw err;
            console.log(`Connection failed, try again in ${3-i} seconds...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}
```

## Q4: Does it support springboard chain (multi-level SSH)?

**A**: Not directly supported. ProxyJump needs to be configured on the SSH server.

SSH configuration example (~/.ssh/config):
```text
Host final-server
    HostName internal-mongo.local
    User mongouser
    ProxyJump bastion1,bastion2
```

## Q5: Is SSH tunnel supported on Windows?

**A**: Fully supported. monSQLize uses the ssh2 library (pure JavaScript implementation) and does not require a system SSH client.

## Q6: Which is better, password authentication or private key authentication?

**A**: Private key authentication is more secure and recommended.

| Authentication method | Security | Convenience | Recommended scenarios |
|---------|--------|--------|---------|
| Password Authentication | ⚠️ Medium | ✅ High | Development/Testing Environment |
| Private key authentication | ✅ High | ⚠️ Medium | Production environment |

---

## Related documents

- [monSQLize main document](../../README.md)
- [API Document](./api-index.md)
- [Connection Configuration Document](./connection.md)
