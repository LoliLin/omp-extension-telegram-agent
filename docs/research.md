# Pi 研究记录

研究对象：`../pi`（pi-mono monorepo）
commit: `f562a1a44f32fa52c345738c0079d12eb2c5cfba`（version 0.84.1，dist 已构建）

研究方法：rg 找 symbol → 阅读相关函数附近代码 → 得出结论。所有判断对应上述 commit。

---

## 1. 长期运行的 Bot runtime 如何承载 AgentSession

**结论：SDK 同进程，`createAgentSession()`。**

- source: `packages/coding-agent/src/core/sdk.ts:169` `createAgentSession(options)`
- 入口参数：`cwd`、`model`、`thinkingLevel`、`modelRuntime`（`ModelRuntime.create()`，读 `~/.pi/agent/auth.json`）、`sessionManager`、`settingsManager`（daemon 用 `SettingsManager.inMemory()`）、`resourceLoader`
- `session.prompt(text, { streamingBehavior })` 走和用户键入完全相同的路径；streaming 期间再 prompt 必须带 `streamingBehavior: "steer" | "followUp"`，否则抛错 —— 这是现成的 burst 排队机制
- `session.sendUserMessage(content, { deliverAs })` 等价语义（agent-session.ts:1480），fire-and-forget 绑定
- `session.subscribe(listener)` 订阅全部事件，返回退订函数
- `session.dispose()` 终结

备选方案（`pi --mode rpc` 子进程，一进程一 session）被否：persona 注入需绕道扩展，daemon+TUI 都是客户端时要多路复用，代码更多。

## 2. 两个 Bot 如何拥有独立 persona 和 provider history

**结论：同进程两个 `createAgentSession()`。**

- `Agent.state.messages`、`SessionManager`、事件监听全部是实例级状态
- 每个 bot：独立 `SessionManager.create(cwd, sessionDir)`（不同 sessionDir）
- persona：每个 bot 一个 `DefaultResourceLoader({ systemPromptOverride: (base) => personaPrompt })`，调 `loader.reload()` 后传入（resource-loader.ts:191）
- `ModelRuntime` 可共享一个（auth 是进程级资源）
- 进程级共享点只有 file-mutation-queue（按文件路径串行化 edit/write，是保护不是冲突）—— 本项目的 bot 不用文件编辑工具，无影响

## 3. TUI 如何退出而 runtime 继续运行

**结论：daemon 自持全部状态；TUI 是短命 renderer，通过本地 IPC attach/detach。**

- pi-tui 的包名是 `@earendil-works/pi-tui`（不是 @mariozechner）
- `TUI` 接口（tui.ts:291）：`TuiMainScreen`（保留终端 scrollback）和 `TuiAltScreen`（alternate buffer + `ScrollView(follow:"end")`）两个实现
- coding-agent 自己就演示了"组件树跨 renderer remount"：`stop({preserveScreen:true})` → `clear()` → 新 renderer → 同一组件树重新 addChild（interactive-mode.ts:779-806）
- 我们的 TUI 是**独立进程**，通过 Unix socket JSONL 连 daemon：打开时拉历史（daemon 从 SQLite 读）+ 订阅实时事件；退出不影响 daemon
- 流式更新模式：聚合全量文本再 `setText`/`updateContent` + `requestRender()`，渲染有 16ms 节流
- 图片有 `Image` 组件（Kitty/iTerm2 协议），tmux/iTerm2-alt-screen 下必须接受文本 fallback

## 4. Telegram event 如何唤醒 Agent

**结论：`session.sendUserMessage(serializedText)`（deliverAs 默认 / "followUp"）。**

- agent 空闲 → 立即触发新 run；streaming 中未给 deliverAs 会抛错；`"followUp"` 等当前 run 结束后投递
- `input` 事件 `source === "extension"` 可区分注入来源
- 观察结果用 `message_end` / `agent_settled`，不要 await sendUserMessage

## 5. Pi 最终发给 provider 的 payload

source: `packages/ai/src/api/openai-completions.ts` `convertMessages`（:1046-1335）

- system prompt = 单条 `{role:"system"|"developer", content: string}` 在最前，单字符串无分段
- user：纯字符串或 content parts（text + image_url data URI）
- assistant：content 永远是**纯字符串**（多 text block join；空则 null）；thinking blocks 以字段名注入：取第一个 thinking block 的 `thinkingSignature` 作字段名（DeepSeek = `reasoning_content`），thinking 文本 `\n` join 作值（:1168-1175）
- tool call：`{id, type:"function", function:{name, arguments: JSON}}`，id 截断 40 字符
- toolResult：`{role:"tool", content: string, tool_call_id}`；tool result 里的图片转为后续合成 user 消息
- `transformMessages` 前置处理：跨模型 replay 时 thinking 降级为 text；**errored/aborted assistant 消息整条丢弃**；孤儿 tool call 补合成 toolResult

