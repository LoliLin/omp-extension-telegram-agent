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
