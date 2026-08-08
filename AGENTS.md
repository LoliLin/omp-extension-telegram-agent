# Agent 指南（仓库根）

本文件是编码 agent 的常载路由与安全指南。保持短、稳定、高信号；详细知识放链接文档，不要在这里展开。

## 1. 仓库地图

- 项目说明与核心目标：`docs/project.md`
- 架构边界与 invariant：`docs/architecture.md`
- 文档索引：`docs/index.md`
- 开发流程（LLM 开发指南，日常开发以此为准）：`docs/engineering/development-guide.md`
- 当前状态 / 新 agent 入口：`docs/handoff.md`（动手前必读，保持短）
- 主需求文档：`docs/requirement.md`；新需求：`docs/requirements/`（**总清单 `REQ-LIST.md`，完成打勾**；模板 `REQ-TEMPLATE.md`）
- 进行中的计划：`docs/plans/active/`（模板 `docs/plans/PLAN-TEMPLATE.md`）
- 架构决策：`docs/adr/`（模板 `ADR-TEMPLATE.md`）
- Cache 工程（provider prefix invariant）：`docs/cache.md`
- 数据模型：`docs/data-model.md`
- 测试策略、命令、当前状态：`docs/testing.md`
- 文档写作规范：`docs/engineering/documentation-guide.md`
- 追溯规则：`docs/engineering/traceability.md`
- 变更记录：`docs/devlog.md`（append-only）

## 2. 指令优先级

1. 用户 / 任务的显式要求
2. 本文件
3. 链接的架构、cache、测试、需求文档

两条指令冲突时，停下报告冲突，不要自行裁决。

## 3. 动手前（非平凡改动）

1. 读 `docs/handoff.md` 和相关需求。
2. 只读理解受影响边界所必需的架构 / cache / data-model 章节，不要把无关文档塞进上下文。
3. 先搜现有模式，再考虑引入新模式。
4. 确定覆盖本次改动的验证命令（`docs/testing.md`）。
5. 多文件、跨边界、改持久格式或行为变化的工作：先建 `docs/plans/active/PLAN-*.md` 再实现。

## 4. 改动路由

把行为放进拥有该职责的层；不要为解决归属不确定而新建共享抽象。

- Telegram API / 轮询 / normalize → `src/telegram/`
- schema / 持久化 → `src/db/`（改 schema 必须带 migration 并更新 `docs/data-model.md`）
- 序列化 grammar / prompt / routing / session 生命周期 / compaction → `src/agent/`
- 进程管理 / IPC server → `src/daemon/`、`src/ipc.ts`
- TUI → `src/tui/`（UI-only 改动不得影响 provider payload，见 `docs/cache.md` invariant 5）
- 工具（search / run_js / 未来工具）→ `src/tools/`，注册顺序固定在 `src/agent/runtime.ts`

归属不清时先查 `docs/architecture.md` 和现有调用点。

## 5. 硬约束

- **Cache invariant**：永不改写已存在的 provider prefix；动态内容只以新 suffix 追加；cache-visible 协议（system prompt shape / persona 序列化 / tool schema / tool 顺序 / 消息序列化 grammar / 摘要 grammar）任一变化必须 bump `CACHE_SCHEMA_VERSION`、开新 context epoch、同步 `docs/cache.md`。
- Secret 不进日志、telemetry、测试 fixture、commit。`.env` 不入库。
- 不得为了让验证通过而削弱测试、类型检查或安全控制（如 run_js sandbox 限制）。
- 不改 SQLite 持久格式、IPC 协议、消息序列化 grammar，除非有明确需求 + 兼容方案 + 文档更新。
- 不做破坏性 git 操作（`reset --hard` / force push / 改写历史）。
- 提交不夹带无关清理；保留任务范围之外的用户改动。

## 6. 实现规则

