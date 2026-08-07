# 测试策略与状态

> 当前真实测试状态，不是计划书。本文件是测试与验证的唯一权威来源。

## 验证漏斗（由便宜到贵，按序跑到能覆盖改动的那层）

1. **目标**：`bun test test/<相关文件>` —— 直接覆盖被改行为的最小测试
2. **全量 unit**：`bun test`（unit + replay，不触网络）+ `bun run check`（tsc --noEmit）
3. **e2e**：`bun run scripts/e2e-agent.ts` / `e2e-compaction.ts`（需 `.env`，触真实 DeepSeek / Telegram）
4. **真实群 / 长运行 smoke**：跨边界或稳定性改动才需要；观察 daemon.log、遥测、内存

## 测试选择规则

- 能确定性复现的 bug fix 必须有回归测试。
- 契约变化（IPC 协议 / schema / 序列化 grammar）需要跨边界测试。
- Agent 行为测可观察轨迹与结果，不断言 prompt 字符串。
- provider cache 相关改动必须跑 `test/cache.test.ts` golden；golden 失败是报警，先查原因，不要随手更新。
- 涉时间序列化的测试必须 pin TZ（bun test 强制 UTC，参考 test/cache.test.ts）。
- 不得为了通过而删除或削弱断言。

## 失败诊断

改源码前先定位失败来源：1) 被改的行为 2) 过期的生成物 / golden 3) 缺 bootstrap / build 产物 4) 环境或工具链不一致（TZ、bun 版本）5) flaky / 外部依赖（Telegram、DeepSeek、TinyFish、codex）6) 与本次改动无关的既有失败。外部 / 既有失败单独报告，不混入本次结论。

## 测试分层

unit / integration / replay / real Telegram / restart / provider-cache / long-running smoke

## 运行命令

```bash
bun test                # unit + replay（不涉及网络）
bun run check           # tsc --noEmit
bun run scripts/e2e-agent.ts        # 真实链路 e2e（需 .env）
bun run scripts/e2e-compaction.ts   # compaction e2e（需 .env）
bun run scripts/e2e-compaction-manual.ts  # 手动 compact() 验证 compaction_end 成功/失败路径（需 .env；1M window 下 threshold e2e 已无法廉价触发自动 compaction）
```

## 当前状态

| 场景 | 状态 | 最后结果 |
|---|---|---|
| GPG 签名提交 | ✅ | 2026-08-07 验证 good signature |
| Bun × Pi SDK 兼容性 smoke | ✅ | 2026-08-07 smoke-pi.ts 真实调用成功 |
| Telegram ingestion/dedupe/restart | ✅ | 2026-08-07 bun test 12/12 + 真实群 e2e + restart 全通过 |
| send terminating | ✅ | 2026-08-07 e2e：成功 send 后无额外 provider 请求 |
| local assistant 不进群 | ✅ | e2e：assistant_text/thinking 只进 agent_events |
| TUI attach/detach | ✅ | 2026-08-07 screen 实测：attach 实时流/退出 daemon 存活/重进历史完整 |
| deterministic routing property tests | ✅ | 2026-08-07 33/33 + 真实群双 bot 实况 |
| run_js sandbox isolation | ✅ | 2026-08-07 REQ-SEC-0001 加固后 66/66（含逃逸回归向量）+ 真实 TinyFish 调用 |
| flush/compaction 状态机（REQ-AGENT-0001） | ✅ | 2026-08-07 test/flush.test.ts + test/search.test.ts：慢 vision 并发触发不重复序列化、send 失败不标 exposed 可重试、compaction 失败/中止/空摘要不错切 epoch、exposure 与 kept tail（N≠40）对齐、search 10s 超时与响应护栏、send 先校验后发 |
| vision lazy/cache | ✅ | 2026-08-07 真实群 sticker/photo 语义正确，双 bot file_id 映射 |
| compaction（threshold→summary→epoch） | ✅ | 2026-08-07 e2e-compaction 强制触发，epoch 持久化+重启恢复；REQ-AGENT-0001 后补 e2e-compaction-manual：成功路径 epoch 4→5、kept tail 41 条精确重标（N≠40），失败路径（Nothing to compact）epoch 不动 + error 落库 |
| cache regression（prefix hash 稳定） | ✅ | 2026-08-07 golden 3/3（bun test 强制 UTC，测试内 pin TZ） |
| threshold 分析脚本 | ✅ | 2026-08-07 50 runs 回放，hit ratio 90.0%，当前规模下各候选均不触发 compaction |
| 长运行 smoke | ⏳ Phase 9 | - |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
