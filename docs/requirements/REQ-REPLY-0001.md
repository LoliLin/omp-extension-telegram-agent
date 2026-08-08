# REQ-REPLY-0001: 直接回复 Bot 的消息必须进入对应模型上下文

- **Status:** Approved（2026-08-08 已按用户澄清调查，未实现）
- **Priority:** P1
- **Source:** 用户追加 `REQ-LIST`：「bot在被回复后百分百回复（不是说一定要给模型兜底，是要让模型保证看到）」
- **依赖:** REQ-ROUTE-0001、REQ-SEND-0001、REQ-AGENT-0001

## 问题

当前 reply-to-bot 通常会优先路由为 `reason=reply`，但“模型一定看到”仍不是数据流 invariant：

- router 只查询 canonical 父消息；若 daemon 未保存被引用的旧 bot 消息，即使 incoming payload 自带 `reply_to_message.from.id`，也可能识别失败；
- dispatch 把 reply/mention/name压成同一个 `explicit` source，runtime不知道哪条 message id是必须交付的 direct reply；
- busy期间只保留一个 boolean `pendingTrigger`。通常下一轮会读到新消息，但无法证明 direct reply未被 catch-up的40条截断丢弃；
- provider提交前daemon异常退出时，消息虽在SQLite，重启后没有自动恢复这个 response opportunity。

现有 `send` tool contract已经告诉模型：人类直接回复 bot 时必须公开回应。用户本次澄清要求修的是“reply消息确定性交给模型”，不是运行时替模型发送固定兜底。

## 目标

每条 human direct reply-to-bot消息都被识别为对应 bot 的强制 provider-delivery obligation。idle、busy burst、catch-up overflow和daemon restart后，该消息都必须进入对应 bot一次成功提交的动态 provider suffix；只有提交成功后才能清除 obligation。模型随后仍按现有唯一 `send`契约决定并产生公开回复。

## 非目标

- 不发送固定 fallback，不自动把本地 Assistant text/reasoning/tool args发到Telegram。
- 不为“催模型回复”新增第二次LLM请求；每条reply只需进入正常response opportunity。
- 不承诺Telegram出站网络一定交付，也不改变 `send` 的unknown-outcome/no-retry语义。
- 不改变mention/name/probability的现有行为，不允许bot-to-bot消息触发。
- 不为每条busy burst reply强制单独建一个provider run；同一有界batch可一次让模型看到多条reply。

## 需求

- **R1 — 完整 reply identity：** normalize必须有界持久化 `reply_to_message.from.id`（缺失时为null）。router先用该snapshot、再用canonical父消息查询识别目标bot；不得把整个嵌套父消息写进provider context。
- **R2 — 原因与消息ID不丢失：** `reply` reason和triggering message id必须从router/daemon传到目标BotRuntime；不得在dispatch时压扁成无法追踪交付的通用explicit flag。
- **R3 — durable obligation：** human sender直接回复目标bot时，在触发provider前记录per-bot message-id obligation。只有该message id已经成功进入`session.sendUserMessage`的suffix后才能清除；provider失败、进程退出或shutdown不得把未提交的obligation伪装成完成。
- **R4 — lifecycle：** idle reply立即启动；busy reply合并进pending loop；cooldown不得阻止；stopping期间消息保留为未完成obligation并由下次daemon启动恢复。bot sender永不创建obligation。
- **R5 — catch-up优先级：** 每次provider suffix仍有硬上限，但未完成direct reply不得被`MAX_CATCHUP_MESSAGES`的普通历史裁剪标记为exposed。超过单batch上限时按Telegram顺序分批，继续flush直到所有reply obligation成功提交；普通非reply历史可沿用既有有界drop策略。
- **R6 — restart恢复：** daemon完成BotRuntime初始化后，必须从SQLite/持久状态恢复当前bot尚未exposed的direct reply并调度normal flush；恢复是幂等的，已exposed reply不重复提交，多个bot只恢复回复自己的消息。
- **R7 — provider可观察结果：** direct reply使用现有固定消息序列化grammar进入动态suffix，包含原始`#message_id`、正文/媒体投影与reply reference；不另造system/tool提示、不注入隐藏控制文本。
- **R8 — 成本与上限：** 不新增“纠错”LLM request；正常burst仍合并。只有超过既有batch上限的真实direct reply backlog才允许额外normal flush，且每次suffix/message数有界。实现必须提供reply delivered/recovered counters而不记录正文。

