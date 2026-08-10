# 2026-08 全面代码审查

## 目的与范围

本记录审查 `7dc1bb8` 时的完整仓库，目标依次是：最大化 provider cache hit、优先复用 Pi 0.84.1、删除 hack 与无收益机制、缩小代码和长期测试面。审查覆盖 `src/`、`.pi/extensions/`、`scripts/`、`test/`、配置和文档；不把“文件更少”置于安全、幂等或 cache invariant 之上。

依据是当前源码、git 历史、已安装的四个 `@earendil-works/pi-*` 包导出和 Pi 当前文档。基线验证为：`bun test` 105 pass、`bun run check` pass、`bun run lint` pass；lint 只报告 Biome 配置项的弃用提示。

## 结论

架构主干是对的：一个 daemon、一个 SQLite authority、每 bot 一个 Pi session、稳定 system prefix、Telegram/Pi 共用同一 timeline。没有发现每 turn 重写历史 prefix 或另造 agent/session/model registry 的系统性错误。

但后续功能增长引入了六类不符合项目目标的机制：

| 优先级 | 已验证事实 | 影响 | 决策 |
| --- | --- | --- | --- |
| P0 | compaction hook 把 `prep.messagesToSummarize` 直接 `as never` 交给 Pi `serializeConversation()` | Pi serializer 接收 provider `Message[]`；Telegram custom messages 可能被遗漏，类型错误被 cast 隐藏 | 按 Pi 文档先 `convertToLlm()`，再 `serializeConversation()`；bump cache schema |
| P1 | `VisionScheduler` 的 foreground/background 双队列只有 foreground 生产调用；小时/日计数仅在进程内存存在 | 优先级分支是死机制；重启即清零的配额既不准确，也会无声跳过用户媒体 | 改成单 FIFO 并发门；删除小时/日配额、budget error 和对应配置/telemetry |
| P1 | 视频帧位置通过 file id、hash、伪随机数和截断正态分布生成 | 对最多 3 帧的任务没有可观察收益，增加实现与统计测试 | 使用固定代表位置；仍保留帧数、文件、超时、输出和全局并发硬上限 |
| P1 | Pi footer 通过 `as never` 伪造一份不完整 `AgentSession` 再传给 `FooterComponent` | 依赖组件内部读取形状，是升级脆弱的真实 hack | 删除 `/tg panel` 和 fake session adapter；attached feed 改用官方 `ctx.ui.setStatus` 提供紧凑统计，并保留 `/tg status` 与 Telegram `/status` 明细 |
| P1 | 配置仍接受旧模型拼写，并让省略的 `tools.search` / `vision.enabled` 根据历史行为隐式开启 | 存在第二套隐含语义，配置表面值不能完整解释行为 | 删除兼容别名和隐式启用；normalized 类型改为真实必填形状 |
| P2 | 两个 compaction e2e 脚本重复，其中一个绕过公开控制方法读取 private session；telemetry/媒体测试含大量一次性展示断言 | 增大修改面与维护成本，没有守住长期 invariant | 合并 e2e 到公开入口；删除已完成调查记录和随功能一起消失的展示测试，保留安全/缓存/幂等回归 |

## Cache 与成本审计

### 必须修复

1. compaction 使用 Pi 官方 `session_before_compact` hook 是正确边界，但消息转换顺序不完整。官方流程是 `serializeConversation(convertToLlm(messages))`。修复后 summary 才能看见 Telegram custom messages，且不再依赖不安全 cast。
2. vision 与 compaction 都使用 `cacheRetention: "none"`，不会污染主会话 cache；保留。
3. tool 注册顺序、system prompt shape、消息 grammar、fixed catalog block 和 compaction grammar 仍属于 cache-visible 协议。每次变更必须同步 `CACHE_SCHEMA_VERSION`、`test/cache.test.ts` golden 与 `docs/cache.md`。

### 接受的动态 sticker suffix

最近上下文 sticker 候选是刻意保留的趣味功能，不是待优化问题。它最多 8 条，只取当前可见、当前 bot 可发送的 sticker，并在所有本轮 event/message bytes 之后追加；预算不足时整体省略。因此它只增加一个很小且有界的当前 turn miss tail，不会改写或打断此前可缓存 prefix。

只要这三个条件仍成立——**最终尾部、上限 8、不得回写旧 entry/prefix**——后续 review 不应以提升 cache hit 为由删除或重构它。若候选移到 prefix 中间、改成无界、或开始重算历史，才重新打开该决策。

### 明确保留

- `agent.streamFunction` 的 cache-retention wrapper：Pi 0.84.1 的 `createAgentSession()` 没有把 `cacheRetention` 暴露为 session option；底层 stream API 支持该值。这是当前唯一必要的 Pi seam，升级 Pi 时复查。
- 本地 `bytes / 2` token 估算：Pi 导出的近似器是 `chars / 4`，会系统性低估中文；这里承担的是发送前硬预算，不应替换。
- 一个稳定 fixed catalog：它让模型只用 short id 发送 sticker，避免每 turn 搜索或再调用模型。catalog 内容变化通过 fingerprint 开新 epoch，不原地改旧 prefix。
- 最终的 recent sticker candidate tail：这是产品上明确接受的有界 miss bytes，不能为追求指标牺牲功能。

## Pi 能力审计

