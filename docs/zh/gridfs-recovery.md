# GridFS 故障恢复与安全升级操作规程（候选 V0.1）

> **仅供运维管理员使用，当前未完成 CI 验收。** 不得对仍在运行、暂停或网络分区状态的写入进程执行恢复。所有权记录时间较久，不等于原写入进程已经终止。禁止按超时自动抢占所有权。

## 不可破坏的安全约束

`<bucket>.uploads` 持久化同一文件 ID 的上传、追加、完成、取消、删除、重命名和孤儿清理的互斥所有权。**文件记录不存在不代表其 chunks 可删**：上传过程中，files 文档尚未可见；删除过程中，MongoDB Driver 可能先删 files，再删 chunks。

任何强制恢复必须先从集群所有节点停止并排空旧版和新版 GridFS 写入进程、队列消费者、定时任务与自动重启，确认没有仍可恢复的旧写入。恢复脚本无法在 MongoDB 层直接阻止旧进程已发出的 chunks 写入；只有外部进程停机隔离后才安全。不得混用忽略 ownership 的旧版与新版本。

dry-run 可以使用领取所有权之前的可见性快照；**apply 必须在独占 claim 之后重新读取 `files`**。若可见性已经变化，或在需要可见文件时 `verifyVisibleFile` 无法确认，脚本失败并保留 `recovering` 所有权。

排查未知 ID 的残留 chunks 时，使用只读巡检脚本 `scripts/maintenance/gridfs-inspect-orphans.cjs`。它按已有 `{ files_id, n }` 索引分批扫描 `<bucket>.chunks`。分类时若未查到 `files` 和 `uploads` 记录，会再次核对 `files`，报告 `visible_file`、`owned` 或 `candidate_orphan`。没有 apply 模式，不会删除，也不会按文档年龄删除。它不是公开的 `GridFSBucket` API。CLI 按行输出 NDJSON 结果及一条摘要。`--max-findings`（默认 1000，上限 100000）限制单次内存；截断时用 `resumeAfter.filesId` 作为下次的 `--after-files-id`。摘要计数在扫描过程中增量累计。

```sh
export MONSQLIZE_RECOVERY_MONGODB_URI='<从密钥管理系统读取的 MongoDB URI>'
node scripts/maintenance/gridfs-inspect-orphans.cjs --db=database --bucket=fs --page-size=200 --max-findings=1000
```


## 上线和回滚步骤

1. 冻结所有 GridFS 写入，禁止新请求和自动重启，核查所有旧版 Writer 已排空；保留相关运行实例、进程、队列、版本和时间证据。
2. 备份 `<bucket>.files`、`<bucket>.chunks`、`<bucket>.uploads`、索引及配置；备份应与目标集群隔离。
3. 在冻结状态部署新版本并运行 `ensureIndexes()`。迁移需将 legacy `createdAt_1` TTL 改为 `expiresAt_1`，以最后活动时间计算普通待上传会话的七天有效期，活动所有权和无 TTL 状态不得被自动过期。迁移前就过期的旧会话可能已被 TTL 清除，需要额外核对孤儿 chunks。
4. 对每一个需要恢复的 ID，核对上传会话状态、ownerToken/activeAppend.token/recovery.token、updatedAt、files 和 chunks 的一致性，确认目标动作并保留审计记录。
5. **先 dry-run，后 apply**。apply 必须明确声明写入进程已停机、实际操作者、恢复原因，并提供精确原始状态、时间戳和令牌。脚本先写入审计记录，再使用条件更新取得 `recovering` 所有权，失败时保留该所有权，禁止直接删除锁。
6. 核对实际 bytes、chunks 顺序/大小、可见性、恢复后状态，并完成当前 HEAD 的 Node 18/20/22、MongoDB 7.0.37/8.0.26、对应 Driver 6/7 和 Release Preflight 全矩阵后再恢复写入。
7. **回滚到旧版并非直接安全**：旧版不会识别新 ownership，必须先停止并排空全部新版写入，审查所有未完成会话和残留锁，再评估可否回滚。不能简单恢复旧的 `createdAt` TTL。

## 操作方式

从已安装依赖的仓库源码目录执行，MongoDB URI 通过环境变量传递，不要在 shell 命令参数或 Issue 中公开凭证。

