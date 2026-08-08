# PLAN-20260808-complete-new-reqs: 逐项实现并提交 REQ-LIST 剩余需求

- **Status:** Active
- **Requirements:** REQ-STICKER-0002, REQ-ROUTE-0001, REQ-SEND-0001, REQ-SEND-0002, REQ-CMD-0001, REQ-TG-0002, REQ-TG-0003, REQ-REPLY-0001, REQ-OPS-0002, REQ-UI-0005, REQ-UI-0006, REQ-UI-0007, REQ-UI-0008, REQ-UI-0009, REQ-UI-0010, REQ-UI-0011, REQ-UI-0012, REQ-PLAT-0001, REQ-DOC-0001, REQ-ONBOARD-0001
- **Source:** 2026-08-08 用户授权：文档完成后逐项开发直到清单完成，并做小粒度原子签名提交

## 结果

REQ-LIST 当前新增项全部实现、验证并以 commit 标注勾选；Telegram plugin 能从 Pi editor 发消息、实时补视觉理解、使用 lifetime 原生 footer stats 与分级命令补全；router 有 busy/cooldown gate；sticker 候选满足 per-bot sendability；平台外围收口为可配置 N-bot/provider；fresh clone 可从 `bun run pi` + `/tg config` 进入双语用户旅程，真实 persona 不再被新 HEAD 跟踪。每个 task 是一个独立签名 commit。

## 已确认边界

- 当前 working tree 的 native transcript 重写已通过 149 tests + real Pi smoke，但尚未提交，必须先按独立 task 落库。
- Pi 官方 extension API：`input` handler 的 `handled` 可阻止进入 agent；`setStatus` 使用默认 footer；`getArgumentCompletions` 原生支持 argument completion。
- STICKER-0002 会改变稳定 catalog prefix，必须 bump cache schema/new epoch/golden；其余 UI/routing 改动预期 cache NONE。
- daemon 正在运行；涉及 cache/schema/runtime 的真实 smoke 前按 runbook 做受控重启，不删除 data。

## Commit-sized tasks

