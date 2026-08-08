# Cache 工程

本文是 provider context、cache identity 与 compaction 的当前权威说明。历史版本变更见 `docs/devlog.md`。

## Invariants

1. 稳定 prefix 的首字节始终来自共享群聊协议，之后才是 persona；固定顺序的 tool name、description 与 parameter schema 属于同一 cache cohort。
2. Telegram 动态内容只能以新的结构化 session entry 追加，不得改写已持久 entry 的 provider projection。
3. `messages` 是 UI/canonical 最新读模型；provider 只消费不可变 `message_events`。edit、metadata enrichment 与 vision completion 都追加 delta。
4. 已消费位置与当前可见性分离：`bot_cursors.consumed_seq` 只单调前进，`bot_visible_messages` 可在成功 compaction 或 session 轮换时替换。
5. 只有完整 context fingerprint 相同且 manifest 指向的 session 文件存在时才恢复 session。cache-visible 身份改变必须在 restore 前创建新 session/context epoch。
6. UI、IPC、日志、operator command 与本地媒体准备不得改变 provider payload。
7. provider 输入和工具输出必须有界；不能把 raw update、Rich Message JSON、完整 sticker 目录或无界历史塞入 context。

## CACHE_SCHEMA_VERSION

当前：**8**。

v8 合并以下有意的 provider-visible 变化：共享 protocol 置于 persona 前、`telegram_context_v2` 结构化消息、immutable edit/metadata/media delta、动态 sticker top-K，以及 unpublished assistant prose 的 `[no_send]` 持久化策略。

cache-visible protocol 包括：

- shared protocol 与 persona 的内容及顺序；
- tool name、description、parameter schema 与顺序；
- Telegram serializer 与 custom-message details 版本；
- compaction prompt、details 与所选 compaction model；
- extension 顺序和 assistant persistence policy；
- provider/api/model/reasoning/cache retention；
- Pi 版本及当前 bot 的 sticker catalog identity snapshot。

`CACHE_SCHEMA_VERSION` 是 fingerprint 中的强制失效字段，不是恢复 session 后再补记的一项 telemetry。任何上述内容变化都必须先 bump version、更新本文件与 golden；runtime 在打开旧 session **之前**计算 fingerprint，不匹配时保留旧文件、创建新 session 并推进 epoch。

## Provider payload 结构

```text
system: SHARED_PROTOCOL + separator + persona
messages: structured Telegram projection + assistant/tool/summary entries
tools: [{ name, description, parameters }] in fixed order
```

- `src/agent/prompt.ts` 拥有 shared protocol/persona 组装。
- `src/agent/tools.ts` 是 provider-facing 工具参数、调用、错误和终止语义的唯一权威；persona 不复制工具参数表。
- `src/agent/extensions/context.ts` 从 `telegram_context_v2.details.providerText` 投影 provider 内容；恢复 cursor/visible ids 只读 structured details，绝不解析渲染文本。
- `send` 成功后 provider 只看到有界 ACK 与 sent message ids；本地发送详情继续写 SQLite/event。
- 未通过 `send` 发布的 assistant prose 写入本地 `agent_events`，session 中用固定 `[no_send]` 代替；thinking/tool protocol entry 保留。

## Telegram 消息 grammar（serializer v2）

```text
--- 2026-08-07 ---
[17:31:42] #18452 Alice (@alice · tag:admin): 文本
[17:31:55] #18453 Bob (u17) ↪ #18452: 文本
[message_edit #18453] 修改后的文本
[message_metadata #18453] ↪ #18452
[media_update #18453] [图片: 新的视觉描述]
```

- message event 保留原有日期、时间、sender、reply、quote、forward 与媒体占位符语义。
- message/event bytes 一旦写入 session 就不重算；后续变化使用 `edit`、`metadata`、`media_update` delta。
- `telegram_context_v2.details` 同时保存 `consumedSeq`、本 entry 的 event refs、`visibleMessageIds` 与固定 provider projection。
- session 写入成功或启动 reconcile 能从 structured details 证明写入后，SQLite cursor 才前进。provider 失败不会靠文本猜测状态。

