# REQ-PLAT-0001: 收口为通用、快速、简洁的可配置 bot 平台

- **Status:** Proposed（2026-08-08 已完成代码库调查，未实现）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「当前平台想做通用快速简洁的 bot 聊天机器人；全面 review 基于固定两个机器人的设计，提高通用可配置性」
- **依赖:** REQ-CONF-0001

## 问题

REQ-CONF-0001 已把核心 daemon 从 A/B 数组重构为任意 bot 配置，但仓库仍混有示例特例、未验证断言和更深的固定假设。若直接把当前项目当平台复用，新用户会遇到文档仍以小雪/小雨为产品定义、e2e 永远选 `bots[0]`、provider 固定 DeepSeek、单群边界未明确等问题。

## 调查结论

### 已经通用，不应重写

- `config.bots` 是非空数组；daemon 用 loop/Map 创建任意数量 poller、BotRuntime、identity 与 stats。
- router 按配置顺序累计 `routing_p`，DB 的 bot identity 列是 TEXT，Pi `/tg attach <id>` 与 widget 动态消费 bot 清单。
- 单 bot/三 bot config unit test 已通过；persona 路径、per-bot model/effort/tools/compaction/sticker sets 可配置。

### 仍需收口

- `src/agent/runtime.ts` 把 provider 写死为 `deepseek`，`AppConfig` 只有一个全局 `deepseekApiKey`；“per-bot model”并不等于真正的 per-bot provider/model 配置。
- `scripts/e2e-agent.ts`、`e2e-compaction*.ts` 固定 `config.bots[0]`，日志还叫 bot A；无法验证指定 bot 或第三 bot。
- `package.json` description、`docs/project.md`、部分 architecture/data-model/testing 文案仍把“两只小雪/小雨 bot”写成平台本体，而不是 example deployment。
- REQ-CONF-0001 AC1 的“第三 bot 真实上线”尚未完成；现有测试主要证明配置解析，不证明第三个 poller/session/IPC 的完整启动链。
- 当前是“一份配置 = 一个 Telegram group + N bots”。这是可以接受的简洁部署边界，但必须明确；不能一边宣称通用平台，一边让读者误以为单进程支持任意多群。
- 固定 sticker 目录的 per-bot 可发送性仍有交叉泄漏，单列 REQ-STICKER-0002，不在本需求重复修。

## 目标

一份最小配置可启动 1..N 个任意 persona Telegram bot；核心代码、验证脚本、Pi UI 与主文档不依赖 A/B 或小雪/小雨。当前双 bot 配置降级为 example deployment，并保持现有 provider bytes 与运行行为。

## 非目标

- 不做 SaaS、多租户、Web 管理后台或配置热重载。
- 本阶段维持“一份 daemon 配置对应一个群”；多群用多实例/独立 data dir，是否做单进程多群另开需求。
- 不把 tools 做成任意第三方插件系统。
- 不删除小雪/小雨 persona 示例或破坏现有 DB 中 A/B id。

## 需求

- **R1 — runtime 零固定身份：** 生产代码不得用 A/B、数组位置或 persona 名决定逻辑；历史 A/B 只作为普通合法 id 与 example 数据存在。
- **R2 — provider 配置：** 明确 `provider + model + auth env` 的 deployment/per-bot schema；至少支持当前 DeepSeek，同时结构不把 runtime lookup 写死为 `getModel("deepseek", ...)`。未配置时现有 deployment 行为逐字节不变。
- **R3 — 可选择的运维脚本：** e2e/analyze/smoke 接受 `--bot <id>`（需要 bot 时）并校验 id；默认值若保留必须文档化，不再隐式 `bots[0]`。
- **R4 — example 与产品分离：** `package.json`、`docs/project.md`、README/runbook 先描述通用平台，再把小雪/小雨列为 example deployment；secret env 名与 persona 路径只出现在 example。
- **R5 — 完整 N-bot 验证：** 用三 bot fixture 启动到 poller/runtime/router/IPC 边界（network 用 fake），证明每 bot 独立 session/state/stats/filter；另保留一次 opt-in 真实第三 bot smoke 的操作清单。
- **R6 — 单群边界：** schema/runbook 明确 group 是 deployment-level；运行多个群时 data dir、socket、pid、DB 必须隔离。未实现多实例安全前不得宣称支持。
- **R7 — 简洁与成本：** 不增加每 turn provider-visible配置说明；通用性应来自确定性 config/runtime dispatch，不通过把平台 metadata 塞进 prompt 实现。
- **R8 — 兼容迁移：** 现有 A/B config、SQLite、session paths、cache golden 全部继续可用；任何 provider/cache-visible drift 按 cache invariant 处理。

## 验收标准

- **AC1:** 仓库生产代码的身份逻辑审计无 A/B/`bots[0]` 特判；示例、测试 fixture 与历史兼容注释允许存在但需标注。
- **AC2:** 1、2、3 bot fixture 从配置加载到 daemon composition/IPC stats 全链测试通过；每个 bot 有独立 poller/runtime/state。
- **AC3:** e2e scripts 对 `--bot C` 生效，对未知 id fail-fast 并列出有效 id。
- **AC4:** 以 REQ-SEND-0001 的 cache schema v4 为既有 deployment baseline；provider/config 泛型化前后 system prompt、tool schema、message serialization、routing 与 DB 行为不变，cache golden 通过。
- **AC5:** 至少两个 provider/model 配置 fixture 能完成 model lookup/auth routing；真实 provider e2e 可 env gate，不进入默认 `bun test`。
- **AC6:** project/package/runbook 新读者无需知道小雪/小雨即可创建一个新 bot；example 仍可复制运行。
- **AC7:** `bun test`、`bun run check` 与 opt-in 第三 bot smoke 清单通过或明确记录未验证项。

## 约束

- Cache impact: **NONE（既有 deployment）**。配置/dispatch 泛型化不得改变现有 provider bytes；若未来 provider 切换，本身是用户配置选择，不允许偷偷修改稳定 prompt grammar。
- Token impact: 每 turn新增 0 token；启动/验证工作不调用 LLM，除显式 e2e。
- Secret：provider/bot credentials 仍只以 env key 引用，example 不含值。

## 例子与边界 case

- 单 bot、`routing_p=0`：仅 mention/reply/name 触发，UI 正常。
- 三 bot、概率和 1：按配置顺序确定性路由。
- 同一 persona 被两个 bot 引用：合法但 session/state 独立。
- 两个 deployment 指向同 data dir：启动必须拒绝或 runbook 明确禁止，不能共享 pid/socket/DB。

## 可观察性

启动日志动态列出 bot id/name/provider/model/persona（不含 secret）；IPC hello/stats 返回配置 bot 清单，不假设顺序或数量。

## 文档影响

`docs/project.md`、`docs/architecture.md`、`docs/data-model.md`、`docs/runbooks/daemon.md`、example config、package metadata。

## 待决问题

- provider auth 是 deployment-level provider registry，还是每 bot 直接引用 auth env。实现计划前需选最小 schema，并保证现有配置零迁移或有显式默认。

## 追溯

- Plans: 实现前建立
- Commits: 从 `Requirement:` git trailer 查