- [x] **T0** — 强化 AGENTS/traceability 的原子签名提交与 message 规范，并建立本计划；validates: 用户提交规范要求；commit: docs/policy only
- [x] **T1** — 提交已验证的 Pi native transcript 重写（package、timeline、entry、tests、current architecture docs）；validates: REQ-UI-0001/2/3/4；commit: native observer behavior
- [x] **T2** — 提交 7 篇新增 REQ、调查记录、REQ-LIST 与 handoff/devlog 基线；validates: requirements traceability；commit: docs only
- [x] **T3** — 按 bot file_id 过滤 fixed/dynamic sticker candidates，补真实回归 fixture并 bump cache schema；validates: STICKER-0002 AC1–AC6；commit: sticker invariant
- [x] **T4** — 为 probability routing 增加 runtime availability + 2s deadline cooldown（explicit trigger 保留），用 fake clock/burst replay验证；validates: ROUTE-0001 AC1–AC7；commit: routing scheduler
- [x] **T5** — 抽取 daemon manual-send service并新增 additive request-id IPC send_message/ack/error；validates: UI-0005 R3–R5；commit: daemon write contract
- [x] **T6** — Pi `input` event + explicit compose identity 接入原生 editor，处理附件/失败/unknown outcome/cleanup；validates: UI-0005 AC1–AC6；commit: editor behavior
- [x] **T7** — vision 成功持久化后发布 additive media identity/update IPC，保证无新增 vision calls；validates: UI-0006 R1/R2/R4；commit: vision transport
- [x] **T8** — timeline/feed 合并 vision update并在 native media card 下实时显示理解；validates: UI-0006 AC1–AC6；commit: vision presentation
- [x] **T9a** — 吸收用户重新打开的 UI-0003，核对 Pi FooterComponent 源码并重写 UI-0003/UI-0007；validates: 用户给出的原生 footer 样例；commit: docs/research only
- [x] **T9b** — 删除自定义 stats panel，用 `setFooter` 直接挂 Pi `FooterComponent` + IPC telemetry read view，保留完整 `/tg status`；validates: UI-0003/UI-0007 AC1–AC6；commit: native footer behavior
- [x] **T10** — 建共享 `/tg` command tree + `getArgumentCompletions`，覆盖动态 bot 与多级 prefix；validates: UI-0008 AC1–AC6；commit: command UX
- [x] **T10a** — 调查用户新增的 lifetime/more stats note，写 UI-0009 并明确 Pi 原生字段边界；validates: documented scope/AC；commit: docs/research only
- [x] **T10b** — 增加 cache-write migration/telemetry、跨重启 lifetime 回归与完整 `/tg status`；validates: UI-0009 AC1–AC6；commit: telemetry completeness
- [x] **T10c** — 调查并正式化用户追加的配置名称强制回复、统一 terminating send、Telegram admin commands 与用户视角 README；validates: 新 notes 可追溯且边界可验收；commit: docs/research only
- [x] **T10d** — 锁定“我叫小雨”在 p=0/busy/cooldown 下的 name explicit route；validates: ROUTE-0001 AC6；commit: routing regression
- [x] **T10e** — 将公开回复用法收口到唯一 send schema，清理 persona/protocol 重复，使用 terminating 最小 ACK 并修正 tools hash/cache epoch；validates: SEND-0001 AC1–AC7；commit: agent send contract
- [x] **T10f** — 调查用户追加的 Pi feed 刷新延迟与缺少流式输出，正式化 message_update/IPC/requestRender 边界；validates: UI-0010 documented scope/AC；commit: docs/research only
- [x] **T10g** — 核对 Telegram `sendChatAction` 官方时限/动作并正式化 response opportunity typing lease；validates: TG-0002 documented scope/AC；commit: docs/research only
- [x] **T10h** — 吸收用户纠正并复核 Bot API 10.1/10.2：private draft Thinking、group fallback 与 Rich Messages 收发/投影边界；validates: TG-0002/TG-0003 capability docs；commit: docs correction/research
- [x] **T10i** — 增加有界 ephemeral assistant stream IPC、原位 Pi native card 与每次 feed change 的 host render request；validates: UI-0010 AC1–AC7；commit: native streaming behavior
- [x] **T10j** — 增加每 bot `typing` activity lease、4 秒续约与 send/settle/shutdown 清理，并锁 group 不调用 private draft；validates: TG-0002 AC1–AC7；commit: Telegram response feedback
- [x] **T10n** — 调查并正式化 direct reply provider-delivery 与 Pi 一键受控重启；validates: REPLY-0001/OPS-0002 documented scope/AC；commit: docs/research only
- [x] **T10k** — 增加 rich JSON migration、统一 inbound/edit/sent normalize 与有界纯文本 projector；validates: TG-0003 AC4–AC6；commit: rich message data plane
- [x] **T10l** — 将 agent `send.message` 接到 `sendRichMessage` Rich Markdown、确定性 plain fallback并 bump cache epoch；validates: TG-0003 AC1–AC3/AC7/AC8；commit: rich outbound contract
- [x] **T10o** — 持久化 reply parent identity/obligation并保证 busy、overflow、restart 后进入目标 bot suffix；validates: REPLY-0001 AC1–AC8；commit: reply provider delivery
- [x] **T10q** — 调查并正式化 fresh-clone `/tg config`、TypeScript 本机配置、提示词隐私、双语 mdBook/Pages 与成本设计概览；validates: ONBOARD-0001 documented scope/AC；commit: docs/research only
- [x] **T10r** — 调查并正式化 Pi native card hierarchy、trailing metadata 与 narrow-width退化；validates: UI-0011 documented scope/AC；commit: docs/research only
- [x] **T10s** — 共享 Pi native header stack，统一message/event/stream层级并锁多宽度/零净LOC；validates: UI-0011 AC1–AC7；commit: native card presentation
- [x] **T10t** — 用T10s真实commit hash记录UI-0011完成并在REQ-LIST勾选；validates: UI-0011 traceability；commit: completion record
- [x] **T10p** — 增加串行 graceful CLI/Pi restart、同deployment孤儿回收与原filter feed重连；validates: OPS-0002 AC1–AC7；commit: daemon restart workflow
- [x] **T10u** — 用T10p真实commit hash记录OPS-0002完成并在REQ-LIST勾选；validates: OPS-0002 traceability；commit: completion record
- [x] **T10v** — 复盘生产重复消息、tool trace与daemon锁竞争，正式化远端commit后的no-retry边界；validates: SEND-0002 documented scope/AC；commit: docs/research only
- [x] **T10w** — 调查并正式化Kitty/Ghostty媒体协议与Pi原生PNG转换边界；validates: UI-0012 documented scope/AC；commit: docs/research only
- [x] **T10x** — 隔离远端committed/partial/unknown与本地副作用失败，阻止同turn重发并补恢复回归；validates: SEND-0002 AC1–AC7；commit: send commit boundary
- [x] **T10y** — 用T10x真实commit hash记录SEND-0002完成并在REQ-LIST勾选；validates: SEND-0002 traceability；commit: completion record
- [x] **T10z** — 复用Pi公开`convertToPng`做Kitty异步去重转换、有界LRU与原卡片重绘；validates: UI-0012 AC1–AC7；commit: native media compatibility
- [x] **T10aa** — 用T10z真实commit hash记录UI-0012完成并在REQ-LIST勾选；validates: UI-0012 traceability；commit: completion record
- [ ] **T10m** — 增加 Telegram `/tg` deterministic command service、public status、admin allowlist、持久 routing/cooldown override 与安全 manual compact；validates: CMD-0001 AC1–AC8；commit: Telegram control plane
- [ ] **T11** — 泛型化 per-bot provider/model/auth lookup并保持现有 DeepSeek deployment bytes不变；validates: PLAT-0001 AC4/AC5；commit: provider config
- [ ] **T12** — 参数化 e2e `--bot`，增加 1/2/3-bot daemon composition/IPC fixture；validates: PLAT-0001 AC1–AC3/AC7；commit: generic verification
- [ ] **T13a** — 将 Pi dependencies/lock 改为可获取版本并增加 `bun run pi` 幂等 bootstrap/fresh-clone fixture；validates: ONBOARD-0001 AC1；commit: portable launcher
- [ ] **T13b** — 加入 typed `telegram.config.ts` loader/legacy JSON兼容；从 HEAD 取消跟踪真实persona并提供默认忽略与通用中英模板；validates: ONBOARD-0001 AC3/AC6；commit: typed config and prompt privacy
- [ ] **T13c** — 建立可取消、原子写入且不泄露 secret 的 config draft/writer，覆盖 validate/editor/backup-replace；validates: ONBOARD-0001 AC2/AC4；commit: onboarding config core
- [ ] **T13d** — 用 Pi 原生 dialogs 实现 `/tg config`，成功后复用受控 readiness 并建立 live feed；validates: ONBOARD-0001 AC2/AC5；commit: native setup wizard
- [ ] **T13e** — 将双语 README/package/project/runbook/example 重写为用户旅程，加入双语用户指南、成本设计概览与机器维护指南；validates: PLAT-0001 AC6 + DOC-0001 AC1–AC6 + ONBOARD-0001 AC7/AC9/AC11；commit: docs/metadata only
- [ ] **T13f** — 配置双 mdBook build/link check 与最小权限 GitHub Pages CI/deploy；validates: ONBOARD-0001 AC8/AC10；commit: docs publishing
- [ ] **T14** — 全量验证、真实 Pi/Telegram smoke、逐篇更新 REQ completion/commit、devlog/handoff，并将计划移 completed；validates: all ACs；commit: completion record