```sh
export MONSQLIZE_RECOVERY_MONGODB_URI='<从密钥管理系统读取的 MongoDB URI>'

# 默认仅读取，不做变更；使用数据库里实际查询到的 ID、状态和时间
node scripts/maintenance/gridfs-recover.cjs \
  --db=database --bucket=fs --id=0123456789abcdef01234567 \
  --expected-status=finalizing \
  --expected-updated-at=2026-11-12T02:00:00.000Z

# 完成所有进程隔离与审计后，才允许执行
node scripts/maintenance/gridfs-recover.cjs \
  --db=database --bucket=fs --id=0123456789abcdef01234567 \
  --expected-status=finalizing \
  --expected-updated-at=2026-11-12T02:00:00.000Z \
  --operator=oncall-id --reason=writers-drained \
  --quiesced --apply
```

以上 ID、时间戳仅为格式示例。如果记录存在 `ownerToken`、`activeAppend.token` 或 `recovery.token`，必须加 `--expected-token=实际令牌`。任何状态/令牌/时间戳不符都应中止，重新检查。**当 `status: recovering` 时，还必须先确认上一轮恢复执行器确实已停止，执行 apply 时加 `--prior-recovery-stopped`。**恢复续接会通过 CAS 原子轮换令牌，两个持同一旧快照的恢复进程不能同时执行删除；但仍无法隔离未停止的旧进程已经发出的 MongoDB 写入。

## 按状态恢复

| 状态 | 恢复动作 | 数据保护 |
|---|---|---|
| direct/uploading | 验证 chunks 连续性、每块长度和总长度；只有 owner 记录了 upload() 写入前验证过的 expected SHA 时才强制校验摘要，否则将 metadata 不一致记为审计 warning | uploadStream() 与任意 metadata.sha256 都是不可信声明；绝不删除可见文件 chunks |
| delete/deleting | 继续删除 files 和 chunks，之后才释放同 ID 的所有权 | 删除未完成时禁止替换上传 |
| cleanup/cleaning | 可见文件保留 chunks，否则清理孤儿 chunks | 先查 files |
| resumable/initializing | 保留可见文件的分片，或清理不可见的残留分片，再释放初始化占位 | 文件不可见时，恢复完成后可重试 `beginResumableUpload` |
| rename/renaming | 先核验可见文件及完整 chunks，缺失或损坏时保留锁；运维核查文件名 | 工具不猜测目标或重新执行 rename |
| pending + activeAppend | 根据 chunks 的连续前缀恢复 nextChunk，清除中断令牌，重新设置七天闲置过期 | 保留已写 chunks，后续需验证重传 |
| finalizing，文件不可见 | 退回 pending，正常 finalize 重新校验 | 不删已有 chunks |
| finalizing，文件可见 | 核对文件长度、chunk size、实际 SHA 和元数据，再清理遗留会话 | 不信任单独的元数据 SHA |
| aborting，文件不可见 | 清理孤儿 chunks，移除会话 | 无新写入抢占 |
| aborting，文件可见 | **阻断；人工分析** | 严禁删除可见文件 |
| recovering | 必须确认上一轮恢复执行器也已停止，加 `--prior-recovery-stopped` 并通过 CAS 取得新恢复令牌 | 同一旧快照不能双重恢复，失败仍保留锁 |

Direct owner 会保存摘要来源：`upload()` 的 `options.sha256` 在写入前已对完整 payload 校验，记录为可信 expected SHA；`uploadStream()` 和任意 `metadata.sha256` 明确标记为未验证。恢复时始终校验可见文件的 chunks 连续性、每块长度和总长度；只有 resumable session 或预校验的 direct upload 才强制比对 SHA。未验证 metadata 与实际内容不一致时只写入审计 warning，不会让完整文件永久卡在 recovering 状态。

## 失败和验收边界

恢复脚本位于源码 `scripts/maintenance/gridfs-recover.cjs`，不是对外公开 API。没有绝对可靠的在线“僵尸 Writer 自动判断”，因此不能靠超时解锁。必须以确定性测试覆盖异常中断后状态、错误令牌拒绝、错误时间戳拒绝、可见文件 chunks 绝不误删、finalize 重验 SHA、abort/delete 幂等续接、审计结果及两版 MongoDB。验证结果未全绿前不能把 PR #12 标记 Ready 或合入 main。
