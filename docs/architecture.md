# 架构

> 描述当前代码真正做了什么。架构变化时同步更新。

## Process model

```
                         Telegram
                    /       |       \
               Poller 1  Poller 2  Poller N
                    \       |       /
                     daemon（单进程、长驻）
                     /      |       \
            ingestion   AgentSession×N   SQLite
             + router                       │
                     \      |              /
                      IPC（Unix socket JSONL）
                                  │
                    Pi interactive process（短生命周期）
                    ├─ Telegram transcript custom entry
                    └─ Pi native FooterComponent
```

- **daemon**：唯一长驻进程。`composeDeployment()`按配置为每个 bot 建立identity state与runtime map，`composePollers()`建立同数量poller；router、Telegram control与IPC消费同一组动态id/name/user-id map。daemon同时持有 SQLite 与 IPC server。
- **Pi 插件**：项目 package 被 Pi 自动发现；通过 IPC 拉历史、订阅实时事件。关闭 Pi 或 `/tg detach` 不影响 daemon。

## 运行时与依赖

- 运行时：**Bun**（Phase 1 会做 Pi SDK × Bun 兼容性 smoke test；不兼容则降级 Node 26 + node:sqlite 并更新本文档）
- Pi：registry `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui` 精确锁定为 v0.84.1；`scripts/pi-launcher.ts` 在 project-local CLI 缺失时执行 `bun install --frozen-lockfile`，随后始终以 Bun 启动 lockfile 对应版本。运行与构建不读取 sibling `../pi`。
- Telegram：raw Bot API（fetch long polling），无第三方 SDK

## Telegram ingestion

- 每个 bot token 一个 getUpdates long-polling 循环（offset 持久化在 SQLite）
- 每条 update：raw update→canonical message→direct-reply obligation在一个SQLite transaction提交，之后poller才推进offset；任一步失败整体回滚并重放。canonical以(chat_id,message_id)去重，second-bot副本可只补齐null `reply_to_sender_id`。`rich_message` 也走同一 normalize：canonical列只保存≤256 KiB source（超限为有界JSON诊断），`text`保存确定性plain projection；projector上限为16层、500 blocks、4096 nodes、32768 code points，未知metadata不泄露URL/file id。revision保留旧source/projection，IPC/Pi/provider只读取projection。
- Telegram create 是不可回滚的 commit boundary。Bot API 返回 Message 后先按 25/100/250 ms 有界重试 canonical SQLite projection，再做 exposure、broadcast、event 与 typing cleanup；这些后置副作用任一失败都只能返回 terminal `committed/no_retry` 并写脱敏 `send_degraded`，绝不把整次 tool call 抛回模型。timeout、断线、非JSON、429/5xx 等无法证明未创建的结果直接 terminal `unknown/no_retry`；message 已提交后 sticker 失败则是 `partial/no_retry`。poller echo 继续以 `(chat_id,message_id)` 完成本地幂等恢复。
- agent `send.message` 走 `sendRichMessage {rich_message:{markdown}}`；只有 Telegram 明确拒绝 rich method/parse 且确认未创建消息的确定性 4xx 才 literal `sendMessage` 一次。operator manual compose仍保持literal plain text，两条路径复用 `src/telegram/send.ts` 的 send→canonical persistence primitive。

## Routing（Phase 5，REQ-CONF-0001 泛型化）