## 6. DeepSeek thinking/tool history 如何 replay

- DeepSeek 走 openai-completions + compat 自动检测（`isDeepSeek`，openai-completions.ts:1488）
- 流式解析依次探测 `reasoning_content`/`reasoning`/`reasoning_text`，字段名存进 `thinkingSignature`
- **thinking 文本会回传**历史（字段 `reasoning_content`），且 `requiresReasoningContentOnAssistantMessages: isDeepSeek` 保证每条历史 assistant 消息至少带 `reasoning_content: ""`（:1223-1229）
- DeepSeek 官方文档建议多轮不回传 reasoning_content，Pi 选择回传——若遇到 provider 报错这是嫌疑点
- **设计约束：持久化 AssistantMessage 时必须原样保留 thinking/thinkingSignature 字段**

## 7. Pi 如何暴露 usage 和 cache read/miss

- `parseChunkUsage`（openai-completions.ts:1374）：cache read = `prompt_tokens_details.cached_tokens`（OpenAI 风格）?? `prompt_cache_hit_tokens`（DeepSeek 风格）；**没有单独 miss 字段，miss = input = prompt_tokens − cacheRead − cacheWrite**
- `Usage`（types.ts:368）：`{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost:{...}}`
- 获取路径：`message_end.message.usage` / `turn_end` / `session.getSessionStats()`
- DeepSeek 无任何显式 cache 字段，服务端自动前缀缓存，**前缀字节级一致才命中** → 稳定前缀的责任全在我们
- 给每个 bot 传稳定且互不相同的 `sessionId`（StreamOptions）有助 OpenAI 系 cache 路由；DeepSeek 无此机制

## 8. send 如何成为 terminating tool

- source: `packages/agent/src/agent-loop.ts:216,582-584` `shouldTerminateToolBatch`
- `execute()` 返回 `{content, details, terminate: true}` → tool result **仍写入 context 并持久化**，但跳过后续 follow-up LLM 调用，run 直接结束
- 前提：同批次**每一个** finalized 结果都 `terminate: true`（并行多 tool 时注意）
- 报错必须 throw；返回任何值都不会标 isError
- **结论：send tool execute → Telegram API → 存 DB → 返回 `{content: "ok sent #id", terminate: true}`，发送后零额外 provider request**

## 9. Pi compaction 的真实行为

source: `compaction.ts`、`agent-session.ts:1962 _checkCompaction`

- 触发：`contextTokens > contextWindow - reserveTokens`（reserve 默认 16384）；contextTokens 用 provider 真实 usage（`calculateContextTokens(usage)`），error 消息回退估算
- summary：单独 LLM 调用（当前会话模型），固定 `SUMMARIZATION_SYSTEM_PROMPT` + `SUMMARIZATION_PROMPT`（Goal/Progress/Next Steps 结构，**coding 导向**）；强制 `cacheRetention:"none"` + 新 sessionId，不写 cache
- 切割：从最新向前累计到 `keepRecentTokens`（默认 20000），在 user/assistant 边界切，永不在 toolResult 处切
- 历史永不删除（append-only JSONL + CompactionEntry），只是上下文视图切换
- **compaction 后 provider prefix 完全变化，prompt cache 全量重建**（= 明确的 epoch boundary，符合我们的 Context Epoch 模型）
- 干预能力：threshold 只能从 settings.json 配；`session_before_compact` 事件可 `cancel` 或返回自定义 `{compaction:{summary,...}}`；底层函数 `prepareCompaction/compact/generateSummary/estimateContextTokens/shouldCompact/appendCompaction` 全部 public
- **结论：群聊场景应 `enabled:false` 关自动，daemon 自己用 `estimateContextTokens()` 按 128K 阈值监控，用自定义 persona 导向 summary prompt 调底层函数（Phase 8 实现）**

## 10. 普通聊天是否需要自定义 compaction policy

需要，理由：内置 summary prompt 是 coding task 导向（Goal/Constraints/Progress），不适合群聊 persona；threshold 需要 128K 而非 contextWindow-16K；summary 应倾向"状态"（人物关系/长期话题/未解决事项）而非逐条复述。Phase 8 实现自定义 policy。

## 11. TUI 可以复用哪些 Pi 组件

