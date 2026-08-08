# REQ-CMD-0001: Telegram 群内控制命令与管理员白名单

- **Status:** Approved（2026-08-08 已调查，未实现）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：Telegram bot 指令支持手动 compact、调整参数、查看信息及其他实用命令；除查看信息外均为管理员命令；白名单可配置，当前 deployment 只允许 `t.me/aac6fef`
- **依赖:** REQ-AGENT-0001、REQ-CONF-0001、REQ-PLAT-0001

## 问题

当前 Telegram ingestion 把所有人类消息统一交给 agent router，没有 deterministic control-command 层。管理员要 compact、调整 routing/cooldown 或检查 daemon/bot 状态，只能登录主机使用 CLI/SQLite；直接在群里输入命令还可能进入模型上下文并触发一次付费 agent run。

现有架构已经提供所需基础：canonical message 含 Telegram `sender_id`、`username` 与 `bot_command` entity；Poller callback 带实际接收 token 的 `botId`；每个 `BotRuntime` 持有 Pi `AgentSession`，Pi 0.84.1 暴露 `session.compact()`；routing probability/cooldown 来自可变的内存 bot config。缺的是严格 parser、授权、持久 override、串行执行和 Telegram 回复边界。

## 目标

目标群内提供一组低成本 `/tg` 控制命令。任何人可查看无敏感信息的 help/bots/status；只有 deployment allowlist 命中的 Telegram 身份能 compact 或修改参数。命令完全由确定性代码处理，不进入 persona/provider context。

## 非目标

- 不让群消息执行任意 shell、SQL、prompt、文件写入或自定义 compaction instructions。
- 不以 Telegram 群管理员身份自动授权；只有显式 deployment allowlist 有效。
- 不在本需求内做 Web 控制台、BotFather 管理、配置热重载或多群控制面。
- 不允许运行时更换 token/provider/model/persona/sticker set；这些仍需受控重启。
- 不硬编码 `aac6fef` 到生产源码或 tracked example。

## 命令表

| 命令 | 权限 | 行为 |
|---|---|---|
| `/tg help` | public | 显示命令摘要与哪些操作需要管理员 |
| `/tg bots` | public | 列出 bot id/name 与可用状态，不显示 token/path |
| `/tg status [bot]` | public | 显示 effective routing/cooldown、runtime 状态、epoch/model 与有界 telemetry |
| `/tg compact <bot\|all>` | admin | 仅 idle runtime 手动 compact；all 按配置顺序逐个执行并汇总 |
| `/tg set <bot> routing_p <0..1>` | admin | 校验全 bot 概率和 `<=1` 后立即生效并持久化 override |
| `/tg set <bot> cooldown_ms <n>` | admin | 设置有限整数 `0..3600000`，立即生效并持久化 override |
| `/tg reset <bot> <routing_p\|cooldown_ms>` | admin | 删除 override，恢复文件配置值 |

`/tg@<bot_username> ...` 与 `/tg ...` 使用同一 grammar；带 username 时由对应 bot 回复，不匹配本 deployment 的 suffix 不处理。

## 需求

- **R1 — entity 驱动 parser：** 只把 offset 0 的 Telegram `bot_command` entity 解析为命令；命令名大小写不敏感，参数 token 有明确数量/类型，未知/缺失/多余参数只返回 usage，不做模糊猜测。普通聊天中提到 `/tg` 不算命令。
- **R2 — 单一命令服务：** parser、authorization、read model、mutation 与 reply formatting 归属 `src/telegram/` 或 `src/daemon/` 的独立服务；daemon callback 只负责接线，不把命令树堆进 `index.ts`。
- **R3 — 权限分层：** `help/bots/status` 对目标群所有 human sender 可读；`compact/set/reset` 必须先通过 allowlist。bot sender、匿名 `sender_chat`、缺失身份、仅 display name 相同者都不能执行 admin 命令。
- **R4 — 可配置 allowlist：** deployment config 提供 `telegram_admins`，接受 Telegram 正整数 user id 与规范化 `@username`；默认空数组即拒绝所有 mutation。当前 ignored `bots.config.json` 只配置 `@aac6fef`，tracked example 使用无效占位符并明确生产推荐固定 numeric user id。
- **R5 — 持久参数 override：** 只开放 `routing_p` 与 `cooldown_ms`；set/reset 写入 SQLite bot state，daemon restart 后恢复。修改 routing 前原子校验全 bot effective 概率和 `<=1`；失败不部分写入。reset 恢复文件配置，不改 tracked/ignored JSON。
- **R6 — 安全 compact：** `compact` 不接收自由文本 instructions；runtime busy/stopping 时拒绝并提示稍后重试，不隐式 abort 当前回复。idle 时调用现有 chat-oriented compaction extension；成功 epoch/exposure 仍由统一 `compaction_end` handler更新。`all` 串行执行并逐 bot 汇总，单个失败不伪装全成功。
- **R7 — context/cost 隔离：** 被识别的 control command 及其 Bot API reply 对所有 agent runtime 标记为已消费，不进入后续 serialized message suffix；不调用主 LLM。命令 edit/replay 不重复 mutation；每个 inserted message id 最多执行一次。
- **R8 — 回复与身份：** command reply 由接收/被 suffix 指定的配置 bot 通过现有 Telegram send→canonical DB→IPC broadcast 路径发送，并 reply 原命令。发送失败只记录本地诊断，不把 secret/stack trace 发群，不自动重试 unknown outcome。
- **R9 — 并发与上限：** 每 bot mutation 串行；同一时刻最多一个 compact，set/reset 与 compact 不能交错破坏状态。回复长度有界且不输出 token、API key、本地绝对路径、完整 persona 或消息正文。
- **R10 — 菜单与帮助：** daemon 启动可 best-effort 为各 bot 发布相同的 `/tg` 菜单描述；失败只告警，不阻塞 polling。无论 Telegram 客户端菜单是否可见，文本命令必须可用。

