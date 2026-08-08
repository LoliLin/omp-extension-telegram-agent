# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前状态

2026-08-08：T13k1a–c已删除视觉`codex exec` hack并实现shared Pi、provider前两路gate与匿名benchmark；当前photo/sticker各n=1真实gate通过且reasoning=0。下一步用真实hash勾选PLAT/VISION，再做photo readiness、TinyFish与T14总验收。

## 已完成

- `.pi/extensions/tg-extension.ts` 用 `registerEntryRenderer` + `appendEntry` 挂一个 TUI-only feed；Pi host 负责 scroll/resize/editor/theme/images。
- `src/plugin/timeline.ts` 只保留 IPC、history cursor、dedupe、stats 与有界媒体读取；旧 `src/tui/engine.ts` 已删除。
- `/tg config`、`/tg attach [bot]`、显式 `/tg compose <bot|off>`、`/tg more`、`/tg detach`、`/tg panel [bot|off]`、`/tg status [bot]` 与 daemon commands 可用。
- package manifest、项目 Pi launcher、fullscreen settings、native Image 和 Pi `FooterComponent` telemetry 已落地。
- 全量验证：372 tests pass / 0 fail / 4836 assertions；`bun run check`、cache v5 golden、双mdBook 18 Markdown/98 links与21 HTML/608 links通过；真实 Pi fullscreen TTY 已验证attach/restart/filter+footer重连/live stream，Telegram群control及Kitty/Ghostty媒体、Rich/reply/组合发送trace留T14。

## 当前实施队列

