# REQ-SEND-0002: Telegram 远端提交后的重复发送防护

- **Status:** Approved（2026-08-08 已复现并定位，未实现）
- **Priority:** P0
- **Source:** 用户新增 `REQ-LIST`：「bot会重复发」
- **依赖:** REQ-SEND-0001、REQ-TG-0003、REQ-OPS-0002

## 问题

生产群已经出现同一 bot 把同一段文字连续发送两次。SQLite 与 Telegram 记录给出了完整复现链：

- `#19614/#19615` 文字逐字相同；第一次 `send` 在 Telegram 已创建 `#19614` 后，本地 canonical 写入因 `database is locked` 抛错，模型收到 `tool_result.isError=true`，随即用相同参数重试并创建 `#19615`。
- `#19619/#19621` 再次走同一轨迹：第一次远端消息成功、本地写入失败、模型判断“数据库锁了，重试一次”，第二次创建新消息。
- 同期存在两个同仓库 daemon，持续的 poller 409 与 SQLite 写锁放大了故障概率；`REQ-OPS-0002` 已回收孤儿进程并防止再次并行启动，但发送事务仍把“远端已提交、后置本地副作用失败”错误地暴露为可重试失败。

当前 `sendRichTextAndPersist()` 已用 `SentMessagePersistenceError` 区分远端成功后的持久化失败，却由 `BotRuntime.executeSend()` 原样抛回模型。相同风险还存在于 sticker 持久化、mark exposed、IPC broadcast、event 记录，以及组合发送中“文字成功、贴纸失败”的半提交路径。Telegram Bot API 没有本项目可用的幂等 key，因此远端调用一旦开始，不能靠重放整个 tool call 获得 exactly-once。

## 目标

把 Telegram 网络调用定义为不可回滚的 commit boundary：远端明确接受、结果未知或组合发送已部分接受后，任何本地失败都不得让同一 agent turn 再次发送相同内容。只允许重试幂等的本地持久化/投影，绝不重试 Telegram 副作用；工具以终止结果结束本轮，并留下不含正文/secret 的可审计诊断。

## 非目标

- 不声称 Telegram 网络具备 exactly-once；timeout/断线后的真实远端结果仍可能未知。
- 不按正文做全局去重；用户或模型在后续独立 turn 有意重复同一句仍是合法行为。
- 不删除 agent 的一般错误处理能力，也不修改 persona 来掩盖事务边界错误。
- 不为 Telegram API 增加不存在的 client idempotency key，不通过查询最近文本猜测是否已发送。
- 不把 text+sticker 两个有意的 Telegram 消息误判成重复；组合发送仍可产生两个不同 message id。

## 需求

- **R1 — 发送前校验：** empty payload、`reply_to` visibility、sticker short id 与当前 bot file-id mapping 等所有确定性校验必须在第一个 Telegram 网络调用前完成；失败时网络调用数为 0。
- **R2 — 单次远端尝试：** 一次 `send` tool invocation 对每个计划组件最多调用一次 Telegram create method。唯一例外是 REQ-TG-0003 已定义的“rich 明确在创建前被拒绝 → 单次 literal plain fallback”；模型不得负责重试该 fallback。
- **R3 — commit boundary：** 任一 Telegram create call 返回消息后，该组件已经 committed。canonical insert、exposure、event 或 broadcast 失败只能触发有界的本地恢复，不能再变成 provider 可见的 retryable tool error。能从 raw response 取到 message id 时，终止结果保留该 id。
- **R4 — unknown outcome：** timeout、连接中断、非 JSON、5xx 等无法证明“未创建消息”的结果必须返回 `unknown/no-retry` 终止结果；不调用 plain fallback、不发第二次同类请求，也不再发起一个 provider 纠错轮次。日志/事件只记录 bot、阶段、分类，不记录正文、URL、token 或完整异常。
- **R5 — 组合发送半提交：** message+sticker 继续共享一个 tool call。若文字已 committed 而 sticker 失败/未知，结果是 terminal partial/unknown；不得把整组参数抛回模型重跑。若两个组件都成功，保持现有固定 `ok` 最小 ACK 与两个 message id。
- **R6 — 本地幂等恢复：** `insertSentMessage` 及后续本地写入可以按 message id 有界重试；poller echo 与恢复重放仍由 `(chat_id,message_id)` 去重。恢复失败不得发送网络请求；单 bot deployment 也必须留下可操作诊断，不能依赖另一 bot 的 poller 才知道发生过故障。
- **R7 — 后置副作用隔离：** `markExposed`、`sentMessageSink`、typing stop 与 `recordEvent` 的单点失败不能推翻已经 committed/unknown 的发送结果。能够安全完成的其余本地副作用继续执行，每个失败最多记录一次分类诊断。
- **R8 — deployment 单写者：** 保留 OPS-0002 的同仓库 PID lock、孤儿枚举与 restart recovery，避免两个 daemon 同时制造 API/SQLite 竞争；发送层不能把该运维防线当作唯一防重复机制。

