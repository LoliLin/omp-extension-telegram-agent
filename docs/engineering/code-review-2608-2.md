# Code Review 2608-2:四路并行全面审查

- **类型**:Review record(一次性的审查结论与修复记录;稳定的能力审计结论见 [code-review-2608.md](./code-review-2608.md))
- **日期**:2026-08-13
- **方法**:4 个并行只读审查 agent —— 2× deepseek/deepseek-v4-pro(审查令牌 `62pN9ZiU`、`LQMIvFk3`)+ 2× deepseek/deepseek-v4-flash(`C/qLUJlG`、`hMi7gSas`);每个 agent 通读 `AGENTS.md`、规范文档、全部 `src/`、`test/`、`.pi/extensions/tg-extension.ts`,并对照 `../pi` 源码与 `node_modules/@earendil-works/pi-*@0.84.1` 导出做 Pi 能力审计。所有高/中严重度指控由 supervisor 独立复核证据后才进入本记录。

## 结论概览

- **cache invariant 无破坏**:稳定 prefix、tool 顺序、fingerprint 全量失效、append-only suffix、compaction/vision 的 `cacheRetention:"none"` 隔离全部核验通过。
- **无新自造轮子**:`run_js`/`search`/`sanitize`/IPC 均为 Pi 没有的领域边界;`streamFunction` 猴补丁经四方对照 Pi 0.84.1 源码确认是注入 `cacheRetention` 的唯一途径,保留并维持"升级 Pi 必查"约定。
- **无过度测试、无防御不存在分支的代码**。
- 发现集中在:生产配置与文档/代码的静默漂移、两个健壮性边界(flush 忙循环、timeline 无界 Map)、若干低危死代码。

## 审查误报记录(已复核否定)

| 指控 | 来源 | 复核结论 |
| --- | --- | --- |
| `llm_runs` INSERT 37 列 vs 38 值、35 参 vs 36 占位符,每次遥测写入必抛错 | flash `C/qLUJlG`(其 Top 1) | **误报**。逐字符核对:VALUES 为 35 个 `?` + 2 个字面 `0` = 37 值 = 37 列;`.run()` 恰好 35 个实参。SQL 自洽。 |
| `provider-context.ts` 的 `contentText` 可替换为 Pi `contentText` | flash `hMi7gSas` | 不可替换:本地实现额外处理 thinking/toolCall/string 回退,替换会改变 telemetry 载荷。 |
| sticker 外层 catch 的 `SentMessagePersistenceError` re-throw 不可达 | flash `hMi7gSas` | 属实:`finishCommittedComponent` 用 `runLocalEffect(..., swallow=true)` 吞掉全部错误,内层 catch 只 rethrow 非持久化错误,外层 catch 不可能见到 `SentMessagePersistenceError`。 |
| `teleram_hastuyuki_bot` 拼写 bug | pro `62pN9ZiU` | 非 bug:`.env` 与 `telegram.config.ts` 两侧拼写一致,可正常工作,仅丑。 |

## 发现与修复

### 1. 缓存与成本(唯一真实成本问题,已修)

**生产配置与 64K 有效窗口/文档三方漂移**(`telegram.config.ts` + `src/agent/runtime.ts:336,350`):

- `compaction_threshold: 128_000` 超过有效窗口,`reserveTokens = max(16_384, 65_536 - threshold)` 静默兜底,实际触发点是 49_152;注释"默认 128000"与代码默认(32_768)、示例(32_768)、文档(32K)全部矛盾。
- `compaction_keep_recent: 20_000` 注释"默认 20000"同样错误(代码默认 1)。
- 决策(2026-08-13,用户确认):有效窗口就是 64K,但 Pi 的 token 估算对 CJK 系统性低估,所以要一个保守触发数。**threshold 定为 49_152** —— 即 64K 窗口减去强制 16K reserve 后的最高生效值,16K reserve 同时充当 CJK 低估缓冲;与修复前有效行为一致,但配置现在诚实地表达意图。
- `compaction_keep_recent` 保留 20_000(用户未要求改变;注释改为诚实描述:摘要 + 约 20K 近期原文,上下文质量更高,压缩后每 turn 成本相应更高。如需省钱可随时改回 1)。
- 同时给 `loadConfig` 加硬校验:threshold > 49_152 直接列配置错误拒绝启动(项目禁止 requested/effective 静默分叉,见 `model-runtime.ts` 对 reasoning clamp 的既有立场)。

### 2. 潜在 bug(已修)

