# REQ-TG-0004: 将 Agent Markdown 映射为 Telegram 文本 entities

- **Status:** Approved
- **Priority:** P1
- **Source:** 用户反馈「加入 rich text 后 bot 永远在写粗体字；让 bot 用 Markdown 语法自动格式化成为 Telegram 支持的 rich text」
- **依赖:** REQ-TG-0003、REQ-SEND-0001、REQ-SEND-0002

## 问题

REQ-TG-0003首版把`send.message`原样交给`sendRichMessage {rich_message:{markdown}}`。当前deployment的只读脱敏审计显示：634次model `send`中630次是无Markdown wrapper的普通文本，整段`**…**`为0；最近200条Telegram rich source中209个正文block是`paragraph`。因此“整段粗体”不是模型偷偷加了`**`，而是把所有普通回复送进RichMessage paragraph presentation的结果。

Telegram当前`sendMessage`支持`entities`；offset/length使用UTF-16 code units。项目已经通过Pi TUI的公开导出获得与Pi自身一致的`Marked` lexer，不需要手写Markdown grammar。当前出站路径应从model Markdown确定性生成普通`text + entities`：未标记段落没有style entity，只有显式Markdown片段才有样式。

## 目标

模型继续只写一个自然Markdown字符串；本地零LLM转换器把稳定子集映射为Telegram `sendMessage` text/entities。普通正文保持普通字重，粗体、斜体、删除线、代码、链接、列表、引用与标题按语义呈现，并保持现有exactly-once持久化和失败边界。

## 非目标

- 不让模型生成Telegram entities、HTML、MarkdownV2 escaping或RichMessage AST。
- 不新增format/tool/第二次provider call，也不做“润色Markdown”的额外模型调用。
- 不删除incoming `rich_message`的normalize、raw persistence或有界纯文本projection；REQ-TG-0003的接收/data-plane能力继续保留。
- 不让operator manual compose自动解释Markdown；它仍发送literal plain text。
- 不支持Markdown image/remote media、raw HTML、脚注、任务交互或任意Telegram entity union。

## 需求

- **R1 — 单一 Markdown source：** provider-visible tool仍是`send(message?,sticker?,reply_to?)`。`message`是自然Markdown；普通段落不包marker，`**`只用于真实强调，禁止默认整段加粗。参数名、tool顺序与terminating ACK不变。
- **R2 — 复用 parser：** 转换器复用Pi依赖公开导出的`Marked` lexer，并拥有一个小型renderer；不得用regex重新实现Markdown parser。未知/不支持token降级为有界可读文本，不执行raw HTML。
- **R3 — 稳定 subset：** 支持plain paragraph、bold、italic、strikethrough、inline code、fenced code、HTTP(S) link、heading、ordered/unordered list、blockquote与simple table。heading映射为bold；list保留可见marker；table用稳定文本分隔。普通paragraph产生0个样式entity。
- **R4 — Telegram entities：** agent出站调用`sendMessage {chat_id,text,entities?,reply_parameters?}`，不再调用`sendRichMessage`。entity offsets/lengths按JavaScript UTF-16 code units计算；emoji/CJK、nested inline styles与换行必须正确。entities按offset/outer-first稳定排序且不得产生非法零长/交叉范围。
- **R5 — 安全链接与 HTML：** 只有public `http:`/`https:` link产生`text_link`；其他scheme与malformed URL只保留label。raw HTML作为普通可见文本或剥离标签，绝不直通Telegram parse mode，也不触发网络。
- **R6 — exactly-once fallback：** entities请求成功后按现有canonical persistence/broadcast/exposure执行。只有Telegram明确以确定性400拒绝entity/format且确认未创建消息时，才可对已经生成的plain `text`做一次无entities fallback；timeout、429、5xx、non-JSON、network或本地持久化失败绝不远端重试。
- **R7 — canonical compatibility：** Telegram返回的`text/entities`走现有normalize/DB/revision/IPC；incoming RichMessage字段与migration不变。event只记`markdown_sent`或`plain_fallback`及message id，不记正文、URL或entity payload。
- **R8 — 有界转换：** source与生成text均受Telegram 4096-character边界约束；parser/token/entity数有固定上限。超限或转换失败必须在任何网络调用前确定性拒绝，不能把AST/异常正文写进日志/provider context。
- **R9 — cache authority：** Markdown用法只写在send tool schema，不复制到persona/system prompt。description更新会改变稳定prefix，必须把`CACHE_SCHEMA_VERSION`从6 bump到7、开新epoch并更新tools hash/cache文档；不新增每turn dynamic token。

