# REQ-DOC-0001: README 从用户视角解释并引导配置平台

- **Status:** Done（2026-08-08；双语 README/用户指南与最终 mdBook/link gate 已验收）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「README 不应只是机械文档列表；应从用户视角解释平台、配置方法，并加强用户文档与通用可配置性」
- **依赖:** REQ-PLAT-0001

## 问题

当前 README 顶部已经把项目称为可配置多 bot 平台，但主体很快退化成命令和内部文档目录。第一次接触项目的使用者仍不知道需要准备什么、怎样从 example 建立一个 bot、provider/token/persona/routing/sticker 配置分别在哪里、Pi 界面能做什么、单 deployment 单群有什么边界，必须跳进内部架构文档自行拼接。

## 目标

README 成为平台用户的首要入口：读者从“它是什么”一路完成 prerequisites、配置、启动、Pi 操作与基础排障；内部开发文档索引退居末尾。

## 非目标

- 不把 README 写成完整架构/reference/贡献指南的复制品。
- 不承诺尚未实现的多群、多租户、Web 控制台、热重载或任意第三方 tool plugin。
- 不放真实 token、群 id、用户名、绝对路径或当前私人 deployment 细节。

## 需求

- **R1 — 产品说明：** 开头用用户语言解释平台解决什么问题、核心能力、成本/cache 取向，以及“一份 deployment = 一个 Telegram 群 + 1..N bots”的真实边界。
- **R2 — 可执行安装路径：** 列出 Bun、Pi 本地依赖、Telegram bot token、LLM provider credential 等 prerequisites，并提供从 clone/install 到复制 example 文件的顺序命令；命令必须与 package scripts/current config parser 一致。
- **R3 — 配置导览：** 用最小、脱敏示例解释 `.env` 的冒号格式、`bots.config.json` 的 deployment 默认与 per-bot override、`token_env`/provider auth/persona/routing/tools/sticker sets；明确 secret 只进 `.env`。
- **R4 — 使用旅程：** 覆盖 start/status/Pi/stop，以及 Pi 内 attach/more/detach/status/compose 的读写边界和 unknown outcome 提示；新用户不需要先读内部 docs 才能观察群聊。
- **R5 — 扩展 bot：** 给出添加第二/第三 bot 的最短步骤，说明配置顺序对概率桶的含义、概率和约束、每 bot session/state 隔离。
- **R6 — 运维与排障：** 提供最常见的配置校验、daemon/socket、真实网络 e2e 与日志入口；深层细节链接 runbook/testing，不重复其全部内容。
- **R7 — 渐进披露：** README 主体按用户任务组织；开发者入口、architecture/cache/requirements/plans 等链接集中在末尾“开发与内部文档”，不能让目录树成为主内容。
- **R8 — 通用文案：** 先描述任意 bot 平台；小雪/小雨只能作为明确标注的 example deployment，不得作为代码必须的身份。

## 验收标准

- **AC1:** 一个不知道小雪/小雨的读者只按 README，可定位并填写全部必需配置、启动 daemon、进入 Pi attach，并安全停止。
- **AC2:** README 包含脱敏的单 bot 最小 config 与添加 bot 示例；字段名和默认值由 config source/example 验证，无过期 key。
- **AC3:** README明确单群deployment、secret边界、attach直发/多bot原生选择、compose override/off与unknown/no-auto-retry行为。
- **AC4:** 文档链接检查无失效相对路径；命令与 `package.json` scripts、`docs/runbooks/daemon.md` 一致。
- **AC5:** `rg` 审计 README 的产品主体不依赖 A/B 或小雪/小雨；若 example 段出现，必须明确标为示例。
- **AC6:** `bun test` 与 `bun run check` 保持通过；本需求不改变运行时代码。

## 约束

- Cache impact: **NONE**。README 不进入 daemon/provider context，不 bump `CACHE_SCHEMA_VERSION`。
- Token impact: runtime 每 turn 新增 0 token；README 避免复制大段内部 reference，降低人和 agent 的检索成本。
- 安全 / 隐私: 所有 credential/peer id 使用明显无效占位符；不得从本地 `.env` 复制值。
- 兼容性: README 必须描述 T11/T12 完成后的实际 provider/config schema，不能抢跑写不存在的字段。

## 例子与边界 case

- 单 bot、无 sticker set、`routing_p:0`：仍可通过 mention/reply/name 使用。
- N bot：追加 config object 与对应 token env，不改生产代码。
- 多群：复制成独立 deployment/data dir；当前不宣称同进程多群。

## 可观察性

文档本身不新增 telemetry；验证证据记录 README 命令检查、link check 与脱敏审计。

## 文档影响

`README.md` 为主；必要时同步 `docs/project.md`、`docs/runbooks/daemon.md`、`.env.example`、`bots.config.example.json` 与 `package.json` metadata，避免相互矛盾。

## 待决问题

等待 REQ-PLAT-0001 的 provider/auth schema 完成后再写最终配置片段，避免文档先于实现。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13`
- Commits: 从 `Requirement:` git trailer 查

## 实施结果（2026-08-08）

- 中英README均把三步首配、真实能力、单群边界、compose unknown/no-retry与排障放在内部文档索引之前；用户无需知道任何私人deployment身份。
- `/tg config`是首选路径；manual typed config、`.env`冒号格式、单bot/N-bot/provider/routing/tools/admin配置由双语guide和tracked examples覆盖。
- package/project/runbook/example metadata已泛型化；public example默认deny admin mutation并关闭可选search，避免复制后误授权或被额外credential阻塞。
- 内部architecture/requirements/plans集中到末尾maintainer入口；runtime/provider bytes未变化，cache impact NONE。
