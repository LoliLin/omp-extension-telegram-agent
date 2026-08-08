# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：REPLY-0001 durable provider delivery已实现；下一步做deployment-wide一键restart，再做Telegram control plane。

## 已完成

- `.pi/extensions/tg-extension.ts` 用 `registerEntryRenderer` + `appendEntry` 挂一个 TUI-only feed；Pi host 负责 scroll/resize/editor/theme/images。
- `src/plugin/timeline.ts` 只保留 IPC、history cursor、dedupe、stats 与有界媒体读取；旧 `src/tui/engine.ts` 已删除。
- `/tg attach [bot]`、显式 `/tg compose <bot|off>`、`/tg more`、`/tg detach`、`/tg panel [bot|off]`、`/tg status [bot]` 与 daemon commands 可用。
- package manifest、项目 Pi launcher、fullscreen settings、native Image 和 Pi `FooterComponent` telemetry 已落地。
- 全量验证：246 tests pass / 0 fail / 3772 assertions；`bun run check`、cache v5 golden通过；真实 Pi fullscreen TTY 已验证 attach/more/detach，Rich/reply真实群trace留T14。

## 当前实施队列

1. **已实现 `REQ-STICKER-0002`**：fixed/dynamic catalog 只暴露当前 bot 有 file_id mapping 的 short id；A `s241–s244` / B `s144` 回归已锁，cache schema 2→3。真实群各 bot 发送 smoke 留到总验收。
2. **已实现 `REQ-ROUTE-0001`**：probability 命中 busy/cooldown target 时 fast-skip 且不改投；默认 2 秒 monotonic deadline；`routing_p=0` 的“我叫小雨”仍以 name explicit 在 busy/cooldown coalesce/bypass。46 个 targeted tests 通过。
3. **已实现 `REQ-UI-0005`**：daemon request-id send→DB→broadcast + Pi interactive `handled` compose 全链完成；footer 唯一身份、附件/失败恢复、ACK unknown/no-retry 与 lifecycle cleanup 共 39 个 plugin/IPC targeted tests 通过。真实发送 smoke 留 T14。
4. **已实现 `REQ-UI-0006`**：T7/T8 完成 identity update、256-entry/10-minute 乱序缓存、多引用/older page/重复幂等合并，以及 `视觉理解` native card 原位刷新与 sanitize；真实 media smoke 留 T14。
5. **已实现 `REQ-UI-0003/0007`**：删除 stats widget；`setFooter` 直接返回 Pi `FooterComponent`，IPC stats 只做内存 read view，完整明细保留 `/tg status`。targeted 53 tests/typecheck/cache golden 通过，真实 TTY footer 留 T14。
6. **已实现 `REQ-UI-0008`**：递归 command tree 同时驱动 help/parser/dispatch/completion；A/B/C、config error 与 future third-level targeted tests 通过，真实 Pi 菜单留 T14。
7. **P1 `REQ-PLAT-0001`**：N-bot daemon 已通用；剩余 DeepSeek provider hardcode、e2e `bots[0]`、双 bot 产品文案与第三 bot 全链验证。
8. **已实现 `REQ-UI-0009`**：DB lifetime 跨 file reopen/daemon rebuild，cache-write 幂等 migration + additive telemetry 完成；Pi 原生 `W/CH` 与详细 status/零 run 共 70 targeted tests 通过，真实 smoke 留 T14。
9. **已实现 `REQ-SEND-0001`**：唯一 send schema 拥有全部用法，persona/protocol 共去掉 8,859 bytes 重复；显式点名不再被 silence 覆盖；固定 `ok` + terminate 保证一次 provider call；tools hash 含 description，cache schema 3→4。
10. **已调查 `REQ-DOC-0001`**：README 需从内部索引改为 prerequisites→配置→启动/Pi→扩 bot→排障的用户旅程；等 provider schema 完成后在 T13 写最终示例。
11. **已调查 `REQ-CMD-0001`**：Telegram `/tg` 由 deterministic control service 消费；help/bots/status 公开，compact/set/reset deny-by-default。allowlist 支持 id/`@username`，当前 ignored deployment 最终只配 `@aac6fef`。
12. **已实现 `REQ-UI-0010`**：assistant start/update/end 经 bot-filtered ephemeral IPC更新同一原生卡片，thinking/text/tool args均有界；32 active/64 ended tombstone，断线清理且不落库。feed每次变化调用 Pi host render，`panel off` 后仍有效；75 targeted / 592 assertions + typecheck/cache通过，真实连续 partial留T14。
13. **已实现 `REQ-TG-0002`**：Telegram 确有private draft Thinking但只接受目标私聊；当前supergroup accepted trigger立即`typing`、每4秒续约，单timer/in-flight。组合send成功、flush settle与shutdown幂等停止；failure streak脱敏且不影响主流程，draft调用恒为0。54 targeted / 2640 assertions通过，真实群长run留T14。
14. **已实现 `REQ-TG-0003`**：T10k统一≤256 KiB source与有界projector；T10l把agent文字接到final `sendRichMessage`，确认parse/method拒绝才单次literal fallback，unknown outcome绝不重发。manual compose仍plain；tool-only说明触发cache 4→5，targeted 61/730通过，真实群留T14。
15. **已实现 `REQ-REPLY-0001`**：只存嵌入父sender numeric id；canonical+obligation在offset前原子提交。reason/chat/message id穿过dispatch，reply优先占≤40 batch；45 reply按40+5提交，busy/cooldown/stopping/file reopen与A/B隔离已锁。provider成功才清，绝无内容兜底/额外纠错call；targeted 70/2680通过，真实trace留T14。
16. **已调查 `REQ-OPS-0002`**：当前所有bot共享daemon，故一键操作定义为deployment-wide `/tg restart`；PID身份校验→graceful stop→资源释放→规范start/ready，并恢复调用前Pi feed filter，绝不热重建单runtime。

UI-0003 用户原始 note 已吸收到正式 R/AC；`19819c9` 仍是 transcript 实现证据，T9b 的新 behavior commit 才是 UI-0003/0007 完成证据。

建议顺序：一键 restart → Telegram admin commands → PLAT provider/config → 参数化 e2e/composition → 平台/README/新onboarding note调查与实现 → T14 总验收。

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
- 原子提交规范已在 `c32d937` 固化；native transcript 重写已签名提交为 `19819c9`。剩余6个既有PLAN task，另有用户刚写入REQ-LIST的clone→`bun run pi`→`/tg config` onboarding raw note待正式化；均会逐项实现/提交。