## 每个 commit 的固定流程

1. 只实现当前 task；先跑目标测试与 `bun run check`。
2. 更新该行为必需的 REQ/architecture/testing/cache docs；devlog 可在 T14 汇总，但行为 contract 必须同 commit。
3. 用显式路径或 patch 暂存，检查 `git diff --cached --check`、`git diff --cached`、`git status --short`。
4. `git commit -S`，subject 遵循 AGENTS.md；有 REQ 写 `Requirement:`，所有本计划 task 写 `Task:`；纯机械且无 REQ 时再写 `Work-Type: mechanical`。
5. 用 `git log -1 --show-signature` 验证 good signature；失败不降级。

## 验证矩阵

| 范围 | 命令 / 观察 | Tasks |
|---|---|---|
| Sticker/cache | `bun test test/sticker.test.ts test/cache.test.ts test/flush.test.ts` | T3 |
| Routing | `bun test test/router.test.ts test/flush.test.ts` | T4 |
| IPC/editor | `bun test test/ipc.test.ts test/tg-engine.test.ts test/tg-extension.test.ts` | T5–T10 |
| Send commit | `bun test test/rich-send.test.ts test/sticker.test.ts test/flush.test.ts test/daemon-control.test.ts` | T10x |
| Native media | `bun test test/tg-extension.test.ts test/tg-engine.test.ts` + Pi real converter fixture | T10z |
| Config/platform | `bun test test/config.test.ts` + 新 composition tests | T11–T13 |
| 全量 | `bun test` + `bun run check` + `git diff --check` | T14 |
| Real Pi | `bun run pi`: attach/compose/send/more/footer/completion/vision | T14 |
| Real Telegram | 每 bot fixed sticker + manual text + live vision | T3/T6/T8/T14 |

