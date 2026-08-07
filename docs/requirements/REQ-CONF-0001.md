# REQ-CONF-0001: 配置体系重构——多 bot 与每 bot 全参数可配

- **Status:** Draft
- **Priority:** P1
- **Source:** 用户 REQ-LIST 第 2 条

## 问题

bot 数量、token env 名、persona 文件、模型 / reasoning effort、routing 概率等目前散落在 `src/config.ts` 与 `src/agent/runtime.ts` 的硬编码双 bot 结构里。加第三个 bot 或调整某个 bot 的提示词 / 参数都要改代码。用户目标：「env 里做好几乎所有可配置项，每个 bot 的各种提示词和参数都可以配置（或许也可以用 .env.ts），支持配置更多 bot 和配置灵活性」。

## 目标

声明式 bot 配置：bot 列表（token、persona、模型参数、routing 概率、工具开关等）全部来自配置文件；增删 bot、调单 bot 参数不改代码。现有双 bot 行为在迁移后逐字节不变。

## 非目标

- 不做配置热重载（改配置重启 daemon 即可）。
- 不做多群支持（target chat 仍是单群，除非用户另行提出）。

## 需求

- **R1:** 定义 bot 配置 schema：每 bot 含 id、token（引用 env key 名而非内联 secret）、persona 文件路径、model / reasoning effort、routing 概率、工具开关（send/search/run_js）、compaction 参数覆盖等。
- **R2:** 配置载体选型并实现（见待决问题：`.env.ts` / `bots.json` / 冒号 .env 扩展）。secret 仍只进 `.env`，配置文件不入 secret。
- **R3:** runtime 由 bot 配置数组驱动创建 N 个 BotRuntime；`bot_id` 在 DB / IPC / TUI 全链路泛型化（现有 "A"/"B" 作为默认值迁移）。
- **R4:** 启动期 schema 校验：缺 token、概率和 >1、persona 文件不存在等全部启动即报错，逐条列出。
- **R5:** 迁移兼容：现有 `.env`（双 bot 冒号格式）无感迁移或给出一次性迁移说明；现有 SQLite 数据保留可用。

## 验收标准

- **AC1:** 仅新增配置、不改任何代码，第三个 bot 上线：poller 轮询、routing、session、TUI 显示均正常（可用 dry-run / 测试群验证）。
- **AC2:** 现有双 bot 配置迁移后，cache golden（system prompt hash / serialize hash）不变，真实群行为无回归。
- **AC3:** 给定缺 token / 概率和 >1 / persona 路径不存在的配置，启动即失败且错误逐条点名。
- **AC4:** 单 bot 修改 reasoning effort 或 routing 概率，只影响该 bot，另一 bot 遥测不变。
- **AC5:** `bun test` + `bun run check` 全绿。

## 约束

- Cache impact: **INTENTIONAL（管理上）**——配置化本身不改 provider 字节，但 persona 路径 / 模型参数进 system prompt 组装，迁移后必须用 golden 证明「逐字节不变」；任何 drift 按意外 cache 变化处理。
- 成本：配置化不得增加每 turn token（如 system prompt 不应因泛型化变长）。
- Secret：配置文件不得内联 token；token 永远经 env 引用。

## 例子与边界 case

- 单 bot 配置（列表长度 1）与三 bot 配置都能启动。
- 两个 bot 引用同一 persona 文件：合法。
- 配置里出现重复 bot id：启动报错。

## 可观察性

- 启动日志列出加载的 bot 清单（id、persona、model，不含 token）。

## 文档影响

- `docs/architecture.md`（配置小节重写）、`.env.example`、`docs/runbooks/`（加 bot 操作 runbook）。

## 待决问题

- 配置载体：`.env.ts`（灵活、可编程，但要解决 secret 与类型安全）vs `bots.json/toml`（声明式、易校验）vs 冒号 .env 扩展（最小改动）。**开工前需用户拍板。**
- 与 REQ-OPS-0001 的校验逻辑合并实现。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
