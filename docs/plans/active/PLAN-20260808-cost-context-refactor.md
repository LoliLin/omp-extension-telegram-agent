# PLAN-20260808-cost-context-refactor: 重构长期群聊上下文与成本边界

- **Status:** Active
- **Requirements:** `docs/requirements/review-260808.md`（`REQ-LIST.md` 的“重构”工作项）

## 结果

Telegram 历史由不可变事件与 per-bot 单调 cursor 增量消费，Pi context 只保留真正可见的结构化引用；compaction 不再重放已消费历史。每轮输入按 token 预算有界打包，session 按全部 cache-visible 配置的 fingerprint 隔离，provider payload 可按段诊断，默认工具、reasoning、vision 与 sticker 候选遵循成本优先策略。路由、编辑、vision completion、assistant persistence 与 retention 都保持幂等、有界、append-only，并由离线测试和 CI 覆盖。

## 现状摸底

- `BotRuntime.flush()` 每轮读取整个 `messages` 表，再以 epoch-local `exposed_ids` 过滤；compaction 会清空该集合并从渲染文本正则恢复，因而消费状态与可见状态混用。
- `messages` 保存最新投影，`message_revisions` 保存旧版本，但没有 provider-facing immutable delta log；edit/enrichment 不具备单调消费位置。
- Pi 0.84.1 已提供 `context`、`before_provider_request`、`message_end`、`session_before_compact` hooks 与带 `details` 的 custom message；当前仅 compaction 使用 inline extension。
- `llm_runs.messages_hash` 已建列但未写入；cache schema bump 在 session 恢复之后发生，只改变 telemetry epoch。
- 现有配置默认继承 Pi reasoning、默认启用 search/run_js，并无 deployment-wide vision budget。为兼容既有本机配置，旧省略字段仍可读取，但新生成配置和文档默认改为显式、成本优先。
- 工作树已有用户改动：新增本评审文件并在 `REQ-LIST.md` 添加未完成入口；实现不得覆盖其内容，只修正链接、状态和完成记录。

## 方案

在 `src/db/` 增加 immutable message events、bot cursors、session manifests、routing claims 与 retention helpers；canonical `messages` 继续作为 Telegram/UI 最新读模型。Agent 侧用结构化 Pi custom message 承载选中事件与可见 id，extension 在 provider context 边界投影固定 grammar，compaction details 恢复 visible refs，cursor 永不回退。batch selector 以模型窗口、当前 context、输出/工具 reserve 和确定性 token 估算打包，并记录选择 telemetry。

Session 初始化先计算内容寻址 fingerprint，再决定打开 manifest 指向的 session 或创建新 session；`CACHE_SCHEMA_VERSION` 仅作为 fingerprint 的强制失效字段。固定 extension 顺序为 context、compaction、payload observer、assistant persistence。sticker catalog 改为本轮本地 top-K 动态候选，不再扩大稳定 system prefix。所有 provider-visible grammar 变化合并为 cache schema v8，并由 golden 锁定。

## 任务

