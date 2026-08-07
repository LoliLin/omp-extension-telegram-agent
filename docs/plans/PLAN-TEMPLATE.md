# PLAN-<YYYYMMDD>-<slug>: <标题>

- **Status:** Proposed | Active | Blocked | Done
- **Requirements:** REQ-...（没有对应 REQ 的临时工作可留空，但要写清来源）

## 结果

一段话描述计划完成时什么东西会存在。

## 现状摸底

只记录会实质影响实现的发现：归属、现有模式、约束、隐藏耦合、迁移状态、已知的坑。

## 方案

描述设计，以及它为什么满足需求。链接 architecture / ADR，不要复制内容。

## 任务

- [ ] **T1** — <内聚任务>; validates: AC1; 预期涉及: <文件/目录>
- [ ] **T2** — <内聚任务>; validates: AC2; 预期涉及: <文件/目录>

任务小到通常一个 commit 对应一个任务。

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| 目标 | `bun test test/<file>` | T1 / AC1 |
| 全量 unit | `bun test` + `bun run check` | T1–T2 |
| e2e | `bun run scripts/e2e-*.ts` | 边界行为 |
| 真实群 / 长跑 | <具体观察方式> | 稳定性 |

## 风险与失败模式

- 风险:
  - 怎么发现:
  - 怎么缓解:

## 迁移 / 兼容性

涉及持久格式、IPC 协议、序列化 grammar 时，写清顺序和向后兼容。

## Cache impact

NONE / INTENTIONAL（说明 bump 策略与 golden 更新点）。

## 文档更新

- [ ] ...

## 完成记录

- 验证证据:
- 需求状态已更新: yes/no
- 后续工作项:

完成后把计划移到 `docs/plans/completed/`，有用的执行历史不删。