1. **已实现 `REQ-STICKER-0002`**：fixed/dynamic catalog 只暴露当前 bot 有 file_id mapping 的 short id；A `s241–s244` / B `s144` 回归已锁，cache schema 2→3。真实群各 bot 发送 smoke 留到总验收。
2. **已实现 `REQ-ROUTE-0001`**：probability 命中 busy/cooldown target 时 fast-skip 且不改投；默认 2 秒 monotonic deadline；`routing_p=0` 的“我叫小雨”仍以 name explicit 在 busy/cooldown coalesce/bypass。46 个 targeted tests 通过。
3. **已实现 `REQ-UI-0005`**：daemon request-id send→DB→broadcast + Pi interactive `handled` compose 全链完成；footer 唯一身份、附件/失败恢复、ACK unknown/no-retry 与 lifecycle cleanup 共 39 个 plugin/IPC targeted tests 通过。真实发送 smoke 留 T14。
4. **已实现 `REQ-UI-0006`**：T7/T8 完成 identity update、256-entry/10-minute 乱序缓存、多引用/older page/重复幂等合并，以及 `视觉理解` native card 原位刷新与 sanitize；真实 media smoke 留 T14。
5. **已实现 `REQ-UI-0003/0007`**：删除 stats widget；`setFooter` 直接返回 Pi `FooterComponent`，IPC stats 只做内存 read view，完整明细保留 `/tg status`。targeted 53 tests/typecheck/cache golden 通过，真实 TTY footer 留 T14。
6. **已实现 `REQ-UI-0008`**：递归 command tree 同时驱动 help/parser/dispatch/completion；A/B/C、config error 与 future third-level targeted tests 通过，真实 Pi 菜单留 T14。
7. **P1 `REQ-PLAT-0001`**：provider/auth与N-bot composition已完成；1/2/3 fixture覆盖state/runtime/poller/router/IPC，单bot脚本强制`--bot`。剩余双bot产品文案在T13e收口；真实C token smoke已有opt-in清单但当前未执行。
8. **已实现 `REQ-UI-0009`**：DB lifetime 跨 file reopen/daemon rebuild，cache-write 幂等 migration + additive telemetry 完成；Pi 原生 `W/CH` 与详细 status/零 run 共 70 targeted tests 通过，真实 smoke 留 T14。
9. **已实现 `REQ-SEND-0001`**：唯一 send schema 拥有全部用法，persona/protocol 共去掉 8,859 bytes 重复；显式点名不再被 silence 覆盖；固定 `ok` + terminate 保证一次 provider call；tools hash 含 description，cache schema 3→4。
10. **已调查 `REQ-DOC-0001`**：README 需从内部索引改为 prerequisites→配置→启动/Pi→扩 bot→排障的用户旅程；等 provider schema 完成后在 T13 写最终示例。
11. **已实现 `REQ-CMD-0001`**：Telegram `/tg` 由 deterministic control service 消费；help/bots/status 公开，compact/set/reset deny-by-default。allowlist 支持 numeric id / `@username`，ignored deployment值不进入文档；完整证据见第21项。
12. **已实现 `REQ-UI-0010`**：assistant start/update/end 经 bot-filtered ephemeral IPC更新同一原生卡片，thinking/text/tool args均有界；32 active/64 ended tombstone，断线清理且不落库。feed每次变化调用 Pi host render，`panel off` 后仍有效；75 targeted / 592 assertions + typecheck/cache通过，真实连续 partial留T14。
13. **已实现 `REQ-TG-0002`**：Telegram 确有private draft Thinking但只接受目标私聊；当前supergroup accepted trigger立即`typing`、每4秒续约，单timer/in-flight。组合send成功、flush settle与shutdown幂等停止；failure streak脱敏且不影响主流程，draft调用恒为0。54 targeted / 2640 assertions通过，真实群长run留T14。
14. **已实现 `REQ-TG-0003`**：T10k统一≤256 KiB source与有界projector；T10l把agent文字接到final `sendRichMessage`，确认parse/method拒绝才单次literal fallback，unknown outcome绝不重发。manual compose仍plain；tool-only说明触发cache 4→5，targeted 61/730通过，真实群留T14。
15. **已实现 `REQ-REPLY-0001`**：只存嵌入父sender numeric id；canonical+obligation在offset前原子提交。reason/chat/message id穿过dispatch，reply优先占≤40 batch；45 reply按40+5提交，busy/cooldown/stopping/file reopen与A/B隔离已锁。provider成功才清，绝无内容兜底/额外纠错call；targeted 70/2680通过，真实trace留T14。
16. **已实现 `REQ-OPS-0002`**：共享controller做同仓库PID身份/孤儿枚举、排他control lock、一次SIGTERM、40秒资源释放与真实socket-connect readiness；现场回收`5090+9316→6329`后跨退避窗口无新409。Pi `/tg restart`异步关闭compose，保留transcript并恢复A/all filter与原生footer；真实stopped/running/Pi三路径均通过。
17. **已实现 `REQ-ONBOARD-0001`**：T13a–T13f完成portable launcher、typed config/persona privacy、atomic writer、Pi原生`/tg config`、中英README/guide/cost overview/maintainer入口及固定mdBook/Pages链路。config取消、override、ready/feed、失败脱敏、source/generated links与最小CI权限均已锁；首次远端Pages run和真实credential smoke留T14。下一步正式化并实现REQ-LIST新增的群友图片与TinyFish fetch raw notes。
18. **已实现 `REQ-UI-0011`**：message/event/stream复用Pi `HStack/TruncatedText` header；身份leading、metadata trailing，bot id优先。40/60/80/120 columns覆盖CJK/emoji/长username与OSC，普通消息仍两行；真实Pi 80/40 columns和当前/浅色主题通过，production extension精确`+15/-15`净零行。
19. **已实现 `REQ-SEND-0002`（`bd4be62`）**：Telegram create后canonical SQLite按25/100/250ms仅本地重试；committed/partial/unknown统一固定`no_retry`+terminate，exposure/broadcast/event/typing失败隔离并只记脱敏诊断。真实双连接lock复现`#19614`路径只有一次create，poller echo最终一行；33 targeted / 190 assertions、全量268 / 3949通过，真实组合发送留T14。
20. **已实现 `REQ-UI-0012`（`49e3067`）**：只服从Pi capability；Kitty路径以公开`convertToPng`异步归一化JPEG/GIF/WebP并继续由`Tui.Image`渲染。path/size/mtime revision共享in-flight，32项/32 MiB LRU、8 MiB单项、32 pending及失败记忆有界；完成只替换相关卡片，detach/restart/shutdown迟到callback失效。targeted 50/469、全量279/4041通过，真实Kitty/Ghostty smoke留T14。
21. **已实现 `REQ-CMD-0001`（`fa311ea` + `f22ed0c` + `c0e5f26`）**：config/override、strict parser/auth/queue/runtime compact、poller前置分流、suffix目标plain reply→canonical→IPC、全runtime consume与best-effort菜单均完成。fake全链锁一次执行/create/broadcast，command+reply跨epoch不进provider；command/cache 45/374、全量302/4298通过。真实群权限/set-reset/compact留T14。
22. **已实现 `REQ-UI-0013`（`533c9ec`）**：sticker改用Pi `Image`公开24×12上限，photo保持56×16；forced Kitty锁24×12/32×16实际placement，WebP转换后仍紧凑，40/80/120列、label/vision与逐行宽度均覆盖。不改转换、vision、协议或数据；targeted 51/586、全量287/4196通过，真实视觉smoke留T14。
23. **新增实施队列 T13h–T13m**：先写单目录单群/极简成本原则和routing审计，再以Pi全局settings/auth共享runtime替代项目provider key；动态群media继续在provider前同步并改用Luna low，photo另做零LLM后台precache，最后给既有search tool增加有界TinyFish fetch。调查实证：概率bucket约67/33正常；photo缺path是下载时机；Luna low真实photo/static sticker各1次约3.87s/$0.000282与2.69s/$0.000124，样本不外推。
24. **已实现 `REQ-DOC-0002`（`dfc23b5`）**：project拥有“最少机制、完整边界”六原则与无namespace资源清单；中英operations解释history/session/offset/PID/socket隔离和第二群安全做法；AGENTS/development/maintainer加入可执行减法检查。7 docs tests、双mdBook links、全量340/4641与typecheck通过。
25. **已实现 `REQ-ROUTE-0002`（`a1321f1`）**：production loader + readonly SQLite只返回identity/trigger code，100,000连续id property锁0.66/0.34互斥；报告匿名拆分assignment、partial lifecycle、run与public。验收快照重放2,046 probability为67.06/32.94%，started为66.74/33.26%，public为52.05/47.95%，确认采样正常而口径不同。
26. **进行中 `REQ-PLAT-0002`**：T13j1 `0859490`移除项目provider secret，T13j2 `f30e22c`合并Pi defaults并建立daemon shared runtime；T13j3已让fresh `/tg config`在dialog/写入前预检Pi model/auth，生成config继承Pi，`.env`只写Telegram token。视觉复用仍由T13k1完成后再勾选。

