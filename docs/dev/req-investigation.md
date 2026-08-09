# 界面显示与 Telegram 状态消息调查

> 适用范围：`docs/dev/req.md` 在 2026-08-09 提出的四项界面需求。本文记录调查证据、实现边界与验收标准；当前稳定行为仍以 `docs/architecture.md` 为准。

## 结论

四项需求不需要修改 provider prompt、SQLite schema 或模型选择，也不应增加 LLM 调用：

1. Pi 0.84.1 已公开导出 `AssistantMessageComponent`，能够按原始 content block 顺序渲染普通文本与真实 `thinking`。当前 Telegram feed 把两者压平成普通 `Text`，并在持久卡片中截断到 400 字，因此丢失的是本地展示能力，不是 provider 内容。
2. `tool_call`、`tool_result`、`markdown_sent` 与 `send` 当前各写一条 `agent_events` 并立即广播，feed 只能逐条建卡。应保留这些 SQLite 诊断事实，同时为每次 agent run 生成一条有界的 UI activity projection；新 projection 是一张卡，原始行不再重复进入 timeline。
3. 视觉描述已经以 Telegram 的跨 bot 稳定身份 `file_unique_id` 存入共享 `media.vision`，同进程并发还由 `WeakMap<Database, Map<file_unique_id, Promise>>` 合并。现状已经满足“一张图只识别一次”；缺口是没有直接守卫两个 bot 并发请求以及持久 cache hit 的回归测试。
4. Telegram 当前 Bot API 已提供 [`sendRichMessage`](https://core.telegram.org/bots/api#sendrichmessage)，参数是 `rich_message: { markdown }`，成功返回普通 `Message`，并支持 `reply_parameters`。`/status` 可以复用既有 Telegram create → canonical persistence → broadcast 边界，只改变确定性的展示载荷。

## 根因与方案

### 1. 真实 thinking 与完整普通输出

当前链路：

`Pi message_update` → `BotRuntime` 提取三个字符串/数组 → IPC `agent_stream` → feed 自画 `Text`

问题有三处：

- 压平后丢失 thinking/text 的原始 block 顺序和 Pi 原生 Markdown 样式。
- stream 在每个 assistant message 结束时被移除，tool 执行阶段无法延续同一张卡。
- SQLite 中的正文虽然完整，`eventBody()` 却只显示 thinking/assistant text 的前 400 字。

实现 MUST：

- IPC 传递有界的 assistant content projection，保留 `text` / `thinking` block 顺序。
- feed 使用 Pi 公开的 `AssistantMessageComponent`，thinking 默认可见；进入组件前仍执行终端控制字符清洗。
- activity 的生命周期覆盖完整 agent run，而不是单个 assistant message。
- 普通输出不再使用 400 字 UI 截断；单个 activity 的传输 projection 仍受 IPC 载荷上限约束。

### 2. 同一 run 只用一张活动卡

SQLite 的原始 agent events 仍是本地诊断证据，不能为了 UI 合并而删掉。实现采用 side-channel projection：

- `agent_start` 建立 activity identity。
- assistant message、tool call/result、formatted/plain send 与最终 send outcome 按发生顺序追加到最多 64 个 section、总计最多 512 KiB 的 projection。
- `agent_settled` 持久化一条 `agent_activity` 并广播，然后移除临时 stream 卡。
- 同一 activity 的原始事件带本地 `activity_id`，保留在 SQLite/debug 中，但 timeline 查询与 live broadcast 不重复展示它们。
- 旧的、没有 `activity_id` 的历史事件保持可见，不做 schema migration 或历史重写。

这样 pagination authority 仍是 `agent_events.id`，IPC 只增加一个展示事件类型，不引入第二张业务事实表。

### 3. 每张图片只识别一次

不新增实现状态。验收测试 MUST 证明：

- A/B 两个 bot 对同一个 `file_unique_id` 并发调用 `ensureVision()` 时，视觉 executor 只运行一次，两边得到同一结果。
- 描述写入 `media.vision` 后再次调用是持久 cache hit，即使使用新的 executor 也不运行 provider。
- 下载时仍使用拥有对应 `file_id` 的 bot API；本项不改变现有 source 配对规则。

这里的“一次”指一次实际视觉 provider 调用。budget 未获准或媒体尚未下载成功不算 provider 调用，后续仍可重试准备阶段。

### 4. `/status` 富消息

`/status` 的 rich Markdown 使用一个总标题和每 bot 一个小节，突出运行状态、模型/epoch、routing/cooldown、累计 runs/tokens/cost 与最近 compact。所有配置文本先做 Markdown 转义并受 3500 字上限约束。

发送语义 MUST：

- 正常路径只调用一次 `sendRichMessage`，返回的 `Message` 走现有 canonical persistence、control reply marker 与 IPC broadcast。
- 只有 Telegram 明确以 400/404 证明 rich 格式/方法在 create 前被拒绝时，才用预先生成的 plain projection 调用一次 `sendMessage`。
- timeout、断线、429、5xx、非 JSON 等无法证明未创建消息的结果不得 fallback，避免重复控制回复。
- `/help`、`/set`、`/compact` 与权限错误保持 plain text。

## Debug impact

- TUI activity 是 side channel；SQLite 原始 events、`llm_runs`、结构化 `agent_tool` / `agent_send` 日志仍是 authority。activity 持久化或 IPC 失败不得改变 provider turn 或 Telegram send 结果。
- 成功：一条 `agent_activity` 与既有 raw events 可按 `activity_id` 关联；rich status 仍有 canonical sent row、control reply marker 和 `telegram_control` audit。
- 合法 no-op：无可见 assistant/tool section 的 run 不生成空 activity；视觉 cache hit 不产生新 provider telemetry。
- 失败：原有 `agent_runtime` / `agent_tool` / `agent_send` / `telegram_control` 固定 category 足以定位边界，不增加包含正文的新日志。
- 禁止进入 daemon log 的内容不变：assistant text/thinking、tool args、rich Markdown、媒体 identity/path、prompt/response 与 secret 均不得记录。
- activity 最多 64 sections、512 KiB；IPC 原有 1 MiB outbound queue 与 4 MiB receive buffer继续兜底。

## Cache 与成本

- Cache impact：**NONE**。全部改动位于 TUI/IPC 展示、视觉去重测试和 Telegram control transport；不改变 system prompt、tool schema/order、provider message grammar、persona、sticker catalog 或 extension 顺序。
- 新增 LLM 调用：**0**。视觉项只锁定现有去重；rich status 由确定性代码构造。
- 新增 provider-visible token：**0**。

## 开发与提交顺序

1. Pi 原生 assistant activity 卡：IPC projection、runtime lifecycle、timeline 去重展示、回归测试、architecture/testing 同步。
2. 视觉跨 bot exactly-once 守卫：只加长期 invariant 测试和必要文档修正；若测试揭示缺口，再在 `src/media/vision.ts` 最小修复。
3. Telegram rich `/status`：API/send/control integration、exactly-once fallback 测试、architecture/user guide 同步。
4. 完整验证、推送、生产部署与只读健康检查。

每个切片通过目标测试后独立签名提交。部署只在完整 `bun test`、`bun run check`、`bun run lint`、`bun run docs:check` 全部通过后进行。