- deterministic：`u = HMAC(router_secret, chatId + ":" + messageId)` → 按配置数组顺序累积 `routing_p` 阈值：`u < p[0]` → bots[0]；`p[0] ≤ u < p[0]+p[1]` → bots[1]；…否则 nobody（Σp ≤ 1 启动期校验）
- 优先级：明确 @mention > reply target > 名字关键词 > 概率 routing
- Bot 消息不进 trigger（`routeMessage` 内部单一权威判断，REQ-TEST-0001 R3）
- router 返回target + reason + chat/message id；reply先认canonical `reply_to_sender_id` snapshot、再查父行。只有 `probability` 走runtime availability gate；bucket先按原HMAC决定，目标busy/cooldown时直接skip，绝不改投其他bot。
- 每 bot 的 probability run 完成后用 monotonic deadline 冷却 `sampling_cooldown_ms`（默认 2000 ms）；deadline 不设 timer、不补抽，之后只有新消息才重新采样。不同 bot 仍可并发。
- mention/reply/name 是 explicit path：配置 `name` 在 text/caption 中字面命中（例如“小雨”命中“我叫小雨”）即使 `routing_p=0` 也成立；busy 时继续 pending coalesce，cooldown 中也可立即启动；shutdown 不等待 cooldown。
- Telegram control override只开放`routing_p`与`cooldown_ms`：文件配置是reset基线，`bot_state`中的有效override在runtime构造前恢复并直接更新同一`BotConfig`对象，因此router/runtime下一次决策立即读取effective值。任何routing set/reset都先按全部配置bot原子校验Σp≤1；坏持久值使启动失败，不静默回退。
- `scripts/analyze-routing.ts`用production loader和严格只读SQLite连接重放**当前effective配置**：SQLite在本地把正文列折叠为trigger code，JavaScript扫描只收到chat/message identity与reason，不持有或输出正文。assignment只含非mention/reply/name的probability样本；canonical主键保证duplicate update不重复计数。daemon log只提供进程内started/busy/cooldown片段，永远标`partial`（缺失为`unavailable`）；报告只用`bot-N`并明确LLM run、response opportunity与最终public message是不同口径。它不写route event、不调用模型，也不能把当前配置重放冒充历史实际配置。
- Telegram control service只接受offset 0的`bot_command` entity；command/subcommand/suffix大小写不敏感，未知suffix不接管，参数严格按固定arity/type解析。daemon在normal route前同步分流，human public read与allowlist mutation分层，所有mutation共用一个串行队列；manual compact先占runtime control lock，只在idle时无instructions调用Pi `session.compact()`，期间explicit coalesce、probability fast-skip，绝不abort在途回复。回复由suffix目标或实际接收bot走plain Telegram create→canonical DB→IPC broadcast，并用`reply_parameters`引用原命令；unknown outcome/local failure只脱敏记录、不远端重试。`telegram_control_claim`/`telegram_control_reply`是跨restart/epoch的消费证据；flush在现有exposure之外永久排除这些message id，compact重置epoch后也不会把控制消息送入provider。每bot启动并行best-effort `setMyCommands(/tg)`，失败不阻塞polling。
- human direct reply在provider前已持久化per-bot obligation。flush每批仍≤40：所有pending reply优先、剩余槽位取最近普通消息并保持Telegram顺序；普通overflow可drop/expose，pending reply绝不drop，>40 replies自动按40+N继续normal flush。只有`session.sendUserMessage`成功后才expose并删除对应obligation；失败/stop保留，startup在session与IPC ready后按bot恢复。provider仍只看到原有动态serialization，没有hidden control/fallback文字或额外纠错模型调用。
- accepted trigger 同步 acquire per-bot Telegram `typing` lease（REQ-TG-0002）：当前目标是 supergroup，只调用 `sendChatAction`，不调用 private-only message/rich draft。单个递归 timer每4秒续约且最多一个in-flight；组合send完整成功时release，沉默/异常/abort/flush settle/shutdown由finally兜底。第一条send清状态后，coalesced pending在下一轮flush重新acquire。side channel失败按streak脱敏告警，不写DB/IPC/exposure/provider context，也不改变routing/cooldown/send结果。

## Agent（Phase 3）

