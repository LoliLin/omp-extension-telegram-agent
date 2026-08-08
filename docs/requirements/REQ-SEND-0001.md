# REQ-SEND-0001: 统一并内聚 Telegram 公开发送工具

- **Status:** Approved（2026-08-08 已调查，未实现）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：回复、文字、sticker 必须合并为一个工具；用法放进工具 schema，不在人设 AGENTS.md 重复；成功后不再调用模型，以 overall cost 为第一目标
- **依赖:** REQ-AGENT-0001、REQ-STICKER-0001、REQ-ROUTE-0001

## 问题

运行时已经只有一个 `send({message?, sticker?, reply_to?})`，成功结果也已经带 `terminate: true`，所以当前并不存在三个独立发送工具或成功后第二次 provider request。剩余问题仍会削弱行为与成本目标：

- `send` 的完整用法在两个 persona、共享 system protocol 与 tool description 中重复，且曾出现 `text/sticker_id` 与当前 `message/sticker` 不同步的历史文案；
- persona 的“防刷屏”规则可以覆盖被配置名称直接点名的显式请求，使 router 已经唤醒正确 bot 后模型仍选择沉默；
- 成功结果把动态 `ok sent #<id>` 写入持久会话，下一次 provider request 会重新读取这些无决策价值的 token；
- 当前 `toolsHash()` 没有包含 tool description，单独改工具提示词时 telemetry/golden 无法识别 provider-visible protocol 已变化。

本地 Pi 0.84.1 源码确认：`terminate: true` 会跳过成功发送后的 follow-up provider request，但 tool call 必须配对一个持久化 `toolResult`；空 content 在 OpenAI adapter 中会展开成 `(no tool output)`。因此“调用后不返回”的最低成本可实现语义是：不再请求模型，并只保留固定、最短的结构 ACK；不能删除协议要求的 tool result。

## 目标

模型只看见一个拥有文字、sticker 与引用 modifier 的第一方 `send` 工具。工具 schema 是参数和调用方式的唯一权威；显式点名获得一次公开回复；成功发送立即终止本轮，后续上下文只承担最小固定 ACK 成本。

## 非目标

- 不把 Telegram 的两次网络操作伪装成事务；文字 + sticker 仍可能由 Bot API 分两次发送。
- 不合并 `search`、`run_js` 等非发送工具。
- 不改变 Pi editor 的 operator manual-send IPC（REQ-UI-0005）。
- 不在模型保持沉默时再发起一次“纠错”LLM 请求，也不自动发送模型的私有 Assistant 文本。
- 不自动重试 Telegram outcome unknown 或部分网络失败。

## 需求

- **R1 — 唯一公开通道：** provider-visible tools 中只存在一个公开 Telegram 工具 `send`；不得新增独立 `reply`、`send_message`、`send_sticker` 或旧 MCP sticker 工具。`search`/`run_js` 不属于公开发送通道。
- **R2 — 一次组合：** `send` 同时接受可选 `message`、`sticker` 与 `reply_to`；`message|sticker` 至少一个存在。文字、贴纸和引用关系必须合并在同一次 tool call，`reply_to` 是两种 payload 共用的 modifier。
- **R3 — tool-local authority：** tool description/parameter descriptions 必须完整说明公开/私有通道、一次组合、可见 `#id`、sticker 候选、纯 sticker、最终调用与成功终止语义。persona 与共享 protocol 只保留人格、何时回应、消息 grammar 等职责，不复制参数表、调用示例或错误恢复步骤。根 `AGENTS.md` 固化此归属规则。
- **R4 — 显式回复义务：** 人类消息经 mention、reply-to-bot 或配置 `name` 路由为显式触发时，persona 不得用概率插话的防刷屏/沉默启发式覆盖它；应在安全和平台约束允许时调用一次 `send`。例如 B 的配置名称为“小雨”且 `routing_p=0` 时，“我叫小雨”仍必须进入 B 并公开回复。
- **R5 — 最终工具调用：** `send` 是完成内容选择后的唯一最终 tool call；需要查询/计算时先完成其他工具，再调用一次 `send`。不得把文字、sticker、reply 拆为多个 provider turn 或多个 send call。
- **R6 — 终止与最小 ACK：** 成功结果必须 `terminate: true`，不得触发 follow-up provider request。provider-visible tool result 使用固定最小 ACK，不含动态 Telegram message id、正文、file id 或完整 Bot API 对象；发送 id 只留在本地 details/DB/telemetry。
- **R7 — 失败语义：** 所有可确定校验在首个网络调用前完成；非法/不可见 `reply_to`、空 payload、未知或不可发送 sticker 结构化失败。失败可返回模型修正，但成功或 outcome unknown 不自动重试。
- **R8 — cache 协议：** tool description 与 parameter schema 都属于 provider prefix；hash 必须覆盖 name + description + parameters + order。实现本需求时 bump `CACHE_SCHEMA_VERSION` 并开启新 epoch，golden 精确锁定预期变化。

