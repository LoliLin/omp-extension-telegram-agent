# REQ-TG-0003: 支持 Telegram Rich Messages 的收发与持久化

- **Status:** Done / Outbound Superseded（incoming、持久化与 projection 已验收；agent 出站由 REQ-TG-0004 取代）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「为 bot 增加 Telegram rich messages 的支持」
- **依赖:** REQ-SEND-0001、REQ-TG-0001、REQ-UI-0001

## 问题

> 2026-08-08 生产视觉反馈：RichMessage paragraph令普通agent回复表现为整段粗体。本文保留incoming RichMessage/data-plane要求；R2/R3及对应出站验收作为历史实现证据，当前出站权威要求见 [REQ-TG-0004](REQ-TG-0004.md)。

Telegram Bot API 10.1 新增 `RichMessage`、`InputRichMessage`、`sendRichMessage` 与 `sendRichMessageDraft`；10.2 又补充显式 media 和 thinking block。当前项目只读取 `Message.text/caption`，只调用 `sendMessage`，因此：

- agent 即使生成标题、列表、代码块、表格等 Markdown，Telegram 也只收到普通文本；
- 群里其他成员/bot 发来的 `rich_message` 没有 canonical text，可能在 DB、Pi feed 和 provider context 中表现为空；
- `insertSentMessage` 不保留 Bot API 返回的 rich structure，无法可靠去重、恢复或以后改进 UI；
- 新的 private draft Thinking 容易被误当成 group streaming API，造成无效调用或把状态发错聊天。

