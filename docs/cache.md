# Cache 工程

## Invariants

1. 稳定 prefix 区域（变化频率极低）：system prompt（persona + 群聊行为规则 + 消息 grammar 说明 + 格式化规则）、tool name/description/parameter schema 与顺序
2. 动态内容只以新 suffix 追加，永不改写已存在的 prefix
3. 历史消息序列化 grammar 固定；已序列化过的消息内容永不变化
4. compaction 是唯一的 cache boundary（新 Context Epoch）
5. UI/TUI 功能不得影响 provider payload（UI-only 改动若改变 provider prefix = 边界设计 bug）

## CACHE_SCHEMA_VERSION

当前：**5**（v5：`send.message` 明确为 Telegram Rich Markdown，tool schema仍是唯一权威，REQ-TG-0003）

cache-visible protocol：system prompt shape、persona serialization、tool name/description/parameter schema/order、消息序列化 grammar、compaction summary grammar、**固定 sticker 目录块**。

修改任一 → bump version → 新 context epoch（daemon 启动时检测 daemon_state.cache_schema_version 不匹配即全员 epoch+1，一次性的 cache reset，而非每轮莫名 miss）。

## Provider payload 结构（DeepSeek via openai-completions）

```
system: persona prompt + 固定 sticker 目录块（有 set 时，单字符串）
messages: user/assistant/tool 序列
  assistant.content = 纯字符串
  assistant.reasoning_content = thinking 回传（DeepSeek 协议要求，由 Pi 处理）
tools: [{type:"function", function:{name, description, parameters}}] 固定顺序
```

DeepSeek context caching 服务端全自动，前缀字节级一致才命中（`prompt_cache_hit_tokens`）。

## Tool 提示词归属（REQ-SEND-0001）

- `src/agent/tools.ts` 是 provider-facing 工具用法的唯一权威：参数、组合方式、可见 id、错误与终止语义都放 tool/parameter description；persona 与共享 protocol 只保留环境、消息 grammar、人格与何时回应。
- `send` 是唯一公开 Telegram 通道，`message`/`sticker`/`reply_to` 在一次最终 tool call 内组合。成功 result 是固定 `ok` + `terminate:true`：Pi 仍持久化协议要求的 toolResult，但不再做 follow-up provider request；动态 sent ids 只在 provider 不读取的 details/DB/event。
- `toolsHash()` 覆盖 provider 实际收到的 name + description + parameters + order；label/execute 是本地字段。per-bot tool filter 使用同一 hash grammar。
- v4 当时的两份 deployment persona 合计减少 8,859 bytes，同时删除 shared protocol 的参数示例；tool description 虽增强，稳定 system prefix 仍显著净缩短。当前 HEAD 不再跟踪这些私有 persona，cache golden 改用公开中英模板；生产本机 persona bytes 与 schema v5 未因此改变。每个成功 send 的结果从动态 `ok sent #<id...>` 缩为固定一 token ACK。
- v5 只扩充 send tool/`message` description，参数名、schema形状、工具顺序、system/serialization/summary hash均不变。每次provider请求的稳定prefix增加有界Rich Markdown说明；不新增tool、LLM call或动态tool result token。

## Sticker 目录分区（REQ-STICKER-0001）

**固定目录（stable prefix）**：每 bot 配置 `sticker_sets`（Telegram set name）；启动时 getStickerSet → media 持久化（file_unique_id 身份 + 每 bot file_id 映射）→ rowid 分配 short_id（`s<N>`，与动态候选同命名空间）→ 对当前已持久结果构造一次prompt snapshot，同时用shared Pi runtime在后台补缺失vision。后台completion不重建当前session prefix；只会在未来restart的新snapshot中出现。序列化块为`# Sticker 目录`（配置 set 顺序 + rowid，无 vision 标 `[未识别]`），且只包含当前 bot 在 `media_file_ids` 中确有映射的条目；另一个 bot 的映射不得泄漏。目录内容/可发送性变化 = cache-visible 协议变化 → bump CACHE_SCHEMA_VERSION + 新 epoch。规模上限 120（超限截断 + warn）。

**动态候选（动态 suffix 尾部）**：`Available stickers:` 块保留，只列**上下文出现过、set 外且当前 bot 确有 file_id 映射**的 sticker（set 内 sticker 已在 prefix 里，排除防冗余）；位置约束：必须在全部消息序列之后（R6，测试锁定），不并入 prefix。

