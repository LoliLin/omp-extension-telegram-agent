# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：ROUTE-0001 精确 name regression 已完成；下一步实现 SEND-0001 的 tool-local/terminating contract，再做 CMD-0001 Telegram control plane。

## 已完成

- `.pi/extensions/tg-extension.ts` 用 `registerEntryRenderer` + `appendEntry` 挂一个 TUI-only feed；Pi host 负责 scroll/resize/editor/theme/images。
- `src/plugin/timeline.ts` 只保留 IPC、history cursor、dedupe、stats 与有界媒体读取；旧 `src/tui/engine.ts` 已删除。
- `/tg attach [bot]`、显式 `/tg compose <bot|off>`、`/tg more`、`/tg detach`、`/tg panel [bot|off]`、`/tg status [bot]` 与 daemon commands 可用。
- package manifest、项目 Pi launcher、fullscreen settings、native Image 和 Pi `FooterComponent` telemetry 已落地。
- 全量验证：149 tests pass / 0 fail / 2821 assertions；`bun run check`、cache golden、diff check 通过；真实 Pi fullscreen TTY 验证 attach/more/detach。

## 当前实施队列

1. **已实现 `REQ-STICKER-0002`**：fixed/dynamic catalog 只暴露当前 bot 有 file_id mapping 的 short id；A `s241–s244` / B `s144` 回归已锁，cache schema 2→3。真实群各 bot 发送 smoke 留到总验收。
2. **已实现 `REQ-ROUTE-0001`**：probability 命中 busy/cooldown target 时 fast-skip 且不改投；默认 2 秒 monotonic deadline；`routing_p=0` 的“我叫小雨”仍以 name explicit 在 busy/cooldown coalesce/bypass。46 个 targeted tests 通过。
3. **已实现 `REQ-UI-0005`**：daemon request-id send→DB→broadcast + Pi interactive `handled` compose 全链完成；footer 唯一身份、附件/失败恢复、ACK unknown/no-retry 与 lifecycle cleanup 共 39 个 plugin/IPC targeted tests 通过。真实发送 smoke 留 T14。
4. **已实现 `REQ-UI-0006`**：T7/T8 完成 identity update、256-entry/10-minute 乱序缓存、多引用/older page/重复幂等合并，以及 `视觉理解` native card 原位刷新与 sanitize；真实 media smoke 留 T14。
5. **已实现 `REQ-UI-0003/0007`**：删除 stats widget；`setFooter` 直接返回 Pi `FooterComponent`，IPC stats 只做内存 read view，完整明细保留 `/tg status`。targeted 53 tests/typecheck/cache golden 通过，真实 TTY footer 留 T14。
6. **已实现 `REQ-UI-0008`**：递归 command tree 同时驱动 help/parser/dispatch/completion；A/B/C、config error 与 future third-level targeted tests 通过，真实 Pi 菜单留 T14。
7. **P1 `REQ-PLAT-0001`**：N-bot daemon 已通用；剩余 DeepSeek provider hardcode、e2e `bots[0]`、双 bot 产品文案与第三 bot 全链验证。
8. **已实现 `REQ-UI-0009`**：DB lifetime 跨 file reopen/daemon rebuild，cache-write 幂等 migration + additive telemetry 完成；Pi 原生 `W/CH` 与详细 status/零 run 共 70 targeted tests 通过，真实 smoke 留 T14。
9. **已调查 `REQ-SEND-0001`**：当前已经是单一 send + terminate；剩余是 tool-local authority、persona/protocol 去重、explicit reply 冲突、最小结构 ACK 与 description-aware tools hash。实现会触发 cache schema bump。
10. **已调查 `REQ-DOC-0001`**：README 需从内部索引改为 prerequisites→配置→启动/Pi→扩 bot→排障的用户旅程；等 provider schema 完成后在 T13 写最终示例。
11. **已调查 `REQ-CMD-0001`**：Telegram `/tg` 由 deterministic control service 消费；help/bots/status 公开，compact/set/reset deny-by-default。allowlist 支持 id/`@username`，当前 ignored deployment 最终只配 `@aac6fef`。

UI-0003 用户原始 note 已吸收到正式 R/AC；`19819c9` 仍是 transcript 实现证据，T9b 的新 behavior commit 才是 UI-0003/0007 完成证据。

建议顺序：ROUTE 精确回归 → SEND tool contract/cache epoch → Telegram admin commands → PLAT provider/config → 参数化 e2e/composition → 平台/README 文档 → T14 总验收。

## 使用方式

```bash
bun run src/main.ts start
bun run pi
# Pi 内：/tg attach A · /tg compose A · 输入纯文本 · /tg compose off
bun run src/main.ts stop
```

attach 默认只读；仅显式 compose 时 interactive editor 发 Telegram，off 后恢复 Pi。未知结果先查群，不自动重试。

## Cache / 数据边界

- 本次 native UI 重写：Cache impact **NONE**，IPC/DB/provider grammar 未变。
- 新的 UI-0005/UI-0006 设计也要求 NONE。
- STICKER-0002 是 **INTENTIONAL** cache change：schema 已从 2 bump 到 3，golden 通过；daemon 下次受控重启会自动开新 epoch。
- 原子提交规范已在 `c32d937` 固化；native transcript 重写已签名提交为 `19819c9`。剩余 7 项按 `PLAN-20260808-complete-new-reqs` 逐项实现/提交。
