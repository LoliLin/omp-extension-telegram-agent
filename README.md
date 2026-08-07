# pi-telegram-agent

两个有人设的 Telegram bot（小雪 / 小雨）「住在」群里：看得到群聊和彼此发言，自主决定是否插话，能发文字和 sticker，能理解图片，必要时搜索 / 计算。本地 daemon 长驻运行（Bun + Pi SDK + SQLite），TUI 随时 attach/detach 观察。

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

```text
README.md（你在这里）
│
├─ AGENTS.md                    常载规则入口：路由、硬约束、验证漏斗、已知坑
│
├─ 现在做到哪了？
│   ├─ docs/handoff.md          当前状态（保持短，动手前必读）
│   └─ docs/devlog.md           历史变更记录（append-only）
│
├─ 怎么开发？
│   ├─ docs/engineering/development-guide.md   LLM 开发指南（流程以此为准）
│   ├─ docs/testing.md                         验证命令与测试状态
│   └─ docs/engineering/traceability.md        需求→计划→提交追溯
│
├─ 做什么？
│   ├─ docs/requirement.md      主需求文档（Phase 1–9 基线）
│   ├─ docs/requirements/       新需求（REQ-*，含清单与实施顺序 README）
│   └─ docs/plans/active/       进行中工作的执行计划（PLAN-*）
│
├─ 系统怎么构成？
│   ├─ docs/project.md          目标、约束、术语
│   ├─ docs/architecture.md     架构边界与 invariant
│   ├─ docs/cache.md            provider cache 工程（本项目第一优先级）
│   ├─ docs/data-model.md       SQLite schema
│   └─ docs/adr/                长期架构决策
│
└─ 其他
    ├─ docs/runbooks/           可重复运维操作
    ├─ docs/research.md         Pi 研究结论（对应 ../pi @ f562a1a）
    ├─ docs/index.md            文档索引（写作规则在这里）
    └─ docs/engineering/documentation-guide.md   文档写作规范
```

**新 agent / 新会话的标准入场路径**：`AGENTS.md` → `docs/handoff.md` → `docs/engineering/development-guide.md`，然后按任务性质读对应边界文档。

## 第一优先级

Provider cache 命中与 token 成本。永不改写已存在的 cached prefix；任何功能开发都要评估 cache hit 率与成本影响。细则：`docs/cache.md` + 开发指南第三节。