## Cache / token budget

- T3: **INTENTIONAL** prefix correction；bump `CACHE_SCHEMA_VERSION`、new epoch、golden/docs/cache。
- T4: **NONE** provider grammar；预期减少 run count/miss tokens，用 deterministic counters/tests证明。
- T5–T10b: **NONE**；TUI/IPC/operator I/O 与 response telemetry 不进入 provider context，vision UI 不新增 inference。
- T10e: **INTENTIONAL**；persona/protocol 去重、send tool description 与 tools hash 修正需要一次 schema bump/new epoch，稳定 prefix 预期净缩短。
- T10f/T10i: **NONE**；只消费已有 provider response stream 并更新 IPC/TUI 内存；不持久 partial、不新增模型调用或 provider-visible bytes。
- T10g/T10h/T10j: **NONE**；Telegram group chat action 是每 active bot 每 4 秒至多一次的 side channel，LLM token/provider payload 不变；private draft 不误用。
- T10k: **NONE** stable prefix；rich structure只经有界 deterministic projection进入原有动态消息 suffix，不新增 LLM call。
- T10l: **INTENTIONAL**；send tool description声明 Rich Markdown，参数/顺序不变但稳定 prefix需 bump schema/new epoch；不新增 tool/LLM call。
- T10n: **NONE（docs only）**；T10o只保证真实direct reply进入既有动态suffix、不改grammar且无fallback LLM；T10p只做进程/UI控制。
- T10o: **NONE**；reply identity/obligation属于确定性data plane，正常burst不新增call，只有超过batch上限的真实reply backlog才有必要分批。
- T10r/T10s: **NONE**；只用Pi native stack重排已有TUI文字/媒体，IPC/DB/provider bytes与调用数不变。
- T10p: **NONE**；restart不改provider/session协议或epoch，不新增LLM call/token。
- T10v/T10x: **NONE**；不改send schema/provider grammar；异常路径在Telegram调用后只终止并重试本地幂等副作用，减少重复provider turn/token。
- T10w/T10z: **NONE**；只在本地TUI按Pi capability异步准备PNG并交给原生Image，不改IPC/DB/provider bytes或vision调用。
- T10m: **NONE**；Telegram control command 与回复均由 deterministic control plane 消费，不进入 provider context；只有显式 compact 使用既有 summary 调用。
- T11–T13f: 现有 deployment **NONE**；provider/persona choice 是显式配置边界，bootstrap/wizard/docs 不进入 provider context，现有 golden 必须不变。

## 风险

- manual send ACK 丢失导致双发：request id + no automatic retry + unknown outcome UI。
- vision update 先于 message：有界 pending map；snapshot仍从 DB取最终值。
- status/command refactor破坏 extension lifecycle：fake host锁 socket ownership和shutdown cleanup。
- direct reply被普通catch-up截断或restart吞掉：durable obligation + provider suffix harness + file DB reopen回归。
- restart并发或旧socket假ready：control lock、PID身份校验、旧资源消失后才spawn并用新连接验证。
- Telegram已成功但SQLite/event/broadcast失败导致模型重试：远端commit boundary之后只给terminal committed/partial/unknown，本地恢复绝不触网。
- Pi Image在Kitty路径把WebP/JPEG误标为`f=100`：只使用Pi公开converter与Image，in-flight去重、LRU/bytes上限、dispose generation阻止迟到更新。
- cache bump误更新非 sticker grammar：逐项 hash diff，只有预期 system hash变化。
- 多原子 commit 与脏工作树混淆：每次显式 staging并审查 staged paths。
- onboarding 覆盖半份配置或泄露 secret：内存校验、同目录原子 rename、existing-file deny-by-default、脱敏 transcript fixture。
- TypeScript config 执行不一致或被误认为沙箱：Node/Pi + Bun 双 runtime fixture，文档明确只加载受信本地代码；legacy JSON 保持兼容。
- 双语文档漂移：schema examples/link checker做机械 gate，两个 book 同一 CI；用户概览只链接内部权威细节。
- native card 右对齐在窄/CJK终端溢出：40/60/80/120列visible-width tests，身份/正文优先，metadata次行退化；禁止自绘compositor。

## 完成记录

- 验证证据: 待 T14
- 需求状态已更新: no
- commits: 待逐 task 填写
