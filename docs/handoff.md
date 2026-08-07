# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前 phase

Phase 9 — Stabilization（长运行 smoke、error recovery、restart/reconnect、文档清理）

## 已完成

- Phase 1–8 全部完成并提交（见 docs/devlog.md）：骨架、Telegram persistence、Basic Agent、TUI、双 bot routing、search/run_js、media pipeline、context refinement
- Phase 8：自定义 compaction（状态导向摘要、threshold=128K 触发、epoch 持久化+exposure 重置）、cache golden 回归测试、threshold 分析脚本、e2e-compaction 验证

## 正在做

- 文档体系已切换为 agent-kit 衍生版（根 AGENTS.md + docs/engineering/development-guide.md 为流程权威）；11 篇 REQ 已建（docs/requirements/README.md 有清单与建议顺序），**等用户审核后按 REQ 开工**
- Phase 9：长运行稳定性验证（daemon 长跑 + TUI 反复 attach/detach + restart + error recovery）

## 下一步（按序）

1. 长运行 smoke：daemon 跑数小时/过夜，观察 daemon.log、遥测、内存
2. error recovery 边界：DeepSeek 报错/超时、Telegram 网络断开、poller 409、codex vision 失败路径
3. restart + TUI reconnect 再验证（Phase 2/4 已做过单点，这次配合长跑）
4. 文档清理：architecture/cache/data-model 与代码最终一致性

## 当前架构决定

Bun 单进程 daemon 双 AgentSession；raw Bot API 长轮询；bun:sqlite；TUI 独立进程 + Unix socket IPC；send terminate:true；自定义 compaction（session_before_compact extension，threshold 128K via reserveTokens，keepRecent 20K）；send/search/run_js 三工具固定顺序；lazy vision via codex exec；deterministic routing（mention>reply>名字>HMAC 概率）

## 重要文件

- src/agent/runtime.ts（BotRuntime：session、tools、compaction ext、exposure、epoch）
- src/agent/serialize.ts / prompt.ts（cache grammar v1，test/cache.test.ts golden 锁定）
- src/config.ts（compaction_threshold / compaction_keep_recent）
- scripts/analyze-context-window.ts / e2e-compaction.ts
- Pi 源码 ../pi @ f562a1a（docs/research.md 结论对应此 commit）

## 最后测试状态

bun test 50/50 ✅；e2e-compaction ✅（epoch 2→3→4，重启恢复）；真实遥测 50 runs hit ratio 90.0%。见 docs/testing.md。

## 已知问题

- personas/ 工具段已适配（Phase 3 完成），无遗留
- bun test 强制 UTC：涉时间序列化的测试必须 pin TZ（cache.test.ts 已处理）