- 每 bot 一个 `createAgentSession()`：独立 SessionManager（sessionDir 分开）与独立 DefaultResourceLoader（`systemPromptOverride` = persona）；整个daemon只创建一个Pi `ModelRuntime`，各session仍绑定自己解析后的`provider/model/thinking`。shared runtime在pid lock后、任何Telegram `getMe`/polling前一次创建并预检全部bot；任一unknown model或unauthenticated provider会释放启动锁并fail-fast。认证完全由Pi auth store提供，项目不读取或注入provider credential。
- 触发/flush 是 BotRuntime 本地持有的串行状态机（REQ-AGENT-0001）：`idle →(trigger) flushing →(drain) idle`；`flushing` 在进入 flush 时同步置位（不等 SDK 事件），在途期间的 trigger 只合并为 `pendingTrigger`，flush 循环结束后统一再跑一轮（burst 合并）；flush 全链路 try/catch，失败只落 agent_events `error`（stage=flush + 固定provider category，不保存上游body），消息保持未曝光由后续 trigger 重试；消息只在 `sendUserMessage` 成功后 markExposed；daemon shutdown 时 `stop()` 有界（30s）等待在途 flush 再 dispose
- 唤醒：`session.sendUserMessage(serialized)`，一次 flush 一批（burst 由 pendingTrigger 合并，不走 SDK 队列）
- 群消息序列化为固定紧凑 grammar（见 docs/cache.md），append-only
- tools 固定为 `send`、`search`、`run_js`（Phase 6 起），禁用 coding agent 默认文件工具。`src/agent/tools.ts` 是 provider-facing 用法唯一权威；persona/protocol 不复制参数。`send(message?,sticker?,reply_to?)` 是唯一公开通道，`message` 为 Telegram Rich Markdown（普通文本是其子集，首版禁止HTML/raw block/remote media）；完整成功返回固定 `ok`，远端 committed/partial/unknown 的退化路径返回固定 `no_retry`，两者都用 `terminate:true` 阻止 follow-up provider call，sent ids 只留本地 details/event。
- local assistant text（未调 send）→ agent_events + TUI，不进群

## run_js sandbox 威胁模型（REQ-SEC-0001）

- **威胁**：run_js 输入来自 LLM，LLM 上下文来自群消息 → 群成员可经 prompt injection 让 bot 执行攻击者构造的 JS。最坏情况是读到 daemon 同 uid 可读的 `.env`（全部 bot token / API key）并联网外发。
- **防到什么**：vm context 由 `Object.create(null)` 创建且 `codeGeneration: { strings: false, wasm: false }`，context 内**不存在任何 host realm 对象/函数**——`console.log.constructor` / `this.constructor.constructor` / `Function` / `eval` 全部拿不到 host `Function`，逃逸链在第一步就断。console/日志在 context 内部 bootstrap；结果只在 context 内 `JSON.stringify` 后以字符串跨界（primitive 跨界安全）。child 进程 env 被 scrub（仅 PATH，无 secret）、隔离 tmp cwd、`--smol` 限内存、同步代码 vm timeout 3s、进程级 5s SIGKILL 兜底、输出 4KB 上限。
- **残余风险（明确承认）**：
  1. node:vm 官方声明不是安全边界；若引擎层 0day/未知向量打穿 realm 隔离，child 仍以 daemon uid 运行，可读 `.env`、可联网。缓解：child env 不含 secret（secret 只存在于 daemon 进程内存与磁盘 `.env`），但这不防「直接读磁盘文件」。
  2. `--smol` 是内存使用倾向而非硬 rlimit；内存硬上限依赖 5s SIGKILL 兜底。
  3. SIGKILL 只杀直接 child；若 vm 被打穿后 spawn 孙进程，孙进程脱离超时范围。
  4. vm timeout 只约束同步代码；异步 microtask 膨胀由 SIGKILL 兜底（实测 Bun 下约 vm timeout 即被打断）。
- **为什么可接受**：纵深防御（realm 隔离 + codegen 禁用 + env scrub + 资源限制 + 超时）使攻击需要未知引擎漏洞而非已知技术；单人项目、威胁源限于群成员 prompt injection。OS 级隔离（低权用户 / seatbelt / seccomp）列为后续增强，非当前威胁模型的必要项。

## SQLite

- 见 docs/data-model.md。WAL 模式，直接 SQL

## Pi 原生 Telegram transcript（REQ-UI-0001/2/3/4）

