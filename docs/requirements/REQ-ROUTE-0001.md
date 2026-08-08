# REQ-ROUTE-0001: 忙碌 bot 跳过概率采样并在回复后冷却

- **Status:** Proposed（2026-08-08 已调查，未实现）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：允许 A/B 并发回复；两者忙碌时新消息全部跳过采样；回复结束后约 2 秒再恢复采样，以更像真人
- **依赖:** REQ-AGENT-0001、REQ-CONF-0001

## 问题

daemon 对每条 canonical inserted/edited message 都调用 `routeMessage()`。概率路由不知道 BotRuntime 是否正忙；若目标 bot 正在 flush，`trigger()` 会把 `pendingTrigger=true`，当前 run 结束后立刻再 flush 一轮。快速群聊因此可能把同一段 burst 连续变成多个 bot run，没有“正在打字时不重新抽签”和回复后的自然停顿。

## 调查结论

- 两个 poller 看见同一消息不会双采样：Poller 只对 `inserted|edited` 调 callback，第二个 canonical duplicate 不调用 route。
- 真正问题是 scheduler 与 runtime lifecycle 分离：`routeMessage` 只看内容/HMAC，`BotRuntime.trigger` 才知道 `flushing/pendingTrigger`。
- 各 BotRuntime 本来就能并发，因此 message 1 触发 A、后续 message 2 触发 B 是现有架构可支持的；缺的是概率路径的 availability gate。
- 2 秒冷却应使用 `cooldownUntil`/clock 判断，不能在 poller callback 里 `sleep(2000)` 阻塞 ingestion。
- 忙碌期消息仍应落 SQLite。它们不在 cooldown 结束时自动补采样；下一条新消息真正触发某 bot 时，现有 exposure/flush 会把尚未曝光的历史一起提供给它。

## 目标

概率触发只面向 idle 且已结束冷却的 bot；两个不同 bot 可以同时工作。当所有可能目标都 busy/cooldown 时，快速后续消息只持久化、不创建 pending run；bot 完成后等待默认 2 秒，只有之后到达的新消息才重新参加概率采样。

## 非目标

- 不丢消息、不停止 ingestion、不从 SQLite 删除忙碌期消息。
- 不让两个 bot 响应同一条概率消息；既有“最多一个 target”语义保留。
- 不把 2 秒实现成阻塞 sleep。
- 本需求不改变 explicit @mention/reply/name trigger 的优先级；它们不是随机“采样”，是否需要独立 cooldown 策略另开需求。

## 需求

- **R1 — 决策原因显式化：** routing 返回 `{target, reason: explicit|reply|name|probability|nobody}`（或等价结构），daemon 只对 probability 应用 availability gate；不得靠重新解析消息猜原因。
- **R2 — 可用状态：** BotRuntime 暴露只读 `idle|busy|cooldown|stopping`/`isAvailableForSampling(now)`；`flushing` 从 trigger 同步置位到整轮结束，busy 判定不能只依赖异步 SDK event。
- **R3 — 不重分配概率：** 先按现有稳定 HMAC 与配置概率得到 target；若该 target busy/cooldown，则本消息 probability skipped，不把它重映射给另一个 bot，避免悄悄抬高其他 bot 的 routing_p。
- **R4 — 并发语义：** A busy 不妨碍本来就命中 B 概率桶的后续消息触发 B；当 A/B 都 busy 时所有 probability message fast-skip，不调用任一 `trigger()`、不设置 `pendingTrigger`。
- **R5 — 冷却：** 每次概率触发的 run 无论发送、保持沉默或受控失败，settle 后进入默认 2000 ms cooldown；用 monotonic/可注入 clock 记录 deadline。shutdown 不等待 cooldown。
- **R6 — 不补抽：** busy/cooldown 期间被跳过的 message 不在状态恢复时自动 route；只有 cooldown 后新到的 inserted message 才产生新概率决策。下一次实际 flush 仍按 exposure 规则带上有界未曝光历史。
- **R7 — 显式触发：** mention/reply/name 在 busy 时沿用 REQ-AGENT-0001 的 pending coalesce，避免直接呼叫丢失；它们不被概率 cooldown 静默吞掉。实现若要改变此点必须先回到本 REQ 明确决策。
- **R8 — 配置：** cooldown 可提供 deployment 默认值与 per-bot override，必须校验有限且 `>=0`；默认 2000 ms，0 表示关闭。

## 验收标准

- **AC1:** fake clock：m1 命中 A → A busy；m2 命中 B → B busy；两者 run 可并行且各只有一次 trigger。
- **AC2:** A/B 都 busy 时连续 100 条 probability message 产生 0 个额外 trigger、0 个 pending run，但全部消息已持久化。
- **AC3:** A settle 后 1999 ms 的新消息仍 skipped；2000 ms 后的新消息可采样。测试不得真实 sleep。
- **AC4:** busy target 的概率桶不重分配给 idle bot；固定 secret/message id 的 target 与旧 router 一致。
- **AC5:** cooldown 到期本身不会触发 run；下一次合法 trigger 的 batch 含有界未曝光消息且无重复序列化。
- **AC6:** explicit mention 在 busy/cooldown 边界的行为有单测，与 R7 一致。
- **AC7:** `bun test`、`bun run check`、routing distribution/property tests、cache golden 与 burst replay 通过。

## 约束

- Cache impact: **NONE**。system/tool/message grammar 不变；这是确定性调度，预期减少 LLM calls、cache miss tokens 与成本。
- Token impact: telemetry 应比较 run/message ratio、skipped sampling 数、miss tokens；不得用 LLM 判断“是否 busy”。
- 状态是进程内瞬时调度状态，不写 provider context；daemon restart 后从 idle 开始可接受。

## 例子与边界 case

- A busy、B idle，消息哈希仍命中 A：跳过，不改投 B。
- A busy、B idle，下一条消息哈希命中 B：B 开始独立 run。
- A 刚发完消息进入 cooldown，群里立即刷屏：只存库；2 秒后没有新消息则不主动醒来。
- 模型保持沉默：run settle 后同样 cooldown，避免连续被抽中思考。

## 可观察性

本地 counters/log：`route_probability_triggered`、`route_probability_skipped_busy`、`route_probability_skipped_cooldown`，含 bot id/message id/reason，不含消息正文。

## 文档影响

`docs/architecture.md` Routing/Agent 小节、`docs/testing.md`、config example/runbook、cache 成本分析说明。

## 待决问题

- edited message 是否继续参加概率采样。当前会 route；实现计划应先用生产数据量评估，再决定是否另行排除，不能顺带改变。

## 追溯

- Plans: 实现前建立
- Commits: 从 `Requirement:` git trailer 查
