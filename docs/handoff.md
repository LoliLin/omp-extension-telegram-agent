# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：Telegram 前端已重做为真正的 Pi native transcript plugin；REQ-UI-0001/2/3/4 重新验收后完成。用户随后新增 7 项，已调查并写成 REQ，**尚未实现**。

## 已完成

- `.pi/extensions/tg-extension.ts` 用 `registerEntryRenderer` + `appendEntry` 挂一个 TUI-only feed；Pi host 负责 scroll/resize/editor/theme/images。
- `src/plugin/timeline.ts` 只保留 IPC、history cursor、dedupe、stats 与有界媒体读取；旧 `src/tui/engine.ts` 已删除。
- `/tg attach [bot]`、`/tg more`、`/tg detach`、`/tg panel [bot|off]`、`/tg status [bot]` 与 daemon commands 可用。
- package manifest、项目 Pi launcher、fullscreen settings、native Image 和 component-factory widget 已落地。
- 全量验证：149 tests pass / 0 fail / 2821 assertions；`bun run check`、cache golden、diff check 通过；真实 Pi fullscreen TTY 验证 attach/more/detach。

## 下一步需求（仅调查完成）

1. **P0 `REQ-STICKER-0002`**：动态候选跨 bot 泄漏。A 的 `s241–s244` 与 B 的 `s144` no-file-id 已从 session + DB 定位；候选需按 `media_file_ids.bot_id` 过滤。实现会改变稳定 catalog prefix，必须 bump cache schema。
2. **P1 `REQ-ROUTE-0001`**：probability 命中 busy bot 目前会设置 pending run；改为 busy/cooldown skip，2 秒后只让新消息重新采样，不阻塞 poller；explicit trigger 保留。
3. **P1 `REQ-UI-0005`**：显式 compose 模式用 Pi `input` event 拦截原生 editor，daemon 新增 additive send IPC；不替换 editor、不进 LLM。
4. **P1 `REQ-UI-0006`**：vision 持久化完成后广播 additive update，更新同一 TUI-only media card；复用 lazy vision，不新增模型调用。
5. **P2 `REQ-UI-0007`**：删除自定义 stats widget，改用 Pi default footer 的 `setStatus` 原生状态行；完整明细留 `/tg status`。
6. **P2 `REQ-UI-0008`**：用 `registerCommand.getArgumentCompletions` + 共享命令树实现 `/tg` 任意层原生补全。
7. **P1 `REQ-PLAT-0001`**：N-bot daemon 已通用；剩余 DeepSeek provider hardcode、e2e `bots[0]`、双 bot 产品文案与第三 bot 全链验证。

建议顺序：STICKER-0002 → ROUTE-0001 → UI-0005 / UI-0006 / UI-0007 / UI-0008 → PLAT-0001。

## 使用方式

```bash
bun run src/main.ts start
bun run pi
# Pi 内：/tg attach A · /tg more · /tg detach · /tg panel A
bun run src/main.ts stop
```

普通 Pi editor 当前仍提交给 Pi agent，不会发送 Telegram；不要把 REQ-UI-0005 写成已完成。

## Cache / 数据边界

- 本次 native UI 重写：Cache impact **NONE**，IPC/DB/provider grammar 未变。
- 新的 UI-0005/UI-0006 设计也要求 NONE。
- STICKER-0002 修复固定 prefix 时是 **INTENTIONAL** cache change，必须走 schema bump + new epoch + golden。
- 原子提交规范已在 `c32d937` 固化；native transcript 重写已签名提交为 `19819c9`。剩余 7 项按 `PLAN-20260808-complete-new-reqs` 逐项实现/提交。