`@earendil-works/pi-tui` 单入口导出：`ProcessTerminal`、`TuiMainScreen`/`TuiAltScreen`、`Container`、`Box`、`Spacer`、`Text`、`TruncatedText`、`Markdown`（heading/code block 带语法高亮回调/list/table/blockquote/hr/bold/italic/strikethrough/codespan/OSC8 link/LaTeX；流式友好 trimPartialClosingFences）、`Image`（PNG/JPEG/GIF/WebP）、`ScrollView(follow:"end", primary)`、`Editor`/`Input`

群聊 TUI 骨架 = `TuiAltScreen` + `ScrollView(follow:"end")` 包 transcript `Container`，每条消息一个 `Markdown`/`Text`，消息间 `Spacer`。

## 12. 哪些能力完全在项目自身完成

- Telegram Bot API 客户端（raw fetch long polling，无第三方 SDK 依赖）
- SQLite 持久化（raw updates / canonical messages / agent events / LLM runs / telemetry）
- deterministic routing（HMAC）
- 群聊序列化 grammar（LLM 看到的紧凑格式）
- persona system prompt 组装
- message exposure tracking / context epoch 管理
- TUI 进程 + IPC
- vision lazy execution + cache（Phase 7）
- search / run_js tool 实现（Phase 6）
- telemetry + threshold 分析脚本（Phase 8）

---

## 关键 API 速查（实现时以 ../pi node_modules 的 .d.ts 为准）

```ts
// 创建 session（每 bot 一次）
const modelRuntime = await ModelRuntime.create();
const loader = new DefaultResourceLoader({ systemPromptOverride: () => personaPrompt });
await loader.reload();
const { session } = await createAgentSession({
  cwd, model, thinkingLevel, modelRuntime,
  sessionManager: SessionManager.create(cwd, sessionDir),
  settingsManager: SettingsManager.inMemory({...}),
  resourceLoader: loader,
});

// 重启恢复
SessionManager.open(sessionFile)          // 精确恢复
SessionManager.continueRecent(cwd, dir)   // 最近一个

// 注入群消息
session.sendUserMessage(text)             // 空闲时直接触发
// 事件
session.subscribe(e => { /* message_update/message_end/turn_end/agent_settled/entry_appended/... */ });
```

---

## REQ-UI-0001 R1 研究：pi-tui 插件形态 vs 独立进程 + kitty 图像（2026-08-07）

**问题**：Telegram 历史界面要不要写成 pi 插件（extension）形态，以复用 pi 主程序的 TUI 与 kitty 图像能力？

**结论：不采用插件形态，保持独立 TUI 进程；kitty 图像支持直接复用 pi-tui 的 `Image` 组件。**

依据（pi docs tui.md + extensions.md + packages/tui/src/components/image.ts）：

1. **插件 UI 只能活在 pi 主程序布局内**：extension 通过 `ctx.ui.custom()` / `setWidget` / `setFooter` 渲染组件，它们是 pi 会话屏幕的一部分（overlay / 底部 widget / footer），没有「接管整个终端」的形态。我们的 Telegram 观察者需要独占全屏（TuiAltScreen）、随时 attach/detach、与后台 daemon 走独立 IPC——这些都不属于 pi 主程序的会话模型。强行插件化 = 每次观察都要开一个 pi 会话，且 UI 被夹在编辑区/输入区之间。
2. **pi-tui 是独立包**（`@earendil-works/pi-tui`），我们本来就直接依赖它（TuiAltScreen/ScrollView/Text）。复用组件与插件形态互斥无关——独立进程同样用全套组件。
3. **kitty 图像协议在 pi-tui 里是原生 `Image` 组件**：`getCapabilities()` 探测终端（KITTY_WINDOW_ID / TERM_PROGRAM kitty|ghostty|wezterm|warp），kitty 协议用 image placement（imageId 复用/清理），非 kitty 自动降级为 `imageFallback` 文本占位符。`Image(base64, mime, {fallbackColor}, {maxWidthCells, maxHeightCells, filename})` 可直接嵌入 ScrollView，行列高度按单元尺寸换算——resize/滚动由 TUI 层重绘处理（pi 自身聊天渲染即此路径）。
4. **媒体传输路径**（R5）：daemon 的 media 缓存已有稳定本地路径 `data/media/<file_unique_id>.<ext>`（vision.ts local_path），TUI 与 daemon 同 uid、socket chmod 600 —— IPC 只传路径字符串，TUI 自行读文件转 base64；tgs/webm/超限文件降级占位符。不扩大本机暴露面。

**落地**（REQ-UI-0001 R2–R5）：TUI 保持独立进程；`MsgItem` 增加 `mediaPath`/`mediaDesc`（additive 协议字段）；有本地缓存且 ≤1MB 的 photo/sticker 渲染 `Image`，其余（tgs/webm/大图/无缓存）保持现有占位符 + vision 描述文本。
