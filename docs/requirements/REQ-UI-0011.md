# REQ-UI-0011: Pi 原生聊天卡片的信息层级与自适应排版

- **Status:** Done（2026-08-08；implementation `614d6d3`）
- **Priority:** P2
- **Source:** 用户新增 REQ-LIST：「Pi 聊天界面 UI 优化；确保复用 Pi、做成 Pi 插件、不要过度设计；信息右对齐并适量补充信息；不增加代码量地改善聊天卡片展示体验」
- **依赖:** REQ-UI-0004、REQ-UI-0001、REQ-UI-0006、REQ-UI-0010

## 问题

当前 Telegram feed 已经是 Pi extension，并使用 Pi `Box` / `Text` / `Image` 等原生 TUI primitive；缺口不是再造 UI，而是卡片信息层级没有充分利用现成布局能力：

- message header 把 sender、`#message_id`、时间和 edited 状态串在同一条左对齐文本里，连续浏览时元数据边界漂移。
- persisted event 与 ephemeral stream 分别复制一套相似 header formatting，状态、身份、时间的视觉顺序不完全一致。
- username、bot identity、reply/media/vision 已有数据，但主身份、正文与次要信息的层级只靠字符串拼接，不利于快速扫读。
- 窄终端下不能用固定 padding 强行右对齐；必须优先保留身份与消息内容，让 trailing metadata 可预测地换行 / 降级。

## 调查结论

- 当前 Pi TUI 已导出 `HStack` / `VStack`、`Box`、`Text`、`Image`、`Spacer`、`visibleWidth` 与 `truncateToWidth`。`HStack` 原生支持 basis/grow/shrink/minSize/maxSize/viewport visibility，不需要手写 terminal column compositor。
- Pi `Text` / `Box` 已处理 ANSI、CJK/emoji visible width、wrap、padding 和 theme background；继续使用 theme token 才能与宿主明暗主题一致。
- 当前三类卡片的 header 代码有重复，足以用一个共享 native header helper 抵消自适应布局 glue；不需要新文件、依赖或组件框架。
- `better-ui` / `better-layout` 的适用原则是保留组件库与密度、共享边缘、按重要性从 leading 到 trailing、内容增长时延迟折叠；高频聊天卡片不加动画。

## 目标

消息、agent event 与 streaming card 在 Pi transcript 中形成一致、安静、可扫读的层级：身份在 leading edge，message id / 时间 /状态等次要元数据在空间足够时靠 trailing edge；正文、reply、媒体和视觉理解按重要性稳定排列。实现只重组现有数据和 Pi 原生组件，生产渲染代码净行数不增加。

## 非目标

- 不引入自绘 TUI engine、CSS、React、第三方 UI kit、icon pack、animation timer 或新的 Pi widget。
- 不改 Telegram / DB / IPC schema，不为“多显示一点”新增网络请求、vision call、provider call 或 telemetry query。
- 不做头像下载、read receipt、reaction picker、thread view、message action menu 或鼠标交互。
- 不改变 feed attach/filter/more/detach、compose、stream lifecycle 或 native footer 行为。
- 不把每个底层字段都塞进卡片；完整 usage/diagnostic 仍属于 footer 与 `/tg status`。

## 需求

- **R1 — 只用 Pi 原生能力：** presentation 只使用当前 Pi TUI exports 与现有 theme token；布局由 `HStack` / `VStack` / `Box` / `Text` / `Image` / `Spacer` 组合，不实现第二套 column/layout/render engine。
- **R2 — 共享 header 语法：** message、persisted event、ephemeral stream 使用同一个 native header helper / 结构：leading 是 sender/bot identity，trailing 是紧凑 metadata。三类卡片只传入内容和状态，不复制 padding/alignment 算法。
- **R3 — trailing metadata：** 正常宽度下 `#message_id · HH:mm:ss · edited` 或 `LOCAL/STREAMING · HH:mm:ss` 靠 card content trailing edge；元数据用 muted/status theme，不能压过身份和正文。
- **R4 — 自适应优先级：** 空间不足时先保留完整正文入口与可识别身份，再把 metadata 移到次行或截断最低优先级 label；任何 rendered line 不得超过 host width。CJK、emoji、长 username/name 和 ANSI sanitize 后仍适用。
- **R5 — 适量信息：** message identity 显示 sender name，以及存在时的 `@username` 或 configured `botId`；metadata 显示既有 message id/time/edited。reply、media kind/emoji、vision description 保持为 muted secondary rows。event/stream 显示 bot name、已有 bot id 与 LOCAL/STREAMING 状态；不新增 raw payload、file id、chat id、成本或 secret。
- **R6 — 稳定阅读顺序与密度：** 顺序固定为 header → reply context → message/agent content → media → vision。正常终端宽度不得给普通纯文本消息增加行高；卡片间距继续由 feed 统一拥有，不用 separator/border 堆装饰。
- **R7 — 代码预算：** 本需求不得增加 production dependency或新 presentation source file；`.pi/extensions/tg-extension.ts` 的 card/header rendering 区域净生产 LOC 必须不增加（tests/docs 不计），以删除重复字符串布局抵消 native adaptive layout。
- **R8 — 安全与边界：** 所有动态文字继续先 `sanitize`；presentation 只读现有 `TimelineItem` / stream snapshot，不写 DB/session/provider context，不改变缓存 schema。

