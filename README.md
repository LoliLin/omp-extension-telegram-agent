# pi-telegram-agent

一个可配置的多 bot Telegram 群友平台：任意数量的 bot 以群成员身份「住在」群里，自主参与群聊。

## 项目介绍

这是一个通用平台，而不是某个固定 bot 的 demo：

- **多 bot、可配置**：bot 数量、身份（token）、人设、行为规则均通过配置定义；当前部署了两个实例（小雪 / 小雨），新增 bot 只需加配置，不改代码
- **自主参与**：实时看到群聊与彼此发言，自主决定是否插话；能发文字和 sticker、理解图片，必要时搜索 / 计算
- **有人设、可观察**：每个 bot 独立人设与记忆，多 bot 同群互动；TUI 随时 attach/detach 观察，统一遥测记录每次行为
- **本地长驻**：Bun 单进程 daemon + Pi SDK + SQLite，raw Bot API 长轮询，无外部服务依赖；进程管理、IPC、错误恢复完整
- **缓存优先**：provider cache 命中率是开发的第一优先级，cache 工程贯穿 prompt 序列化、compaction 与遥测（[docs/cache.md](docs/cache.md)）

## 常用命令

```bash
bun run start      # 启动 daemon
bun run status     # 查看状态
bun run attach     # 打开 TUI 观察
bun run stop       # 停止 daemon
bun test           # unit + replay（不触网络）
bun run check      # tsc --noEmit
```

配置：复制 `.env.example` 为 `.env`（`key: value` 冒号格式）。

## 文档路径图

### 入口

- [AGENTS.md](AGENTS.md) — 常载规则入口：路由、硬约束、验证漏斗、已知坑

### 现在做到哪了

- [docs/handoff.md](docs/handoff.md) — 当前状态（保持短，动手前必读）
- [docs/devlog.md](docs/devlog.md) — 历史变更记录（append-only）

### 怎么开发

- [docs/engineering/development-guide.md](docs/engineering/development-guide.md) — LLM 开发指南（流程以此为准）
- [docs/testing.md](docs/testing.md) — 验证命令与测试状态
- [docs/engineering/traceability.md](docs/engineering/traceability.md) — 需求→计划→提交追溯

### 做什么

- [docs/requirement.md](docs/requirement.md) — 主需求文档（Phase 1–9 基线）
- [docs/requirements/](docs/requirements/) — 新需求（总清单 [REQ-LIST.md](docs/requirements/REQ-LIST.md)，完成打勾）
- [docs/plans/active/](docs/plans/active/) — 进行中工作的执行计划（PLAN-*）

### 系统怎么构成

- [docs/project.md](docs/project.md) — 目标、约束、术语
- [docs/architecture.md](docs/architecture.md) — 架构边界与 invariant
- [docs/cache.md](docs/cache.md) — provider cache 工程（本项目第一优先级）
- [docs/data-model.md](docs/data-model.md) — SQLite schema
- [docs/adr/](docs/adr/) — 长期架构决策

### 其他

- [docs/runbooks/](docs/runbooks/) — 可重复运维操作
- [docs/research.md](docs/research.md) — Pi 研究结论（对应 `../pi` @ f562a1a）
- [docs/index.md](docs/index.md) — 文档索引（写作规则在这里）
- [docs/engineering/documentation-guide.md](docs/engineering/documentation-guide.md) — 文档写作规范

**新 agent / 新会话的标准入场路径**：[AGENTS.md](AGENTS.md) → [docs/handoff.md](docs/handoff.md) → [docs/engineering/development-guide.md](docs/engineering/development-guide.md)，然后按任务性质读对应边界文档。

## 第一优先级

Provider cache 命中与 token 成本。永不改写已存在的 cached prefix；任何功能开发都要评估 cache hit 率与成本影响。细则：[docs/cache.md](docs/cache.md) + [开发指南第三节](docs/engineering/development-guide.md)。
