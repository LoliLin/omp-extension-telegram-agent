# PLAN-20260807-flush-state-machine: agent 触发/flush 生命周期串行状态机

- **Status:** Done
- **Requirements:** REQ-AGENT-0001

## 结果

`trigger → flush → agent run` 收敛为 BotRuntime 持有的串行状态机：flush 进入即占位、重入只合并为 pending、全链路异常只落 agent_events error；compaction 失败/中止/空摘要不错切 epoch；exposure 重置与实际 kept tail 严格对齐；search 有 10s 超时；send 先校验后发送。

## 现状摸底

- 生产实证：`flush()` 可重入（trigger 只看 SDK `agent_start` 置位的 `running`，vision await 窗口最长 90s）、`markExposed` 先于 `sendUserMessage`（send 失败 = 持久失忆）、两处 `void this.flush()` 无 catch。
- SDK 契约（../pi @ f562a1a 源码确认）：
  - `compaction_end` payload = `{ reason, result: CompactionResult|undefined, aborted, willRetry, errorMessage? }`；失败/中止时 `result === undefined`。
  - `sendUserMessage` 的 promise 在整个 run（含自动 compaction）结束后才 resolve；只有 preflight 失败（无 auth / compaction 进行中 / streaming 中无 deliverAs）才 throw，throw 时 user entry 未落盘 → 重试安全。
  - **extension runner 会吞掉 handler 异常**（emitError 后继续），`session_before_compact` handler throw 不等于失败路径——会静默回退 Pi 默认摘要。正确的「拒绝」机制是返回 `{ cancel: true }`，SDK 随后发 `compaction_end { aborted: true, result: undefined }`。
  - `session.sessionManager.buildContextEntries()`（public、同步）在 compaction_end 时已反映新状态：`[compaction entry, ...kept tail（从 firstKeptEntryId 起）, ...之后的 entry]`——即 provider 实际可见的 entry 集合。
- kept tail 对齐方案：解析 context 内 user-role message entry 文本里我们自己序列化 grammar 的锚定行 `^[HH:MM:SS] #<id> `，反推幸存 message_id 集合。SDK 不提供 entry→telegram id 的映射，这是能与 provider 实际可见内容严格对齐的最直接来源。已知残余风险：用户消息文本伪造锚定行（换行 + `[HH:MM:SS] #id `）会造成个别 id 误标 exposed（丢失至下次 compaction 前不可见）；assistant/toolResult/custom entry 不参与解析，无注入面。

## 方案

状态机（BotRuntime 单所有者）：`idle →(trigger) flushing →(flush 完成且无 pending) idle`；flushing 期间的 trigger 只置 `pendingTrigger`，flush 循环结束后统一再跑一轮（burst 合并语义不变）。`flushing` 在 trigger 内同步置位，不等任何 SDK 事件。`stop()` 置 `stopping` 并有界等待在途 flush（30s）再 dispose。

Cache impact: NONE——不改 system prompt / 序列化 grammar / tool schema / tool 顺序；provider 可见字节零变化。

## 任务

- [x] **T1** — runtime.ts：flush 串行状态机（flushing/pendingTrigger/stopping）、markExposed 后移、全链路 catch、stop 有界等待; validates: AC1, AC2
- [x] **T2** — runtime.ts：compaction_end 成败区分 + kept tail 解析对齐 + 空摘要 cancel; validates: AC3, AC4
- [x] **T3** — search.ts 超时 + 响应护栏、runtime search tool 结构化错误; validates: AC5
- [x] **T4** — executeSend 先校验后发送; validates: R7
- [x] **T5** — 回归测试 test/flush.test.ts（AC1–AC4）+ search 超时/护栏测试 + R7 测试; validates: AC1–AC6
- [x] **T6** — 文档同步（architecture/cache/devlog/handoff/testing/REQ-LIST）+ 签名提交

## 完成记录

- 行为与测试签名提交：`a549335`；REQ-AGENT-0001已在总清单完成。
- 后续全量基线持续覆盖flush/compaction/search/send invariant；计划归档不改变行为。
- Cache impact：**NONE**。

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| 目标 | `bun test test/flush.test.ts` | T1–T5 / AC1–AC5 |
| 全量 unit | `bun test` + `bun run check` | 全部 |
| cache golden | `bun test test/cache.test.ts` | Cache impact NONE |
| e2e | `bun run scripts/e2e-compaction.ts`（若 .env 可用） | compaction 真实路径 |

## 风险与失败模式

- 风险: kept tail 解析漏 id（grammar 变化后 regex 失配）→ 消息重复序列化
  - 怎么发现: cache golden + AC4 测试断言精确 id 集合
  - 怎么缓解: regex 锚定完整行首格式；grammar 改动必须 bump CACHE_SCHEMA_VERSION，golden 会报警
- 风险: stop() 30s 截断在途 run → 重启后该批消息重复序列化一次
  - 怎么发现: daemon.log shutdown 时序
  - 怎么缓解: markExposed 紧跟 sendUserMessage resolve，窗口极小；30s 仅兜底卡死

## 迁移 / 兼容性

无持久格式变化（exposed_ids / context_epoch 的 bot_state key 语义不变）。重启后第一个 trigger 正常重放未曝光消息。