**动态媒体 gate**：photo/sticker按identity命中持久cache或以最多2个worker完成一次terminal vision；全部settle后才序列化当前batch。成功描述或确定性fallback都只进入这次新suffix，已exposed entry不重发。photo precache只提前准备≤1 MiB本地显示文件，并与vision共享同一次Telegram download；`media_ready`、`vision_update`、本地转换和catalog后台completion不写Pi session。cache v5 golden因此逐字节不变，新增LLM/vision call与provider token均为0。

**send**：两种来源的 short_id 共用 media 表解析 + 每 bot file_id；无效 id 在发送前结构化报错（REQ-AGENT-0001 R7 协同）。

## 消息序列化 grammar（v1，Phase 3 实现后以此为准）

```
--- 2026-08-07 ---                                  # 日期变化时插入
[17:31:42] #18452 Alice (@alice · tag:admin): 文本
[17:31:55] #18453 Bob (u17) ↪ #18452: 文本
[17:32:19] #18455 Alice (@alice) ↪ #18454 quote="...": @BotA 文本
```

- 时间 HH:mm:ss；日期分隔 `--- YYYY-MM-DD ---`
- `#<telegram message_id>`；无 username 用户分配稳定短 alias `u<N>`
- sender tag / quote / forward / edit 等 optional metadata 只在存在且有信息价值时输出
- reply 父消息不在上下文时带短 reference：`↪ #18452 @alice "片段"`

## Context epoch 与 threshold

- 初始 threshold：**128K tokens**（provisional，依据：compaction 后基础 ≈10K + summary ≈6K，平均每 bot turn 新增 2K–8K）
- compaction 后新 epoch：summary（ persona 导向、倾向"状态"）+ 保留近期消息
- 架构不得硬编码 128K；threshold 在 model config（`compaction_threshold` / `compaction_keep_recent` env）

## Compaction 实现（Phase 8，runtime.ts；REQ-AGENT-0001 修正）

- Pi 自动 compaction 开启：`reserveTokens = max(16384, contextWindow - threshold)`，DeepSeek 1M window 下触发点即 threshold
- 自定义 `session_before_compact` extension：用 `serializeConversation(messagesToSummarize)` + chat-oriented 中文摘要 prompt（状态导向，≤800 字，保留人物关系/未决事项/#id 引用），有 previousSummary 时合并；`completeSimple(model, …, {cacheRetention:"none", maxTokens:4096})`
- 空摘要防护：extension 得到空 summary 时返回 `{cancel: true}`（SDK 会吞掉 handler 异常并回退默认摘要，cancel 是唯一到达失败路径的机制）→ `compaction_end {aborted:true}`，不持久化空摘要
- `compaction_end` → `onCompactionEnd(event)`：**仅成功**（`result` 存在且未 aborted）才 epoch+1 持久化、清 exposure、写 agent_events `compaction`；失败/中止只写 agent_events `error`（stage=compaction），epoch 与 exposure 不动
- exposure 重置与 kept tail 严格对齐：从 `sessionManager.buildContextEntries()`（compaction 后 provider 实际可见的 entry 集合）中的 user message 文本解析锚定行 `^[HH:MM:SS] #<id> ` 得到幸存消息集合；替代旧的「最近 40 条」启发式（kept tail 按 token 保留，条数启发式两个方向都错）。已知限制：群消息文本伪造换行+锚定行可误标个别 id（assistant/tool/custom entry 不解析，模型无法注入）
- keepRecentTokens = `compaction_keep_recent`（默认 20000）

## Threshold 分析脚本

`bun run scripts/analyze-context-window.ts [db]`：重放 llm_runs 遥测，模拟 64K/96K/128K/160K/192K/256K 候选 threshold 的 compaction 次数、miss/turn、read/turn、$/turn。估算工具，不是 runtime 组件。

## Telemetry（每次 provider 请求记录）

bot、model、provider、timestamp、context epoch、context tokens、cache read、cache write、cache miss(=input)、output、reasoning、latency、cost（可算时）、compaction flag；外加 system hash、tool schema hash、ordered provider-message hashes 用于排查意外 miss。secret 不进 telemetry。REQ-UI-0009 的 cache-write schema/IPC 只记录 provider response，不改变任何 provider request/cache-visible bytes。