官方边界是：[`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage) 可发往普通 chat/supergroup；`InputRichMessage` 必须在 `html`、`markdown`、`blocks` 中恰选一个。[`sendRichMessageDraft`](https://core.telegram.org/bots/api#sendrichmessagedraft) 是 30 秒临时预览且只允许目标私聊，完成后必须另发 final rich message。本项目是一 deployment 对一个 supergroup，因此支持 final rich messages，不伪装 group draft streaming。

## 目标

agent 的现有 `send.message` 成为 Rich Markdown 文本入口：普通文本仍是合法子集，结构化回复可在 Telegram 原生渲染。所有收到/发出的 rich message 都保留原始结构，并投影成确定、有界的纯文本供 SQLite timeline、Pi feed 和 provider context 使用。

## 非目标

- 不向当前 supergroup 调 `sendMessageDraft` / `sendRichMessageDraft`；private Thinking 由 REQ-TG-0002 记录 capability 边界。
- 不把 Telegram 近百种 rich block 全部重画成项目自有 TUI renderer；Telegram 客户端拥有 rich presentation，Pi 首版显示确定性纯文本投影。
- 不把 Bot API 的巨大 union schema直接暴露给模型，也不新增独立 `send_rich` 工具。
- 不让模型上传本地文件、读取任意 URL 内容或传 Bot API media objects；首版 `send.message` 只开放 text-rich Markdown，sticker 仍走现有参数。
- 不改变 operator manual compose 的 literal plain-text 语义；该路径若要 rich，另开显式 UX 需求，避免误解析用户输入。

## 需求

- **R1 — 唯一工具保持：** provider-visible 工具仍只有 `send(message?, sticker?, reply_to?)`，参数名/数量不变。`message` description 明确其内容按 Telegram Rich Markdown 发送，普通文本无需特殊标记；不得新增 rich JSON、HTML、blocks 或 format 参数。
- **R2 — final rich send：** agent `message` 使用 `sendRichMessage {chat_id, rich_message:{markdown}, reply_parameters?}`；文字 + sticker 仍在一次 tool call 中按既有顺序执行。成功走 canonical persistence、broadcast、exposure、固定 `ok` 与 terminate；reply 语义与 plain send 一致。
- **R3 — 安全 fallback：** 只有 Telegram 明确返回“rich method/parse 不支持且确认未创建消息”的确定性 4xx 时，才可降级一次 literal `sendMessage`；网络超时、非 JSON、5xx 或 outcome unknown 不自动 fallback/retry，避免双发。fallback outcome 必须本地可观察。
- **R4 — canonical storage：** `messages` 增加 nullable rich JSON 字段并提供幂等 migration；保存 Telegram 返回/更新中的 `rich_message` 原始结构。普通 `text/caption` 行保持兼容。schema、migration 与 `docs/data-model.md` 同提交。
- **R5 — deterministic projection：** `src/telegram/` 拥有一个无 LLM 的 rich-to-plain projector，递归覆盖 string/array/inline wrappers 和已知 block/container；保持阅读顺序，用换行/列表/table cell separator 表达结构，忽略纯样式 metadata。未知 object 安全遍历文本承载字段，不输出 URL metadata、file id 或整段 JSON。
- **R6 — 有界输入：** rich JSON decode 深度、node 数与纯文本长度有硬上限；超限投影带单一截断标记。raw rich JSON 的 DB 大小也有上限，过大时保留有界诊断而不是把无界 payload 写入 provider suffix/IPC。
- **R7 — ingestion/edit/echo：** 新消息、edited message、agent send immediate insert 与另一个 bot 的 poller echo 使用同一 normalize/projector；canonical unique key 和 revision 语义不变。rich edit 更新 structure/text；echo 不产生第二行。
- **R8 — Pi/IPC/provider：** `MsgItem.text` 与既有 serialization 只消费投影文本，首版不传 raw rich JSON 给 Pi 或 provider。Pi 继续用原生 `Text`/theme 显示；Telegram rich source 不进入 system prefix/tool result。用户不可见 metadata 不增加 token。
- **R9 — tool/cache authority：** rich Markdown 用法只写在 send tool schema，不复制到 persona/system prompt。description 变化属于稳定 prefix，必须 bump `CACHE_SCHEMA_VERSION`、开新 epoch、更新 tools hash golden 与 `docs/cache.md`；预期参数 schema/顺序不变。
- **R10 — platform compatibility：** tracked tests 不依赖私人 bot；真实 Bot API 10.2 smoke 覆盖当前 deployment。若目标 API 返回确定性 unsupported，plain fallback 可用且 telemetry 明确；不得在启动时为探测能力发送测试消息。

## 验收标准

- **AC1:** API unit test 锁定 `sendRichMessage` payload 恰为 `chat_id + rich_message.markdown + reply_parameters`，不含 tool-only/sticker/internal 字段；返回 Message 先落库再 broadcast。
- **AC2:** heading、list、code fence、table、blockquote 与普通中文文本在 fake API 全链只调用一次 rich send；plain text 不需额外参数。真实群至少验证标题/列表/代码和 reply。
- **AC3:** 确定性 parse 4xx 只 fallback 一次 plain send；timeout/5xx/unknown 调用 plain send 0 次。任何路径的 canonical message、send event 与 ACK 都恰好一次。
- **AC4:** inbound rich fixture 覆盖 nested inline styles、list/table/details/media caption、未知 block、malformed/oversize；DB 保存有界 JSON，text projection 顺序稳定、无 `[object Object]`/file id/raw JSON。
- **AC5:** rich edit 与 A immediate insert→B poller echo 不丢/不重；file DB close/reopen 后 rich source 和 projection仍存在。旧 DB migration 幂等，旧普通消息逐字节不变。
- **AC6:** Pi timeline/IPC 只收到 projection text，不收到 rich raw metadata；ANSI/OSC 仍由现有 sanitize 去除，session entry 数不增加。
- **AC7:** send tool 仍只有 `message, sticker, reply_to`，persona/protocol 无 rich API教程；schema version/tools hash/golden 精确反映 description change。
- **AC8:** `bun test`、`bun run check`、migration/cache golden 与真实 Telegram rich smoke 通过；private draft methods 在 group fixture 调用数为 0。

## 约束

- Cache impact: **INTENTIONAL（outbound tool contract）**。send description 改为 Rich Markdown 会改变稳定 tool prefix，需一次 schema bump/new epoch。rich message 的具体内容仍只在动态 suffix，且投影有界。
- Token / cost: 不新增 LLM call或 tool；参数 schema 不扩张。Rich Markdown instruction 会增加少量稳定 prefix token，canonical projector避免把结构 JSON放进每 turn。
- 数据 / 迁移: SQLite additive nullable column；migration 幂等，不重写旧行。raw JSON 有字节上限，data-model 记录。
- 兼容性: canonical message key、IPC frame shape、serialization grammar与 send ACK 不变；manual compose继续 plain。
- 安全 / 隐私: 不把 bot token、本地路径、file id、arbitrary media object或未知 metadata暴露给模型/UI。rich remote media首版不承诺支持。

## 例子与边界 case

- `send({message:"# 标题\n\n- A\n- B"})`：Telegram 原生 rich message；provider/SQLite 投影为同序文本。
- `send({message:"普通一句话", sticker:"s12", reply_to:42})`：rich text + sticker 两条 Telegram 消息，共用 reply；一次 tool call，最终 terminate。
- rich table 中有 link/custom emoji：投影保留可读 label，不序列化 URL/custom emoji id。
- model 生成未闭合 rich HTML：Telegram 明确 parse 4xx 时 literal plain fallback；网络断线则 unknown，不 fallback。

## 可观察性

本地 event/metric 记录 `rich_sent`、`plain_fallback`、`rich_parse_truncated` 与错误分类，只含 bot id/message id/计数，不记录正文或完整 rich JSON。usage telemetry 通过 cache schema/hash观察一次预期 miss。

## 文档影响

`docs/architecture.md` Telegram ingestion/send、`docs/data-model.md`、`docs/cache.md`、`docs/testing.md`、README/platform capability 与 handoff。

## 待决问题

首版是否允许 Rich Markdown remote media。默认按非目标处理：只验证 text-rich constructs；如果 Telegram parser仍接受 remote media，agent tool description 明确禁止，未来要开放时另做 URL/privacy/size威胁模型。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10h`、`#T10k`、`#T10l`
- Commits: 从 `Requirement:` git trailer 查
