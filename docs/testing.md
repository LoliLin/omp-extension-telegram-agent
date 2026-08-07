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
| Bun × Pi SDK 兼容性 smoke | ⏳ Phase 1 | - |
| Telegram ingestion/dedupe/restart | ⏳ Phase 2 | - |
| send terminating | ⏳ Phase 3 | - |
| local assistant 不进群 | ⏳ Phase 3 | - |
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