## 验收标准

- **AC1:** parser tests 覆盖 `/tg`、`/TG@known_bot`、entity 不在 offset 0、未知 suffix、空/多余参数、caption/edit；只有合法 command entity 被消费。
- **AC2:** `@aac6fef` 与配置 numeric id 可执行 mutation；相同 display name、`@AAC6FEF` 以外 username、bot/匿名 sender 均得到无敏感信息的拒绝。public status 不要求 allowlist。
- **AC3:** set routing/cooldown 立即影响 route/runtime，file DB close/reopen 后 override 仍存在；reset 恢复 config 值；概率和超限/NaN/未知 bot 时 0 state changes。
- **AC4:** fake Pi session 对 idle compact 调用一次；busy/stopping 调用 0 次；成功沿用现有 epoch/exposure handler，失败有逐 bot结果且 daemon 继续运行。
- **AC5:** fake Poller/BotApi 全链证明 command 只执行一次、reply 引用原 message、DB/IPC 各出现一次；命令和 reply 不出现在任一 bot 下一次 provider suffix。
- **AC6:** help/bots/status 输出有界且脱敏；没有 token/env value/persona path/message body。mutation 日志只含 command kind、bot id、sender id/username 与 outcome。
- **AC7:** 当前 ignored deployment 的 effective admin matcher 恰好一项 `@aac6fef`；tracked example 不包含该私人用户名。
- **AC8:** `bun test`、`bun run check`、cache golden 通过；真实群用非管理员验证 status 可读/set 拒绝，再用 `@aac6fef` 验证 set→reset 与一次 compact。

## 约束

- Cache impact: **NONE**。命令被 deterministic control plane 消费，不改 system/tool/message/summary grammar，也不进入 provider suffix；不 bump `CACHE_SCHEMA_VERSION`。
- Token impact: command 主 LLM token 为 0；manual compact 本身按既有 auxiliary summary 调用计费，这是用户显式操作，status 必须提示/telemetry 记录。
- 数据 / 迁移: 复用 `bot_state` key/value，不改 SQLite schema；override key 稳定且 reset 可删除。
- 安全 / 隐私: deny by default；authorization 使用 Telegram canonical identity，不信任 display name/命令参数；群内诊断脱敏。
- 运维: 当前 deployment allowlist 写进 ignored config，不把私人身份变成平台默认。

## 例子与边界 case

- 普通成员 `/tg status B`：返回 B 的公开状态。
- 普通成员 `/tg set B routing_p 0.2`：permission denied，DB/config/runtime 0 changes。
- `@aac6fef` `/tg set B routing_p 0.2`，但总和会到 1.1：拒绝并显示允许范围，不修改任一 bot。
- `/tg compact all` 遇 A idle、B busy：A 可成功，B 报 busy；不得 abort B。
- 编辑一条旧消息改成 `/tg compact all`：不执行 mutation，也不转给 agent。

## 可观察性

新增有界 command audit event/counter：command、sender identity、target、authorized、outcome、duration；不含参数之外的消息正文。status 可读 effective override 来源（config/telegram override）与最后 compact结果。

## 文档影响

`docs/architecture.md`、`docs/data-model.md`（bot_state keys）、`docs/testing.md`、`docs/runbooks/daemon.md`、README、config example。

## 待决问题

无。首版可调参数刻意限制为 routing/cooldown；新增 mutation 必须回到本命令表、权限和持久化验收，不通过 generic key/value 接口偷渡。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10h`
- Commits: 从 `Requirement:` git trailer 查
