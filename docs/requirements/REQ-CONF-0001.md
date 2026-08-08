# REQ-CONF-0001: 配置体系重构——任意数量 bot、persona 外置

- **Status:** Done（2026-08-08；1/2/3-bot配置与完整dry-run composition均已验收）
- **Priority:** P1
- **Source:** 用户 REQ-LIST 第 2 条 + 2026-08-07 用户澄清（bot 数量不固定为两个，必须通用）

> 现行配置权威已由 REQ-ONBOARD-0001 更新为首选 ignored `telegram.config.ts`；本文最初拍板的 `bots.config.json` 继续作为 legacy 兼容载体。REQ-PLAT-0002 也已取消项目 provider credential。任意数量 bot、persona 外置、严格校验和零 provider-byte drift 仍是本文有效 invariant。

## 问题

当前代码把「两个 bot」写死了：bot A/B 的 token env 名、persona 文件、模型参数、routing 概率（`routing_p_a/p_b`）散落在 `src/config.ts`、`src/agent/runtime.ts`、`src/daemon/index.ts` 的硬编码结构里，persona 是项目文件（`personas/`）。用户要求：**任意数量**的 bot，每个 bot 的提示词与参数都是**用户自己的配置文件**（可在仓库外），增删 bot、调参数不改代码。

## 目标

声明式多 bot 配置：bot 列表来自一份用户配置文件；persona 由配置路径加载（支持仓库外绝对路径）；secret 仍只进 `.env`。现有双 bot 行为迁移后逐字节不变。

## 设计决策（已拍板）

- **配置载体：`bots.config.json`**（项目根，可用 env `bots_config` 改路径）。不选 `.env.ts`：配置是数据不是代码——JSON 可做严格的启动期 schema 校验、可读 diff、不会诱导把逻辑塞进配置。
- **secret 与配置分离**：`bots.config.json` 里 token 只写 **env key 名**（如 `"token_env": "teleram_hastuyuki_bot"`），值仍在 `.env`。真实 `bots.config.json` 进 .gitignore（含个人路径），仓库提供 `bots.config.example.json`。
- **persona 外置**：`persona_path` 支持绝对路径 / `~` / 相对项目根；仓库内 `personas/` 降级为示例，代码不再假设它存在。
- **routing 泛型化**：每 bot 一个 `routing_p`，按配置数组顺序累积阈值，Σp 必须 ≤ 1（现状 pA=0.08, pB=0.08 是其特例）。
- **bot id**：用户配置的唯一字符串（现有 DB 数据用 "A"/"B"，示例配置沿用则无感迁移）。

## 非目标

- 不做配置热重载（改配置重启 daemon）。
- 不做多群支持（target chat 仍单群）。
- 不改 trigger / 序列化 / compaction 语义。

## 需求

- **R1:** 定义并文档化 `bots.config.json` schema：
  - 全局：`group_peer_id`、`router_secret_env`、默认 `model` / `reasoning_effort` / `compaction_threshold` / `compaction_keep_recent`、`db_path`、`tinyfish_key_env` 等。
  - 每 bot：`id`、`token_env`、`persona_path`、`routing_p`，可选覆盖 `model` / `reasoning_effort` / `tools`（send/search/run_js 开关）/ compaction 参数。
- **R2:** 启动期 schema 校验并逐条报错：bot id 唯一非空；`token_env` 在 `.env` 中存在；`persona_path` 文件可读；`routing_p ∈ [0,1]` 且 Σ ≤ 1；数值参数有限且 > 0。
- **R3:** runtime / daemon / router 由 bot 配置数组驱动：`createAgentSession` 每 bot 一个、poller 每 bot 一个、router 按配置顺序算阈值；代码中不出现 "A"/"B" 字面量或双 bot 假设。
- **R4:** DB / IPC / TUI 全链路 bot_id 泛型化确认：`bot_state`、`agent_events`、`llm_runs`、`aliases` 等表的 bot 列已是 TEXT 的验证即可；TUI 显示任意 bot 集合。
- **R5:** 迁移：提供 `bots.config.example.json`（复刻当前双 bot 行为）；现有 `.env` 与 SQLite 数据保留可用；`config.ts` 中双 bot 专用键（`routing_p_a/b` 等）移除，迁移说明写进 devlog 与 runbook。
- **R6:** 校验失败时 stderr 逐条列出全部错误（与 REQ-OPS-0001 R2 的校验框架合并实现）。

## 验收标准

- **AC1:** 仅新增配置、不改代码，第三个 bot 上线：poller 轮询、routing、session、TUI 显示正常（测试群或 dry-run 验证）。
- **AC2:** 用复刻现状的 `bots.config.json` 迁移后，`test/cache.test.ts` golden（system prompt / serialize hash）逐字节不变，真实群行为无回归。
- **AC3:** 给定缺 token env / 重复 bot id / Σp>1 / persona 路径不可读的配置，启动即失败且错误逐条点名。
- **AC4:** persona 文件移到仓库外任意路径，配置指过去后行为不变（golden 不变）。
- **AC5:** 单 bot 配置（数组长度 1）与三 bot 配置都能正常启动运行。
- **AC6:** `bun test` + `bun run check` 全绿。

## 约束

- Cache impact: **INTENTIONAL（管理上）**——配置化本身不改 provider 字节；迁移后必须用 golden 证明逐字节不变，任何 drift 按意外 cache 变化处理。
- 成本：配置化不得增加每 turn token（system prompt 不因泛型化变长）。
- Secret：`bots.config.json` 不得内联任何 secret；token 永远经 env 引用。

## 例子与边界 case

- 两个 bot 引用同一 persona 文件：合法。
- `routing_p` 全 0：永不概率触发（合法，仅 mention/reply/名字触发）。
- bot id 含特殊字符：限制为 `[a-z0-9_-]+`，校验报错。

## 可观察性

- 启动日志列出加载的 bot 清单（id / persona 路径 / model，不含 token）。

## 文档影响

- `docs/architecture.md`（配置小节重写）、`.env.example`、`bots.config.example.json`、`docs/runbooks/`（加 bot runbook）、`docs/data-model.md`（如有 bot 列语义澄清）。

## 待决问题

无（设计决策见上节）。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
