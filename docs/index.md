# 文档索引

## 规范性文档

- `../AGENTS.md` — agent 路由、安全、验证入口（常载）
- `project.md` — 项目目标、约束、术语
- `architecture.md` — 稳定的架构边界与 invariant
- `cache.md` — provider cache 工程：prefix invariant / CACHE_SCHEMA_VERSION / telemetry
- `data-model.md` — SQLite schema 与去重规则
- `requirement.md` — 主需求文档（Phase 1–9 基线）
- `requirements/` — 新需求（**总清单 `REQ-LIST.md`**，模板 `REQ-TEMPLATE.md`）
- `plans/active/` — 进行中工作的执行状态；完成后移到 `plans/completed/`（模板 `plans/PLAN-TEMPLATE.md`）
- `adr/` — 长期架构决策（模板 `ADR-TEMPLATE.md`）
- `engineering/development-guide.md` — **LLM 开发指南，日常开发流程以此为准**
- `engineering/documentation-guide.md` — 文档写作规范
- `engineering/traceability.md` — 需求 ↔ 计划 ↔ 提交 追溯
- `testing.md` — 测试策略、规范命令、当前状态

## 过程性文档

- `handoff.md` — 当前状态与新 agent 入口，始终保持短
- `devlog.md` — append-only 变更记录
- `research.md` — Pi 研究结论（对应 `../pi` @ f562a1a）
- `runbooks/` — 可重复操作流程（daemon 运维、数据恢复等）

## 写作规则

- 一个事实一个权威来源，其余地方链接而不是复制。
- 稳定事实放 architecture / cache / data-model；易变执行状态放 plans / handoff。
- 明确写清每篇文档的适用范围。
- 规范用词用 MUST / SHOULD / MAY；规范必须可验证或可 review。
- 模糊成本高的地方给具体例子。
