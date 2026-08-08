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
- 空 content 经 OpenAI adapter 会变成 `(no tool output)`，反而比固定 `ok` 长；tool result 的 `details` 不进入 provider payload
- **结论：send tool execute → Telegram API → 存 DB → 返回 `{content: "ok", details:{sent}, terminate:true}`；发送后零额外 provider request，后续 context 不含动态 sent id**

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

> **已被 2026-08-08 复核推翻。** 本节把“扩展内手写 viewport”误当成 Pi 插件完成态，并且真实探针运行的是全局 Pi 0.83.0，不是项目依赖的 0.84.1。保留本节只用于解释错误方向的来源；当前决策见下一节。

**问题**：Telegram 历史界面要不要写成 pi 插件（extension）形态，以复用 pi 主程序的 TUI 与 kitty 图像能力？

**结论：不采用插件形态，保持独立 TUI 进程；kitty 图像支持直接复用 pi-tui 的 `Image` 组件。**

依据（pi docs tui.md + extensions.md + packages/tui/src/components/image.ts）：

1. **插件 UI 只能活在 pi 主程序布局内**：extension 通过 `ctx.ui.custom()` / `setWidget` / `setFooter` 渲染组件，它们是 pi 会话屏幕的一部分（overlay / 底部 widget / footer），没有「接管整个终端」的形态。我们的 Telegram 观察者需要独占全屏（TuiAltScreen）、随时 attach/detach、与后台 daemon 走独立 IPC——这些都不属于 pi 主程序的会话模型。强行插件化 = 每次观察都要开一个 pi 会话，且 UI 被夹在编辑区/输入区之间。
2. **pi-tui 是独立包**（`@earendil-works/pi-tui`），我们本来就直接依赖它（TuiAltScreen/ScrollView/Text）。复用组件与插件形态互斥无关——独立进程同样用全套组件。
3. **kitty 图像协议在 pi-tui 里是原生 `Image` 组件**：`getCapabilities()` 探测终端（KITTY_WINDOW_ID / TERM_PROGRAM kitty|ghostty|wezterm|warp），kitty 协议用 image placement（imageId 复用/清理），非 kitty 自动降级为 `imageFallback` 文本占位符。`Image(base64, mime, {fallbackColor}, {maxWidthCells, maxHeightCells, filename})` 可直接嵌入 ScrollView，行列高度按单元尺寸换算——resize/滚动由 TUI 层重绘处理（pi 自身聊天渲染即此路径）。
4. **媒体传输路径**（R5）：daemon 的 media 缓存已有稳定本地路径 `data/media/<file_unique_id>.<ext>`（vision.ts local_path），TUI 与 daemon 同 uid、socket chmod 600 —— IPC 只传路径字符串，TUI 自行读文件转 base64；tgs/webm/超限文件降级占位符。不扩大本机暴露面。

**落地**（REQ-UI-0001 R2–R5）：TUI 保持独立进程；`MsgItem` 增加 `mediaPath`/`mediaDesc`（additive 协议字段）；有本地缓存且 ≤1MB 的 photo/sticker 渲染 `Image`，其余（tgs/webm/大图/无缓存）保持现有占位符 + vision 描述文本。

---

## REQ-UI-0004 复核：Pi 原生 transcript custom entry（2026-08-08）

**结论：Telegram feed 应成为 Pi transcript 中一个 TUI-only custom entry；不再使用 `ctx.ui.custom` 聊天窗口，也不再自己管理 viewport。**

### 版本事实

- 项目 `package.json` 的四个 Pi 包均指向 `../pi` 0.84.1；项目入口 `bun run pi` 使用这份声明依赖。
- 0.84.1 的 coding-agent fullscreen transcript 管理滚动与 Kitty viewport cropping。早先围绕系统旧版 binary 的探针已失效，不再是当前运维问题。

### API 边界

