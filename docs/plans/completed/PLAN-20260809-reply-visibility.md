# PLAN-20260809-reply-visibility: 修复同轮精确回复可见性

- **Status:** Done
- **Requirements:** REQ-SEND-0003

## 结果

本轮 custom context 中完整可见的消息在 provider 执行工具时即可被 `reply_to` 引用，提交失败则恢复既有 durable context 状态。

## 现状摸底

- 生产 SQLite 显示最近 Telegram create 正常，模型也频繁调用 `send`；失败集中为本地 `messaging.reply_not_visible`。
- `flush()` 当前在 `await session.sendCustomMessage(... triggerTurn:true)` 返回后才更新 `visibleMessageIds`，但 Pi 在 await 内完成 tool execution。
- durable cursor/visibility 必须继续只在 provider submission 成功后由 `commitConsumedContext()` 原子推进。

## 方案

在 `BotRuntime.flush()` 中仅对 `packed.visibleMessageIds` 建立 turn-local 内存可见性，再触发 provider。成功后沿用现有 durable commit；失败时通过已有 structured session reconciliation 恢复 authoritative state。复用现有集合与 reconcile 路径，不增加数据库表、协议或抽象。

## 任务

- [x] **T1** — 增加同-turn reply 与 provider-failure rollback 回归，实施最小 runtime 修复并同步需求/架构/测试/交接文档；validates: AC1–AC3；预期涉及: `src/agent/runtime.ts`, `test/flush.test.ts`, `docs/`

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| 目标 | `bun test test/flush.test.ts test/context-refactor.test.ts test/send-commit.test.ts` | AC1–AC3 |
| cache | `bun test test/cache.test.ts` | provider-visible bytes 未变 |
| 全量 unit | `bun test` + `bun run check` | 全回归与类型 |
| 文档 | `bun run docs:check` | 链接与构建 |
| 真实群 | 只读历史证据；不调用 provider/Telegram | 根因与边界确认 |

## 风险与失败模式

- 风险: provider submit 失败后临时 id 残留，允许引用未提交上下文。
  - 怎么发现: fault-injection test 同时断言内存、SQLite cursor 与 visibility。
  - 怎么缓解: catch 中复用 structured session reconciliation，不从文本推断。
- 风险: 为修 reply 改动 provider-visible协议。
  - 怎么发现: cache golden。
  - 怎么缓解: 只改 runtime 本地时序。

## 迁移 / 兼容性

无 schema、IPC 或 grammar 变化；现有数据库无需迁移。

## Cache impact

NONE。provider 接收同一 suffix；只修正该 turn 内本地 tool preflight 的时序。

## 文档更新

- [x] architecture / testing / devlog / handoff / REQ-LIST

## 完成记录

- 验证证据: targeted 35 pass / 357 assertions；全量444 pass / 5128 assertions；typecheck、cache v8 golden 7/7、文档门禁通过。
- 需求状态已更新: yes
- 后续工作项: 用户明确授权后受控restart并做一次真实群精确引用smoke；当前不阻塞离线AC。