- [x] **T0** — 收录 review、建立 active PLAN，并把“大任务默认拆成多个小原子提交”写入根 agent 指南；validates: 可执行提交边界与追溯入口；预期涉及: `AGENTS.md`, `docs/requirements/`, `docs/plans/active/`
- [x] **T1** — 建立 durable context state：immutable message event log、per-bot cursor/visible refs/session manifest、routing claims、migration/backfill 与索引；edit/enrichment/vision 只能追加 delta；validates: P0-1、P0-2、P2-1、P2-2；commit: `dbdc438`
- [x] **T2** — 建立有界成本原语：token packer、deployment-wide vision scheduler/budget、retention helper、搜索输出上限、sticker top-K、本地配置与相关单测；validates: P0-3、P1-2、P1-3、P1-4、P1-5、P1-6、P2-3；commit: `15c82cc`
- [x] **T3** — 定义固定顺序 Pi extension、结构化 Telegram context projection、完整 fingerprint、payload HMAC observer 与 assistant persistence policy，并用纯协议测试锁定；validates: 2.2 A–D、P0-4、P1-7；commit: `f50f10d`
- [x] **T4** — 集成 runtime/daemon context generation：cursor commit/reconcile、compaction visibility、session 轮换、公共协议顺序、cache schema v8、routing claim、vision/retention maintenance 与真实 telemetry；validates: 2.2 A–E、P0-4、P1-1、P1-2、P1-3、P1-7；预期涉及: `src/agent/runtime.ts`, `src/daemon/`, runtime/cache tests
- [ ] **T5** — 加入固定 Bun/Pi 的核心 CI，独立执行 cache golden、全量离线测试与 TypeScript check；validates: review 第一阶段、P2-4；预期涉及: `.github/workflows/ci.yml`
- [ ] **T6** — 同步 architecture/cache/data-model/testing/config/user docs、devlog/handoff/REQ 状态，执行全量验证并审阅 diff；validates: 全部评审不变量与完成定义；预期涉及: `docs/`, `README*`, examples

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| 状态与 DB | `bun test test/db.test.ts test/ingest.test.ts test/flush.test.ts test/reply-delivery.test.ts test/router.test.ts` | T1 / cursor、delta、claim、bounded query |
| Agent/cache | `bun test test/agent.test.ts test/cache.test.ts test/config.test.ts test/vision.test.ts test/sticker.test.ts` | T2–T4 / hooks、fingerprint、packing、budget、golden |
| 全量 unit | `bun test` + `bun run check` | T1–T6 |
| 文档 | `bun run docs:check` | T6 |
| 查询计划 | `EXPLAIN QUERY PLAN` fixture + 大历史 replay | `(chat_id, ingest_seq)` 索引与历史量无关 |
| e2e | 不自动执行；真实 provider/Telegram 需用户另行明确授权 | session rotation、真实成本/延迟 |

## 风险与失败模式

- 迁移把旧 canonical 历史错误地当成 fresh：迁移 cursor 初始化到 backfill max seq，旧 session 一律由 fingerprint 隔离；测试 existing DB upgrade。
- cursor 在 context 写入前失败后前移造成丢消息：SQLite 只在 custom message 已持久化或启动 reconcile 能证明其存在后推进；provider 失败后的已持久 entry 仍在下一轮 context，obligation 则只凭独立 commit marker 清理。
- overflow direct reply 被截断或丢弃：obligation 最高优先，每批可继续 drain；单条只截正文并保留 identity/头尾。
- hook 修改 tool-call assistant 破坏 provider 协议：assistant policy 保留 toolCall/toolResult 链，只规范无 tool-call prose 与 send 附带 prose。
- fingerprint 或 telemetry 保存敏感正文：canonical JSON 仅在内存参与 deployment-local HMAC，SQLite 只保存 hash/索引/计数。
- vision budget 使已有部署行为突变：显式 `vision.enabled` 控制；旧配置显式写了 `auxiliary_visual_model` 时兼容启用，新模板默认关闭。

## 迁移 / 兼容性

- schema migration 幂等创建新表/列/索引，并从现有 `messages` backfill immutable baseline；所有 bot cursor 初始化到 backfill 水位，避免重放旧历史。
- 旧 `exposed_ids` 不再决定消费或可见性；fingerprint 不匹配时直接建立新 session/epoch，初始化完成后删除该 legacy key。
- 没有 matching manifest/fingerprint 的旧 session 保留在磁盘但不恢复；新 manifest 原子指向新 session，不删除用户数据。
- IPC 和 Telegram canonical message 读模型保持兼容；新增 telemetry 字段 additive。

## Cache impact

**INTENTIONAL**：公共 protocol/persona 顺序、Telegram custom-message grammar、edit/media delta、sticker suffix 与 assistant silence policy 都改变 provider-visible bytes。`CACHE_SCHEMA_VERSION` 7→8，fingerprint 自动建立新 session/context epoch；更新 `docs/cache.md` 与 cache golden。目标是缩短公共 prefix、消除 compaction 后历史重放并严格限制每 turn suffix；不会新增固定 provider call。

## 文档更新

- [ ] `docs/architecture.md`、`docs/cache.md`、`docs/data-model.md`、`docs/testing.md`
- [ ] 配置 example、双语 README/user guide/runbook
- [ ] `docs/devlog.md`、`docs/handoff.md`、`docs/requirements/REQ-LIST.md`

## 完成记录

- 验证证据: 待完成
- 需求状态已更新: no
- 后续工作项: 待最终验证后填写
