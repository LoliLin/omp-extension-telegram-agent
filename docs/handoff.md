# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-09：`review-260808`重构完成，计划归档到`docs/plans/completed/PLAN-20260808-cost-context-refactor.md`，`REQ-LIST.md`已全部勾选。

- HEAD使用cache schema v8：immutable Telegram events、per-bot monotonic cursor、separate visible refs/reply obligations、restore前完整session fingerprint、固定Pi extensions、structured compaction与payload HMAC observer均已集成。
- 每轮输入默认上限12k tokens、单event 4096；sticker本地top-K≤8；search输出有界；reasoning/search/run_js/vision使用成本优先默认，vision与retention有deployment边界。`/tg config`会固定预检过的provider/model并显式写出这些默认值。
- 最终离线基线：`bun test` 442 pass / 0 fail / 5118 assertions（42 files，零外网）、`bun run check`、cache v8 golden 7/7通过。
- 文档门禁：mdBook 0.5.4，18个Markdown/98 links、21个HTML/620 links通过。
- 本轮未重启真实daemon，也未调用provider、TinyFish或Telegram；运行中的旧deployment可能仍是旧schema，下一次受控restart会按fingerprint建立v8 session并保留旧session文件。

## 下一步

没有遗留实施队列。若要观察真实session rotation、长期成本/延迟或vision budget，先记录授权与预期副作用，再执行明确opt-in smoke；历史90% cache-hit样本不是schema v8生产承诺。

## 常用命令

```bash
bun test
bun run check
bun run docs:check
bun run status
bun run pi
```

Cache、测试与提交规范分别见`docs/cache.md`、`docs/testing.md`和`docs/engineering/traceability.md`。
