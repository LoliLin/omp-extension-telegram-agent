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
