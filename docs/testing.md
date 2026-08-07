# 测试状态

> 当前真实测试状态，不是计划书。

## 测试分层

unit / integration / replay / real Telegram / restart / provider-cache / long-running smoke

## 运行命令

```bash
bun test                # unit + replay（不涉及网络）
bun run test:telegram   # 真实 Telegram integration（需 .env，Phase 2+）
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
| run_js sandbox isolation | ✅ | 2026-08-07 46/46 + 真实 TinyFish 调用 |
| vision lazy/cache | ✅ | 2026-08-07 真实群 sticker/photo 语义正确，双 bot file_id 映射 |
| compaction（threshold→summary→epoch） | ✅ | 2026-08-07 e2e-compaction 强制触发，epoch 持久化+重启恢复 |
| cache regression（prefix hash 稳定） | ✅ | 2026-08-07 golden 3/3（bun test 强制 UTC，测试内 pin TZ） |
| threshold 分析脚本 | ✅ | 2026-08-07 50 runs 回放，hit ratio 90.0%，当前规模下各候选均不触发 compaction |
| 长运行 smoke | ⏳ Phase 9 | - |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
