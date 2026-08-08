# REQ-TG-0002: 在 Bot 处理响应机会期间续约 Telegram 输入状态

- **Status:** Done（2026-08-08；精确 lease 回归与当前双 bot 超过 5 秒的真实处理轮次共同验收）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「当信息被采样到 bot 的时候在 Telegram 展示正在输入/正在思考，直到模型放弃发送或发送成功；状态至多展示 5 秒，所以要续约」
- **依赖:** REQ-AGENT-0001、REQ-ROUTE-0001、REQ-TG-0001

## 问题

bot 从收到一次有效 routing opportunity 到最终调用 `send` 可能经过 vision、provider thinking、tool generation 和网络等待。Telegram 群内目前完全没有处理反馈，用户只能猜测 bot 是没被抽中、正在思考还是已经放弃。

Telegram Bot API 现在确实原生支持 Thinking：[`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) 传空 `text` 会显示 “Thinking…” placeholder；Bot API 10.1/10.2 的 [`sendRichMessageDraft`](https://core.telegram.org/bots/api#sendrichmessagedraft) 还支持 `<tg-thinking>` / `InputRichBlockThinking`。但两个 draft method 的 `chat_id` 都明确限定为**目标私聊**，而本 deployment 的目标是 `-100…` supergroup；thinking block 又明确只能用于 rich draft，不能作为普通群消息发送。

群聊可用的官方 feedback 仍是 [`sendChatAction`](https://core.telegram.org/bots/api#sendchataction)：状态保持 5 秒或更短，bot 消息到达时客户端清除；动作集合包含 `typing`、`choose_sticker` 等，但没有 `thinking` action。因此当前群聊首版使用 `typing`，以 4 秒周期留出到期余量。这里是**当前 chat capability fallback**，不是声称 Telegram bot 全局不支持 Thinking。

## 目标

当某个配置 bot 真正接受一次 response opportunity 时，该 bot 立即在目标群显示 Telegram 原生 `typing` 状态，并在仍可能回复期间持续续约；成功发出消息或本轮确定不发后停止续约。

## 非目标

- 不否认或重造 Telegram 已有的 draft Thinking；当前 supergroup 不调用 private-only draft，也不发送“正在思考”普通文本消息。
- 不根据尚未完成的 tool args 在 `typing` / `choose_sticker` 间频繁切换；首版统一 `typing`。
- 不为 nobody、概率 busy/cooldown skip、bot 自己的消息或纯 UI attach 显示状态。
- 不保证 Telegram API/客户端故障时状态必然可见；这是一条不得影响主流程的 best-effort side channel。
- 不用状态替代 Pi LOCAL stream、route telemetry 或最终 Telegram 回复。

## 需求

- **R1 — 启动边界：** `BotRuntime.trigger()` 接受并启动新 flush 时立即 acquire activity lease；显式 trigger 在已有 flush 中 coalesce 时复用现有 lease。probability `skipped_busy` / `skipped_cooldown` / `skipped_stopping` 与 `nobody` 不创建新 lease。
- **R2 — capability-correct 官方动作：** 对当前 supergroup 使用当前 bot token 调 `sendChatAction {chat_id, action:"typing"}`。不得把 `sendMessageDraft` / `sendRichMessageDraft` 发往负数 group id，也不得把状态偷发到 trigger sender 的私聊。chat id 只取 deployment 配置，不接收模型参数；API 方法归属 `src/telegram/`。未来只有官方允许 group draft 后才可另行切换 native Thinking。
- **R3 — 续约：** active lease 立即发送一次，之后每 4 秒最多发送一次；同一 bot 最多一个 in-flight action request，重复 start 幂等。单次超时/429/网络错误不终止 provider run，下一 tick 可重试。
- **R4 — 停止语义：** `send` 的全部请求成功后立即 release；Telegram 消息本身会清除客户端状态。没有调用 send、send 最终失败、provider abort/error 或本轮决定沉默时，在 flush settle/finally release。release 只停止续约；由于 API 无显式 cancel，已有状态允许在官方剩余 5 秒内自然过期。
- **R5 — pending 生命周期：** 若第一轮成功发送后还有 coalesced pending trigger，下一次 `flush()` 开始前重新 acquire，避免第一条消息清除状态后第二轮无反馈。整个 flush loop 结束、runtime stop 与 daemon shutdown 都幂等 release。
- **R6 — 隔离：** chat action 不写 raw update、canonical message、agent event、Pi session、exposure 或 provider context，也不经 IPC 当作聊天项广播。它不能改变 routing decision、cooldown deadline、send retry 或终止语义。
- **R7 — 有界可观察性：** 每个 active bot 只有一个 timer/lease；错误日志按一次 active failure streak 去重，不含 token/URL。可测试计数 start/renew/stop/failure，生产 status 不输出 secret。

## 验收标准

- **AC1:** fake clock 下 accepted trigger 在等待 provider 前产生一次 `{chat_id, action:"typing"}`；4 秒前无第二次，4 秒时续约一次，持续 12 秒总调用数有确定上界。
- **AC1b:** 当前负数 supergroup fixture 对 `sendMessageDraft` / `sendRichMessageDraft` 调用数恒为 0；状态不会出现在 trigger sender 私聊。文档 contract 测试锁定 draft Thinking 是 private-only capability，而非不存在。
- **AC2:** probability busy/cooldown/stopping skip、nobody 与重复 coalesced trigger 调用 0 个额外 lease/start；不同 bot 可各自独立 active。
- **AC3:** successful text、sticker、message+sticker send 均在完整成功后停止；Telegram send 失败但 run 仍重试时不误报成功，最终 settle 后停止。
- **AC4:** 不调用 send 的 LOCAL response、provider error/abort、flush throw 与 daemon shutdown 都清 timer；推进 fake clock 后不再调用 API。
- **AC5:** 第一轮 send 后存在 pending trigger 时，第二轮开始重新发送 typing；没有 timer overlap、重复 interval 或跨 run 的旧 callback。
- **AC6:** action API 超时/429/throw 不改变 `trigger` outcome、DB rows、exposure、providerCalls 或最终 send；一段失败只写一条脱敏 warning，恢复后可继续续约。
- **AC7:** `bun test`、`bun run check`、cache golden 通过；真实群观察长于 5 秒的 run 状态不中断，send 到达后清除，沉默 run 最迟自然过期。

## 约束

- Cache impact: **NONE**。Telegram side-channel 不进入 system/tool/message/summary/provider payload。
- Token / cost: LLM 调用与 token 增量 0；Telegram API 调用上限约为每 active bot 每 4 秒一次。
- 兼容性: 不改 SQLite、IPC 或 serialization grammar。
- 性能: timer 数量 O(active bots)，而非 O(messages)；禁止 5 秒 sleep 阻塞 poller/runtime。
- 安全 / 隐私: token 只留 daemon/BotApi；日志不能拼 API URL、token 或群消息正文。

## 例子与边界 case

- A 概率命中并 started，B 概率命中但 busy skipped：只有 A 显示 typing。
- 用户明确 @B 时 B 正忙：已有 B response lease 继续，不新增 interval；pending 下一轮在前一条 send 后重新 acquire。
- bot 只生成 LOCAL assistant text 而未调用 send：settle 时停止续约，Telegram 最多再显示官方剩余 5 秒。
- `send(message, sticker)`：整个组合成功后 release；不得在文字成功、sticker 失败的半成功边界谎称完整成功。

## 可观察性

测试注入 fake clock/action sender，断言调用时刻与 lease 数。生产仅在 action failure streak 首次写 `[chat-action] bot=<id> ...` 脱敏 warning；不为每次成功写日志。

## 文档影响

实现时同步 `docs/architecture.md` 的 routing/runtime side channel、`docs/testing.md` 与 `docs/handoff.md`。官方行为权威仍是 Telegram Bot API 链接，不在多处复制动作全集。

## 待决问题

无。未来若 Telegram 官方允许 group draft Thinking，另开 capability migration；若只想根据确定的 sticker send 切换 `choose_sticker`，另开 UX 需求并证明不会增加状态抖动。本需求不预留 generic action 输入。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10g`、`#T10h`、`#T10j`
- Commits: 从 `Requirement:` git trailer 查