- package 入口是 `.pi/extensions/tg-extension.ts`；`package.json` 的 `pi.extensions` 使项目可被 Pi 自动发现，规范启动命令是 `bun run pi`。
- `/tg attach [bot-id]` 通过 `registerEntryRenderer` + `appendEntry` 在 Pi 自己的 transcript 中挂载一个 **TUI-only custom entry**。一次 attach 只写一个锚点；Telegram snapshot、实时消息和历史页只存在于该 entry 的内存组件树，不逐条写 Pi session，也不进入 provider context。
- 消息、LOCAL 事件、日期与媒体由 Pi 的 `Container`、`Box`、`Text`、`Image`、`Spacer` 和 theme 组合。Pi fullscreen host 拥有滚动、resize、选择、editor、宽度处理及 Kitty image placement/cropping；项目不持有 viewport、终端尺寸、键盘处理或 ANSI 主题代码。
- `src/plugin/timeline.ts` 是无展示逻辑的 IPC client，只负责连接、snapshot/live/history、复合游标、去重、stats 合并、有界媒体读取与 ephemeral stream frame 转发。
- public extension API 没有 transcript scroll-top 事件，因此更早历史由 `/tg more` 显式加载；`/tg detach` 只断开 live socket，已显示内容保留。session restore 的旧锚点以 detached 状态呈现，不自动重连。
- stats 通过官方 `ctx.ui.setFooter` mount point 直接返回 Pi 导出的 `FooterComponent`。插件只提供只读内存 telemetry session view；不复制 footer renderer、不写真实 Pi session。active feed 复用同一份 IPC stats，独立 panel 只拥有一个可清理的订阅。
- `/tg` 只注册一个 Pi slash command；声明式递归 command tree 是 syntax/help/dispatch/completion 的共同来源。`getArgumentCompletions` 返回 replace-entire-argument value，动态节点只从启动期已验证 config 缓存 bot `id/name`，不读 DB、网络或 secret。
- IPC：Unix socket JSONL，daemon 为 server；协议 = hello（可带 bot filter）/ history 分页拉取 / event 订阅 / usage 增量推送（REQ-UI-0003）/ additive `send_message`→`send_result`（REQ-UI-0005）/ additive `agent_stream`（REQ-UI-0010）/ identity-only `vision_update`与owner-local `media_ready`（REQ-UI-0006/0014）。
- **manual send（UI-0005 daemon contract）**：extension 只提交 request id、bot id 与纯文本；daemon 校验身份/空文本/4096 字符上限，在有界 256-entry request cache 中合并并发重复，再调用 Telegram。API 成功后先写 canonical DB、再 broadcast、最后 ACK；ACK 丢失不触发 daemon retry。相同 id 不同内容返回 conflict；API/DB 边界给出 explicit failure/unknown outcome，token 不出 daemon。
- **原生 editor compose（UI-0005）**：`/tg compose <bot-id>` 显式打开发送身份，当前 Pi footer 持续显示 `TELEGRAM · SEND AS ...`；attach 本身永远只读。extension 只拦截 interactive `input` 并返回 `handled`，不写 Pi session/provider context；RPC/extension source 继续交给 Pi。发送期间拒绝第二次提交；明确失败恢复 editor 原文，ACK 超时/断线恢复原文并关闭 compose、提示先查群且不自动重试。附件被拦截且不降级为只发文字。attach 切换、detach、daemon 断线与 session shutdown 均清除身份。
- **传输层**：FrameDecoder 持单个 streaming TextDecoder（多字节字符跨 chunk 不腐蚀）；接收缓冲 4MB 上限，超限断开；socket.write <0 即踢连接，出站队列 1MB 上限，超限断开（TUI 挂起时 daemon 内存有界）
- **分页**：merged timeline 统一排序键 (ts, rank, id)（rank 0=agent 事件，1=群消息），history 用复合游标，同秒多条消息不丢不重；旧客户端只发 beforeTs 时保持严格 `ts<` 语义（双向兼容，新客户端同时发送两字段）
- **本机暴露面**：socket 文件 chmod 600；history limit 服务端夹取 [1,500]
- **终端注入防护**：渲染前 strip ANSI/OSC/DCS 转义与控制字符（保留 \n/\t），群消息无法清屏/改色/写剪贴板（OSC 52）
- **竞态去重**：snapshot 与 broadcast 重复条目按 (chatId,messageId)/(evtId) 去重；翻页补日期分隔线
- **attach 过滤（REQ-UI-0002）**：`/tg attach <bot-id>` 以单 bot 视角观察——daemon 端对 snapshot / history / broadcast / usage 过滤 agent_events（群消息始终全量）；不指定时为全局视角；非法 id 由 extension 根据 daemon hello 信息列出有效清单。
- **Pi 原生 telemetry footer（REQ-UI-0003/0007/0009）**：SQLite 保留期 lifetime 的 `cacheMiss/output/cacheRead/cacheWrite/cost` 映射到 Pi 原生 `↑/↓/R/W/CH/$`，最近 run 提供 current context，配置提供 model/reasoning；全局只聚合当前配置 bots 并取最新 run 的 model。snapshot 附全历史基线（`lastId` 防 live 双计），llm_run 经 additive IPC 推送 cache/reasoning/latency。telemetry view 只存在于内存，委托 `FooterComponent` 处理 theme/width/cwd/git/status；`panel off` 恢复 operator session default footer，完整 lifetime/latest 明细由 `/tg status` 通知。
- **Pi 原生 assistant stream（REQ-UI-0010）**：runtime 将 Pi assistant `message_start/update/end` 转成有界完整快照（thinking/text/至多 4 个 tool args），daemon 按 bot filter只向 live listener 推送，不写 SQLite/snapshot/history/Pi session。feed 最多保留 32 张临时 `Container`/`Box`/`Text` 卡片，end/abort/disconnect 原位移除，迟到 ended id 被有界 tombstone 忽略；最终 LOCAL/tool/Telegram event继续走既有单次持久链路。extension 从 `setFooter` factory保留 session `TUI.requestRender()`，每次 feed 变化只请求宿主刷新；Pi 自己约 16 ms 合帧，`panel off` 不销毁 render handle。
- **媒体内联（REQ-UI-0001/UI-0012/UI-0013）**：终端能力只读 Pi `getCapabilities()`。PNG 直接交给 Pi `Image`；Pi 判定为 Kitty protocol 时，JPEG/WebP/GIF 先用 coding-agent 公开的 `convertToPng()` 异步归一化，完成后只重建引用同一文件的原生卡片并请求 host render。sticker 使用 Pi `Image` 的 24×12 cell 上限，photo 等其他图片保留 56×16；比例、窄宽度 clamp、resize、crop 与 fallback 仍全部由 Pi 负责。转换按 path + size + mtime revision 合并 in-flight，结果/失败共用最多 32 项、32 MiB 的 LRU（单项 8 MiB，pending 32）；detach/restart/shutdown 会移除旧 feed callback。iTerm2/无图像能力继续走 Pi 自身 Image/fallback，WebM等不支持格式保留文字占位。IPC 只传 `mediaPath`/`mediaDesc`；source 读取仍限 1 MiB，base64与绝对路径不进入日志、DB、session或provider。
- **photo readiness（REQ-UI-0014）**：poller先提交raw/canonical/offset，daemon再broadcast placeholder并把photo identity交给后台queue；routing/nobody/busy不影响下载。live queue按identity去重、最多2 active/128 pending；startup按最新`media.rowid`只排100条`local_path IS NULL`。precache和vision共享同一Telegram download in-flight；支持的≤1 MiB静态文件以hash basename写同目录0600临时文件后rename，成功才更新`media.local_path`并广播`media_ready`。timeline用256项/10分钟乱序cache把path合入live/history消息，feed只重建匹配slot并请求Pi host render；不新增entry、vision或LLM call。shutdown先stop/abort queue再关DB，失败只留label fallback与脱敏聚合。