| 发现 | 位置 | 严重度 | 修法 |
| --- | --- | --- | --- |
| flush 忙循环:mandatory obligation 装不进 512 token 地板时 `flush()` 返回 obligation 仍存在 → `flushLoop` 无迭代上限、无 provider 调用地无限空转,bot 永久 busy | `runtime.ts:1176-1177,1248-1251`;`token-packer.ts` force-fit 只截正文 | 中 | 空批次且无法打包时返回 false 终止循环并记 warn;`deferredMandatory` 接入日志(此前是死字段)。obligation 留待下次 trigger 或 compaction 释放空间后交付。 |
| `TimelineClient.pendingUsage` 无上限:只随 snapshot 清理,长连接 attach 期间每 turn 一条永不清除 | `plugin/timeline.ts:129,287,299` | 中 | 加 256 条容量上限(删除最小 id),与同文件 vision/media 缓存的 TTL/上限风格一致。 |
| shutdown 链脆弱:`rt.stop()` 里 `session.dispose()` 抛错会中断 shutdown 循环,跳过 `ipc.stop()`/`releasePidLock()`/`db.close()`,只剩 35s 硬超时兜底 | `daemon/index.ts:355` | 中-低 | `Promise.allSettled` + 拒绝告警。 |
| SSRF prefilter 不拦 `0x7f000001`/`2130706433` 等替代记法 IP(委托 TinyFish 抓取,非本地 SSRF) | `net/public-url.ts` | 低 | 记录为 best-effort 已知边界,不改(收益低于复杂性)。 |
| `requiredEvents()` 对同一义务事件重复并入,`deferredMandatory` 遥测可能双计 | `runtime.ts:822-826` | 低 | 按 eventKey 去重(与 pack 内部去重一致)。 |
| TZ 不进 context fingerprint:serialize 用本地时区,换 TZ 的机器恢复 session 后序列化语义漂移 | `serialize.ts` / `runtime.ts` fingerprint | 低 | 不改协议;生产固定 Asia/Singapore,测试已 pin TZ。留待 fingerprint 下次 bump 时评估。 |
| `agent_events` 中 thinking/assistant_text 原文无长度上限 | `runtime.ts recordEvent` | 低 | 受模型 maxTokens + 90 天保留间接约束,不改。 |

### 3. 过度设计 / 死代码(已清)

- `PackedMessageEvents.deferredMandatory` 由死字段变为已接入;`droppedNormal` 删除(无消费者)。
- `deleteBotState`、`isAcceptedRoutingStatus`、`visionMimeForPath` 三个全仓库无调用的导出删除。
- sticker 外层 catch 不可达的 re-throw 分支删除。
- `routeCounters`(daemon 内存计数、无消费者)删除,保留 routing decision 日志。
- 4 处文本提取中 3 处(`assistant-policy.ts`、`runtime.ts` 摘要提取、`vision.ts`)换用 Pi 导出的 `contentText`(`@earendil-works/pi-ai`);`provider-context.ts` 保留(见误报记录)。

### 4. Telegram `/status` emoji 图例换行(已修,用户要求)

`formatContextBreakdown` 的 visual 输出改为等宽友好格式:第一行演示 emoji 色条,其后每条图例一行,label 定宽右对齐百分比;`statusRichSection` 把该字段包进 `text` fenced code block(`pre` entity),Telegram 端等宽字体、不自动折行。

### 5. 未采纳(评估后明确不做)

- `config.ts` 双通道校验去重与 `loadDebugDeploymentIdentity` 归一化抽取(2608 已点名):改动面大、收益低,留待 config 下一次大改。
- `cache-observer.ts` 为字节偏移诊断保留全量 canonical JSON 快照:内存有界(previous + pending),换来的 first-divergent-byte-offset 是 cache 排障的核心指标,保留。
- `sanitize.ts` 与 Pi `stripTerminalSequences` 合并:本地实现是安全超集(OSC-52/DCS/C0/DEL),不换。
- `streamFunction` 猴补丁改 `options?.cacheRetention ?? bot.cacheRetention`:当前唯一调用方语义不受影响,等 Pi 出现第二个调用方再改。
- `telemetry.test.ts` 锁精确 emoji 色块字符串:属共享读模型格式契约,保留。

## 验证

- `bun test`(全量,零外网)
- `bun run check`(tsc --noEmit)
- `bun run lint`(Biome)
- 修复提交均为原子提交,见 git 历史(`code-review-2608-2` 之后的 commits)。
