# 从 3.3.1 升级到 3.3.2

本页帮助应用从 **3.3.1 升级到 3.3.2**。未打 tag 的检出仍按发布候选处理。安装准确版本前，先执行 `npm view monsqlize@3.3.2 version --registry=https://registry.npmjs.org/` 并核实不可变 tag；尚未发布时，在预发布环境验证候选的打包产物。准备候选不会发布 npm，也不会更新稳定站。

本补丁修复 BSON 查询与缓存身份、Model 缓存失效、分页、事务、同步及资源清理。公开包入口、Node.js `>=18`、直接运行时依赖和构建格式保持不变。自动缓存失效仍默认关闭。

## 安排升级

1. 用候选运行应用测试，重点检查缓存查询、Model 软删除、自定义游标还原和同步目标。
2. 为查询、聚合结果、totals 和书签的冷启动预留容量。预热热点查询，使用书签时调用 `prewarmBookmarks()`。旧条目可正常过期；无需全局清空 Redis，也不迁移业务数据。
3. 共享缓存的实例尽量一起升级。如需新旧版本共存，隔离缓存后端，或使用集合/操作级广泛失效；精确 descriptor 只构建当前键代次。
4. 启用同步时，升级前停止写者并排空工作，保留 checkpoint、两代幂等标记和恢复快照。不要混跑不同标记格式的写者。
5. npm 发布后，在预发布环境安装准确版本、验证应用，再逐步恢复流量。稳定双语文档必须在 registry 验收后，从同一个不可变 `v3.3.2` tag 部署。

## 缓存与查询兼容性

共享 BSON 查询编码使用 `v4` 代次，区分实际生效的输入/解码选项、有序 BSON 文档、undefined、负零及二进制视图/子类型。函数按原生逐次出现语义序列化；一次逻辑分页与 totals 操作共享已捕获输入。公开书签前缀仍为 `bm:v4`，但 hash 发生变化。详见[缓存迁移](./cache.md)。

不适合 JSON 结果缓存的模式会绕过该缓存。动态解码映射保留文档约定的惰性行为；按维度管理书签时可能拒绝这类映射。自定义 `cursorValueNormalizer` 若要复用分页/书签缓存，必须提供非空、稳定的 `cursorValueNormalizerVersion`。缺少版本时，查询仍会执行，但绕过这些缓存，预热抛出 `INVALID_ARGUMENT`，深跳可能达到 `jump.maxHops`。

基于 pipeline 的 `findPage()` 支持普通包含/排除投影，并在自定义 stage 后应用。find 专用的 `$slice`、`$elemMatch` 和位置投影会以 `INVALID_OPERATION` 拒绝。保序 `findByIds()` 对受支持的排除/计算身份投影保留单次原生查询；无法保留真实身份的组合明确拒绝。`preserveOrder: false` 保留原生执行。特殊 `_id` 投影和 BSON 结果模式的边界见[分页](./findPage.md)及[ID 查询](./find.md)。

显式 Model 聚合/分页缓存失效会考虑软删除可见性。写入仅在已有失效控制明确要求时清理缓存。失效在写入或 commit 成功后 best-effort 执行，不会回滚已经提交的 MongoDB 数据。详见[缓存失效](./cache-invalidation.md)。

## 事务

事务 `timeout` 和 `maxDuration` 限制 commit 开始前的工作，commit 耗时受 driver/server 限制。未知提交结果不代表已经回滚，也不能据此自动重放业务回调；相关缓存会保守失效。详见[事务](./transaction.md)。

## 同步检查点与回退

空 checkpoint store 会在打开 stream 前先保存包含 canonical EJSON BSON Timestamp 的不透明初始操作时间 envelope。自定义 store 必须能原样往返保存。已有原始事件 resume token 仍受支持。严格持久化失败、损坏检查点或历史过期会停止推进，不会删除检查点。

**降级前暂停同步并保留 store。** 旧读取者不能把初始 envelope 当作原始 resume token。成功保存的原始事件 token 只能在旧版本行为和 MongoDB 历史保留允许时恢复格式兼容。不能清空初始 envelope 或从当前时间重启来强行降级。

每个目标的幂等键使用 v2 JSON tuple。旧版拼接标记可能有歧义，不能无条件作为 v2 的重复证据；除非能证明有限映射，否则应依赖目标业务幂等并允许重放。通用 get/set/del store 无法自动枚举或反解旧键。

回退时再次停止写者并排空工作，保留两代标记，核实兼容的原始 token 和目标恢复点。保存恢复快照，按明确方案核对受影响数据；不要清空任一 store。完整说明见[Change Stream 同步](./sync-backup.md)。

## 版本说明与故障恢复

[3.3.2 版本说明](../../changelogs/v3.3.2.md) 汇总全部修复组；[支持矩阵](./support-matrix.md) 说明公开 CI 与可选私有环境验证的范围。包维护者应使用仓库中独立的[发布与恢复手册](https://github.com/devcodex-labs/monSQLize/blob/main/docs/zh/release-preflight.md)；OIDC 就绪不能证明 npm 已发布，也不能提前验证 npm 后台的可信发布者设置。