## Vision（Phase 7）

- lazy：图片落库即显示，只有 bot 被唤醒且图片需进上下文时才识别
- 识别结果按 media identity 持久化，所有配置 bot 共享（vision cache）
- photo 与 sticker 用不同 prompt 语义
- daemon在任何Telegram调用前把视觉选择与所有聊天模型一起交给唯一Pi `ModelRuntime`做catalog/auth预检；视觉默认/示例为`openai-codex/gpt-5.6-luna:low`，历史`gpt-5.6-luna-low`仅在loader边界归一化，不进入runtime。模型缺失、未认证或不支持image input均按固定category终止启动，项目不读取credential。
- JPEG/PNG原样作为Pi `ImageContent`发送；静态WebP/GIF先走Pi公开`convertToPng()`，TGS/WebM/未知格式确定性fallback且不调用provider。每次`completeSimple()`固定low、256 output tokens、90秒abort、provider retry 0；上游失败/空响应只落固定outcome，不写错误正文。
- production vision event只含kind、source/converted bytes bucket、latency、input/output/reasoning token、cost与outcome；不含media identity/path/prompt/response。动态batch先按identity去重，再以最多2个worker等待所有terminal结果，之后才执行唯一一次`serializeMessages()`/provider submit；1/2/3 media分别形成1/1/2个执行波次。失败/unsupported直接进入同一次fallback，exposed后不重写旧entry。
- configured catalog也只开2个后台worker；runtime先从当时DB构造一次system prompt snapshot且不await后台任务，completion只更新DB/UI，当前session的prompt字符串/hash引用不变。下一次restart才可能吸收新描述。UI update与本地展示始终是provider外side channel。
- 新的非空描述成功写入 DB 后，`ensureVision` 只发布一次 `(fileUniqueId,text)`；cache hit、unsupported、空结果与失败不发布。background catalog 与 lazy batch 共用同一 in-flight promise，因此 UI transport 不增加 vision provider call。
- `MsgItem.fileUniqueId` 与 additive `vision_update` 经 daemon IPC 广播给所有 live transcript；旧 client 可忽略新字段/帧。snapshot/history 仍从同一 `media.vision` 读取，provider serialization 不变。
- timeline 以 256-entry / 10-minute map 有界缓存乱序 update；message/live/history 到达时按 `fileUniqueId` 合并。已显示消息收到新描述时，feed 更新所有匹配 item 并用 Pi component tree 原位 rebuild，不追加 session entry；重复 update 幂等。
- media card 在图片或 fallback 正下方用 Pi theme `Text` 显示 `视觉理解 · <text>`，snapshot 与 live 文案一致；显示前继续走 `sanitize()`，ANSI/OSC 不进入终端控制流。