1. `ctx.ui.custom()` 只临时替换 editor container。它不是 transcript 插槽；要让它像聊天窗口一样滚动，仍需项目自己维护高度、scrollTop 和输入，正是要删除的重复代码。
2. `pi.registerMessageRenderer` 对应 custom message，消息会参加 LLM context，不适合 observer UI。
3. `pi.registerEntryRenderer` + `pi.appendEntry` 对应 custom entry，官方文档明确说明 **不进入 LLM context**。renderer 返回普通 Pi `Component`，宿主把它放进自己的 transcript。
4. 每条 Telegram 消息各 append 一个 entry 会让 Pi session 随群历史线性膨胀。正确粒度是：一次 attach 只 append 一个锚点 entry；entry 的动态 `Container` 在内存中接收 snapshot/live/page，真实持久历史仍在 SQLite。
5. public extension API 不暴露宿主 transcript 的 scroll-top 事件。历史分页采用显式 `/tg more`；这比读取私有 layout/scroll 状态或轮询终端尺寸稳定。

### 组件与生命周期

- message/event/date/media：只组合 `Container`、`Box`、`Text`、`Markdown`、`Image`、`Spacer`，颜色来自 entry renderer 的 `theme`。
- scrolling、resize、mouse/keyboard、selection、width guarding、Kitty placement/cropping：全部由 Pi fullscreen transcript 拥有。
- session restore 时，旧 attach entry 只渲染 detached 摘要；只有当前 `/tg attach` 产生的 instance id 能拿到内存 activation 并建立 IPC socket，避免 reload 重复连接。
- `/tg attach` 保证单 live feed，`/tg more` 分页，`/tg detach` dispose；panel 使用 `setWidget` component factory。

### Cache / token 结论

custom entry 不进入 LLM context；IPC 与 provider serialization 不变。Cache impact = **NONE**，由 `test/cache.test.ts` golden 复核。

---

## REQ-UI-0005 调查：复用 Pi editor，而不是再造输入框（2026-08-08）

**结论：使用 extension `input` event 拦截 compose 模式的 interactive submit；不替换 editor component。**

- Pi 当前 extension 文档规定处理顺序：已注册 extension command → `input` event → skill/template expansion → agent。handler 返回 `{ action: "handled" }` 可跳过 agent。
- 因而 Telegram compose 可以完整保留 Pi 原生 editor/history/autocomplete/keybindings；只有显式模式下的普通文本被送到 daemon。
- 当前 IPC 是 observer-only，extension 也没有 bot token。实现需要 additive request/reply，由 daemon 复用 Telegram send → canonical DB insert → live broadcast 链路。
- 风险不是 UI 技术，而是发送身份与误发：全局 attach 没有唯一 bot，必须显式选择并持续显示 `SEND AS <bot>`；断线后的未知结果不得自动重试。
- 详细验收边界见 `requirements/REQ-UI-0005.md`。

## REQ-UI-0006 调查：vision 结果已有，但 live UI 缺 update（2026-08-08）

**结论：复用 `media.vision`，新增完成通知并更新现有 TUI-only card；不触发额外识别。**

- `IpcServer.msgToItem()` 在 snapshot/history 时会读取 `media.vision` 到 `mediaDesc`，所以重连后能看到描述。
- `ensureVision()` 完成只持久化 SQLite；live feed 没有 `vision_update`，初次广播的 message card 不会自动补描述。
- 最小链路是 additive `fileUniqueId` + `vision_update`，timeline 合并后 invalidate；同一 media 的多个 message card 一起更新。
- UI 更新只改变 custom entry 内存组件树，不 append Pi entry、不改 `serializeMessages`，Cache impact = **NONE**。默认也不为 UI 新增视觉 provider call。
- 详细验收边界见 `requirements/REQ-UI-0006.md`。

## REQ-STICKER-0002 调查：跨 bot 候选泄漏导致 no file_id（2026-08-08）

**结论：生产 bug 已定位到 `stickerCandidatesBlock()` 缺少 per-bot sendability filter。**