## 验收标准

- **AC1:** `TOOL_DEFS`/实际注册顺序仍恰好是 `send, search, run_js`；send schema 只有 `message, sticker, reply_to`，没有第二个公开发送工具。
- **AC2:** component test 用一次调用同时发送文字 + sticker + reply，两个 Telegram 请求收到同一 `reply_to`，成功结果为 `terminate: true` 与固定最小 ACK；本地 details 仍能诊断发送 id。
- **AC3:** 测试证明仅修改 tool description 会改变 tools protocol hash；`CACHE_SCHEMA_VERSION`、system/tools golden 与 cache 文档同步。
- **AC4:** 两个 persona 和共享 protocol 不再包含 send 参数调用示例、参数表或 `messaging.reply_not_visible` 恢复教程；tool schema 单独包含这些语义，机械测试防止重新复制。
- **AC5:** `routing_p=[0,0]`、消息“我叫小雨”仍得到 `{target:B, reason:name}`；busy 时 coalesce、cooldown 时立即走 explicit path，而非 probability skip。
- **AC6:** fake session/harness 证明成功 send 后没有第二次 provider completion；后续 replay 的结构 ACK 不含消息 id，且比旧 `ok sent #<id>` 有更低的动态 token 成本。
- **AC7:** `bun test`、`bun run check`、cache golden 通过；真实群 smoke 覆盖文字、纯 sticker、文字 + sticker + reply 各一次且没有紧随其后的模型输出。

## 约束

- Cache impact: **INTENTIONAL**。persona/system prompt 去重、tool description 增强、tools hash 修正都会改变稳定 prefix；实现必须 bump `CACHE_SCHEMA_VERSION`、全 bot 新 Context Epoch，并同步 `docs/cache.md`。
- Token impact: 稳定 prefix 预期净缩短；每次成功发送省去动态 id 结果 token，且 `terminate` 保证额外 provider request 为 0。不得用新增 LLM fallback 换取“保证回复”。
- 兼容性: SQLite、Telegram message grammar、IPC 与现有 `send` 参数名不变；旧 session 在新 epoch 通过现有 compaction/context boundary 继续可回放。
- 安全 / 隐私: token、Bot API 完整对象、file id 不进入 provider-visible结果或日志。

## 例子与边界 case

- `send({message:"收到", reply_to:18452, sticker:"s12"})`：一次模型 tool call；Telegram 可产生文字与 sticker 两条消息；成功后本轮结束。
- `send({sticker:"s12"})`：合法纯 sticker。
- `send({reply_to:18452})`：空 payload，网络调用前失败。
- `send({message:"收到", reply_to:99999})`：当前 context 未暴露该 id，网络调用前失败。
- 同一 Assistant message 同时请求 `search` 和 `send`：违反最终调用约束；不得依赖 mixed batch 的 terminate 语义。

## 可观察性

沿用 `agent_events` 的 `tool_call/tool_result/send/error`，本地 send event 保留 sent ids；不新增消息正文日志。usage telemetry 可比较实现前后 system/tools hash、miss tokens 与成功 send 后 provider run 数。

## 文档影响

`AGENTS.md`、`docs/architecture.md`、`docs/cache.md`、`docs/research.md`、`docs/testing.md`、两个 persona。

## 待决问题

无。Pi 的结构 tool result 不能删除，采用固定最小 ACK 是已调查后的兼容结论。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10e`
- Commits: 从 `Requirement:` git trailer 查