UI-0003 用户原始 note 已吸收到正式 R/AC；`19819c9` 仍是 transcript 实现证据，T9b 的新 behavior commit 才是 UI-0003/0007 完成证据。

建议顺序：Telegram admin commands → PLAT provider/config → 参数化 e2e/composition → onboarding/双语文档 → T14 总验收。

## 使用方式

```bash
bun run src/main.ts start   # 或 restart
bun run pi
# Pi 内：/tg attach A · /tg compose A · 输入纯文本 · /tg compose off
bun run src/main.ts stop
```

attach 默认只读；仅显式 compose 时 interactive editor 发 Telegram，off 后恢复 Pi。未知结果先查群，不自动重试。

## Cache / 数据边界

- 本次 native UI 重写：Cache impact **NONE**，IPC/DB/provider grammar 未变。
- 新的 UI-0005/UI-0006 设计也要求 NONE。
- STICKER-0002 是 **INTENTIONAL** cache change：schema 已从 2 bump 到 3，golden 通过；daemon 下次受控重启会自动开新 epoch。
- 原子提交规范已在 `c32d937` 固化；ONBOARD-0001 已拆成六个实施task；全部按目标测试→显式暂存→签名commit推进。
- SEND-0002 是 **NONE**：tool schema/system/serialization/cache epoch逐字节不变；正常成功仍是`ok`，只有异常路径用固定terminal `no_retry`省掉重复provider turn与Telegram消息。
- UI-0012 是 **NONE**：只在本地Pi TUI按terminal capability准备显示PNG；IPC/DB/provider bytes、vision调用与context epoch不变。
- 新增六REQ中只有SEARCH-0001会改变tool schema并计划cache v5→v6；Pi auth、vision gate、photo readiness、routing审计与哲学文档均为provider grammar **NONE**。