- session 历史：A 对 `s243/s241/s244/s242`、B 对 `s144` 的 send tool 均返回 `not sendable by this bot (no file_id)`。
- SQLite：`s241–s244` 属于 B 的 Mikufufu 且只有 B file_id；`s144` 属于 A 的 myadestes set 且只有 A file_id。
- 动态候选目前只排除当前 bot 自己配置的 set，却查询全局 `media`；于是“另一个 bot 的固定目录”会变成“我的 set 外动态候选”。
- `executeSend` preflight 已正确阻止 network send，故没有半发送；修复点是让固定目录与动态候选都只暴露当前 bot 可发送的 mapping。
- 过滤稳定 catalog prefix 会改变 provider bytes；实现必须 bump `CACHE_SCHEMA_VERSION` 并开新 epoch。详细要求见 `requirements/REQ-STICKER-0002.md`。

## REQ-PLAT-0001 调查：N-bot 核心已通用，外围和 provider 仍有固定假设（2026-08-08）

**结论：不要重写 daemon；收口剩余明确缺口。**

- 已通用：配置数组、daemon composition、router、TEXT bot_id、IPC stats/filter 与 Pi UI 都按任意 bot id/数量工作；单 bot和三 bot配置已有 unit test。
- 未收口：runtime model lookup 固定 `deepseek` 与单全局 key；e2e scripts 隐式 `bots[0]`；package/project/runbook 仍把小雪/小雨双 bot 当产品本体；第三 bot 完整启动链未验证。
- 当前“一份 deployment = 一个群 + N bots”是合理的简洁边界，应明确文档化；多群不应被误宣称已支持。
- 现有双 bot deployment 必须保持 cache/provider bytes 不变；通用性来自 config dispatch，不能靠给 prompt 塞平台 metadata。
- 详细审计清单见 `requirements/REQ-PLAT-0001.md`。

## REQ-ROUTE-0001 调查：当前 busy trigger 会排下一轮，不会跳过采样（2026-08-08）

**结论：在 daemon probability scheduler 增加 availability/cooldown gate；不改 ingestion 或阻塞 poller。**

- canonical duplicate 不会重复 route；Poller 只对 inserted/edited 调 callback。
- 每条 callback 当前都调用 `routeMessage`，router 不知道 runtime 状态。命中 busy bot 后，`BotRuntime.trigger()` 设置 `pendingTrigger`，当前 flush 结束立刻再 flush，正是 burst 中连续 run 的来源。
- 不同 BotRuntime 已可并发，所以 A busy 时本来命中 B 概率桶的新消息可正常让 B 工作；只需让 busy/cooldown target 的概率命中 skip，且不要重新分配给另一个 bot。
- 2 秒停顿用 `cooldownUntil` + 可注入 clock，不用真实 sleep；skip 的消息只存库，不在 cooldown 到期时补抽，下一次合法 trigger 再由 exposure batch 带入。
- explicit mention/reply/name 不是概率采样，调查建议保留 pending coalesce，避免直接呼叫丢失。详细边界见 `requirements/REQ-ROUTE-0001.md`。

## REQ-UI-0003/0007 再调查：精确复用 Pi 原生 usage 行（2026-08-08）

**结论：`setStatus` 无法满足用户样例；用 `setFooter` 直接挂 Pi 导出的 `FooterComponent`，不复制 renderer。**

- 用户实机要求的是 default footer 第二行的 `↑/↓/R/CH/$/context/model` 结构，不是第三行 extension status。源码确认 `setStatus` 永远在 cwd/usage/model 后另起一行，因此先前 UI-0007 的 setStatus 结论作废。
- `FooterComponent` 公开导出并独占 token formatting、context/model、theme、width/truncate 与 extension status 合并；`setFooter(factory)` 是官方 mount point。
- extension API 没有 external usage setter。插件将 IPC `BotStats` 映射为只读内存 telemetry session view后交给 `FooterComponent`；view 委托真实 sessionManager 的 cwd/name和 modelRegistry 的 model/context window，但不写真实 Pi session、也不进入 provider context。
- 精确 mapping：cacheMiss→input `↑`、output→`↓`、cacheRead→`R`、read/(read+miss)→`CH`、cost→`$`、latest context/model→context/model。全局 aggregate totals，latest run 决定 context/model。
- 生产代码不得实现 footer render/format/padding/theme；Pi 升级不兼容时显式适配 view contract，不能复制 FooterComponent 源码。完整数值继续由 `/tg status` 提供。

