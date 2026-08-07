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