## 验收标准

- **AC1:** deterministic render tests 覆盖 40、60、80、120 columns；去 ANSI 后每一行 `visibleWidth <= width`，无负 padding、异常或截断到不可识别身份。
- **AC2:** 80/120 columns 的 message/event/stream header 中，trailing metadata 的最后一个可见字符与 card content trailing edge 对齐；leading identity 的起始 edge 一致。
- **AC3:** 40 columns 下 long CJK sender、emoji、long username、edited metadata 可安全降级；正文仍在 header 后出现，message id/time 至少有一个稳定可识别位置，不与身份字符交叠。
- **AC4:** fixtures 覆盖 human username、configured bot id、reply、edited、sticker/media+vision、LOCAL event、thinking/text/tool streaming；信息顺序与 R5/R6 一致，raw payload/file id/chat id 不出现。
- **AC5:** 普通 80-column pure-text message 的 rendered line count 不高于改动前；event/stream 使用共享 header，现有 sanitize/media image/fallback 行为保持。
- **AC6:** production diff 无新 dependency/production file，card/header rendering 区域净 LOC `<= 0`；不得用不可读的一行压缩规避代码预算，typecheck/lint review 仍通过。
- **AC7:** `bun test test/tg-extension.test.ts test/tg-engine.test.ts`、`bun run check` 与 cache golden 通过；真实 Pi TTY 在窄/宽 resize、明暗主题和连续 streaming 下无错位/闪烁。

## 约束

- Cache impact: **NONE**。TUI-only presentation 不改变 system/tool/message/summary grammar、provider-visible bytes或context epoch。
- Token / 成本: 每 turn 新增 0 token、0 LLM call；不新增 vision/network/DB query。
- 兼容性: IPC `TimelineItem` 与 old daemon frames不变；缺少 optional `botId` / username / mediaDesc 时自然省略。
- 性能: 无 timer/animation；每 render 只使用 Pi 现有有界 layout和当前 item字符串。
- 可访问性: 不只靠颜色表达LOCAL/STREAMING/edited；文本 label必须保留。终端reading order与视觉顺序一致。

## 例子与边界 case

- 宽屏：`Alice · @alice` 在 leading，`#812 · 15:42:07 · edited` 在 trailing；正文下一行。
- 自有 bot：`Helper · bot helper` 在 leading；不显示 Telegram token或chat id。
- 窄屏：长中文名字优先保持可识别前缀，metadata退到次行；正文不被丢弃。
- Agent event：`Helper · bot helper` + `LOCAL · 15:42:07`，event body顺序不变。
- Stream：同一header位置显示`STREAMING`静态文本；partial更新只替换body，不新增动画。

## 可观察性

不新增运行时 telemetry。证据来自多宽度 render snapshot、visible-width invariant、production LOC gate与真实 Pi resize/theme smoke。

## 文档影响

实现后更新 `docs/handoff.md`、`docs/devlog.md`；若 Pi API compatibility floor变化才更新 `docs/research.md` / architecture。本需求不增加用户操作命令。

## 待决问题

无。实现使用当前已安装/发布的 Pi native stack primitive；不再为旧版 Pi 写 fallback。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10r/T10s`
- Commits: implementation `614d6d3`；其余从 `Requirement: REQ-UI-0011` git trailer 查

## 实现证据

- message、persisted event、ephemeral stream 复用单一 Pi `HStack` / `TruncatedText` header；身份位于 leading，message id/time/state 位于 trailing，bot identity 优先显示 configured bot id。
- 40/60/80/120 columns 回归锁定 visible-width、trailing edge、CJK/emoji/长 username、ANSI/OSC sanitize、reply/media/vision/stream ordering；普通纯文本卡片仍为两行。
- `.pi/extensions/tg-extension.ts` 的实现 diff 为 15 additions / 15 deletions，production dependency/file 均未增加。
- 真实 Pi TTY 已在 80/40 columns 与当前/浅色主题 attach feed 验证；连续 stream frame lifecycle 由既有 update-in-place 回归覆盖，最终真实 Telegram generation smoke 并入 T14。
- Cache impact: **NONE**；cache v5 golden不变。
