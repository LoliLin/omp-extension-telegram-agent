# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：`docs/requirements/REQ-LIST.md` 已全部勾选；本轮总计划已移到 `docs/plans/completed/PLAN-20260808-complete-new-reqs.md`。Telegram 前端是 Pi 原生 transcript/footer/editor/select/completion/Image 组合；agent 出站使用 Pi Marked lexer生成 classic Telegram entities，incoming RichMessage data plane继续保留。

- daemon 受控重启后运行在 cache schema v7；当前 deployment 为两只 bot。
- 最终离线基线：`bun test` 424 pass / 0 fail / 5059 assertions，`bun run check`与cache v7 golden通过。
- 文档门禁：mdBook 0.5.4，18个Markdown/98 links、21个HTML/620 links通过。
- 真实验收：Pi attach/editor/footer/completion/stream/media，以及Telegram Markdown、新photo、per-bot sticker、reply/obligation均通过；T14没有调用provider或TinyFish。
- 外部可选项：第三bot真实token smoke、全新credential写入向导、首次GitHub Pages main deploy未在当前deployment执行，边界和步骤已记录在完成计划与`docs/testing.md`。

## 下一步

没有遗留实施队列。新任务先按AGENTS.md读取相关REQ/架构边界并新建commit-sized PLAN；不要把真实TinyFish/provider调用放进测试。一次性真实脚手架必须显式opt-in并在验收后删除。

## 常用命令

```bash
bun test
bun run check
bun run docs:check
bun run status
bun run pi
```

Cache、测试与提交规范分别见`docs/cache.md`、`docs/testing.md`和`docs/engineering/traceability.md`。