## REQ-UI-0008 调查：一个 `/tg` 可用原生 API 做任意层参数补全（2026-08-08）

**结论：为 `registerCommand("tg")` 实现 `getArgumentCompletions`，用共享命令树返回完整 argument value。**

- Pi 在 `/tg ` 后把完整 argument text 传入 completion callback；选择 item 后替换完整 argument prefix。
- 因此一级建议 value=`attach`，二级建议 value=`attach A`，未来三级同理。callback 可返回动态 bot id/name 与 `off`。
- 不需要自定义 autocomplete provider/editor/menu；命令树应同时生成 handler dispatch、completion 与 help，防止清单漂移。
- 详细 prefix/leaf/config-error 验收见 `requirements/REQ-UI-0008.md`。

## REQ-UI-0009 调查：lifetime 累计与 Pi 能原生显示的更多指标（2026-08-08）

**结论：现有 footer totals 已是 SQLite 首条 telemetry 以来的全生命周期累计；补齐 `W`，其余明细放 `/tg status`。**

- `IpcServer.loadStats()` 对 `llm_runs` 无时间下界地 COUNT/SUM，且只按 bot filter；因此 baseline 跨 daemon/Pi restart、epoch 和 compaction。Timeline snapshot 的 `lastId=MAX(id)` 会滤掉竞态中已进入 baseline 的 push，live run 恰好累计一次。
- Pi `FooterComponent` 把 entries 全历史 usage 汇总为 `↑/↓/R/W/$`，CH 用最新 entry 的 `read/(input+read+write)`；本插件只有一个 synthetic lifetime entry，所以 CH 也是 lifetime。context 则必须是 latest occupancy，不能累加历史 context。
- 当前 telemetry 丢失了 provider `cacheWrite` 的独立值；`llm_runs` 需加默认 0 的兼容列，新 run 精确记录，历史未知值不回填。这样 Pi 在非零时自然显示 `W`。
- runs、epoch、first/last time、reasoning total 与 latency 不属于 Pi native usage layout；`reasoning_tokens/latency_ms` 已在 DB，可作为 `/tg status` 的 lifetime/latest 详情。拒绝额外 footer status 行、session name hack 或自绘 renderer。
- Cache impact **NONE**：只补 provider response telemetry 的持久化/IPC/TUI，不改请求字节或 agent context。详细契约见 `requirements/REQ-UI-0009.md`。

## REQ-UI-0010 调查：延迟来自漏掉 host render，流式来自漏掉 message_update（2026-08-08）

**结论：两个根因都在项目 glue code；复用 Pi 已有事件和 scheduler 即可，不需要自绘 UI。**

- `BotRuntime.subscribeEvents()` 当前只在 `message_end` 提取 assistant text/thinking；Pi AgentSession 已按 provider token 发出 `message_update`，其中 partial message还包含逐步修复后的 tool call arguments。项目主动丢掉这些事件，所以以 `send` tool 为主的回复直到 tool execution 才有可见输出。
- `TelegramFeed.onEvent()` 会 append/rebuild component tree，但 custom entry renderer 拿不到 TUI，changed callback 也没有请求重绘。于是 socket 数据已经到达，屏幕仍要等宿主下一次无关 render，形成不稳定延迟。
- Pi 的 `setFooter(factory)` 官方 factory 会同步拿到同一个 session `TUI`；attach 本来就挂 native footer，可以保留这个 handle 的 `requestRender` callback 供 feed 生命周期使用。`panel off` 只恢复 footer presentation，不应清掉 session render handle。
- Pi `TUI.requestRender()` 内部已合并重复请求并限制到约 16 ms 一帧；项目不再加 debounce/render loop。stream update 使用有界完整展示快照，允许 update-before-start 自愈，并覆盖 thinking/text/partial tool args；start/update/end 不落 DB/Pi session/provider context。
- Cache impact **NONE**，新增 completion/token/DB writes 均为 0。详细边界见 `requirements/REQ-UI-0010.md`。

