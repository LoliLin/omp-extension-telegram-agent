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