## 验收标准

- **AC1:** 回归 fixture 复现“Telegram 返回 `#19614` 后 canonical insert 抛 `SQLITE_BUSY`”：远端文字调用恰好 1 次，tool 返回 terminate/no-retry 而非 throw，模型不会出现第二个相同 `tool_call`；本地恢复不调用 Telegram。
- **AC2:** sticker-only 的 post-send DB failure 与 message+sticker 的第二段失败各有测试；已成功的组件不重复，partial details 能区分 committed id 与 failed/unknown component。
- **AC3:** timeout、socket reset、non-JSON、429/5xx 各最多一次 create call且无 rich→plain fallback；结果终止当前 tool turn并明确 outcome unknown。明确的 rich parse/method rejection仍只发生既有一次 plain fallback。
- **AC4:** preflight 的 empty/reply-not-visible/unknown sticker/missing bot mapping 均保持 0 network calls；这些“尚未跨 commit boundary”的错误仍可由模型修正。
- **AC5:** local persistence retry/echo replay对同一 message id最终至多一条 canonical row、一次 feed identity；诊断不含 message正文或credential。关闭/锁住 DB 时也不出现第二次 Telegram call。
- **AC6:** controller regression继续覆盖重复同仓库 daemon无法共存、restart只启动一个replacement；真实 daemon在至少一个30秒poll backoff窗口内无新409。
- **AC7:** targeted send/runtime/poller/controller tests、`bun test`、`bun run check`、cache golden与`git diff --check`通过；真实群单次 message+sticker smoke只产生预期的一个文字和一个贴纸。

## 约束

- Cache impact: **NONE**。不改 tool name/description/schema、system/message/summary grammar或 context epoch；只改变异常路径的确定性 tool outcome。
- Token / 成本: 正常成功路径新增 0 token、0 LLM call；异常路径通过 terminate/no-retry减少重复 provider turn 与 Telegram 消息。
- 兼容性: Telegram API、SQLite schema、IPC frame与 canonical grammar不变；现有 rich deterministic fallback保持。
- 数据 / 迁移: 无 schema migration。恢复仍使用既有 raw Telegram message与 canonical idempotency key。
- 安全 / 隐私: 诊断不得包含发送正文、token、完整请求或未经脱敏的异常字符串。
- 运维: daemon singleton仍由 OPS-0002负责；本需求单独保证发送 commit boundary正确。

## 例子与边界 case

- Telegram 返回 message id 900，随后 DB locked：对模型返回 terminal committed/locally-degraded，后台/本地只重试 `INSERT #900`，绝不再次调用 send。
- rich request明确 400 parse rejection：允许一次 plain fallback；plain返回后 DB失败仍按 committed处理，不能再次发 rich或plain。
- 文字返回 901，sticker timeout：文字不重发，tool以 partial/unknown终止；群里可能只有文字，这是比重复整组更安全的可观察退化。
- sticker mapping在网络前已经缺失：直接普通 tool error且零网络调用，因为尚未跨 commit boundary。
- 两个独立的人类 turn有意得到相同文本：不按内容拦截；本需求只约束同一 tool invocation/故障重试链。

## 可观察性

复用 `agent_events`，新增/细化有界 `send_degraded` 类事件：只含 bot、component、outcome (`committed|partial|unknown`)、已知 message id与本地 failure stage/category。controller status/log继续暴露 duplicate daemon/409；不记录消息正文。

## 文档影响

实现时同步 `docs/architecture.md` 的 send commit boundary、`docs/testing.md` 的 duplicate-send fixture、`docs/devlog.md` 与 `docs/handoff.md`。若事件字段新增，只做 additive payload并在相关测试中锁定脱敏边界。

## 待决问题

无。Telegram 无通用幂等 key时，安全策略固定为：远端调用开始后的 unknown/partial/committed均 no-retry；只重试本地幂等副作用。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10v/T10x`
- Commits: 从 `Requirement: REQ-SEND-0002` git trailer 查