## REQ-TG-0002 调查：Telegram 原生处理状态需要主动续约（2026-08-08）

**结论：accepted response opportunity 持有一个 per-bot `typing` lease；4 秒续约，send/settle 时 release。**

- 用户纠正成立：Telegram 已有原生 Thinking。`sendMessageDraft` 传空 `text` 会显示 “Thinking…” placeholder；Bot API 10.1/10.2 的 `sendRichMessageDraft` 还支持 `<tg-thinking>` / `InputRichBlockThinking`。
- 两个 draft method 的 `chat_id` 都明确限定为目标**私聊**，thinking block 又只能用于 rich draft。当前 deployment 的目标是 `-100…` supergroup，所以不能把 private draft 发到群，也不能偷发到 trigger sender 私聊。
- 群聊 capability fallback 是 `sendChatAction {action:"typing"}`：官方说明状态只保持 5 秒或更短，bot 消息到达会清除；动作表没有 `thinking` action，因此模型尚未决定输出类型时统一使用 `typing`。
- 启动点不能是每条 ingested message：应在 `dispatchRoutingDecision` 接受 runtime trigger 后，由 runtime 自己覆盖 flush/pending 生命周期。这样 nobody、probability busy/cooldown skip 不会制造虚假反馈，explicit coalesce 也不会创建重复 timer。
- `send` 成功后 Telegram 消息会清状态，runtime 同时停止续约；无 send、abort/error/沉默则在 flush settle 停止，已有状态按官方剩余 5 秒自然过期。API 没有 cancel action，不能承诺即时清除。
- side channel 必须 best-effort：每 bot 一个 timer、4 秒至多一次、禁止 overlapping call；错误不影响 route/provider/send，日志按 failure streak 去重。Cache/token impact **NONE**。
- 官方参考：<https://core.telegram.org/bots/api#sendmessagedraft>、<https://core.telegram.org/bots/api#sendrichmessagedraft>、<https://core.telegram.org/bots/api#sendchataction>；完整验收见 `requirements/REQ-TG-0002.md`。

## REQ-TG-0003 调查：Rich Messages 是 final message 能力，不是群 draft streaming（2026-08-08）

**结论：保留唯一 `send` 工具，把 `message` 解释为 Rich Markdown；收发两端统一持久化有界 rich source，并只向 Pi/provider 暴露纯文本投影。**