| 能力 | Pi 0.84.1 状态 | 项目决策 |
| --- | --- | --- |
| agent session、模型/auth registry、session persistence | 已公开提供 | 已复用，不自建 |
| custom message 转换 | `convertToLlm` | 补上遗漏调用 |
| compaction 生命周期 | `session_before_compact` / `session_compact` | 已复用；只保留 Telegram 专用 summary instruction |
| transcript 序列化 | `serializeConversation` | 已复用；修正输入类型 |
| TUI layout、Markdown、图片转换、assistant/tool card | 已公开提供 | 已复用；工具调用改用`ToolExecutionComponent` |
| footer customization | `ctx.ui.setFooter` 会替换 footer，`FooterComponent` 要求真实 session；`ctx.ui.setStatus` 可在原生 footer 追加持久 status | 不再伪造 session或替换 footer；删除 panel，attached feed 用 `setStatus` 显示紧凑 usage |
| model reference parser | `parseModelPattern` 有导出，但标为 internal/testing，且是依赖 model catalog 的模糊匹配器 | 保留严格的小型 `provider/model:thinking` parser |
| provider cache retention | 底层 stream option 有，`createAgentSession` option 无 | 保留单点 wrapper，不扩散私有访问 |
| Telegram transport、routing、SQLite outbox、search、sandboxed JS | Pi 无对应领域实现 | 保留项目实现 |

项目没有完整重造 Pi agent loop、session store、model registry、Markdown parser 或 TUI framework。此次发现的 Pi 复用缺口只有 compaction 的 `convertToLlm`；其余自有代码属于 Telegram 领域边界或安全边界。

## 防御代码裁决

应删除：

- normalized 配置之后的 `??` / `?.` 默认值和同字段二次验证；
- 旧配置拼写、旧默认行为和测试专用 fallback；
- vision 内存小时/日预算、foreground/background 优先级和 budget outcome；
- fake `AgentSession`、private-session e2e cast、可以由真实类型表达的 `as never`；
- 已被稳定实现取代的调查文档、重复 e2e 与纯展示 snapshot 式测试。

必须保留：

- Telegram JSON、配置原始值、SQLite/session 恢复、IPC、文件路径和网络响应等不可信边界校验；
- `run_js` sandbox、search SSRF/redirect、network isolation 与 secret/redaction 守卫；
- Telegram send 的 unknown-commit 幂等状态机；超时后盲目重发可能产生真实重复消息；
- 队列、provider 输出、单 turn 媒体量、视频帧数/大小和 session retention 的硬上限；这些限制真实约束成本或内存，不是猜测性防御；
- 能确定性复现的 cache、序列化、跨 bot media identity、compaction pruning 与 daemon ownership 回归测试。

## 结构与代码味道

- `BotRuntime` 和 extension 文件偏大，但职责仍分别围绕一个 session owner 和一个 Pi extension。现在拆层只会增加共享类型、转发方法和 ownership 模糊，暂不为行数重构。
- daemon supervision 与 manual-send 状态机看似复杂，但分别保护单进程 owner 和未知提交幂等，不能按“防御代码”删除。
- telemetry 的共享读模型服务 Telegram `/status`、Pi `/tg status` 和 attached feed 的紧凑 footer status；删除的是 fake session 适配层，不删除成本可观测性。
- Biome 的弃用提示是独立机械维护项，不影响运行或 cache；在行为清理后单独迁移，不能夹入功能提交。

## TUI 补充审查

- 原实现只把tool event画成一行accent文本，和Pi coding agent的pending/success/error工具卡外观不一致。extension已能从官方`setWidget` factory取得真实host TUI，因此直接使用公开`ToolExecutionComponent`，不再复制工具卡。
- 消息标题用`botId ? ... : username ? ...`，导致own bot消息有username也必然隐藏。新标题始终优先呈现display name + `@username`，bot id降为右侧metadata。
- 全部身份曾只分成固定human/bot两色。现在用稳定identity hash选择Pi theme已有语义/语法色；没有硬编码RGB、独立palette配置或持久颜色表。
- feed entry内部重复的scope/帮助header已删除；scope与两个常用动作只留在editor上方的一行官方widget。卡片只保留身份、消息定位信息和正文/媒体，避免同一信息占两层。
- fake `AgentSession` footer 已删除；attached feed 的成本统计经官方 `ctx.ui.setStatus` 进入 Pi 原生 footer extension-status 行，不接管 footer component。

以上均为本地UI side channel，Cache impact为**NONE**；不改system、tool schema、消息grammar或provider payload。

## 执行顺序

每一步一个原子提交，行为提交同时更新它拥有的测试和文档：

1. compaction 改用 `convertToLlm`，建立 cache schema v12，并加一条 custom-message 回归。
2. 简化 vision 并发门和视频取帧；删除无持久语义的配额配置。
3. 删除旧配置兼容语义，并让 normalized 类型消除下游 fallback。
4. 删除 fake Pi footer 与 `/tg panel`，用官方 footer status 保留 attached feed 紧凑统计，并保留 `/tg status` 明细。
5. 对齐Pi原生工具卡并重排Telegram卡片身份层级。
6. 合并 compaction e2e、删除完成态调查记录，并按长期 invariant 收缩测试。
7. 运行完整验证漏斗；全部通过后才部署并检查生产 daemon。

## 验证与更新条件

每个提交至少运行受影响测试与 `bun run check`；最终必须通过：

```bash
bun test
bun run check
bun run lint
bun run docs:check
```

部署只在工作树干净、提交签名有效且生产配置已使用显式新字段时进行。Pi 包升级、cache-visible grammar、vision 调度、extension UI API 或测试策略变化时，必须重新审查本记录对应章节；稳定 invariant 的权威说明仍分别属于 `docs/cache.md`、`docs/architecture.md`、`docs/testing.md` 和 `docs/telemetry.md`。
