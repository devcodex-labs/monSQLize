# GridFS

实例和 Model 助手用于存取 MongoDB GridFS 文件。已发布的 npm 包仍是 3.4.0；本 API 位于该版本之后的源码中，还不是已发布的 3.5.0 包。

GridFS 是普通集合上的客户端约定（`<bucket>.files` 与 `<bucket>.chunks`），不依赖 Search 或 Vector Search。集成测试使用 `mongodb-memory-server` 7.0.37。正式服务器矩阵仍是 MongoDB 7.x 与 8.x。更早的服务器（包括 4.x）未经验证。

## 打开 bucket

```ts
const bucket = msq.gridfs(bucketName?: string, opts?: {
  db?: string;
  pool?: string;
  chunkSizeBytes?: number;
});

const modelBucket = model.gridfs(bucketName?: string, opts?: {
  chunkSizeBytes?: number;
});
```

`bucketName` 默认 `fs`。空字符串会被拒绝。`chunkSizeBytes` 默认 261120（255 KiB），且必须是正整数。

`msq.gridfs()` 使用运行时连接，除非 `pool` 指定了已配置的连接池。命名池使用该池自己的 client，再调用 `client.db(db)`。`db` 默认运行时数据库。`model.gridfs()` 固定使用 Model 的 `poolName` 与 `dbName`，不接受 `pool` 或 `db`。

在 `connect()` 之前调用会抛出 `NOT_CONNECTED`。

## 文件 API

| 方法 | 结果 |
|------|------|
| `upload(filename, data, opts?)` | 返回文件信息的 Promise。`data` 可以是 `Buffer`、`Uint8Array` 或 `Readable`。 |
| `uploadStream(filename, opts?)` | 同步返回带 `id` 与 `done` 的 `Writable`。等待 `done` 取得文件信息或映射后的错误。 |
| `download(idOrName)` | 返回 `Buffer` 的 Promise。 |
| `downloadStream(idOrName, range?)` | 同步返回 `Readable`。文件不存在和区间错误通过 `'error'` 事件发出。 |
| `getFile(id)` | 文件信息；id 不存在时为 `null`。 |
| `findFiles(filter?, opts?)` | 文件信息列表。`limit` 必须是正整数，`skip` 必须 `>= 0`，排序值只能是 `1` 或 `-1`。 |
| `delete(id, opts?)` | 删除 files 文档及其 chunks。`ignoreMissing: true` 时，id 不存在也会成功。 |
| `rename(id, filename)` | 重命名一个已可见文件。 |
| `drop()` | 删除存在的 `<bucket>.files`、`<bucket>.chunks` 和 `<bucket>.uploads`。 |
| `ensureIndexes()` | 创建下文索引。可以重复调用。 |

`idOrName` 是 `ObjectId` 或 `{ filename, revision? }`。`revision` 与驱动一致：`0` 是同名最旧文件，`-1`（默认）是最新文件。因此 `download({ filename })` 返回该文件名的最新文件。

### `ifExists` 与 sha256

`upload` 的 `ifExists` 默认为 `'error'`。

- 提供 `sha256` 时，冲突键是 `metadata.sha256`。摘要必须是 64 位小写十六进制。`Buffer` 与 `Uint8Array` 会在任何 GridFS 写入之前完成哈希。不一致时抛出 `GRIDFS_INTEGRITY_MISMATCH`，并且不会留下可见文件。
- 带 `sha256` 的 `Readable` 会先完整缓冲再哈希，然后才写入。大文件应改用可恢复上传。
- 带 `sha256` 的 `skip` 返回该摘要最新的可见文件。不带 `sha256` 的 `skip` 返回同名最新可见文件。`duplicate` 总是再创建一份。
- `uploadStream` 只把 `sha256` 写入 metadata。它不校验字节，也不接受 `ifExists`。

这些助手写入的 `metadata.sha256` 会覆盖调用方自己放在 `metadata.sha256` 里的值。

### 区间

`downloadStream` 的区间是包含的 `start` 和排除的 `end`。省略 `start` 表示 `0`，省略 `end` 表示文件长度。合法区间满足 `0 <= start < end <= length`。其余情况，包括 `start === end` 和 `start === length`，都会发出 `GRIDFS_RANGE_INVALID`。依赖文件长度才能判断的失败会带上 `details[0].length`。查找文件之前就能拒绝的形态错误不含 `length`。`download()` 用同一个错误码拒绝 Promise，并且不接受区间。

## 可恢复上传

第一阶段可恢复上传把未完成会话放在 `<bucket>.uploads`，直到 finalize。`finalizeResumableUpload` 成功之前，文件不可见。`uploadId` 就是将来的 `files._id`。

```ts
const session = await bucket.beginResumableUpload(filename, {
  length,
  sha256,
  chunkSizeBytes?,
  metadata?,
  contentType?,
  id?,
});
const progress = await bucket.appendChunks(session.uploadId, fromChunk, data);
const info = await bucket.finalizeResumableUpload(session.uploadId);
await bucket.abortResumableUpload(session.uploadId);
```

`beginResumableUpload` 必须提供 `length` 和 `sha256`。`files` 或 `uploads` 中已经存在该 id 时抛出 `GRIDFS_FILE_EXISTS`。

