# Code Review 2608-3:六区并行全面审查(造轮子 / hack / 过度防御 / 冗余)

- **类型**:Review record(一次性审查结论;稳定结论见 [code-review-2608.md](./code-review-2608.md)、[code-review-2608-2.md](./code-review-2608-2.md))
- **日期**:2026-08-20
- **方法**:先由 1 个只读 agent 盘点 Pi 平台能力(以项目锁定的 `node_modules/@earendil-works/*@0.84.1` 的 `.d.ts` 为准,对照 `/usr/lib/node_modules/pi-coding-agent/` monorepo 源码,版本 0.84.2,仅 patch 差异、不影响结论);再由 6 个并行只读审查 agent 分区通读全部源码与直接调用点:`src/agent/`、`src/telegram/`、`src/media/`、`src/daemon/`+`src/ipc.ts`、`src/db/`+`src/config.ts`+`src/observability/`、`src/onboarding/`+`src/plugin/`+`.pi/extensions/`+`scripts/`+`test/`。前两次 review 已决策事项经复核后不重报。

## 结论概览

- **无系统性造轮子**:session / compaction / usage 统计 / 工具注册 / TUI 组件 / 扩展 API 全部走 Pi 官方出口;`markdown.ts` 复用 pi-tui re-export 的 marked;onboarding 的模型/授权委托 Pi 原生 `/login` + `/model`。自造部分(Telegram 层、daemon/IPC、结构化 logger、SQLite 读模型、中文摘要 prompt)均为 Pi 真实没有的能力。
- **`streamFunction` 不是私有缝**:`Agent.streamFunction` 在 0.84.1 是公开可变字段,函数包函数是官方形态(另有 `setDefaultStreamFn`/`AgentOptions.streamFn` 两个注入点);真实缺口仅是 `createAgentSession()` 不接受 streamFn 选项,只能事后覆盖。AGENTS.md"已知坑"中"唯一的 Pi 私有缝"的措辞据此修正。
- **主要债务**:依赖卫生 2 处(Pi 升级时静默 break 型)、孤儿 DI 测试缝与死代码(最大存量,约 200 行可删)、配置默认值三处定义且已漂移 1 处、若干不可达防御分支。

## 发现与修复决策

### 1. 依赖卫生(高优先,一行级)

| 发现 | 位置 | 修法 |
| --- | --- | --- |
| 硬编码字符串 `"conversation history before this point was compacted"` 是 Pi `COMPACTION_SUMMARY_PREFIX` 的中段拷贝,Pi 改措辞则 compacted 消息分类静默失效 | `src/agent/extensions/cache-observer.ts:25` | 改从 `@earendil-works/pi-agent-core` import 该常量(0.84.1 包根已导出) |
| `import { Type } from "typebox"` 引用未声明的传递依赖(pi-ai hoist),不 hoist 或升级即 break | `src/agent/tools.ts:6` | 改从 `@earendil-works/pi-ai` 导入(其 index 明确 re-export `Type`) |

### 2. 健壮性修复

| 发现 | 位置 | 严重度 | 修法 |
| --- | --- | --- | --- |
| `daemonEntry` 用空白分隔解析 `ps` 输出,rootDir 含空格时 ownership 检查必失败,CLI 拒绝管理自己的 daemon | `src/daemon/pid.ts:54-69` | 中 | 实施时改为读 `/proc/<pid>/cmdline`(NUL 分隔 argv,空格安全)+ `/proc/<pid>/cwd` 校验身份;未采用 env marker 方案——`/proc/<pid>/environ` 是 exec 快照,`start --foreground` / systemd 直启 / 进程内 setenv 都不覆盖,marker 会把前台 daemon 误判为 foreign 并夺锁 |
| `visionNumber` 把超限值静默回落默认值,与同文件 `compaction_threshold`"禁止 requested/effective 静默分叉"立场矛盾 | `src/config.ts:726-731,751-752` | 低-中 | `loadBotConfig` 校验改为硬拒绝,删静默兜底 |
| 静态 vision 图片不做 resize,最大 20MB 原图 base64 直发 provider(载荷 +33%,可能撞单图上限) | `src/media/vision.ts:229-260` | 中 | 接入 Pi 导出的 `resizeImage()`(尺寸+字节双上限);video 帧已由 ffmpeg `scale=1280` 有界,不动 |
| compaction 摘要不查 `stopReason`,provider 出错被误记为 "empty summary" | `src/agent/runtime.ts:830-851` | 低 | 调用后检查 `stopReason` 再判空 |
| `createSharedModelRuntime` 的 `catch {}` 吞掉真实错误原因 | `src/agent/model-runtime.ts:146-148` | 低 | 附截断后的 `error.message` |
| SIGTERM 无 ESRCH 兜底(pidAlive 与 kill 之间 TOCTOU,CLI 可能未捕获崩溃) | `src/daemon/control.ts:444` | 低 | 捕获 ESRCH 视为已退出 |
| shutdown 末尾固定 `sleep(500)` 是隐式时序耦合 | `src/daemon/index.ts:369` | 低 | 改为等待 poller 实际停止 |

### 3. 过度防御清理