## 验收标准

- **AC1:** parent canonical row存在与不存在两种fixture中，incoming `reply_to_message.from.id=<bot>`都稳定得到 `{target:<bot>, reason:reply}`；另一个bot、人类父消息与bot sender不创建该bot obligation。
- **AC2:** fake runtime证明reply reason/message id穿过dispatch；idle立即启动、busy coalesce、cooldown bypass、stopping持久待恢复，probability/mention/name不创建reply obligation。
- **AC3:** provider harness断言direct reply的`#message_id`与正文确实出现在对应bot的`sendUserMessage` suffix；成功后obligation清除，provider throw后保留并在下一次flush原样重试。
- **AC4:** 45条普通未曝光消息后接1条direct reply时，reply仍进入首个有界batch且不被overflow drop；超过40条direct reply时分批全部提交，每条恰好一次、单batch不超上限。
- **AC5:** file DB在“已入库未提交”边界close/reopen，daemon恢复只触发目标bot；已成功exposed的reply重启后不重复。A/B分别被回复时彼此obligation隔离。
- **AC6:** schema migration对旧数据库幂等；incoming/edit/sent/duplicate路径保留reply identity，provider消息序列化grammar/golden逐字节不变。
- **AC7:** 测试明确证明没有fixed fallback send、没有自动发送Assistant text、没有额外retry/completion；公开输出仍只可能来自现有`send` tool。
- **AC8:** `bun test`、`bun run check`、cache golden通过；真实群分别回复A/B一次，在Pi stream/provider trace中确认对应`#id`进入模型，随后由模型正常公开回复。

## 约束

- Cache impact: **NONE**。新增reply identity/obligation只影响确定性路由与动态消息选择；不改system/tool/message/summary grammar或provider-visible稳定prefix，不bump `CACHE_SCHEMA_VERSION`。
- Token impact: 每条真实direct reply本来就应进入模型；正常路径不新增call。仅>40条强制reply backlog分批时增加必要的normal calls，单call有界且不得用LLM做路由判断。
- 数据 / 迁移: `messages`增加nullable `reply_to_sender_id`；旧行保持null并继续用父消息查询兼容。durable obligation必须复用可审计持久状态或提供等价幂等恢复，不能只靠进程内boolean。
- 安全 / 隐私: 只持久化Telegram numeric sender id和message id；不保存嵌套父消息全文，不输出token/正文到日志。

## 例子与边界 case

- Alice回复`#900`（A发言）：“为什么？”：`#901`成为A obligation并进入A的下一次provider suffix；B不被触发。
- A正在处理旧消息时Alice回复A：`#902`进入pending，当前run结束后下一轮suffix包含`#902`，不是只把boolean清掉。
- daemon在保存`#903`后、provider提交前退出：重启扫描到A尚未exposed的direct reply并恢复一次normal flush。
- backlog有45条普通消息和最后1条direct reply：普通旧消息可按既有策略drop，direct reply不能drop。
- 模型看到reply后仍输出本地文本而未调用send：本需求不偷发；这是可观察的模型行为，不代表输入交付失败。

## 可观察性

本地有界counter/event：`reply_obligation_created`、`reply_obligation_coalesced`、`reply_obligation_recovered`、`reply_obligation_delivered`。payload只含bot id/message id/outcome，不含消息正文、reasoning、token或Bot API对象。

## 文档影响

`docs/architecture.md` Routing/Agent、`docs/data-model.md`、`docs/cache.md`、`docs/testing.md`、`docs/handoff.md`。

## 待决问题

无。用户已明确：保证的是模型看到direct reply，不要求runtime提供内容兜底。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10o`
- Commits: 从 `Requirement:` git trailer 查