## 验收标准

- **AC1:** `普通中文 😀`转换结果text逐字节相同、entities为空；fake API payload不含`rich_message`/`parse_mode`，Telegram返回后canonical row恰一条。
- **AC2:** `**粗体** *斜体* ~~删除~~ \`code\``生成正确text和4个entity；混合CJK/emoji前缀的offset/length按UTF-16精确。
- **AC3:** heading/list/code fence/blockquote/table/link fixture产生稳定可读text和支持的entities；raw HTML、javascript/data/file link与Markdown image不执行、不联网、不产生危险URL entity。
- **AC4:** nested style ranges合法、稳定排序、无零长/partial-surrogate/非法交叉；plain paragraph永远没有bold entity，直接锁住本次回归。
- **AC5:** formatted message + sticker + reply仍在唯一一次`send` tool call中按原顺序执行，成功固定`ok`并terminate；provider call数不增加。
- **AC6:** entity-specific确定性400只plain fallback一次；timeout/429/5xx/non-JSON/network/persistence failure的第二次Telegram create调用数为0。任一路径canonical、broadcast、event恰一次。
- **AC7:** send tool仍只有`message,sticker,reply_to`且顺序不变；tools hash、cache schema 7/golden和persona/protocol去重检查通过。
- **AC8:** `bun test test/telegram-markdown.test.ts test/rich-send.test.ts test/sticker.test.ts test/send-tool.test.ts test/cache.test.ts`、全量`bun test`、`bun run check`与真实群plain/bold/list/code/reply smoke通过；自动测试0真实Telegram/TinyFish调用。

## 约束

- Cache impact: **INTENTIONAL**。只改变稳定send description，schema 6→7；不增加tool、参数、provider call或每turn dynamic suffix。
- Token/cost: converter完全确定性，0 LLM call；更精确的短说明替换旧RichMessage描述，不复制到persona。
- Compatibility: canonical DB key、rich inbound列、IPC、message serialization、reply与send ACK grammar不变。
- Safety: 不启用Telegram HTML/MarkdownV2 parser，不访问link，不记录正文/URL；unknown remote outcome不重试。
- 运维: 不在daemon启动时发送capability probe；真实smoke只在T14显式执行。

## 例子与边界 case

- `普通一句话` → `text="普通一句话"`，无entities，视觉上不再整段粗体。
- `这是 **重点**` → `text="这是 重点"`，只给“重点”一个bold entity。
- `😀 **重点**` → bold offset为3（emoji占2个UTF-16 units，加一个空格），length为2。
- `[官网](https://example.com)` → label + `text_link`；`[危险](javascript:...)` → 只有label。
- entity API 400 → 同一plain text无entities一次fallback；网络超时 → 结果unknown且不fallback。

## 可观察性

本地只记录transport、message id与固定失败category。测试可观察converter text/entities和fake API调用；生产审计不得输出source Markdown、URL、chat identity或token。

## 文档影响

实现时同步`docs/architecture.md`、`docs/cache.md`、`docs/testing.md`、中英能力/成本文档以及REQ-TG-0003的出站supersession说明。

## 待决问题

无。当前证据已经排除“模型整段加粗”；采用classic message entities是对presentation bug的最小确定性修复。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13n`、`#T13p`
- Commits: 从`Requirement: REQ-TG-0004` trailer查
