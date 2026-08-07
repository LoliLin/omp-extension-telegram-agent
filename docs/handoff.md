# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前 phase

Phase 1 — Research & skeleton（研究完成，骨架进行中）

## 已完成

- 需求通读（docs/requirement.md）
- GPG 签名提交链路（scripts/git-gpg.sh + repo-local gpg.program，已验证）
- Pi@f562a1a 研究 → docs/research.md（SDK 双 session / sendUserMessage / terminate:true / DeepSeek cache / compaction / pi-tui）
- 文档套件初版：project/architecture/cache/data-model/testing/devlog/handoff

## 正在做

项目骨架：package.json（file: 依赖 ../pi/packages/*）、config/env loader（.env 是 `key: value` 冒号格式）、SQLite skeleton、Bun×Pi SDK smoke test

## 下一步（按序）

1. Bun×Pi SDK 兼容性 smoke test（不兼容→降级 Node26+node:sqlite，更新 architecture.md）
2. personas/xiaoxue.md、personas/xiaoyu.md（从 requirement.md 末尾抽取，适配本项目 send tool schema）
3. Phase 2：Telegram ingestion + 持久化 + restart

## 当前架构决定

- Bun runtime（待 smoke 验证）；daemon 单进程双 AgentSession（SDK createAgentSession）；raw Bot API fetch long polling；bun:sqlite；TUI 独立进程 + Unix socket IPC；send tool terminate:true；compaction 关自动、Phase 8 自定义 128K policy

## 重要文件

- docs/requirement.md（完整需求 + 两人设全文）
- docs/research.md（Pi 结论 + API 速查）
- Pi 源码：../pi @ f562a1a（dist 已构建，file: 依赖）
- env：.env（冒号格式；变量名见 .env.example）

## 最后测试状态

仅 GPG 签名验证通过。见 docs/testing.md。

## 已知问题

- 无阻塞问题
