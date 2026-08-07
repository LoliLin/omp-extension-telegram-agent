# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前 phase

Phase 2 — Telegram persistence（ingestion + normalization + SQLite + dedupe + restart）

## 已完成

- 需求通读；GPG 签名提交链路；Pi@f562a1a 研究（docs/research.md）
- 文档套件（project/architecture/cache/data-model/testing/devlog/handoff）
- 骨架：config loader（.env 冒号格式）、bun:sqlite schema（11 表）、personas/ 原文提取
- **Bun×Pi SDK×DeepSeek smoke 通过**（scripts/smoke-pi.ts，真实 API 调用成功）

## 正在做

Phase 2：Telegram Bot API client（raw fetch long polling）→ raw_updates → normalize → messages → dedupe → offset 持久化 → restart 验证

## 下一步（按序）

1. src/telegram/client.ts（getUpdates 长轮询，getMe 拿 bot 身份）
2. src/telegram/normalize.ts（update → canonical message）
3. src/daemon/ 主循环 + start/stop/status CLI（src/main.ts）
4. fixture replay 测试 + 真实群 ingestion 测试 + restart 测试

## 当前架构决定

Bun runtime（已验证）；daemon 单进程双 AgentSession（SDK createAgentSession）；raw Bot API fetch；bun:sqlite；TUI 独立进程 + Unix socket IPC；send tool terminate:true；compaction 关自动、Phase 8 自定义 128K policy

## 重要文件

- src/config.ts / src/db/schema.sql / src/db/db.ts
- scripts/smoke-pi.ts（SDK 用法范本：DefaultResourceLoader 需 cwd+agentDir+systemPrompt）
- docs/research.md（Pi 结论）；personas/（原文，Phase 3 适配工具段）
- Pi 源码 ../pi @ f562a1a

## 最后测试状态

smoke-pi ✅（DeepSeek 真实调用）；schema ✅。见 docs/testing.md。

## 已知问题

- personas/ 里工具相关段落（send 参数名、sticker_id、gpt-researcher、/data 工作区）还是原系统的，Phase 3 建 agent 前必须适配成本项目 schema
