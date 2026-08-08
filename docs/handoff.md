# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-09：群内控制命令已重做（本工作树待提交）：平级 `/help`、`/status`、`/compact`、`/set` 取代单 `/tg` 入口；`/set` 写穿 `telegram.config.ts`（原子写+全量校验+失败回滚），DB `telegram_override:*` 覆盖层已删除、残留行不再读取。真实行为验证待下次 daemon 重启。

2026-08-09：REQ-SEND-0003、REQ-SEARCH-0002、REQ-OBS-0001与REQ-OPS-0003已由签名提交`6afaa8d`、`5891ac0`、`6082b8e`完成。最终唯一daemon PID 40594已ready，A/B都注册`send,search`并处于新context identity。

- HEAD使用cache schema v8：immutable Telegram events、per-bot monotonic cursor、separate visible refs/reply obligations、restore前完整session fingerprint、固定Pi extensions、structured compaction与payload HMAC observer均已集成。
- 同turn `reply_to`会在provider/tool turn前临时暴露完整packed ids，失败按structured session恢复。TinyFish旧配置 omission重新保持兼容，当前私有配置显式启用search。
- daemon统一JSONL/rotation，`bun run debug`默认关联SQLite/log/session并展示无正文provider结构；显式`--show-provider-content --bot ID`只向stdout显示完整system/current messages。新功能须遵守debug guide。
- 每轮输入默认上限12k tokens、单event 4096；sticker本地top-K≤8；search输出有界；reasoning/search/run_js/vision使用成本优先默认，vision与retention有deployment边界。`/tg config`会固定预检过的provider/model并显式写出这些默认值。
- 最终离线基线：`bun test` 454 pass / 0 fail / 5179 assertions（45 files，零外网）、`bun run check`、cache v8 golden 7/7、文档门禁通过。
- 文档门禁：mdBook 0.5.4，18个Markdown/98 links、21个HTML/620 links通过。
- 最终restart已回收诊断期间的两个同仓库实例并启动唯一PID 40594；同权限域status确认running/socket。旧session因工具/fingerprint变化保留但不恢复，A/B污染上下文已由新epoch隔离；一次manual compact在新空session上被Pi以`Nothing to compact`拒绝，未伪造成摘要成功。

## 下一步

下一步只在需要时观察真实群新的精确引用或TinyFish调用；当前不再操作daemon。历史90% cache-hit样本不是schema v8生产承诺。

## 常用命令

```bash
bun test
bun run check
bun run docs:check
bun run status
bun run pi
```

Cache、测试与提交规范分别见`docs/cache.md`、`docs/testing.md`和`docs/engineering/traceability.md`。