- `runtime.ts` 三处 `this.model?.`/`?? 200_000` 等(`!` 声明且 `init()` 无条件赋值,不可能分支)。
- `rich-message.ts` 的 WeakSet 循环/共享引用防护(JSON.parse 产物不可能有环,`MAX_DEPTH` 已兜底)。
- `control.ts` `liveProjectPids` 重复过滤(`listOurDaemons` 已过滤)。
- `ipc-server.ts` broadcast 的空字段兜底(调用点语义保证非空)。
- `vision.ts` 三个不可达分支(readinessFailure 早退、空 images、kind 不一致——kind 是 insert-only 字段)。
- `media-cache.ts` `apis.get()` 二次校验;`local-cache.ts` 冗余 `chmod 0o600` ×2;`activity.ts` 不可达的 `?? "null"`。
- **IPC "old daemons" 兼容层删除**:`src/ipc.ts` 的 additive optional 字段 + `timeline.ts` `emitStats` 的 12 个 `?? 0` 兜底已删;`docs/architecture.md` 同步立项"daemon 与 extension 同仓库原子升级"。**两处保留**:`UsageRun` 的 `cacheEstimated`/`thinkingMs`/`sendMs`/`sendSamples`/`contextBreakdown`/`compaction` 仍 optional——生产端 runtime 的 compaction run 与首发 run 本就不填,属当前行为而非旧 daemon 兼容;`evtId` 回退 key 保留——live 广播在 agent_events INSERT 后同步触发但 sink 签名拿不到 rowid,是真实缺省。彻底清理需先把 `lastInsertRowid` 传入 eventSink。
- shutdown 固定 `sleep(500)` 已改为等待 poller 实际停止,并给 Poller 补了 AbortSignal 支持(`getUpdates` 长轮询与退避 sleep 都可中止),否则 restart 最坏等 25s。

### 4. 冗余清理(最大存量)

- **孤儿 DI 测试缝**(脚手架测试已删、缝未删,全库无调用点):`DaemonControlPort` 16 方法接口、onboarding `fileOps`/`nonce`/`onEvent`+`ConfigFileOps`、`TelegramExtensionOptions` 6 参数、`NativeMediaCache` 3 构造参数、`TimelineClient.sendAckTimeoutMs`、`ActivityScheduler`/`intervalMs` 缝、`docs-site.ts CommandRunner`、`pi-launcher.ts PiLauncherIO`。
- **死代码**:`TypingLeaseMetrics` 全部计数 + `isActive`(约 25 行)、`MediaCacheQueue` 三统计 getter + `peak` + 四个无人传参的配置项、`Poller.running`(write-only)、`isDaemonCommand` 死导出、`backfillCacheReadEstimates`(生产库已迁移)、`log.ts`/`usage.ts` 无外部消费者的导出、`restoreLastCompaction` 多余 export、`revisionHex` 双 slice、`TelegramControlResult.duplicate` 字段。
- **重复逻辑合并**:daemon "查行→broadcast" 回调 ×3 → 闭包;`bytesBucket` ×2;in-flight 去重样板 ×2;`itemKey` ×2;`boundedRichStatus` 多 section 通用性简化为单 section;`codePointLength`/`takeCodePoints` 二遍扫描合并;`onboardingConfigPath` 无价值包装;`ipc-server.ts` 三个无语义收益的 WeakMap → Map;`db/usage.ts` 的 `as never` 行类型改为本地接口。
- **配置默认值三处漂移**:`renderFirstRunConfig` 曾硬编码渲染 `config.ts` 已有默认值的全部字段,且与 example 漂移(wizard 生成 `compaction_keep_recent: 1`——重演 2608-2 §1 的失败模式)。已修:wizard 只渲染必填 + 用户收集的字段,其余回落 `config.ts` 默认值。注意 `config.ts` 默认 `compaction_keep_recent` 为 1,example 显式写 20_000 是 2608-2 用户确认过的调优示例,二者是"默认值 vs 显式覆盖"关系,不算漂移;wizard 不再是第三个定义源。

### 5. 未采纳(评估后明确不做)

- IPC 分帧换 pi-protocol `encodeFrame/FrameDecoder`:0.84.1 的 framing 是纯通用长度前缀分帧(此前"Pi server 专用"判断不成立),但换二进制分帧是 breaking IPC 变更且收益仅十几行,JSONL 协议已由 REQ-IPC 约束,不动。
- compaction 摘要换 `generateSummaryWithUsage()`:Pi 版固定编码任务向 SUMMARIZATION_PROMPT、system prompt 不可换,本项目中文群聊摘要 prompt 是产品决策,不换。
- `usage.input + cacheRead + cacheWrite` 换 `calculateContextTokens()`:Pi 实现含 output,语义不同,不换;仅标注两边 "context tokens" 语义分歧。
- `pendingPayloadObservations` 与 `recordUsage` 的顺序配对错位风险:仅影响诊断遥测,不加机制。
- `tokenEstimate` 与 `estimateProviderTokensUpperBound` 合并:语义不同(诊断估算 vs 硬预算上界),仅互加引用注释。
- `ensureVision` 下载路径不接 AbortSignal:记录为已知边界,留待 daemon shutdown 链路下次改动时评估。
- `config.ts` 校验换 TypeBox `Value.Errors`:交叉字段检查仍须手写,收益低(与 2608-2 未采纳决策一致)。

## 验证

- `bun test`:113 pass / 0 fail(9 文件,零外网)。
- `bun run check`(tsc --noEmit)与 `bun run lint`(Biome 85 文件):全绿。
- `bun run docs:check`:本环境无 mdbook,未执行(环境限制,非本次改动引入)。
- 上线验证(2026-08-20):`bun run restart` 快速完成(poller abort 生效,无 25s 长轮询等待);两 bot session 以原 fingerprint/epoch resume(cache-visible 协议未变,`cache_schema` 不变);`bun run scripts/e2e-agent.ts --bot A` **PASS**——真实 LLM run → send tool → 群消息 58816/58817 → DB 遥测全链路通;restart 后无 error/warn(e2e 并发写库期间 bot B 出现一次 `ingest_failed` sqliteerror,下一 poll 自愈,offset 未推进语义正确);双 bot 后续收发正常。
