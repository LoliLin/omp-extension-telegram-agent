# Cache 工程

## Invariants

1. 稳定 prefix 区域（变化频率极低）：system prompt（persona + 群聊行为规则 + 消息 grammar 说明 + 格式化规则）、tool schema、tool 顺序
2. 动态内容只以新 suffix 追加，永不改写已存在的 prefix
3. 历史消息序列化 grammar 固定；已序列化过的消息内容永不变化
4. compaction 是唯一的 cache boundary（新 Context Epoch）
5. UI/TUI 功能不得影响 provider payload（UI-only 改动若改变 provider prefix = 边界设计 bug）

## CACHE_SCHEMA_VERSION

当前：**1**

cache-visible protocol：system prompt shape、persona serialization、tool schema、tool order、消息序列化 grammar、compaction summary grammar。

修改任一 → bump version → 新 context epoch（明确的一次性 cache reset，而非每轮莫名 miss）。

## Provider payload 结构（DeepSeek via openai-completions）

```
system: persona prompt（单字符串）
messages: user/assistant/tool 序列
  assistant.content = 纯字符串
  assistant.reasoning_content = thinking 回传（DeepSeek 协议要求，由 Pi 处理）
tools: [{type:"function", function:{name, description, parameters}}] 固定顺序
```

DeepSeek context caching 服务端全自动，前缀字节级一致才命中（`prompt_cache_hit_tokens`）。

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
- 架构不得硬编码 128K；threshold 在 model config

## Telemetry（每次 provider 请求记录）

bot、model、provider、timestamp、context epoch、context tokens、cache read、cache miss(=input)、output、latency、cost（可算时）、compaction flag；外加 system hash、tool schema hash、ordered provider-message hashes 用于排查意外 miss。secret 不进 telemetry。

## 测试结果

（暂无，Phase 3 起记录真实 cache hit/miss 数据）