- Bot API 10.1 增加 `RichMessage`、`InputRichMessage`、`sendRichMessage` 与 `sendRichMessageDraft`，10.2 又增加 rich media 与 thinking block。`sendRichMessage` 可面向目标 chat/supergroup；`InputRichMessage` 必须在 `html`、`markdown`、`blocks` 中恰选一个。
- 项目已有唯一 `send(message?, sticker?, reply_to?)`。最小稳定模型 contract 是让 agent 的 `message` 使用 `rich_message:{markdown}`；普通文本仍是合法子集，不暴露巨大 block union、HTML 或另一个 `send_rich` 工具。operator compose 继续 literal plain text。
- 当前 normalize 只看 `text/caption`。incoming/edit/sent/echo 必须共用一个有深度、节点、输出和 raw JSON 上限的 rich-to-plain projector；SQLite 保存有界 source，IPC、Pi feed和 provider serialization只拿投影，不泄露 file id、URL metadata或整段 JSON。
- outbound fallback 只允许 Telegram 明确返回“未创建消息”的确定性 4xx 后降级一次 plain `sendMessage`；timeout、5xx、非 JSON和 outcome unknown 都不得 fallback，防止双发。canonical insert、broadcast、exposure和固定 ACK仍恰好一次。
- `send.message` description 是稳定 provider prefix；实现 Rich Markdown authority 必须 bump `CACHE_SCHEMA_VERSION`、开新 epoch并更新 tools hash golden。参数/顺序、LLM call 数与动态 tool result不增加。
- private `sendRichMessageDraft` 不用于当前 supergroup；原生 draft Thinking 的 capability 边界由 REQ-TG-0002 单独锁定。
- 官方参考：<https://core.telegram.org/bots/api#sendrichmessage>、<https://core.telegram.org/bots/api#inputrichmessage>、<https://core.telegram.org/bots/api#sendrichmessagedraft>；完整验收见 `requirements/REQ-TG-0003.md`。

## REQ-SEND-0002 调查：重复消息来自远端成功后的本地失败被误报为可重试（2026-08-08）

**结论：Telegram create call 是不可回滚的 commit boundary；跨过后只能终止并恢复本地副作用，不能把整次 tool call抛回模型重试。**

- 生产 canonical 明确记录 `#19614/#19615` 与 `#19619/#19621` 两组逐字相同消息。对应 agent trace 都是：第一次 `tool_call send` 已在Telegram创建消息，随后 `tool_result.isError=true`；模型以“数据库锁了，重试一次”发出第二个相同tool call。
- 第一条已成功但未进入第一次`send` event，说明失败点在API成功后的canonical/event链，而不是两次独立routing。同期多daemon造成的SQLite lock/409放大了问题；OPS-0002修复单写者后仍必须修正send事务语义。
- `sendRichTextAndPersist`已经抛出专门的`SentMessagePersistenceError`，但runtime没有把它与preflight/network rejection区分。sticker insert、markExposed、broadcast/event，以及message成功后sticker失败也有相同半提交风险。
- Telegram没有本项目可用的通用idempotency key。确定性rich rejection的一次plain fallback仍合法；timeout/网络断开、远端成功后的本地失败和组合partial都必须是terminal no-retry，且本地canonical恢复按message id幂等、绝不触网。
- Cache impact **NONE**：send tool/schema/grammar不变；正常路径零token变化，异常路径减少重复Telegram请求和provider纠错turn。完整边界见`requirements/REQ-SEND-0002.md`。

## REQ-UI-0012 调查：Kitty/Ghostty能力检测正确，payload格式错误（2026-08-08）

**结论：保留Pi `Image`，按Pi自己coding-agent的模式在Kitty路径先异步`convertToPng`。**

- Context7当前Pi文档声明`Image`可接收PNG/JPEG/GIF/WebP，且Ghostty使用Kitty graphics protocol；本地已升级Pi源码也明确把Kitty/Ghostty/WezTerm/Warp检测为`images:"kitty"`。
- 同一源码的`encodeKitty()`固定`f=100`，Kitty官方协议规定该值只表示PNG。项目目前把Telegram WebP sticker/JPEG photo原样base64传入，因此尺寸解析虽成功，终端wire payload仍无效并可静默不显示。
- Pi coding-agent公开导出`convertToPng()`，其注释和`ToolExecutionComponent`都明确在Kitty路径异步转换非PNG、完成后requestRender；这就是插件应复用的native integration，不需要改Pi或自写escape。
- 实施边界是同file revision in-flight去重与32项/32MiB LRU；source继续≤1MiB、单converted≤8MiB。失败/超限/迟到completion保持文本fallback，不发无效`f=100`、不无限重试。
- Cache impact **NONE**：仅本地extension内存与host render，IPC/DB/provider grammar、LLM/vision/network调用和每turn token均不变。完整验收见`requirements/REQ-UI-0012.md`。
