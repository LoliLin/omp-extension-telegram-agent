# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：UI-0006 transport + native media card 实时刷新已完成；下一项 T9 先吸收用户重新打开的 UI-0003，再与 UI-0007 一起实现 Pi default footer stats。

## 已完成

- `.pi/extensions/tg-extension.ts` 用 `registerEntryRenderer` + `appendEntry` 挂一个 TUI-only feed；Pi host 负责 scroll/resize/editor/theme/images。
- `src/plugin/timeline.ts` 只保留 IPC、history cursor、dedupe、stats 与有界媒体读取；旧 `src/tui/engine.ts` 已删除。
- `/tg attach [bot]`、显式 `/tg compose <bot|off>`、`/tg more`、`/tg detach`、`/tg panel [bot|off]`、`/tg status [bot]` 与 daemon commands 可用。
- package manifest、项目 Pi launcher、fullscreen settings、native Image 和 component-factory widget 已落地。
- 全量验证：149 tests pass / 0 fail / 2821 assertions；`bun run check`、cache golden、diff check 通过；真实 Pi fullscreen TTY 验证 attach/more/detach。

## 当前实施队列

1. **已实现 `REQ-STICKER-0002`**：fixed/dynamic catalog 只暴露当前 bot 有 file_id mapping 的 short id；A `s241–s244` / B `s144` 回归已锁，cache schema 2→3。真实群各 bot 发送 smoke 留到总验收。
2. **已实现 `REQ-ROUTE-0001`**：probability 命中 busy/cooldown target 时 fast-skip 且不改投；默认 2 秒 monotonic deadline；explicit trigger 保留 pending/bypass。44 个 routing/flush/config/cache 测试通过。
3. **已实现 `REQ-UI-0005`**：daemon request-id send→DB→broadcast + Pi interactive `handled` compose 全链完成；footer 唯一身份、附件/失败恢复、ACK unknown/no-retry 与 lifecycle cleanup 共 39 个 plugin/IPC targeted tests 通过。真实发送 smoke 留 T14。
4. **已实现 `REQ-UI-0006`**：T7/T8 完成 identity update、256-entry/10-minute 乱序缓存、多引用/older page/重复幂等合并，以及 `视觉理解` native card 原位刷新与 sanitize；真实 media smoke 留 T14。
5. **P2 `REQ-UI-0007`**：删除自定义 stats widget，改用 Pi default footer 的 `setStatus` 原生状态行；完整明细留 `/tg status`。
6. **P2 `REQ-UI-0008`**：用 `registerCommand.getArgumentCompletions` + 共享命令树实现 `/tg` 任意层原生补全。
7. **P1 `REQ-PLAT-0001`**：N-bot daemon 已通用；剩余 DeepSeek provider hardcode、e2e `bots[0]`、双 bot 产品文案与第三 bot 全链验证。

用户在工作树重新打开 `REQ-UI-0003` 并给出 Pi default footer 预期；两处改动仍未暂存，T9 先调查/重写 UI-0003/UI-0007 验收再共同实现。

建议顺序：STICKER-0002 → ROUTE-0001 → UI-0005 / UI-0006 / UI-0007 / UI-0008 → PLAT-0001。

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