分片长度必须符合会话：

- 除最后一片外，每片长度都是 `chunkSizeBytes`。
- 最后一片长度是 `length % chunkSizeBytes`；能够整除时仍是 `chunkSizeBytes`。
- 无法按这些长度切开的 payload 抛出 `INVALID_ARGUMENT`。

`appendChunks` 以 `fromChunk` 定位：

- `fromChunk` 超过从 0 开始的连续前缀时，抛出 `GRIDFS_RESUME_MISMATCH`，并带上 `expectedNextChunk`。
- 用相同字节重放已写入的分片是幂等的，不会把 `nextChunk` 往回退。
- 用不同字节重放已写入的分片会抛出 `GRIDFS_RESUME_MISMATCH`。
- `{ files_id, n }` 唯一索引冲突只有在已存字节相同的时候才算成功。

`finalizeResumableUpload` 要求分片从 0 连续、总长度等于会话长度，且 sha256 等于会话摘要。然后插入 files 文档、写入 `metadata.sha256`，并删除会话。缺少的分片序号抛出 `GRIDFS_UPLOAD_INCOMPLETE`，`details[0].missingChunks` 列出缺口。摘要不符或分片长度不对抛出 `GRIDFS_INTEGRITY_MISMATCH`。这些失败都不会插入 files 文档。

`abortResumableUpload` 删除会话；如果还没有可见的 files 文档，同时删除该上传的 chunks。会话不存在或已经中止时直接成功。对已经可见的文件调用 abort 不会删除该文件的 chunks。

`<bucket>.uploads` 在 `createdAt` 上有 TTL 索引，`expireAfterSeconds` 为 604800（7 天）。TTL 只删除上传会话文档，不删除 chunks。不再需要的会话应 abort 或 finalize。

## 索引

`upload`、`uploadStream`（打开驱动流之前）、`beginResumableUpload` 和 `ensureIndexes` 会创建：

| 集合 | 键 | 选项 |
|------|----|------|
| `<bucket>.files` | `{ filename: 1, uploadDate: 1 }` | |
| `<bucket>.files` | `{ 'metadata.sha256': 1 }` | 非唯一 |
| `<bucket>.chunks` | `{ files_id: 1, n: 1 }` | 唯一 |
| `<bucket>.uploads` | `{ createdAt: 1 }` | `expireAfterSeconds: 604800` |

读取不会创建索引。被 `writePathPolicy` 拒绝的写入也不会创建。

## writePathPolicy

GridFS 写入的类别是 `gridfs`。命名空间是 `<bucket>.files`，匹配顺序与其他写入相同：实例 id、`pool:db.collection`、`db.collection`、集合名，然后 `default`。

| `gridfs` | `mode` | `msq.gridfs()` 写入 | `model.gridfs()` 写入 |
|----------|--------|---------------------|----------------------|
| `inherit`（默认） | `allow-both` | 允许 | 允许 |
| `inherit` | `model-only` | 阻断 | 阻断 |
| `allow` | 任意 | 允许 | 允许 |
| `block` | 任意 | 阻断 | 阻断 |

`inherit` 不沿用 management 规则。management 的 `inherit` 仍然允许 Model 管理操作、阻断直接管理操作。`model-only` 下 GridFS 的 `inherit` 会同时阻断两个入口。`model.gridfs().drop()` 仍属于 management，因此 `model-only` 下 Model 的 drop 仍然允许，而 `msq.gridfs().drop()` 会被阻断。

被阻断的调用在任何 GridFS 写入之前抛出 `INVALID_OPERATION`。`details[0]` 包含 `category: 'gridfs'`（`drop` 为 `'management'`）和 `reason: 'WRITE_PATH_POLICY'`。`onViolation: 'warn'` 会记录该明细并放行。`getFile`、`findFiles`、`download` 和 `downloadStream` 不受该策略约束。

## 错误

| 错误码 | 时机 |
|--------|------|
| `GRIDFS_FILE_NOT_FOUND` | 下载、删除、重命名或可恢复会话的目标不存在 |
| `GRIDFS_FILE_EXISTS` | `ifExists: 'error'` 发现冲突，或指定 id 已经存在 |
| `GRIDFS_INTEGRITY_MISMATCH` | 字节与 `sha256` 不符，或 finalize 时分片长度不对 |
| `GRIDFS_UPLOAD_INCOMPLETE` | finalize 发现缺口。`details[0].missingChunks` 列出缺少的序号 |
| `GRIDFS_RESUME_MISMATCH` | `fromChunk` 超前于连续前缀，或重放的分片内容不同 |
| `GRIDFS_RANGE_INVALID` | `start` / `end` 不是合法的半开区间 |
| `INVALID_ARGUMENT` | 文件名、bucket 名、分片大小、摘要、metadata 键或分片 payload 不合法 |
| `INVALID_OPERATION` | `writePathPolicy` 阻断了调用 |
| `NOT_CONNECTED` | 运行时未连接，或所选连接池的 client 不存在 |
| `MONGODB_ERROR` | 其他驱动或服务器失败。`cause` 是原始错误 |

`downloadStream` 把 `GRIDFS_FILE_NOT_FOUND` 和 `GRIDFS_RANGE_INVALID` 发到流上。方法本身不抛出这两个错误。