## 有界 suffix 与 sticker 候选

- runtime 每轮最多索引读取 256 条近期 event，并额外读取最多 64 条 direct-reply obligation event；不扫描整张 `messages` 表。
- reply obligation 优先打包；普通 event 从最新端选择后恢复时间顺序。默认 suffix 上限 12,000 tokens，单 event 上限 4,096 tokens，并为输出、reasoning 与 tool follow-up 预留空间。
- 普通溢出 event 可以被 cursor 消费但不标 visible；reply obligation 只有在结构化 commit marker 证明交付后才删除。
- sticker catalog 永不进入 system prompt。每轮从本地可发送 mapping 中按当前 suffix 检索，最多追加 8 个候选；不命中或预算不足时不追加。
- page fetch 先受 8,000 字符本地护栏约束，再受 2,048 provider tokens 上限约束；query 与工具失败输出同样有界。

## Vision 与 provider boundary

Vision 默认关闭；只有显式 `vision.enabled: true`，或旧配置明确提供 `auxiliary_visual_model` 的兼容路径，才会执行。

- foreground 每轮默认最多 2 个 media、并发 2；deployment scheduler 默认每群每小时 24 次、每日 200 次。
- persistent media identity cache 在 bots 间复用。新的非空结果只追加 `media_update` event，不改写旧 message entry。
- photo precache、`media_ready`、TUI card 与 `vision_update` IPC 都是 provider 外 side channel。
- compaction 单独使用配置的廉价模型与 `cacheRetention: "none"`；vision/compaction 不继承主模型的 reasoning 默认。

## Compaction 与 context epoch

- Pi 达到配置阈值时，`tg-compaction` 用状态导向 prompt 生成不超过 800 字的摘要，并保留配置的 recent tail。
- 空摘要、provider failure 或 abort 会 cancel；cursor、visible refs 与 epoch 均不伪造变化。
- 成功结果的 structured details 保存当前 `consumedSeq` 与 retained `visibleMessageIds`。runtime 用这些 details 替换 visibility、推进 epoch；`consumedSeq` 永不回退。
- 手工 `/tg compact` 复用同一边界，不向模型注入 operator 指令。

## Payload 诊断与 telemetry

`tg-cache-observer` 在 `before_provider_request` 对 canonical payload 计算 deployment-local HMAC：system、tools、每条 message 与完整 payload 分段记录 hash，并记录相对上次请求的首个 divergence segment/index/byte offset。SQLite 不保存 plaintext payload、prompt、secret 或 HMAC key。

每次 provider response 还记录 provider/api/model/session hash/cache retention、epoch、context/input/cache read/cache write/output/reasoning/latency/cost、trigger、public send、vision/tool rounds，以及 input event/token estimate/rows scanned。保留期默认 90 天，因此 UI 的 lifetime 表示**当前 SQLite 保留窗口**，不是永久累计。

`bun run scripts/analyze-context-window.ts [db]` 可离线比较 threshold；它是估算工具，不是在线 optimizer。

2026-08-07 的 50-run DeepSeek 数据曾测得 90.0% cache hit。该数字仅是历史 deployment 样本，不代表当前 schema v8、其他模型或未来负载。

## Golden

`test/cache.test.ts` 当前锁定：

| 项目 | 值 |
| --- | --- |
| schema | `8` |
| zh system | `71aa33e82b4d` |
| en system | `57e3746bcf4d` |
| legacy message serializer | `68a17d6e5c05` |
| immutable event serializer | `4a57de738bf9` |
| tools | `280868a5b3a9` |
| compaction prompt | `045a5241fdd7` |
| extension order | `e04f7032d531` |
| context protocol | `a9ca6974ac5f` |

测试必须 pin `TZ=Asia/Singapore`；`bun test` 自身强制 UTC。若 hash 有意变化，先解释 cache impact，再更新 version 与 golden；不要只改 expected value。
