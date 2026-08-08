# REQ-UI-0010: 恢复 Pi 原生 feed 的即时刷新与流式 Agent 输出

- **Status:** Implemented（2026-08-08 unit/integration 已验证；真实 Pi 连续流式 smoke 留 T14）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「pi 的界面似乎刷新有延迟，并且原来 pi 是有流式的，但这个界面没有流式，看起来不好」
- **依赖:** REQ-UI-0004、REQ-IPC-0001

## 问题

当前 Telegram custom entry 存在两个可复现的独立缺口：

1. `TelegramFeed` 收到 snapshot/live/history/vision 后只修改内存 `Container`，没有请求 Pi host 重绘。新内容只能等键盘、footer 或其他 Pi 事件碰巧触发 render，因此表现为不稳定的刷新延迟。
2. `BotRuntime` 订阅 Pi AgentSession 时忽略 `message_update`，只在 `message_end` 持久化并广播完整 `assistant_text` / `thinking`。Pi provider 已经逐 token 产生增量，但 daemon 到 plugin 的链路主动丢掉了它们。

本地 Pi 0.84.1 的公开行为已经足够：`message_update` 携带完整 partial assistant message；`setFooter` factory 获得官方 `TUI`；`TUI.requestRender()` 自带约 16 ms 合帧。无需恢复自绘 viewport、轮询终端或另造 renderer。

## 目标

Telegram feed 每次收到离散 IPC 变化都立即请求 Pi 原生宿主刷新；Agent 正在生成的 thinking、assistant text 与 tool call 参数以同一张临时 Pi 原生卡片持续原位更新，结束后由现有持久 LOCAL/Telegram 项接管。

## 非目标

- 不把流式片段写入 SQLite、Pi session 或任一 provider context。
- 不让 Telegram 群消息本身逐 token 发送或反复 edit；Telegram 发送仍只在 `send` tool 完整执行后发生一次。
- 不复制 Pi 的 transcript、viewport、Markdown renderer、16 ms scheduler 或键盘逻辑。
- 不改变 provider request、persona、tool schema、消息 serialization 或 compaction grammar。
- 不保证 attach/IPC 断线期间的中间帧可重放；最终持久事件必须恢复完整可观察结果。

## 需求

- **R1 — 宿主重绘权威：** extension 只通过 Pi factory 提供的 `TUI.requestRender()` 请求刷新。attach 时捕获当前 session 的 TUI handle；feed 的 append/prepend/vision/stats/status/stream/disconnect 变化均触发请求，Pi 负责合帧。`panel off` 不得让仍连接的 feed 失去刷新能力。
- **R2 — ephemeral stream transport：** AgentSession 的 assistant `message_start` / `message_update` / `message_end` 映射为 additive IPC stream start/update/end。update 是带 stream id 的有界完整展示快照，包含 thinking、assistant text 与最多若干 tool call 的 name/arguments；Unix socket 顺序使 replace 幂等，update 即使缺 start 也可建立卡片。
- **R3 — 不持久化：** start/update/end 不调用 `recordEvent`，不进入 `agent_events`、snapshot/history、usage 或 exposure。`message_end` 仍只把最终内容按现有契约持久化一次；先结束临时卡片，再广播最终持久项，避免重复显示。
- **R4 — 原生原位卡片：** feed 按 `(botId, streamId)` 更新一个 `Container`/`Box`/`Text` 组件，不为每个 token append Pi entry 或 timeline item。卡片明确标记 `STREAMING`，分别呈现 thinking、text 和 tool；end/abort/error/disconnect 时移除。
- **R5 — 边界与安全：** 所有流式文本继续走 `sanitize()`。单卡展示内容、tool 数、单 tool 参数与并发 active stream 数均有硬上限；超出只截断 UI，不改变最终 provider/DB 数据。无 listener 时 daemon 不序列化/缓存 stream history，慢 client 继续受既有 1 MiB 出站队列保护。
- **R6 — 生命周期：** 每个 bot 同一时刻最多一个 active assistant message；tool turn 可使用新 stream id。`message_end`、`agent_end`、runtime stop、IPC close 和 extension shutdown 均幂等清理；迟到的旧 stream update 不能覆盖新 stream。
- **R7 — filter 与兼容：** `attach <bot>` 只接收该 bot 的 stream；全局 attach 可并发显示多个 bot。协议只新增 server frame，旧 client 可忽略；新 client 连接旧 daemon 时仍显示最终持久事件。

## 验收标准

- **AC1:** fake host 收到普通 append 后 `requestRender` 计数立即增加；关闭 stats panel 后同一 active feed 的 append 仍增加，且不依赖键盘/定时器。
- **AC2:** fake AgentSession 依次发 thinking/text/toolcall partial 时，同一 stream id 的单张卡片逐步出现内容；Pi entry 数量始终为 attach anchor 的 1。
- **AC3:** 以 `send({message:"你好"})` 为主、没有 assistant text 的回复也能在执行前看到逐步 tool 参数，而不是只显示空 spinner。
- **AC4:** message end 后临时卡片消失，最终 `assistant_text`/`thinking`/`tool_call` 或 Telegram message 只显示一次；DB 中没有 stream row，每个最终事件仍只有一行。
- **AC5:** A/B filter、update-before-start、重复 update/end、abort/error、32+ concurrent streams、超长/ANSI/OSC 参数都有回归；状态与内存有界。
- **AC6:** IPC 断开/重连不重放中间帧但最终 snapshot 可恢复持久结果；旧 frame parser 与旧 daemon 兼容测试通过。
- **AC7:** targeted tests、`bun test`、`bun run check`、cache golden 通过；真实 Pi 中首个 partial 可见且连续生成时无人工触发刷新。

## 约束

- Cache impact: **NONE**。只消费 provider response 的既有本地事件并更新 TUI-only state；provider 可见字节逐字节不变。
- Token / cost: 主模型调用数与输入/输出 token 不变；不得为 UI 发额外 completion。IPC 快照和 active state 必须硬有界。
- 兼容性: IPC server frame additive；不改 SQLite schema、消息 serialization grammar 或 Pi session 持久格式。
- 性能: 复用 Pi `requestRender()` 的 16 ms 合帧；不得创建每-token timer、session entry 或 DB write。
- 安全 / 隐私: 展示内容只等同现有本机 LOCAL/tool observability；不新增 token、key、路径或 provider raw metadata。

## 例子与边界 case

- thinking 先来、text 后来：同一卡片先显示 thinking，再补正文。
- 直接生成 `send` tool：卡片显示 `send · {message: ...}` 的修复后 partial 参数；tool 执行结束后由 Telegram canonical message 接管。
- attach 恰好发生在 stream 中间：第一帧 update 可自行建立卡片并带当前完整有界快照；若之后没有 update，则最终持久事件仍可见。
- panel off：只恢复 Pi default footer，不销毁已捕获的 session TUI render handle。

## 可观察性

测试统计 stream start/update/end、active card 数、render requests 与 DB rows。生产不记录每个 partial；既有 LOCAL final event、usage 与 IPC disconnect 日志足够诊断。

## 文档影响

实现时同步 `docs/architecture.md` 的 Pi transcript/Agent/IPC 生命周期、`docs/testing.md` 与 `docs/handoff.md`。Cache reference 只需记录 NONE，无 schema bump。

## 待决问题

无。中间帧采用有界完整快照而非持久 delta log：这使 update-before-start/reconnect 后续帧可自愈，也避免为 UI 建 replay 数据面。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10f`、`#T10i`
- Commits: 从 `Requirement:` git trailer 查