## Sticker 可发送性（REQ-STICKER-0002）

- `media.file_unique_id` / `short_id` 是共享身份；`media_file_ids(bot_id,file_id,file_unique_id)` 才是 bot-specific 可发送能力。
- fixed catalog、background vision 与 dynamic candidates 都用当前 bot 的 mapping 过滤；set name 只决定 fixed/dynamic 分区，不能证明可发送。
- `send` tool 在任何 network call 前再次用同一 mapping 做 preflight；若已提交的 short id 缺 mapping，记录 `candidate_invariant`，不会先发文字再失败。
- catalog 启动日志给出 fetched/catalog/sendable/missing_file_id；缺 mapping 行不进入稳定 prefix。该修复对应 cache schema v3。

## Provider context flow

- 稳定 prefix：system prompt（persona + 群聊规则 + 消息 grammar 说明 + 格式化规则）+ 固定顺序 tool name/description/parameter schema
- 动态 suffix：新群消息 / reply 依赖 / vision 结果 / sticker candidates / tool outputs，只追加
- exposure tracking 保证已出现内容不重复序列化
- compaction → 新 Context Epoch（明确的 cache boundary）

## 配置（REQ-CONF-0001 重构后）

- **`telegram.config.ts`**（项目根，首选）通过`defineConfig()`提供静态字段类型与注释；它是用户明确信任的本机代码，不是sandbox。legacy `bots.config.json`保持同一schema与归一化结果；默认同时存在两份时fail-fast，env `bots_config`可显式选择`.ts` / `.json`路径，其他扩展名拒绝。全局字段为`group_peer_id` / `router_secret_env` / `provider` / `model` / `tinyfish_key_env` / `auxiliary_visual_model` / `db_path` / `reasoning_effort` / `compaction_threshold` / `compaction_keep_recent` / `sampling_cooldown_ms` / `telegram_admins`（默认空；正整数user id或规范化`@username`）；每bot字段为`id`（`[A-Za-z0-9_-]+`唯一）/ `name`（显示与名字触发，缺省=id）/ `token_env`（env key名，值在.env）/ `persona_path`（绝对路径 / `~` / 相对项目根，可指仓库外）/ `routing_p`（Σ≤1），以及provider / reasoning / compaction / cooldown / tools / sticker overrides。省略聊天模型字段时读取`SettingsManager.create(projectRoot,getAgentDir())`合并后的Pi global/project defaults；只写legacy model可与Pi default provider组合，跨provider覆盖必须显式给model。`auxiliary_visual_model`使用`provider/model:effort`并默认Luna low。loader为旧ignored deployment接受`api_key_env` / `deepseek_key_env`并丢弃，也只把旧视觉拼写归一化到canonical ref；canonical schema和example不再暴露旧字段/拼写。
- **`.env`**（`key: value`冒号格式，自解析）+ `.env.example`：只放项目拥有的secret（bot tokens / TinyFish / router_secret / gpg passphrase）；Pi auth store独占provider credential。旧`.env`中的provider key即使保留也不会被loader读取，配置、启动日志与运行时对象均不含其env key或值。
- **onboarding write boundary**：`src/onboarding/config-core.ts`只接受完整内存draft；先校验peer、Telegram token/env key与persona，再将`.env`、typed config与private persona写为各自同目录0600临时文件。fresh `.env`只含Telegram token，生成config省略模型字段并继承Pi defaults。create模式遇到任一现有目标即保留并拒绝；明确replace才先rename到唯一backup，再安装全部新文件。任一rename/chmod/final `loadConfig()`失败会删除新目标并恢复backup；editor路径先用临时同扩展名文件走生产loader，确认前不改原字节。事件只含phase与相对路径。
- **Pi 原生配置向导（REQ-ONBOARD-0001）**：`/tg config`是command tree中的静态节点，config loader失败时仍可帮助、补全和dispatch。fresh/replace流程在第一个输入dialog前用Pi defaults + catalog/auth status做零provider-call预检，只显示脱敏`provider/model:thinking`；失败固定分类并引导Pi `/login`、`/model`，writer调用为0。`src/onboarding/config-wizard.ts`只编排Pi公开的`select/input/confirm/editor/notify`；public persona template先于Telegram secret输入读取，取消任一步不调用writer。source探测与production loader同样服从`.env`/process的`bots_config`；自定义source只允许安全的validate/项目根原文edit，缺失或坏override先修复而不旁写一个daemon不会读取的default。首次写入或已确认的原文替换通过production loader后，extension只用固定参数委托既有`bun run src/main.ts restart`控制路径；只有exit 0且输出明确`daemon ready`才建立all-bots native feed。失败保留已验证文件、清除旧连接并显示经过credential redaction的status/retry诊断。dialog值不写notification、进程参数、Pi session或provider context。
- **启动期校验（REQ-OPS-0001 R2 + REQ-CONF-0001 R6 合并框架）**：TS/JSON 共用运行时 schema 校验（id 唯一合法、token_env 在 .env 存在、persona 文件可读、routing_p ∈[0,1] 且 Σ≤1、数值有限>0）+ env 数值检查；peer id 三种形式统一归一化；校验失败收集**全部**错误一次性抛出（ConfigError 逐条点名），不静默 NaN
- **进程管理（REQ-OPS-0001/0002）**：daemon 最早时机 `openSync(wx)` 排他pid锁，退出只删除仍属于自己的pid file。CLI controller把start/restart共用同一detached spawn与readiness：先按同仓库cwd/绝对entry验证PID，枚举并优雅停止该deployment的pid owner与孤儿进程，等待所有PID/pid file/socket消失后才spawn；新socket必须真实connect且新PID身份有效才是ready。restart另有可回收control lock，foreign PID与命令文本decoy绝不signal。Pi只异步委托CLI，保留原transcript并以原filter/footer更换IPC client；跨client snapshot按canonical identity去重，compose/pending send按unknown outcome/no-retry关闭。
- **单群deployment边界（REQ-PLAT-0001）**：一个daemon只读取一个`group_peer_id`，且当前`data/`、DB、session、pid、control lock与socket均由工作目录决定。同一checkout内只换`bots_config`并行多群不安全且不支持；多群必须使用隔离工作目录/data资源，不能共享持久化或进程控制文件。
- 模型相关数值（contextWindow/价格/threshold/reserve）放 `config/models.json`（Phase 8）
