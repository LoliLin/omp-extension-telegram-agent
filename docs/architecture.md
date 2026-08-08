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

- **daemon**：唯一长驻进程。按 `bots.config.json` 为每个 bot 创建 poller 与 AgentSession，并持有 SQLite、router 和 IPC server。
- **Pi 插件**：项目 package 被 Pi 自动发现；通过 IPC 拉历史、订阅实时事件。关闭 Pi 或 `/tg detach` 不影响 daemon。

## 运行时与依赖

- 运行时：**Bun**（Phase 1 会做 Pi SDK × Bun 兼容性 smoke test；不兼容则降级 Node 26 + node:sqlite 并更新本文档）
- Pi：本地源码 `../pi`（commit f562a1a, v0.84.1, dist 已构建），通过 `file:../pi/packages/*` 依赖 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui`；传递依赖经 symlink realpath 从 `../pi/node_modules` 解析
- Telegram：raw Bot API（fetch long polling），无第三方 SDK

## Telegram ingestion

- 每个 bot token 一个 getUpdates long-polling 循环（offset 持久化在 SQLite）
- 每条 update：原样存 raw_updates（bot identity + update_id 唯一）→ normalize 成 canonical message（chat_id + message_id 唯一，多个 bot 收到的同一条群消息只存一条）→ edit 存 revision。`rich_message` 也走同一 normalize：canonical列只保存≤256 KiB source（超限为有界JSON诊断），`text`保存确定性plain projection；projector上限为16层、500 blocks、4096 nodes、32768 code points，未知metadata不泄露URL/file id。revision保留旧source/projection，IPC/Pi/provider只读取projection。
- Bot 自己 send 成功后，Telegram 返回的 Message 立即落库（发送→DB→TUI 事务链）。agent `send.message` 走 `sendRichMessage {rich_message:{markdown}}`；只有 Telegram 明确拒绝 rich method/parse 且确认未创建消息的确定性 4xx 才 literal `sendMessage` 一次。timeout、非JSON、429/5xx/unknown outcome不降级，防止双发；`rich_sent`/`plain_fallback` event只记录message id。operator manual compose仍保持literal plain text，两条路径复用 `src/telegram/send.ts` 的 send→canonical persistence primitive。

## Routing（Phase 5，REQ-CONF-0001 泛型化）

- deterministic：`u = HMAC(router_secret, chatId + ":" + messageId)` → 按配置数组顺序累积 `routing_p` 阈值：`u < p[0]` → bots[0]；`p[0] ≤ u < p[0]+p[1]` → bots[1]；…否则 nobody（Σp ≤ 1 启动期校验）
- 优先级：明确 @mention > reply target > 名字关键词 > 概率 routing
- Bot 消息不进 trigger（`routeMessage` 内部单一权威判断，REQ-TEST-0001 R3）
- router 返回 target + reason；只有 `probability` 走 runtime availability gate。bucket 先按原 HMAC 决定，目标 busy/cooldown 时直接 skip，绝不改投其他 bot。
- 每 bot 的 probability run 完成后用 monotonic deadline 冷却 `sampling_cooldown_ms`（默认 2000 ms）；deadline 不设 timer、不补抽，之后只有新消息才重新采样。不同 bot 仍可并发。
- mention/reply/name 是 explicit path：配置 `name` 在 text/caption 中字面命中（例如“小雨”命中“我叫小雨”）即使 `routing_p=0` 也成立；busy 时继续 pending coalesce，cooldown 中也可立即启动；shutdown 不等待 cooldown。
- accepted trigger 同步 acquire per-bot Telegram `typing` lease（REQ-TG-0002）：当前目标是 supergroup，只调用 `sendChatAction`，不调用 private-only message/rich draft。单个递归 timer每4秒续约且最多一个in-flight；组合send完整成功时release，沉默/异常/abort/flush settle/shutdown由finally兜底。第一条send清状态后，coalesced pending在下一轮flush重新acquire。side channel失败按streak脱敏告警，不写DB/IPC/exposure/provider context，也不改变routing/cooldown/send结果。

## Agent（Phase 3）

- 每 bot 一个 `createAgentSession()`：独立 SessionManager（sessionDir 分开）、独立 DefaultResourceLoader（`systemPromptOverride` = persona）、共享一个 ModelRuntime
- 触发/flush 是 BotRuntime 本地持有的串行状态机（REQ-AGENT-0001）：`idle →(trigger) flushing →(drain) idle`；`flushing` 在进入 flush 时同步置位（不等 SDK 事件），在途期间的 trigger 只合并为 `pendingTrigger`，flush 循环结束后统一再跑一轮（burst 合并）；flush 全链路 try/catch，失败只落 agent_events `error`（stage=flush），消息保持未曝光由后续 trigger 重试；消息只在 `sendUserMessage` 成功后 markExposed；daemon shutdown 时 `stop()` 有界（30s）等待在途 flush 再 dispose
- 唤醒：`session.sendUserMessage(serialized)`，一次 flush 一批（burst 由 pendingTrigger 合并，不走 SDK 队列）
- 群消息序列化为固定紧凑 grammar（见 docs/cache.md），append-only
- tools 固定为 `send`、`search`、`run_js`（Phase 6 起），禁用 coding agent 默认文件工具。`src/agent/tools.ts` 是 provider-facing 用法唯一权威；persona/protocol 不复制参数。`send(message?,sticker?,reply_to?)` 是唯一公开通道，`message` 为 Telegram Rich Markdown（普通文本是其子集，首版禁止HTML/raw block/remote media）；成功返回固定最小 ACK + `terminate:true`，sent ids 只留本地 details/event。
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
- IPC：Unix socket JSONL，daemon 为 server；协议 = hello（可带 bot filter）/ history 分页拉取 / event 订阅 / usage 增量推送（REQ-UI-0003）/ additive `send_message`→`send_result`（REQ-UI-0005）/ additive `agent_stream`（REQ-UI-0010）。
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
- **媒体内联（REQ-UI-0001）**：Pi `Image` 渲染本地缓存的 PNG/JPEG/WebP/GIF（终端无图像能力时由 Pi 降级）；IPC 只传 `mediaPath`/`mediaDesc`（同 uid 读文件，不扩大暴露面）；不支持格式、无缓存或超过 1 MiB 时显示占位符与已有 vision 描述。

## Vision（Phase 7）

- lazy：图片落库即显示，只有 bot 被唤醒且图片需进上下文时才识别
- 识别结果按 media identity 持久化，所有配置 bot 共享（vision cache）
- photo 与 sticker 用不同 prompt 语义
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

- **`bots.config.json`**（项目根，env `bots_config` 可改路径）：声明式 bot 列表——全局 `group_peer_id` / `router_secret_env` / `deepseek_key_env` / `tinyfish_key_env` / `auxiliary_visual_model` / `db_path` / 默认 `model` / `reasoning_effort` / `compaction_threshold` / `compaction_keep_recent` / `sampling_cooldown_ms`；每 bot `id`（`[A-Za-z0-9_-]+` 唯一；大写 A/B 兼容历史数据）/ `name`（显示与名字触发，缺省=id）/ `token_env`（env key 名，值在 .env）/ `persona_path`（绝对路径 / `~` / 相对项目根，可指仓库外）/ `routing_p`（累积阈值，Σ≤1），可选覆盖 model / reasoning_effort / compaction_threshold / compaction_keep_recent / sampling_cooldown_ms / tools（`{send, search, run_js}` 布尔开关，send 关 = 纯观察 bot）
- **`.env`**（`key: value` 冒号格式，自解析）+ `.env.example`：只放 secret（bot tokens / deepseek / tinyfish / router_secret / gpg passphrase）
- **启动期校验（REQ-OPS-0001 R2 + REQ-CONF-0001 R6 合并框架）**：JSON schema 校验（id 唯一合法、token_env 在 .env 存在、persona 文件可读、routing_p ∈[0,1] 且 Σ≤1、数值有限>0）+ env 数值检查；peer id 归一化（`-1004402809405` / `-4402809405` / `4402809405` → 裸正数）；校验失败收集**全部**错误一次性抛出（ConfigError 逐条点名），不静默 NaN
- **进程管理（REQ-OPS-0001）**：daemon 最早时机 `openSync(wx)` 排他 pid 锁；`stop`/`status` 校验 cmdline 归属；死 pid 接管/清理；`start` 等 socket ready
- 模型相关数值（contextWindow/价格/threshold/reserve）放 `config/models.json`（Phase 8）
