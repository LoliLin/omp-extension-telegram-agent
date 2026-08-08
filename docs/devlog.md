# Devlog（append-only）

每条：时间 / 做了什么 / 为什么 / 改了哪些文件 / 测试结果 / cache impact / 下一步。旧记录保留。

---

## 2026-08-07 (1) — 项目启动 + GPG 签名链路

- 做了：读完整需求（docs/requirement.md, 4055 行）；确认 env 变量名（.env 为 `key: value` 冒号格式）；建立 scripts/git-gpg.sh（loopback pinentry 从 .env 读 passphrase）；配置 repo-local gpg.program；验证签名提交
- 为什么：原子化签名提交是开发流程基线
- 文件：scripts/git-gpg.sh, .env.example, docs/*
- 测试：`git log --show-signature` → Good signature (G)
- Cache impact: NONE
- 下一步：Pi 研究

## 2026-08-07 (2) — Pi 研究完成（Research Gate）

- 做了：5 路并行研究 Pi@f562a1a（Extension API / SDK / provider serialization / compaction / TUI），结论写入 docs/research.md
- 关键结论：
  - daemon 用 SDK `createAgentSession()` 同进程双 session；persona 用 `systemPromptOverride`
  - `sendUserMessage` 是官方注入通道；`terminate:true` 工具结果仍持久化但跳过 follow-up LLM 调用
  - DeepSeek 无显式 cache 字段，前缀字节级一致才命中；usage 里 miss=input、read=prompt_cache_hit_tokens
  - 内置 compaction 是 coding 导向，Phase 8 接管（关自动 + 自定义 128K policy）
  - TUI 复用 `@earendil-works/pi-tui`，组件树与 renderer 分离，TUI 独立进程 + IPC
- 文件：docs/research.md, docs/project.md, docs/architecture.md, docs/cache.md, docs/data-model.md, docs/testing.md, docs/devlog.md, docs/handoff.md
- Cache impact: NONE（仅文档）
- 下一步：项目骨架 + Bun×Pi SDK smoke test

## 2026-08-07 (3) — Phase 1 完成：骨架 + Bun×Pi SDK smoke

- 做了：package.json（file: 依赖 ../pi/packages/*，全部 0.84.1 与研究 commit 一致）；tsconfig；src/config.ts（.env 冒号格式 loader）；src/db/schema.sql + db.ts（bun:sqlite，11 表）；personas/ 两人设提取（verbatim，工具适配留到 Phase 3 首次 agent run 前）；scripts/smoke-pi.ts
- 为什么：验证最大技术风险——Bun 跑 Pi SDK
- 关键发现：DefaultResourceLoader 需要 cwd+agentDir+systemPrompt（不是 systemPromptOverride 函数）；pi-ai 原生支持 DEEPSEEK_API_KEY env；deepseek-v4-flash 在内置 catalog（contextWindow 1M, cacheRead $0.0028/M）
- 测试：smoke-pi 真实调用 DeepSeek 成功（reply "4"，thinking 捕获，usage 含 cacheRead/cacheWrite 字段）；schema 建表验证通过
- Cache impact: NONE（尚未有 agent run）
- 下一步：Phase 2 Telegram ingestion

## 2026-08-07 (4) — Phase 2 完成：Telegram persistence

- 做了：src/telegram/api.ts（raw fetch Bot API：getMe/getUpdates/sendMessage/sendSticker/getFile/download）；normalize.ts（canonical message，isTargetChat 兼容 raw/-/-100 三种 chat id 形式）；ingest.ts（raw_updates 去重 → canonical 去重 → edit revision）；poller.ts（offset 持久化、retry_after、409 检测、指数退避）；daemon/index.ts + main.ts CLI（start [--foreground]/status/stop，pidfile + log）
- 为什么：先把"可靠记住群聊"做好
- 测试：
  - bun test 12/12 通过（normal/reply/quote/mention/bot/edit/photo/sticker/duplicate/two-bot/ignored）
  - 真实群「小雪の后宫」(-1004402809405)：双 token getMe ✅（@hastuyuki_bot / @kosamerobot）
  - e2e：bot B 发消息 → 双 poller 收到 → canonical 仅 1 条（first_seen_by=A）✅
  - restart：offset 恢复，raw_updates 无重放，新消息正常落库 ✅
- Cache impact: NONE
- 下一步：Phase 3 Basic Agent（Pi session + 序列化 grammar + send tool + telemetry）；先做 personas 工具段适配

## 2026-08-07 (5) — Phase 3 完成：Basic Agent

- 做了：personas 工具段适配（send({message,reply_to,sticker}) schema、sticker 目录按需、gpt-researcher→search、/data 工作区→输出通道说明、<message id>→#id 格式）；src/agent/serialize.ts（cache grammar v1：日期分隔/HH:mm:ss/#id/@username 或 u<N> alias/↪引用/quote/媒体占位，确定性输出有测试锁定）；prompt.ts（persona+PROTOCOL 固定结构、CACHE_SCHEMA_VERSION=1、hash）；runtime.ts（BotRuntime：每 bot 一个 AgentSession、send tool terminate:true、reply_not_visible 校验、exposure 持久化、burst 合并（pendingTrigger）、agent_events + llm_runs 落库）；router.ts（mention/text_mention/reply 显式触发）
- 测试：bun test 25/25 ✅；scripts/e2e-agent.ts 真实链路 ✅（合成 human 消息 → 序列化 → DeepSeek → send → 真实群消息 #18368 → transcript 落库 → telemetry）
- 真实 cache 数据：run1 miss=5797（冷），run2 cache_read=6400/miss=74 —— append-only prefix 设计实测命中
- 意外发现：send 失败（Telegram 拒绝 reply 不存在的合成消息）→ error 透传给 LLM → 模型按人设规则省略 reply_to 重试成功。终止语义验证：成功 send 后无第三次 provider 请求
- Cache impact: INTENTIONAL（首次建立 system/tools prefix；grammar v1 被测试锁定）
- 下一步：Phase 4 TUI（attach/detach + 历史 + 实时）

## 2026-08-07 (6) — Phase 4 完成：TUI attach/detach

- 做了：src/ipc.ts（JSONL 协议 + FrameDecoder）；daemon/ipc-server.ts（snapshot/history/broadcast，merged timeline = messages + agent_events 按 ts 合并）；tui/index.ts（pi-tui：TuiAltScreen + ScrollView(follow:"end") + Text 组件树，LOCAL 事件黄色标记，滚到顶部自动加载更早并恢复滚动位置，q/Ctrl+C 退出）；main.ts attach 接线；runtime.ts 增加 eventSink/sentMessageSink（bot 自发消息 poller echo 去重后 TUI 需要独立广播路径）
- 踩坑记录（重要）：Bun socket.write 返回**字节**数且可能部分写入（8192/次），按 UTF-16 code unit slice 字符串会截断多字节字符造成字节重复/损坏 → 必须 TextEncoder 编码成 Uint8Array 按字节偏移排队 + drain 回调冲刷
- 测试：IPC snapshot(100)/history(50, hasMore) ✅；screen 真实终端 attach 显示实时群聊 ✅；TUI 退出 daemon 存活 ✅；重进历史含离开期间新消息 ✅
- Cache impact: NONE（UI-only，未触 provider payload——已确认 system/tools hash 不变）
- 下一步：Phase 5 双 bot deterministic routing + 真人触发测试

## 2026-08-07 (7) — Phase 5 完成：双 bot + deterministic routing

- 做了：router.ts 完整路由链（@mention/text_mention > reply > 名字关键词 > HMAC 概率 u=HMAC(secret,chatId:messageId) 前 6 字节 /2^48）；config 增加 routing_p_a/routing_p_b（默认各 0.08，对真实群保守）；daemon route() 换用 routeMessage
- 测试：33/33 unit ✅（确定性/[0,1)/唯一性/分布 ±15%/优先级/p=0）；真实群观察 3 分钟：4 次概率触发，两个 bot 都在群里以人设自然发言（小雪暖场、小雨毒舌），reply_to 正确，bot 消息不互相触发 ✅
- 真实遥测：A: 3 runs (cache_read 12928)；B: 3 runs (cache_read 16384)
- Cache impact: NONE
- 下一步：Phase 6 search (TinyFish) + run_js sandbox

## 2026-08-07 (8) — Phase 6 完成：search + run_js

- 做了：src/tools/search.ts（TinyFish GET api.search.tinyfish.ai?query=，X-API-Key，≤5 结果、snippet≤200 字）；src/tools/run-js.ts（child bun + node:vm 最小 context：无 process/require/Bun/fetch，空 env（仅 PATH），隔离 tmp cwd，5s kill，4KB 输出上限）；runtime 注册三工具，固定顺序 [send, search, run_js]
- 文档研究：TinyFish 四端点（search/fetch 免费），endpoint 从官方 cookbook 确认
- 测试：46/46 ✅（算术/JSON/regex/数组/语法错误/死循环超时 + typeof process|require|Bun|fetch 全 undefined + 真实 TinyFish 调用）
- Cache impact: INTENTIONAL EPOCH CHANGE（toolsHash 94fa00c707dd → 7b1983d95e25，tool schema 从 1 个变 3 个；生产前最后一次预期变化）
- 下一步：Phase 7 media（photo/sticker/lazy vision/cache）

## 2026-08-07 (9) — Phase 7 完成：Media

- 做了：ingest 记录 media 身份 + 每 bot file_id 映射（重复消息也记录第二个 bot 的 file_id，有测试）；media.short_id 目录（s<N>，migration 兼容旧 dev db）；vision.ts（codex exec -m gpt-5.6-luna -c reasoning low，photo/sticker 两种 prompt，持久缓存双 bot 共享，tgs/webm 标记 unsupported 不污染目录，in-flight 去重）；flush 前 lazy vision（只在 bot 被唤醒且媒体进入其上下文时）；stickerCandidatesBlock 动态后缀（≤8 条语义候选）；send sticker 解析 s<N> → 本 bot file_id
- Codex 研究发现：auxiliary_visual_model "gpt-5.6-luna-low" = 模型 gpt-5.6-luna + reasoning low（ChatGPT 账号不支持 "-low" 后缀模型名，models_cache.json 确认可用 slug）；codex exec -i 图片 -o 输出文件 --ephemeral --skip-git-repo-check -s read-only
- 测试：47/47 unit ✅；真实群：sticker vision 语义正确（"撒娇卖萌地表示委屈…大眼含泪"）、photo OCR 正确（识别出终端截图里的 todo 清单）、双 bot file_id 映射 ✅
- Cache impact: NONE for provider payload（sticker candidates 是动态 suffix，追加式）；序列化 placeholder 对同一媒体确定
- 下一步：Phase 8 context refinement（compaction policy/telemetry 分析脚本/cache 回归测试）

## 2026-08-07 (10) — Phase 8 完成：Context refinement

- 做了：runtime.ts 自定义 compaction（session_before_compact extension：serializeConversation + 状态导向中文摘要 prompt ≤800字、previousSummary 合并、completeSimple cacheRetention:"none" maxTokens 4096；reserveTokens=max(16K, window-threshold) 使触发点=threshold；compaction_end → epoch+1 持久化 + exposure 重置 + 最近 40 条重标 exposed）；config 增加 compaction_threshold(128K)/compaction_keep_recent(20K)；scripts/analyze-context-window.ts（遥测回放模拟候选 threshold）；scripts/e2e-compaction.ts；test/cache.test.ts（golden：schema version + systemA/B hash + serialize hash）
- 踩坑：bun test 强制 UTC（Date offset=0），而 daemon 按本地时区序列化 → golden hash 不一致；测试内 pin TZ=Asia/Singapore 解决
- 顺手修：sticker short_id 分配改 rowid-based（原 COUNT+1 在并发/删除下会撞号）
- 测试：bun test 50/50 ✅；e2e-compaction（threshold=1500 强制）epoch 2→3→4 持久化、重启恢复 epoch=4 ✅；分析脚本回放 50 runs：hit ratio 90.0%，估算 $0.00038/turn，当前规模各候选 threshold 均不触发 compaction（128K 基线维持）
- Cache impact: INTENTIONAL（compaction summary 是新 prefix 边界，由设计保证只发生在 epoch 切换时）；golden test 从此锁住意外变化
- 下一步：Phase 9 Stabilization（长运行 smoke、error recovery、restart/reconnect、文档清理）

## 2026-08-07 (11) — 引入 large-repo-agent-kit 文档体系（单人适配版）

- 做了：新增根 AGENTS.md（路由/硬约束/验证漏斗/已知坑）、docs/index.md、docs/engineering/{development-guide,documentation-guide,traceability}.md、docs/requirements/REQ-TEMPLATE.md、docs/plans/PLAN-TEMPLATE.md、docs/adr/ADR-TEMPLATE.md、docs/runbooks/README.md；docs/testing.md 并入验证策略（漏斗/选择规则/失败诊断）；docs/project.md 指向开发指南
- 适配：删掉多人协作内容（PR 模板、CONTRIBUTING、分支命名、CI 检查、team/owner 字段）；traceability 保留 git trailer 但只约束新工作，历史追溯仍靠 devlog；开发指南与本项目既有 devlog/handoff/签名提交流程合并，新增 cache impact 评估为每个任务的强制环节
- 文件：AGENTS.md, docs/index.md, docs/engineering/*, docs/requirements/, docs/plans/, docs/adr/, docs/runbooks/, docs/testing.md, docs/project.md
- 测试：纯文档，无代码改动
- Cache impact: NONE
- 下一步：按新流程继续 Phase 9

## 2026-08-07 (12) — 全量 code review（5 路并行，未修代码）

- 做了：对 src/ 全部模块 + scripts/ + test/ 做并行 review，关键怀疑点（vm 逃逸、二次编辑丢 revision、生产日志中的 flush 竞态）均已实证
- 最重要发现：
  1. **Critical**：run_js 的 node:vm sandbox 被经典 constructor 逃逸打穿（实测可达 host process/文件系统）→ 群成员 prompt injection 可读到 .env 全部 secret；现有隔离测试只测表面
  2. **High**：runtime.flush() 可重入 + markExposed 先于 sendUserMessage → 生产 daemon.log 已出现 "Agent is already processing a prompt"，消息被标 exposed 却没进 context（持久丢失）
  3. **High**：message_revisions 主键用旧 edit_date，第二次编辑起中间版本被 INSERT OR IGNORE 静默丢弃（实测）
  4. **High**：ipc.ts FrameDecoder 非 streaming TextDecoder，多字节字符跨 chunk 被切碎
  5. **High**：poller ingest 失败仍推进 offset（静默丢消息）；run-js spawn 无 error 监听且依赖 PATH 里的 bun（可打死 daemon）
  6. **Medium**：.env.example 是 `KEY=value` 而 parser 只认 `key: value`（模板即坏配置）；`data/` 未进 .gitignore（agent.db/sessions 含敏感数据，一次 git add data/ 即泄漏）；数值 env 无校验（NaN 静默失效）；compaction_end 不区分成功/失败；search/run_js fetch 无超时；IPC 分页同 ts 丢消息、socket write -1 未处理、队列无上限；TUI 未过滤 ANSI 转义；stop 按裸 pid 杀进程
  7. **测试盲区**：runjs.test.ts 里混了真实 TinyFish 网络调用（与"testing 不触网络"矛盾）；cache golden 未锁 tools_hash；bot 消息不触发的 invariant 在 daemon 层而无测试；e2e 脚本永不 fail
- 测试：bun test 50/50 ✅、bun run check ✅（review 期间基线）
- Cache impact: NONE
- 下一步：用户决定修复优先级（建议顺序：run_js 威胁模型 → flush 状态机 → revision key → FrameDecoder → 配置校验/gitignore）

## 2026-08-07 (13) — REQ 文档集 + README 路径图 + cache/成本全局要求

- 做了：
  - review 结论 + 用户 REQ-LIST 转成 11 篇 REQ（docs/requirements/REQ-{SEC,AGENT,TG,IPC,OPS,TEST,CONF,STICKER,UI}-*.md），README.md 清单含建议实施顺序与依赖关系；REQ-LIST.md 已吸收删除
  - 新增根 README.md：项目简介 + 文档路径图（新 agent 入场路径 AGENTS.md → handoff → development-guide）
  - 「cache hit 率 / token 成本」升级为全局开发要求：development-guide 第三节扩展为 Cache 与成本（两问 + 设计取向 + 遥测验证），AGENTS.md 实现规则加对应条目
  - handoff 更新为「REQ 待审核」状态
- 旧文档处理：无纯废弃文档——project/architecture/cache/data-model/testing/research/devlog/handoff 全部保留并被新索引引用；唯一删除的是被吸收的 REQ-LIST.md
- 测试：纯文档，无代码改动
- Cache impact: NONE
- 下一步：用户审核 REQ（重点：REQ-SEC-0001 威胁模型拍板、REQ-CONF-0001 配置载体拍板）→ 按建议顺序开工

## 2026-08-07 (14) — REQ-SEC-0001：run_js 沙箱加固

- 做了：vm context 改 `Object.create(null)` + `codeGeneration: { strings: false, wasm: false }`，context 内零 host realm 对象（console/logs 由 bootstrap 脚本在 context 内创建，结果在 context 内 JSON.stringify 后以纯字符串带出，Promise 在 context 内挂 then、host 轮询取字符串）；spawn 改 `process.execPath` + `error` 监听（ENOENT 走结构化 ok:false）；child 加 `--smol`；`__RESULT__` marker 移除（wrapper 协议改单行 JSON：{ok, logs, result/error}，用户输出不再可能撞 framing）；Promise 返回值正常序列化（不再静默 "{}"）；architecture.md 新增威胁模型段（防到什么/残余风险/为什么可接受）
- 为什么：review 实证 `console.log.constructor("return process")()` 逃逸可读 .env 全部 secret（群成员 prompt injection → daemon uid 任意代码）
- 文件：src/tools/run-js.ts、test/runjs.test.ts、docs/architecture.md、docs/testing.md、docs/handoff.md
- 测试：bun test 66/66 ✅ + bun run check ✅；7 个逃逸向量（constructor 链 ×5、new Function、eval）全部 ok:false；fs 读取尝试无一成功；spawn ENOENT 结构化报错；异步 microtask/内存膨胀 ~3s 内被打断（实测 Bun 下约等于 vm timeout），5s SIGKILL 兜底
- Cache impact: NONE（tool schema/description/name 未动，toolsHash 不变）
- 下一步：REQ-AGENT-0001（flush 状态机）

## 2026-08-07 (15) — REQ-AGENT-0001：trigger/flush 生命周期收敛为串行状态机

- 做了：
  - R1 flush 串行化：`flushing` 本地标志在 trigger 内同步置位（不等 SDK agent_start），在途 trigger 只合并为 `pendingTrigger`，flush 循环 drain；agent_settled 不再另起 flush（单一所有者）。burst 合并语义不变
  - R2 markExposed 移到 `sendUserMessage` 成功之后（含 catchup skip 的标记也后移）；send 失败消息保持未曝光，由后续 trigger 重试
  - R3 flush 全链路 catch → 只落 agent_events `error{stage:flush}`，无 unhandled rejection 逃逸；`stop()` 置 stopping + 有界（30s）等待在途 flush 再 dispose（shutdown 不写半状态）
  - R4 `compaction_end` 读 event payload：仅 `result` 存在且未 aborted 才 epoch+1/清 exposure；失败/中止只落 `error{stage:compaction}`。空摘要防护用 `{cancel:true}` 而非 throw——**SDK extension runner 吞掉 handler 异常并静默回退默认摘要**（源码实证），cancel 是唯一到达失败路径的机制
  - R5 exposure 重置与 kept tail 严格对齐：从 `sessionManager.buildContextEntries()`（compaction 后 provider 实际可见 entry 集合）的 user message 文本解析锚定行 `^[HH:MM:SS] #<id> ` 反推幸存集合，替代「最近 40 条」启发式（kept tail 按 token 保留，实测 N=41）。SDK 不提供 entry→telegram id 映射，解析自身 grammar 是唯一严格对齐来源；已知限制：群消息文本伪造换行+锚定行可误标个别 id（assistant/tool/custom entry 不解析，模型无法注入）
  - R6 search.ts：`AbortSignal.timeout(10s)` + 响应体 256KB 护栏（content-length + 实际读取双检查）；runtime search tool 捕获失败返回结构化错误文本 + `error{stage:tool_search}`，不再让 running 卡死
  - R7 executeSend：sticker short_id/file_id 解析等全部校验前移到任何网络发送之前，消除 text 双发
- 为什么：生产 daemon.log 实证 flush 重入（"Agent is already processing a prompt" ×2）与 markExposed 先于 send 的持久失忆
- 文件：src/agent/runtime.ts、src/tools/search.ts、test/flush.test.ts（新，AC1–AC4+R7）、test/search.test.ts（新，AC5+护栏）、scripts/e2e-compaction-manual.ts（新）、docs/{architecture,cache,testing}.md、docs/plans/active/PLAN-20260807-flush-state-machine.md
- 测试：bun test 75/75 ✅（基线 66 + 新增 9）+ bun run check ✅；cache golden 不动（tool name/params/schema 未动，diff 可查）。e2e-compaction-manual 真实链路：失败路径（Nothing to compact）epoch 不动 + error 落库 ✅；成功路径 epoch 4→5、kept tail 41 条精确重标（N≠40，证明启发式已移除）✅。注意 e2e-compaction.ts（threshold 版）在 1M window 下已无法廉价触发自动 compaction（reserveTokens 地板 16384 → 触发点 ~984K tokens）
- Cache impact: NONE——system prompt / 序列化 grammar / tool schema / tool 顺序零变化；provider 可见字节不变（exposure 语义修正是 bug fix，AC1 锁 cache invariant 3）
- 下一步：REQ-TG-0001（ingestion/poller 可靠性）；长运行 smoke 观察 flush 状态机在真实群的表现

## 2026-08-07 (16) — REQ-TG-0001：Telegram ingestion 与 poller 可靠性

- 做了：
  - R1 revision key 修正：被取代版本用它自己的时间作 key（原始版用消息 `date`，编辑版用其 `edit_date`），SELECT 补查 `date`；修掉二次编辑撞 `(chat_id, message_id, edit_date)` 主键被 INSERT OR IGNORE 静默丢中间版本的实证 bug；`"edit-unknown"` 提取为常量 `EDIT_UNKNOWN_BOT_ID`
  - R2 ingest 失败不再推进 offset：`setBotState` 移入 per-update try 且仅在 ingest 成功后执行；失败即中断本批（防止后续 update 的 offset 跳过失败项），下轮 getUpdates 重拉，raw_updates 去重保证幂等；连续失败计数，>=5 次 log warn
  - R3 setBotState 失败与 ingest 失败同路径走 backoff，poller run() 不再因此 reject 带崩 daemon；主循环在 `await getUpdates` 返回后与每个 update 处理前重检 `stopped`（shutdown 期间返回的批次整体丢弃，不写库不触发路由）
  - R4 BotApi.call 加 `AbortSignal.timeout`（默认 10s；getUpdates 为长轮询窗口 +10s grace；downloadFile 30s）；非 JSON 错误响应（如 502 HTML）不再抛 SyntaxError，改抛带 HTTP status 的 TelegramApiError；poller 对 401/404 鉴权错误 fail-fast（fatal 日志 + throw），不再无限 backoff
  - R5：`insertSentMessage` 补 `recordMedia`（消除对 poller echo 补 file_id 映射的隐式依赖）；editMessage 不更新 media 列——代码注释明确不支持 editMessageMedia（编辑带来的 media identity/file_id 映射仍由 ingestUpdate 里的 recordMedia 记录）
- 为什么：code review 实证二次编辑丢 revision；ingest 抛异常 offset 照常推进导致消息永久丢失；setBotState 异常可让双 bot daemon 整体退出；fetch 无超时 TCP 半死时 poller 假死
- 文件：src/telegram/{ingest,poller,api}.ts、test/ingest.test.ts（AC1 二次编辑回归 + edit-unknown 边界）、test/poller.test.ts（新，AC2–AC4 + 401 fail-fast，scripted fake API + db 故障注入，不触网络）、docs/{data-model,testing}.md
- 测试：bun test 81/81 ✅（基线 75 + 新增 6）+ bun run check ✅。AC1：v1(date)/v2(e1) 两条 revision 全链 + messages=v3；AC2：注入故障 offset 不动、重放落库无重复；AC3：setBotState 持续失败 poller 存活走 backoff；AC4：stop 发生在长轮询 in-flight 期间，返回批次不处理不写库
- Cache impact: NONE——ingestion/poller 层改动，provider 可见内容（system prompt / grammar / tool schema）零变化
- 下一步：REQ-IPC-0001（IPC/TUI 健壮性）；遗留：raw_updates 与 messages 写入非事务（ingest 在两者之间失败时重放会被 raw 去重短路，需 raw 侧故障模型才触发，本 REQ 未改）；未跑真实群 e2e（改动由 fault-injection 单测覆盖）

## 2026-08-07 (17) — 完成 REQ-LIST 剩余 8 篇（IPC/OPS/TEST/CONF/STICKER/UI×3）

- 做了（每篇一个内聚 commit，trailer 见 git log）：
  - **REQ-IPC-0001** (d0d5d56)：FrameDecoder 单 streaming TextDecoder + 4MB 接收上限；socket.write<0/队列 1MB 上限即踢；history 复合游标 (ts,rank,id)（rank 0=evt id、1=msg id，同秒不丢不重，legacy beforeTs 保持严格 ts< 双向兼容）；socket chmod 600 + limit 夹取 [1,500]；TUI strip ANSI/OSC/DCS + (chatId,messageId)/(evtId) 去重 + 翻页日期分隔
  - **REQ-OPS-0001** (ca55ec0)：loadConfig 收集全部错误一次性抛出（数值范围/概率和/peer id 归一化）；.env.example 冒号格式；data/ 进 .gitignore；daemon 最早时机 wx 排他 pid 锁 + stop/status cmdline 校验（pid 复用不误杀）+ 残留清理；git-gpg.sh 改 --passphrase-fd；start 等 ready
  - **REQ-TEST-0001** (c8fcd67)：TinyFish 真实调用 env gate；tools.ts 提取 + golden 锁 tools hash 与 compaction summary prompt；is_bot 下沉 routeMessage；e2e 脚本断言 exit code + 轮询替代 sleep；analyze 脚本 epoch/flag/回落同步（60 runs 回放：3 真实 compaction、幻影 0）；盲区补测
  - **REQ-CONF-0001** (3027e95)：bots.config.json（任意数量 bot、persona 外置绝对路径/~、token_env 引用、routing_p 累积阈值、tools 开关）；id 校验 [A-Za-z0-9_-]+（大写兼容历史 A/B）；迁移 golden 逐字节不变
  - **REQ-STICKER-0001** (84da315 + 563f014 + 91c0c9a)：每 bot sticker_sets；启动 getStickerSet 持久化 + rowid short_id + vision 预识别（**后台化**：codex 每 sticker ~10s，阻塞会让 poller 离线数十分钟）；目录块进 system prompt（CACHE_SCHEMA_VERSION 1→2，daemon 检测版本变化全员开新 epoch）；动态候选排除目录 sticker 且锁定在消息之后；上限 120
  - **REQ-UI-0001/2/3** (014ec4c + 91c0c9a)：R1 研究（docs/research.md）——pi 插件形态不适合独立观察者，保持独立进程 + pi-tui `Image` 组件（kitty 原生、自动降级）；attach [bot-id] 服务端过滤（hello filter，broadcast/usage/history/snapshot 全过滤，群消息全量）；底部面板（每 bot epoch/last run/cum tokens/成本/hit ratio，snapshot 全历史基线 + lastId 防双计 + usage 增量推送）；媒体经 IPC 传 mediaPath/mediaDesc，TUI 同 uid 读文件
- 真实群冒烟发现并修复：catalog short_id 先于 vision 分配 → 动态候选查询 JSON.parse(null) 崩（修复 + 回归测试）；shutdown 在 provider/codex 挂起时可永久卡死（35s 硬超时兜底）；gpt-5-mini 对 ChatGPT 账号 codex 不可用（example 改 gpt-5.6-luna-low）；start 首启等待策略（60s 窗口 + 提示 status/log）
- 文件：src/{ipc,config,sanitize,main}.ts、src/daemon/{index,ipc-server,pid}.ts、src/agent/{runtime,router,prompt,tools}.ts、src/media/sticker-catalog.ts、src/tui/index.ts、scripts/*、test/{ipc,config,sticker,analyze}.test.ts 等、docs/{architecture,cache,data-model,testing,research}.md、docs/runbooks/daemon.md、bots.config.example.json
- 测试：bun test 134/134 ✅ + bun run check ✅；真实冒烟：daemon 秒起、socket 600、attach A 单 bot 视角 + 全局面板双 bot 遥测（hit 89.4%）、非法 id 报错、stop 2s 优雅退出
- Cache impact: **INTENTIONAL**（REQ-STICKER-0001：v1→v2，固定目录进稳定 prefix，系统 prompt 带目录 bot hash 变化；无目录 bot 逐字节不变；golden 锁定；真实群 system hash 已变、epoch 已开新）
- 下一步：真实群长运行观察（sticker 目录 + 后台 vision 预热完成后重启验证目录语义补全、面板实时更新、双 bot 行为无回归）

## 2026-08-07 (18) — REQ-UI-0004 pi 插件形态落地 + 真实 pi TTY 全链路验证

- 做了：.pi/extensions/tg-extension.ts（/tg attach|panel|status|start|stop|status-daemon）+ src/tui/engine.ts（共享数据/协议层）；删除自绘 TUI（src/tui/index.ts）与 main.ts attach
- 真实 pi TTY 验证（expect PTY 注入）发现的平台事实：
  1. pi 二进制把 @earendil-works/pi-tui 重定向到内置 bundled 副本，jiti 环境下 **VStack/HStack/ScrollView 不可构造、未导出**（探针验证：Text/Container/Image/Markdown/Spacer 可用）→ attach 视图用自管理行缓冲 + tui.terminal.rows 视口
  2. **jiti 扩展环境没有 Bun 全局**（Bun.connect/Bun.spawnSync 报 ReferenceError）→ engine 改 node:net，/tg start/stop 改 node:child_process
  3. **process.stdout.rows/cols 在 jiti 里是 0**（pi 自管 TTY 尺寸）→ 视图高度取 ctx.ui.custom 的 tui.terminal；widget 无尺寸参数 → 行固定截 60
  4. **custom/widget 行超宽直接崩 pi**（"Rendered line exceeds terminal width"）→ 所有输出行 truncateToWidth
  5. setWidget 工厂形式不渲染（数组形式正常）→ panel 用数组 + 每次更新重设
- 真实验证结果（80x24 script PTY + 真实 daemon/Telegram/DeepSeek）：/tg attach A 显示真实群消息（#18902-18904）；/tg attach nobody 报错列出 A, B；/tg status A 遥测（cum in 727.7K/out 10.7K）；/tg panel A 常驻 widget（A · ep6 · last 16.0K (r 15.2K/m 792) · cum in 727.7K）；/tg stop→start 完成 daemon 重启（pid 53167→1983）
- 遗留：kitty 内联图像在滚动视图中降级为占位符+vision 描述（bundled 缺 ScrollView，图像 placement 无法跟随自管理视口；REQ-UI-0001 AC1 以占位降级达成）
- 测试：145/145 + check ✅（tg-engine.test.ts 真 socket 6 条、tg-extension.test.ts 5 条）
- Cache impact: NONE（纯前端形态）
- 下一步：真实群长运行观察（当前 daemon 健康，无新 error）

## 2026-08-08 (19) — 推翻自绘 hack，以 Pi native transcript 重做 Telegram 前端

- 用户纠正：上一版虽叫 extension，实际仍有 `TgAttachView`、手写行缓冲/scrollTop/终端尺寸/键盘/render/ANSI，extension + engine 617 行，高于旧独立 TUI 389 行；REQ-UI-0001/2/3/4 先全部取消勾选并重写验收标准。
- API 调查：通过 Context7 当前 Pi 文档与项目 `../pi` 0.84.1 source 确认，`ctx.ui.custom` 是 editor replacement；TUI-only transcript 应使用 `registerEntryRenderer` + `appendEntry`。public API 无 scroll-top event，所以采用显式 `/tg more`。
- 实现：
  - `.pi/extensions/tg-extension.ts` 改为一个动态 native custom entry，消息/LOCAL/date/media 只组合 Pi `Container`/`Box`/`Text`/`Image`/`Spacer` 与 theme；Pi host 拥有 fullscreen scroll/resize/editor/image placement。
  - `src/tui/engine.ts` 删除，新增 `src/plugin/timeline.ts`，只做 IPC snapshot/live/more、复合 cursor、dedupe、stats merge 与 ≤1 MiB media read。
  - attach 单例与 activation map 防 session restore 重连；`/tg more` prepend、`/tg detach` 保留内容；panel 改 component factory 并严格区分 feed/standalone socket ownership。
  - `package.json` 增加 Pi package manifest、`pi-package` keyword 与项目 launcher；`.pi/settings.json` 启用 fullscreen。
- 验证：目标测试 35 pass；全量 `bun test` 149 pass / 0 fail / 2821 assertions；`bun run check`、cache golden、`git diff --check` 通过；禁止手写 UI symbol 的 `rg` 0 命中；生产代码 611 行 < 617 基线。真实 Pi TTY：attach A 显示 #19061–#19063，more prepend 到 #18961，detach 后内容保留，native media fallback/widget/footer 正常。
- 文档：architecture/testing/runbook/research/requirements/handoff 同步；完成 plan 移到 `docs/plans/completed/`；四篇 UI REQ 重新勾选为完成（working tree 未提交）。
- Cache impact: **NONE**——custom entry 是 TUI-only；IPC、DB、system prompt、tool schema、message/summary grammar 均未变，golden 6/6。

## 2026-08-08 (20) — REQ-LIST 新增项调查与需求文档（未实现）

- 将用户新增四项改写为可验收文档：`REQ-UI-0005`（Pi editor 发送 Telegram）、`REQ-UI-0006`（live vision 描述 UI update）、`REQ-STICKER-0002`（per-bot sticker sendability）、`REQ-PLAT-0001`（通用平台收口）。本条只调查/写文档，没有实现这些行为。
- UI-0005：Pi `input` event 可在 extension command 之后拦截 interactive submit并返回 handled，保留原生 editor；当前 IPC 无 write contract，未来由 daemon 复用 send→DB→broadcast，且必须显式 `SEND AS bot` 防误发。
- UI-0006：snapshot/history 已读 `media.vision`，但 `ensureVision` 写库后没有 IPC update；未来用 additive media identity + `vision_update` 更新现有 TUI-only card，默认不增加视觉模型调用。
- STICKER-0002：session 历史实证 A 的 `s243/s241/s244/s242` 与 B 的 `s144` 均 no file_id；DB 映射证明它们属于另一个 bot 的固定 set。根因是 `stickerCandidatesBlock()` 查询全局 media、只排除自己的 set，却未按当前 `media_file_ids.bot_id` filter。preflight 正常阻止 network send，未发生半发送。
- PLAT-0001：daemon loop/Map/router/DB/IPC/Pi UI 已支持 N bots，不重写；剩余 runtime provider 固定 DeepSeek、e2e scripts `bots[0]`、package/project 双 persona 文案、第三 bot 全链未验证。单 deployment 单群作为明确边界，不在本需求膨胀为多租户。
- Cache impact: **NONE（本条纯文档）**。未来 UI-0005/0006 与既有 deployment 泛型化要求 NONE；STICKER-0002 从稳定 prefix 移除不可发送目录项是 INTENTIONAL，必须 bump `CACHE_SCHEMA_VERSION` + new epoch + golden。
- 下一步：先修 P0 STICKER-0002，再实现 UI-0005/UI-0006，最后收口 PLAT-0001；每项开始前单独建 active plan。

## 2026-08-08 (21) — 继续吸收 REQ-LIST 并调查 routing/footer/command tree（未实现）

- 在最终复核时发现用户又追加三项，全部保留为未勾选并写成 REQ：`REQ-ROUTE-0001`、`REQ-UI-0007`、`REQ-UI-0008`；没有实现代码。
- ROUTE-0001：Poller duplicate 不会双 route；真正现状是每个 inserted/edited 都采样，概率命中 busy runtime 时 `trigger()` 设 pending，当前 run 结束立刻再 flush。设计为 probability-only availability gate：A/B 可并发、busy/cooldown target 不重分配、全忙时只存库、settle 后 2 秒用 deadline（非阻塞 sleep）、到期不补抽；explicit trigger 保留 pending coalesce。
- UI-0007：当前 stats 是自定义 `TelegramStatsPanel` + editor 上方 widget。Pi default `FooterComponent` 已原生消费 `ctx.ui.setStatus`，并负责 sanitizer/theme/sort/width truncation；未来应删 custom panel，用 status 行放紧凑指标，完整明细保留 `/tg status`。移动 widget 或 `setFooter` 都仍是造样式。
- UI-0008：`registerCommand.getArgumentCompletions` 收完整 argument prefix，选择后替换完整 prefix；共享 command tree 可返回 `attach` → `attach A` → future level，动态读取 bot id/name，无需自定义 editor/autocomplete provider。
- Cache impact: **NONE（纯文档）**。未来三项也要求 provider bytes 不变；ROUTE-0001 预期减少 calls/miss tokens，UI 两项 token 增量 0。
- 下一步顺序更新：STICKER-0002 → ROUTE-0001 → UI-0005/0006/0007/0008 → PLAT-0001。

## 2026-08-08 (22) — 原子提交规范与新需求实施基线

- 用户授权把剩余需求逐项实现并原子签名提交；根 `AGENTS.md` 现在强制 commit-sized PLAN task、显式 staging/staged diff review、目标测试后立即签名提交、英文祈使 subject 与 Requirement/Task trailers。详细规则在 `docs/engineering/traceability.md`。
- 建立 `PLAN-20260808-complete-new-reqs`，将 7 个 REQ 拆为 daemon contract、plugin UI、routing、cache、provider/config、verification 等可独立回滚的 tasks。
- 签名提交：`c32d937` 固化 workflow；`19819c9` 提交 Pi native transcript（REQ-UI-0001/2/3/4），trailer 与 GPG signature 已机械验证。
- 本次文档基线提交 7 篇 Proposed REQ、调查证据、依赖顺序和当前 handoff；不实现这些新行为。
- Cache impact: **NONE**（workflow/docs only）。native transcript commit 的 cache impact 也是 NONE，golden 已通过。
- 下一步：T3 优先修 REQ-STICKER-0002，并执行唯一一次预期的 cache schema bump。

## 2026-08-08 (23) — sticker 候选按 bot 可发送性隔离

- fixed catalog、catalog vision preload 与 dynamic candidate SQL 全部要求当前 `bot_id` 在 `media_file_ids` 有映射；set name 只负责分区，不再被误当作可发送能力。
- `ensureStickerCatalog` 返回并记录 catalog/sendable/missing mapping；部分 fetch 失败留下的全局 media 行不会进入当前 bot prefix。send preflight 仍在任何 network call 前执行，异常映射另记 `candidate_invariant`。
- 回归 fixture 精确覆盖生产历史 A 的 `s241–s244`、B 的 `s144`，并覆盖 shared/A-only dynamic sticker 与缺映射 fixed row。
- Cache impact: **INTENTIONAL**——`CACHE_SCHEMA_VERSION` 2→3；合法 prefix hash 不变，但部署中不可发送的旧行会被移除，下次 daemon 启动自动开新 epoch。动态候选减少，降低失败 tool turn 与 miss tokens。

## 2026-08-08 (24) — probability routing busy gate 与自然冷却

- routing decision 现在显式返回 `target + reason`；原 HMAC bucket/distribution 不变。daemon 只把 probability 标为采样，目标 busy/cooldown 时 runtime 原子拒绝且不改投。
- BotRuntime 暴露 idle/busy/cooldown/stopping；probability run 的 flush 无论成功/沉默/受控失败，结束后以 monotonic deadline 冷却。默认/全局/per-bot `sampling_cooldown_ms=2000`，0 可关闭；不创建 timer，不自动补抽。
- mention/reply/name 统一走 explicit path：busy 继续 pending coalesce，cooldown 中仍可立即启动。daemon 维护并打印 triggered/skipped_busy/skipped_cooldown counters，不记录消息正文。
- 测试：router distribution/reason/no-redistribution、100-message persisted burst、fake clock 1999/2000 ms、失败后冷却、explicit 边界与 config validation；routing/flush/config/cache 44 pass，typecheck 通过。
- Cache impact: **NONE**——system/tool/message grammar 与 provider bytes 不变；预期减少连续 LLM run、miss tokens 与成本。

## 2026-08-08 (25) — daemon manual-send service 与 additive IPC

- 抽取 `sendTextAndPersist`，agent tool 与 operator path 共享 Telegram success → canonical DB primitive；manual path 在 daemon 内持有 token/API，extension 只会看到 bot id、request id 与结果。
- `ManualSendService` 校验 request id、配置 bot、非空文本与 4096 字符上限；256-entry 有界 cache 合并并发/已完成重复，same-id different-content 明确 conflict，全 in-flight 时 fast-fail busy。
- IPC additive 增加 `send_message` / `send_result`；Telegram 成功后 DB 落库、live broadcast、ACK。401/普通失败可恢复，Telegram 已成功但 DB 失败或 socket ACK 丢失走 unknown/no-auto-retry 语义；observer callback 失败不把已发送消息翻成 failure。
- 测试：manual service + IPC + real Unix observer client + canonical echo + agent send/cache regression 62 pass，含 4096 Unicode code-point 边界；typecheck 通过。
- Cache impact: **NONE**——manual operator I/O 不调用 LLM、不改 system/tool/message grammar；provider token 增量 0。

## 2026-08-08 (26) — Pi 原生 editor 显式 Telegram compose

- `/tg compose <bot-id>` 显式选择唯一发送身份；attach 保持只读。Pi default footer 持续显示 `TELEGRAM · SEND AS id/name`，`compose off` 恢复默认 Pi 输入。
- 只拦截 interactive `input` 并返回 `handled`，不创建 Pi session/provider-visible entry；RPC/extension source 原样 continue。附件/空文本阻止发送，明确失败恢复 editor 原文。
- timeline client 以 request id 匹配 ACK，pending 上限 32、15 秒超时；ACK 前断线/IPC 错误/超时统一为 unknown outcome，恢复原文、关闭 compose、提示先查群且不自动重试。发送中第二次提交不会进入 socket。
- attach 切换、detach、daemon disconnected 与 session shutdown 都清除 compose identity。真实 Unix socket ACK/timeout 和 fake Pi lifecycle 共 39 targeted tests 通过，`bun run check` 通过；真实 Pi/Telegram smoke 留 T14。
- Cache impact: **NONE**——operator input 被 extension handled；不调用 LLM，不改 provider prefix/suffix、tool schema 或序列化 grammar，新增 token 为 0。

## 2026-08-08 (27) — vision 持久化完成通知与 additive IPC

- `MsgItem` 新增可选 `fileUniqueId`，snapshot/history 与 live message 暴露同一非敏感媒体身份；daemon 新增 additive `vision_update {fileUniqueId,text}`，旧 client 可直接忽略。
- `ensureVision` 只在新非空描述成功写库后调用 observer；cache hit、空文本、unsupported 与失败不发布。lazy batch 与 background catalog 都接同一动态 sink，已有 per-media in-flight promise 继续保证 concurrent 只做一次 provider call。
- observer 异常不反转已完成持久化、不触发重试；IPC 只广播 identity/text，不含本地路径、model metadata 或 token。测试锁定 concurrent+cached describeCalls=1、空/unsupported 无帧、snapshot identity/trim 与全 listener additive push；50 targeted tests + typecheck 通过。
- Cache impact: **NONE**——没有新增 vision 调用，也不改 vision prompt、agent serialization、system/tool/message grammar 或 context epoch；provider token/cost 增量 0。

## 2026-08-08 (28) — native media card 实时合并视觉理解

- timeline client 接收 `vision_update` 后按 `fileUniqueId` 合并；256-entry、10-minute 缓存覆盖 update-before-message 与 later history，数量/时间均有界。重复同文 update 不再发 UI event。
- feed 对所有匹配消息替换内存 item 并 rebuild Pi component tree；不 append Pi entry。图片或 sticker fallback 正下方统一显示 Pi theme `视觉理解 · ...`，snapshot/live 使用同一 `mediaDesc`。
- 测试覆盖 update 先到、older page、300 update 驱逐后 size=256、同 uid 两卡片、重复幂等、ANSI/OSC strip，以及 session entry 数量不变；44 plugin/timeline/IPC tests + typecheck 通过。
- Cache impact: **NONE**——纯 IPC/TUI state merge，不改 DB schema、provider serialization、prompt/tool grammar或 vision 调用次数；token/cost 增量 0。

## 2026-08-08 (29) — 重新调查 UI-0003 的 Pi 原生 footer 定义（文档）

- 用户实机重新打开 UI-0003：现有 `TelegramStatsPanel` 是 editor 上方自定义结构，且 `setStatus("telegram")` 多出第三行；期望明确为 Pi 默认第二行 `↑/↓/R/CH/$/context/model`。
- 核对本地 Pi 0.84.1：`setStatus` 只能产生 extension-status 第三行，无法注入 usage stats；此前 UI-0007 的 setStatus 方案作废。`FooterComponent` 与 `setFooter` 均是公开 API，前者拥有全部 token/context/model/theme/width renderer。
- 新方案写入 UI-0003/UI-0007：factory 直接返回 Pi `FooterComponent`；IPC stats 只映射成内存 telemetry session view，不复制 render、format、padding或 theme，不修改/append Pi session。off/detach 恢复 default footer。
- mapping 固定为 miss→↑、output→↓、read→R、read/(read+miss)→CH、cost→$、latest context/model→右侧；global totals aggregate。后续 T9b 必须用 render test 锁用户样例。
- Cache impact: **NONE（docs/research only）**；未来实现也是 TUI-only、provider token 0。

## 2026-08-08 (30) — Telegram telemetry 改用 Pi 原生 FooterComponent

- 删除 `TelegramStatsPanel` 与 stats `setWidget`/`setStatus` 路径；attach/panel 经官方 `setFooter` mount point 直接返回 Pi 导出的 `FooterComponent`，主题、宽度、token formatter、cwd/git/status 均继续由 Pi 拥有。
- IPC totals 只映射为只读内存 telemetry session view：miss→↑、output→↓、read→R、read/(read+miss)→CH、cost→$，最新 run 提供 context/model；不 append/修改真实 Pi session。
- active feed 复用 stats；不同 panel 范围最多一个 standalone client。off/detach/feed 或 stats disconnect/session shutdown 都幂等清理并恢复 default footer；compose identity 继续通过同一原生 footer 显示。
- targeted plugin/timeline/IPC/cache 53 tests + typecheck 通过，覆盖用户样例、global aggregation、24/80 列、socket ownership 与 session isolation；真实 Pi TTY smoke 留 T14。
- Cache impact: **NONE**——纯 IPC→TUI read model，不改 provider prefix/suffix、tool/message grammar，token/cost 增量 0。

## 2026-08-08 (31) — `/tg` 使用 Pi 原生分级命令补全

- 单一递归 `TG_COMMAND_TREE` 现在同时生成 slash description、空命令 help、parser dispatch 与 `getArgumentCompletions`；选择值始终是 Pi 所需的完整 argument replacement，不注册额外顶级命令或自绘菜单。
- `attach/status/compose/panel` 从已验证配置缓存 bot `id/name`，compose/panel 加 `off`；config 失败安全退回静态一级候选，不接触 token value、DB、网络或 LLM。
- tests 覆盖 A/B/C、空/partial/trailing/连续空格、unknown/extra、无参数 leaf、所有 suggestion parser round-trip 与 future third-level，targeted extension/cache 28 pass，typecheck 通过；真实 Pi 菜单留 T14。
- Cache impact: **NONE**——deterministic TUI autocomplete/help，不进入 provider context，token/cost 增量 0。

## 2026-08-08 (32) — 调查 footer lifetime 与更多原生统计（文档）

- 用户新增 note 已转写为 `REQ-UI-0009`：`loadStats()` 无时间下界，所以现有 totals 是 SQLite telemetry 首条 run 以来的 lifetime，跨 daemon/Pi restart、epoch/compaction；snapshot `lastId` 与 live merge 保证恰好一次。
- Pi `FooterComponent` 已消费 `↑/↓/R/CH/$/latest context/model/reasoning`，唯一尚可原生补齐的 token 字段是非零 cache-write `W`。runs/epoch/reasoning total/latency 不属于原生 usage layout，后续进入完整 `/tg status`，不加第三行或自绘。
- T10b 将做 `cache_write DEFAULT 0` 幂等 migration（历史不伪造）、additive IPC、restart regression 和详情输出；provider request/session/cache grammar 不变。
- Cache impact: **NONE（docs/research only）**；未来实现也仅记录 provider response telemetry，token/cost 增量 0。

## 2026-08-08 (33) — 补齐 lifetime cache-write 与详细 telemetry

- `llm_runs.cache_write NOT NULL DEFAULT 0` 由 `openDb` 幂等迁移；历史行不伪造，新 provider response 精确持久化并 live push cacheWrite/reasoning/latency。aggregate 另带 first run 与 latency totals/samples。
- Timeline 对旧 daemon 缺失 additive 字段按 0/null，并按 `lastId` 合并排序后的 live ids；file DB close/reopen + IpcServer rebuild 回归证明 lifetime 跨重启，global 不含已移除 bot。
- synthetic lifetime entry 现在把 cacheWrite 交给真实 `FooterComponent`，非零时 Pi 自动显示 `W` 并用 miss+read+write 算 CH。`/tg status` 增加 lifetime runs/since、latest 明细、reasoning 与平均 latency；不新增 footer 行/render。
- DB/runtime/IPC/plugin/cache targeted 70 pass，typecheck 通过；真实 deployment migration/restart/footer/status 留 T14。
- Cache impact: **NONE**——只记录 provider response telemetry并用于 IPC/TUI；provider request、session、prompt/tool/message/summary grammar 逐字节不变，token 增量 0。

## 2026-08-08 (34) — 调查强制点名、统一 send、群命令与用户 README（文档）

- 用户追加的四组 raw notes 已转成可验收边界：ROUTE-0001 增补“我叫小雨”在 p=0/busy/cooldown 的 name explicit 精确回归；新建 SEND-0001、CMD-0001 与 DOC-0001，REQ-LIST 不再用无链接自然语言承载需求。
- 代码调查确认当前已经只有 `send(message, sticker, reply_to)`，且成功 `terminate:true` 会跳过 follow-up provider request；真正缺口是 persona/system/tool 三处重复、显式点名可被 persona 沉默规则覆盖、成功结果携带动态 id，以及 tools hash 漏掉 description。
- Pi 0.84.1 要求 tool call 配对持久 toolResult，空 content 会被 OpenAI adapter 展开为 `(no tool output)`；后续实现采用固定最小 ACK，不伪称能删除结构结果。发送 id 留本地 details/DB/event。
- README 调查确认顶部已有平台简介，但主内容仍以内部文档目录为主；T13 等 provider schema 稳定后按 prerequisites→配置→运行/Pi→扩 bot→排障重写，并明确单 deployment 单群。
- Telegram command 调查确认当前没有 control plane；canonical identity/entity、Poller 接收 bot id、Pi `session.compact()` 与内存 routing config 足够实现。首版命令固定为 public help/bots/status 与 admin compact/set/reset；allowlist deny-by-default，实现时让 ignored deployment 只配 `@aac6fef`，命令不进 provider context。
- Cache impact: **NONE（本条纯文档）**。SEND-0001 实现是 **INTENTIONAL**：稳定 prefix 去重与 tool description/hash 修正需 bump schema/new epoch，预期 persona prefix 净缩短；ROUTE 精确测试、Telegram control plane 与 README 为 NONE。

## 2026-08-08 (35) — 锁定配置名称的显式路由语义

- 新回归直接用用户例子“我叫小雨”：即使 `routing_p=[0,0]`，仍得到 `{target:"B", reason:"name"}`，不会落入 probability/nobody。
- 同一 decision 在 busy runtime 映射为 explicit coalesce，在 cooldown runtime 映射为 explicit started；与真实 BotRuntime 的 explicit coalesce/cooldown bypass fake-clock test 组成完整边界证据。
- routing/flush/config/cache 共 46 tests、2564 assertions 通过；`bun run check` 与 diff check 通过。算法无需修改，新增测试防未来调度重构把 name 错归 probability。
- Cache impact: **NONE**——只补回归与事实文档，router provider payload、system/tool/message grammar、run 数和每 turn token 均不变。