## 测试结果

- 2026-08-07（50 runs，bots A/B，DeepSeek deepseek-v4-flash）：cache read 734,208 / miss 81,659，**hit ratio 90.0%**；典型 turn read≈14.7K miss≈1.6K，估算 $0.00038/turn
- 2026-08-07 e2e-compaction：`compaction_threshold=1500` 强制两轮触发，compaction → epoch 2→3→4 持久化、exposure 重置、摘要调用成功；重启后 epoch=4 恢复
- 2026-08-07 REQ-STICKER-0001：CACHE_SCHEMA_VERSION 1→2，固定 sticker 目录进入 system prompt（systemA/B 无目录 hash 不变、带目录新 golden 锁定）；daemon 启动检测 schema 版本变化全员开新 epoch；sticker 相关 cache 对比方法：llm_runs 里 system_hash 变化即目录变更，`analyze-context-window.ts` 按 epoch 同步模拟
- 2026-08-08 REQ-STICKER-0002：CACHE_SCHEMA_VERSION 2→3；stable catalog 与 dynamic candidates 都按当前 bot 的 file_id mapping 过滤。合法目录的 hash 不变，已有跨 bot 泄漏行会从 prefix 消失；daemon 下次启动自动为所有 bot 开新 epoch。
- 2026-08-08 REQ-SEND-0001：CACHE_SCHEMA_VERSION 3→4；send 调用知识从 persona/protocol 收口到 tool schema、显式点名不再被 persona silence 覆盖、成功 result 固定最小 ACK、tools hash 补 description。daemon 下次受控重启为所有 bot 开新 epoch。
- 2026-08-08 REQ-UI-0010：**NONE**；只消费 Pi 已产生的 assistant partial并推送到 TUI-only ephemeral IPC/card，不写 session/DB、不改 provider request、tool/system/message/summary grammar。cache schema仍为 4，golden逐字节不变，LLM call/token增量 0。
- 2026-08-08 REQ-TG-0002：**NONE**；群内 `sendChatAction typing` 是 runtime side channel，每active bot每4秒至多一次，不进入DB/session/IPC/provider payload，不改system/tool/message/summary grammar或LLM调用数。cache schema仍为4。
- 2026-08-08 REQ-TG-0003 T10k：**NONE**；新增canonical rich source只留SQLite，既有动态消息位置消费≤32768 code points确定性plain projection；不改system/tool/serialization grammar、消息entry数或LLM调用数，raw JSON不进Pi/provider。cache schema仍为4，golden逐字节不变。T10l的tool description变更再单独bump。
- 2026-08-08 REQ-TG-0003 T10l：**INTENTIONAL**；agent文字改为Rich Markdown并只在send tool schema说明能力，CACHE_SCHEMA_VERSION 4→5、tools hash `631bf05405d1`。systemA/B、serialize、compaction与catalog hash不变；daemon下次启动只开一个新epoch。参数/工具/LLM调用数不变，具体rich source仍不进入provider。
- 2026-08-08 REQ-REPLY-0001 T10o：**NONE**；reply sender/obligation只改变动态消息选择，原`#id`行仍用既有serialization。system/tool/message/summary grammar、schema v5 golden与正常burst调用数不变；只有真实pending reply超过40条时按有界normal batch产生必要的额外call。
- 2026-08-08 REQ-UI-0014 T13l：**NONE**；photo precache、`media.local_path`与additive `media_ready`只存在于Telegram/local SQLite/owner socket/Pi TUI side channel。与vision共享下载但不调用模型；system/tools/messages/summary grammar、context epoch、vision次数与每turn token逐字节不变，schema仍v5。
- cache golden（test/cache.test.ts）：CACHE_SCHEMA_VERSION=5、systemA/B hash、serialize hash、**tools hash（含 description/schema/order）、compaction summary prompt hash** 与 per-bot catalog filter 全部锁定；**注意 bun test 强制 UTC，测试 pin TZ=Asia/Singapore 与生产一致**
- 分析脚本（REQ-TEST-0001 R5）：llm_runs 的 epoch/compaction 列与 >30% context 回落都被视为真实 compaction 并同步模拟 context；60 runs 回放识别 3 次真实 compaction（e2e 遗留 epoch 1→4），幻影触发 0
