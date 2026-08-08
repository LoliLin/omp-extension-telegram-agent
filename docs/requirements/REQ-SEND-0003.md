# REQ-SEND-0003: 本轮 provider 可见消息可被精确回复

- **Status:** Done
- **Priority:** P0
- **Source:** 2026-08-09 生产 SQLite 与 `agent_events` 诊断

## 问题

最近生产上下文显示 Telegram create 与普通 `send` 均正常，但模型对本轮刚进入 provider suffix 的消息调用 `send(reply_to=...)` 时，本地前置校验连续返回 `messaging.reply_not_visible`。模型随后只能再调用一次不带 `reply_to` 的 `send`，公开消息虽能发出，却失去 Telegram 原生引用关系并额外消耗一次 tool follow-up。

根因是 `sendCustomMessage(..., { triggerTurn: true })` 会在 promise 返回前执行完整 provider turn 与工具调用，而 runtime 只在该 promise 返回后才把本批 `visibleMessageIds` 加入内存集合。

## 目标

模型在同一 provider turn 内可精确引用本轮 suffix 中完整可见的消息；未提交或已被 token packing 丢弃的消息仍不得引用。

## 非目标

- 不强制概率触发的每个 turn 都公开发言。
- 不改变 Telegram API 的失败、重试或 commit boundary。
- 不改变 direct-reply obligation、routing、compaction 或 provider context grammar。

## 需求

- **R1:** 触发 provider turn 前，本轮 `packed.visibleMessageIds` 必须可供同 turn 的 `send.reply_to` 前置校验使用。
- **R2:** provider 提交失败时，临时可见性必须回滚到 session/SQLite 已提交状态，消息仍可在后续 trigger 重试。
- **R3:** token packing 未完整暴露的消息和任意未知 message id 必须继续在任何 Telegram create 前被拒绝。

## 验收标准

- **AC1:** Given 新消息被完整打包进 custom context，when fake provider 在 `sendCustomMessage` 返回前执行 `send(reply_to=<该消息>)`，then Telegram create 恰好一次且保留该 `reply_to`。
- **AC2:** Given custom context provider submit 抛错，when flush settle，then cursor/持久 visibility 不前进，内存临时 visibility 也被移除；后续 trigger 可重试该消息。
- **AC3:** 既有未知/不可见 id 的 preflight 回归保持零 Telegram create。

## 约束

- Cache impact: **NONE**；不改 system/persona、tool schema/description/order、serializer 或 provider suffix 字节。
- 兼容性: 不改 SQLite 持久格式、IPC 协议或消息 grammar。
- 性能 / token 成本: 不新增模型调用或 provider token；成功精确回复可避免当前失败后的额外 tool follow-up。
- 安全 / 隐私: 测试使用内存数据库与 fake Telegram，不复制生产消息正文。
- 数据 / 迁移: 无。
- 运维: 修复需在下一次受控 daemon restart 后生效。

## 例子与边界 case

- 当前 batch 含 `#42` 且完整可见：同 turn 的 `reply_to: 42` 合法。
- `#42` 因普通 backlog token overflow 未被选入 suffix：`reply_to: 42` 仍拒绝。
- provider 在工具调用前失败：`#42` 不得残留为可见，后续 flush 仍提交它。

## 可观察性

沿用 `agent_events.tool_call/tool_result/send` 与 `llm_runs.tool_followup_rounds/public_send_count`；不新增动态 telemetry 字段。

## 文档影响

同步 `docs/architecture.md`、`docs/testing.md`、`docs/devlog.md` 与 `docs/handoff.md`。

## 待决问题

无。

## 追溯

- Plans: `../plans/completed/PLAN-20260809-reply-visibility.md`
- Commits: 从 `Requirement: REQ-SEND-0003` git trailer 查；当前用户未授权提交。
