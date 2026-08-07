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
| TUI attach/detach | ⏳ Phase 4 | - |
| deterministic routing property tests | ⏳ Phase 5 | - |
| run_js sandbox isolation | ⏳ Phase 6 | - |
| vision lazy/cache | ⏳ Phase 7 | - |
| cache regression（prefix hash 稳定） | ⏳ Phase 8 | - |
| 长运行 smoke | ⏳ Phase 9 | - |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
