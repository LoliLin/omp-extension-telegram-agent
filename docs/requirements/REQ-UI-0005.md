# REQ-UI-0005: 用 Pi 底部 editor 直接发送 Telegram 消息

- **Status:** Implemented（2026-08-08 T5 daemon + T6 Pi compose/editor；真实 Pi/Telegram smoke 留到 T14 总验收）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「用底部的输入栏作为 bot 发送消息」
- **依赖:** REQ-UI-0004、REQ-CONF-0001

## 问题

Telegram feed 已在 Pi transcript 中显示，但 Pi 底部 editor 仍只会向 Pi coding agent 提交 prompt。观察群聊后若要以某个 bot 身份发言，用户必须切回 Telegram 客户端，插件没有发送链路。

## 调查结论

- Pi extension 的 `input` event 在已注册 extension command 之后、skill/template 展开之前触发；返回 `{ action: "handled" }` 可保留原生 editor，同时阻止输入进入 Pi agent。这比替换 editor component 更小、更兼容。
- 当前 IPC 只有 hello/history/live/usage，没有写请求；发送必须在 daemon 内完成，extension 不应读取 bot token。
- daemon 已有正确发送事务链：Telegram API 成功 → `insertSentMessage` → IPC broadcast；新入口应复用同一个应用服务，而不是复制 `BotRuntime.executeSend`。
- 全局 attach 没有唯一发送身份。必须显式选择 bot，且 editor/footer 要持续显示当前模式，避免把私密 Pi prompt 误发到群里。

## 目标

在明确的 Telegram compose 模式下，用户仍使用 Pi 原生底部 editor；Enter 将纯文本以选定 bot 身份发送到当前配置群，并立即出现在 native transcript。退出 compose 后，editor 恢复正常 Pi prompt 行为。

## 非目标

- 本需求不发送图片、文件、sticker、reply 或 Telegram entities。
- 不让 extension 直接持有 bot token 或直连 Telegram。
- 不把手动发送文本注入任一 bot 的 provider context；后续 poller 是否让其他 bot 看见，沿用现有 ingestion/routing 规则。
- 不替换 Pi 的 editor、历史、autocomplete 或键位实现。

## 需求

- **R1 — 明确模式：** `/tg attach <bot-id>` 可选择观察/发送身份；全局 `/tg attach` 保持只读。提供 `/tg compose <bot-id>` 与 `/tg compose off`（最终命令名实现前可微调），任何发送前都必须有唯一有效 bot。
- **R2 — 原生输入拦截：** 只拦截 `event.source === "interactive"` 的普通 editor 提交；extension command 继续按 Pi 的既定顺序优先执行。compose off 时返回 `continue`，行为逐字节等同当前 Pi。
- **R3 — IPC 写契约：** 新增有 request id 的 `send_message { botId, text }` / success / error 响应。daemon 校验 bot id、非空文本与 Telegram 长度上限，再调用共享发送服务；token 永不发给 extension。
- **R4 — 持久化与实时显示：** Telegram API 成功后立即 `insertSentMessage`，再经现有 live broadcast 进入 feed；poller echo 仍按 `(chat_id,message_id)` 去重。
- **R5 — 失败语义：** 提交期间防重复；明确失败将原文本放回 editor 或提供可复制恢复方式。连接在 Telegram 已可能成功但 ACK 未到时，不得自动重试，必须提示“结果未知，请先检查群聊”，避免重复发送。
- **R6 — 防误发提示：** footer/widget 与 editor border 至少一处持续显示 `TELEGRAM · SEND AS <id/name>`；compose off 显示 Pi 默认状态。切换 attach、detach、daemon 断线、session shutdown 时发送模式必须安全关闭。
- **R7 — 附件边界：** compose 模式收到 `event.images` 时阻止提交并提示“不支持附件”，不得静默把附件转交 Pi agent或只发送文字部分。
- **R8 — 上下文隔离：** input handler 返回 handled，不调用 `pi.sendUserMessage` / `ctx.sendUserMessage` / `appendMessage`；手动发送 UI 本身不产生 provider-visible 内容。

## 验收标准

- **AC1:** `/tg compose A` 后在原生 editor 输入 `hello`，fake daemon 只收到一次 `send_message(A,"hello")`，Pi agent 没有开始 run。
- **AC2:** daemon 真实 fixture 返回 Telegram message 后，DB 只有一条 canonical row，feed live 显示它；poller echo 不重复。
- **AC3:** compose off、全局只读 attach、RPC/extension source、非法 bot、空文本、超长文本和附件都有确定行为与测试。
- **AC4:** send API 400/401、daemon 断线、ACK 丢失不导致自动双发；UI 可恢复原始文本或明确报告未知结果。
- **AC5:** footer/editor 明确显示发送身份；detach/shutdown 后普通 editor 再次进入 Pi agent。
- **AC6:** `bun test`、`bun run check`、真实 Pi TTY smoke 与 cache golden 通过。

## 约束

- Cache impact: **NONE**。这是 operator → Telegram 的确定性 I/O，不增加 LLM 调用或 provider token。
- IPC 变化必须 additive，旧 observer client 继续可用；更新 `src/ipc.ts`、daemon、plugin 与跨边界测试。
- Secret 只留在 daemon；Unix socket 继续 chmod 600。

## 例子与边界 case

- `/tg attach`（全局）后直接输入：仍是 Pi prompt，除非先 `/tg compose A`。
- `/tg compose A` 后输入未知 slash 文本：Pi 已注册 command 仍优先；普通文本由 Telegram 模式处理。
- 发送中 daemon 退出：不重试，editor 恢复文本并标记结果未知。

## 可观察性

发送开始/成功/失败/未知结果进入插件本地状态；不得写 provider context。daemon 可记录不含 token 的 bot id、request id、Telegram message id。

## 文档影响

`docs/architecture.md`、`docs/runbooks/daemon.md`、`docs/testing.md`、IPC reference（实现时补）。

## 待决问题

- **已决：** `/tg attach A` 只选择观察范围，不自动打开发送；必须显式 `/tg compose A`。全局 attach 也可显式 compose 某个有效 bot，但 footer 始终显示唯一身份。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs` T5/T6
- Commits: `0b3fad0`（daemon contract）；Pi editor commit 从 `Requirement: REQ-UI-0005` trailer 查
