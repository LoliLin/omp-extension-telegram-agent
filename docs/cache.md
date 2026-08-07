# Cache 工程

## Invariants

1. 稳定 prefix 区域（变化频率极低）：system prompt（persona + 群聊行为规则 + 消息 grammar 说明 + 格式化规则）、tool schema、tool 顺序
2. 动态内容只以新 suffix 追加，永不改写已存在的 prefix
3. 历史消息序列化 grammar 固定；已序列化过的消息内容永不变化
4. compaction 是唯一的 cache boundary（新 Context Epoch）
5. UI/TUI 功能不得影响 provider payload（UI-only 改动若改变 provider prefix = 边界设计 bug）

## CACHE_SCHEMA_VERSION

当前：**2**（v2：固定 sticker 目录块进入 system prompt，REQ-STICKER-0001）

cache-visible protocol：system prompt shape、persona serialization、tool schema、tool order、消息序列化 grammar、compaction summary grammar、**固定 sticker 目录块**。

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

## Sticker 目录分区（REQ-STICKER-0001）

**固定目录（stable prefix）**：每 bot 配置 `sticker_sets`（Telegram set name）；启动时 getStickerSet → media 持久化（file_unique_id 身份 + 每 bot file_id 映射）→ rowid 分配 short_id（`s<N>`，与动态候选同命名空间）→ vision 预识别（复用懒 vision 缓存，重启零重复下载）。序列化为 system prompt 内稳定块：`# Sticker 目录`（配置 set 顺序 + rowid，无 vision 标 `[未识别]`）。目录内容变化 = cache-visible 协议变化 → bump CACHE_SCHEMA_VERSION + 新 epoch。规模上限 120（超限截断 + warn）。

**动态候选（动态 suffix 尾部）**：`Available stickers:` 块保留，只列**上下文出现过的 set 外** sticker（set 内 sticker 已在 prefix 里，排除防冗余）；位置约束：必须在全部消息序列之后（R6，测试锁定），不并入 prefix。

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

bot、model、provider、timestamp、context epoch、context tokens、cache read、cache miss(=input)、output、latency、cost（可算时）、compaction flag；外加 system hash、tool schema hash、ordered provider-message hashes 用于排查意外 miss。secret 不进 telemetry。

## 测试结果

- 2026-08-07（50 runs，bots A/B，DeepSeek deepseek-v4-flash）：cache read 734,208 / miss 81,659，**hit ratio 90.0%**；典型 turn read≈14.7K miss≈1.6K，估算 $0.00038/turn
- 2026-08-07 e2e-compaction：`compaction_threshold=1500` 强制两轮触发，compaction → epoch 2→3→4 持久化、exposure 重置、摘要调用成功；重启后 epoch=4 恢复
- 2026-08-07 REQ-STICKER-0001：CACHE_SCHEMA_VERSION 1→2，固定 sticker 目录进入 system prompt（systemA/B 无目录 hash 不变、带目录新 golden 锁定）；daemon 启动检测 schema 版本变化全员开新 epoch；sticker 相关 cache 对比方法：llm_runs 里 system_hash 变化即目录变更，`analyze-context-window.ts` 按 epoch 同步模拟
- cache golden（test/cache.test.ts）：CACHE_SCHEMA_VERSION=1、systemA/B hash、serialize hash、**tools hash（含顺序）、compaction summary prompt hash** 全部锁定（REQ-TEST-0001 R2 补全）；**注意 bun test 强制 UTC，测试 pin TZ=Asia/Singapore 与生产一致**
- 分析脚本（REQ-TEST-0001 R5）：llm_runs 的 epoch/compaction 列与 >30% context 回落都被视为真实 compaction 并同步模拟 context；60 runs 回放识别 3 次真实 compaction（e2e 遗留 epoch 1→4），幻影触发 0