- 满足验收标准的最小改动；复用现有抽象，不过早泛化。
- **任何功能必须评估 cache hit 率与 token 成本影响**：确定性内容进稳定 prefix 而非动态 suffix；能用确定性代码解决的不花 LLM token；每 turn 新增 token 有界（细则见 `docs/engineering/development-guide.md` 第三节）。
- Provider-facing 工具的参数、调用方法、错误/终止语义只在 `src/agent/tools.ts` 的 tool description / parameter schema 维护；persona 与共享 system protocol 只描述环境和行为，不复制工具参数表或调用示例。改 tool description 也属于 cache-visible protocol，必须 bump schema 并更新 golden。
- 行为变化与机械重构尽量分开提交。
- 行为变化加 / 更新测试；能确定性复现的 bug 必须有回归测试。
- Agent / LLM 行为测可观察的轨迹与结果，不断言 prompt 字符串。
- Provider context 必须有界：不把无界历史、日志、工具输出塞进模型可见内容。
- 注释只写非显然的理由，不复述语法。
- 接口、invariant、工作流、架构边界变化时同步更新文档。

## 7. 验证漏斗（由便宜到贵）

1. `bun test <相关文件>` → `bun test`（unit + replay，不触网络）
2. `bun run check`（tsc --noEmit）
3. 相关 e2e 脚本（`scripts/e2e-*.ts`，需 `.env`，触真实服务）
4. 真实群观察 / 长运行 smoke（跨边界或稳定性改动才需要）

规范命令以 `docs/testing.md` 为准；仓库已有脚本时不要猜底层命令。

## 8. 完成定义

任务不算完成，直到：

- 验收标准全部满足；相关测试通过；`bun run check` 通过。
- diff 不含无关改动。
- 契约或工作流变化已同步文档。
- `docs/devlog.md` 追加一条（含 cache impact 评估：NONE / INTENTIONAL + 理由）。
- `docs/handoff.md` 更新为最新状态。
- 明确报告未验证区域、遗留风险与假设。

## 9. 提交与追溯

- 用户授权提交后，**大任务必须先在 PLAN 中拆成 commit-sized tasks**：一个 task 只产生一个可独立审查、可独立回滚且通过目标验证的行为变化。测试与该行为必需的文档属于同一 commit；机械重构、无关清理、不同需求不得混入。
- 每个 task 完成后立即提交，不得把多个已完成 task 留到最后压成一个大 commit。提交前只显式暂存本 task 路径/patch（脏工作树禁止 `git add -A`），检查 `git diff --cached` 与 `git status --short`，并先跑该 task 的目标测试；整项任务结束再跑全量验证。
- 所有授权提交必须签名（repo 已配 `scripts/git-gpg.sh` 为 `gpg.program`）；签名失败时停下诊断，不得改成 unsigned commit。不得用 amend/rebase 把已完成的原子提交重新揉在一起，除非用户明确要求改写历史。
- Commit subject 采用 `<Imperative verb> <concrete code outcome>`：英文祈使句、首字母大写、无句号、建议不超过 72 字符；描述代码结果，不写空泛的 “update/fix stuff”，不把 REQ/PLAN 标题当 subject。可选 body 解释非显然的 why / invariant / 验证，subject 与 body、body 与 trailer 之间各空一行。
- 有对应 REQ 的 commit 末尾必须写 `Requirement:`；有 active PLAN task 的必须写 `Task:`；纯机械且无 REQ 的 commit 用 `Work-Type: mechanical`。精确格式、示例与查询命令见 `docs/engineering/traceability.md`。

## 10. 已知坑

- `bun test` 强制 UTC：涉及时间序列化的测试必须 pin TZ（参考 `test/cache.test.ts`，生产为 Asia/Singapore）。
- Bun `socket.write` 返回**字节数**且可能部分写入：必须 TextEncoder 编码成 Uint8Array 后按字节偏移排队写（参考 `src/ipc.ts`）。
- `.env` 是 `key: value` 冒号格式，由 `src/config.ts` 自己解析，不是 dotenv 的 `KEY=value`；首选 ignored `telegram.config.ts`，legacy `bots.config.json` 仍兼容，两份默认文件不得并存。
- Pi 依赖精确锁定 registry `0.84.1`；`bun run pi` 缺依赖时会先执行 frozen-lockfile bootstrap。开发 sibling `../pi` 不参与解析，升级四个 Pi package 时必须同一原子提交更新 manifest、lock 与兼容性测试。
- sticker short_id 用 rowid 分配，不要用 COUNT+1（并发/删除下撞号）。

## 11. 指南更新规则

单次失误不加规则。新增 / 修改规则须满足：非显然、会复发、可执行、足够稳定、放在最窄适用范围。能机械强制的规则优先做成测试 / lint / schema check，而不是文字。
