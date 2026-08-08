# REQ-UI-0005: 用 Pi 底部 editor 直接发送 Telegram 消息

- **Status:** Implemented（2026-08-08 T13o；真实Pi/Telegram smoke留T14后勾选）
- **Priority:** P1
- **Source:** 用户原始需求「用底部的输入栏作为 bot 发送消息」；追加纠正「输入文本按 Pi 的发送键盘直接发送，如果有多个 bot 跳出来选择框（复用 Pi）」
- **依赖:** REQ-UI-0004、REQ-CONF-0001

## 问题

首版实现只在显式执行 `/tg compose <bot-id>` 后拦截 Pi editor；`/tg attach` 本身仍是只读。这个额外模式与用户希望的聊天体验不一致：打开 Telegram feed 后，editor 应直接属于 Telegram；当全局 feed 对应多个 bot 时，发送当下才需要选择身份。

当前 daemon request-id send → canonical SQLite → live broadcast 链已经满足 exactly-once 边界，缺口只在 Pi extension 的输入模式与身份选择。不得为此替换 editor 或自绘 selector。

## 调查结论

- Pi 0.84.1 的 extension `input` event 在 agent 处理前触发；返回 `{ action: "handled" }` 会保留原生 editor、历史与键位，同时阻止文本进入 Pi agent。
- Pi `ExtensionUIContext.select(title, options)` 是当前公开的原生选择器；取消返回 `undefined`。它已经被项目 onboarding 使用，不需要新增 TUI component。
- active feed 已持有 `filter`。过滤到一个 bot 时身份唯一；全局 feed 在一个配置 bot 时也唯一；只有全局 feed + 多 bot 才需要 selector。
- `/tg compose <bot-id>` 仍有价值：它是连续以同一 bot 发言的显式 sticky override；`compose off` 则是在 feed 保持可见时把 editor 暂时还给 Pi。

## 目标

`/tg attach [bot]` 成功挂载 feed 后，interactive editor 默认直接发送 Telegram。身份唯一时直接发送；配置多个 bot 的全局 feed 在每次提交时使用 Pi 原生 selector 选择身份。所有路径继续复用 daemon 写链，不进入 Pi session/provider context。

## 非目标

- 不发送图片、文件、sticker、reply 或 Telegram entities；operator editor 仍是 literal plain text。
- 不让 extension 读取 bot token 或直连 Telegram。
- 不替换 Pi editor、autocomplete、history、提交键或 selector。
- 不记忆全局 selector 的上一次选择；若要固定身份，使用 `/tg compose <bot-id>`。
- 不把 operator 手动发送注入任一 bot 的 provider context；poller 后续如何让其他 bot 看见沿用现有 ingestion/routing。

## 需求

- **R1 — attach 即可发送：** `/tg attach <bot-id>` 进入 scope compose，editor 直接以该 bot 发送；全局 `/tg attach` 也进入 scope compose。配置恰有一个 bot 时直接发送，多个 bot 时执行 R2。attach 不得再默认只读。
- **R2 — Pi 原生身份选择：** 全局 feed + 多 bot 的每次 interactive 普通文本提交都调用 `ctx.ui.select`。选项由当前配置动态生成并同时显示稳定 bot id/name；选中后只发送一次。取消时恢复原始 editor 文本、返回 `handled`，既不发 Telegram 也不进入 Pi。
- **R3 — 可逆 override：** `/tg compose <bot-id>` 保留为 sticky identity 并跳过 selector；`/tg compose` 无参数恢复当前 feed 的 scope compose；`/tg compose off` 保持 feed 但令后续 editor 输入返回 `continue` 给 Pi。命令树、help、parser 与 completion 共同表达 `[bot|off]`。
- **R4 — 原生输入拦截：** 只拦截 `event.source === "interactive"`；extension command 仍由 Pi 先处理，RPC/extension source永远`continue`。任何Telegram输入路径返回`handled`，不调用`sendUserMessage`、`appendMessage`或其他provider-visible API。
- **R5 — 唯一写链：** extension只调用已有request-id `send_message {botId,text}` IPC；daemon继续负责bot/text/长度校验、Telegram API、canonical persistence与broadcast。token不离开daemon。
- **R6 — 失败与并发：** selector展示和发送期间都阻止第二次提交。明确失败、selector取消、附件和空文本恢复原文；Telegram可能成功但ACK丢失时关闭compose并提示先查群，绝不自动重试。
- **R7 — 持续可见身份：** filtered/single-bot scope或sticky override显示`TELEGRAM · SEND AS <id/name>`；全局多bot scope显示`TELEGRAM · CHOOSE BOT ON SEND`；选择或发送期间显示有界busy状态。`compose off`清除该status。
- **R8 — 生命周期：** 新attach替换旧scope；detach、daemon disconnect、session shutdown、受控restart/config变更都安全关闭compose与未确认选择。迟到selector结果或ACK不得向已替换feed发送。
- **R9 — 附件边界：** Telegram compose收到`event.images`时阻止提交并提示不支持附件；不得静默交给Pi或只发caption。

## 验收标准

- **AC1:** `/tg attach A` 后直接输入 `hello`，fake daemon精确收到一次`send_message(A,"hello")`；没有先执行`/tg compose A`，Pi agent也没有开始run。
- **AC2:** 全局attach + A/B/C时，提交一次只出现一个Pi native select，选B后只发送B；选项顺序与配置一致且label可区分id/name。
- **AC3:** selector取消恢复逐字节相同的原文、发送数为0、结果为`handled`；全局只有一个bot时selector调用数为0。
- **AC4:** sticky `/tg compose A` 连续发送不弹selector；`compose off`后interactive输入交给Pi；无参数`/tg compose`后恢复scope行为。
- **AC5:** daemon fake返回Telegram Message后DB只有一条canonical row且feed live显示；poller echo不重复。400/401、断线、ACK丢失与pending double-submit都不双发。
- **AC6:** RPC/extension source、空文本、超长文本、非法bot、附件、attach replacement、detach/shutdown/restart都有确定行为和回归测试。
- **AC7:** footer status精确区分`SEND AS`与`CHOOSE BOT ON SEND`；实现中不存在自定义editor/select component。
- **AC8:** `bun test test/tg-extension.test.ts test/tg-engine.test.ts test/ipc.test.ts test/manual-send.test.ts`、`bun run check`、cache golden与真实Pi/Telegram smoke通过。

## 约束

- Cache impact: **NONE**。operator → Telegram是provider外的确定性I/O；selector不增加LLM call或token。
- IPC保持additive；当前request-id/no-auto-retry协议不变。
- Secret只留daemon，Unix socket继续0600。
- 配置读取或selector失败必须恢复原文并保持身份明确，不得猜bot。

## 例子与边界 case

- `/tg attach A` → status `SEND AS A` → Enter直接发A。
- `/tg attach`，配置A/B/C → status `CHOOSE BOT ON SEND` → Enter → Pi select → B → 发B；下一条再次选择。
- `/tg compose A` → sticky A；`/tg compose off` → editor回到Pi；`/tg compose` → 回到当前attach scope。
- selector打开期间feed被detach/restart：选择结果作废，原文恢复，不发送。
- 未知slash文本仍遵循Pi command precedence；只有普通interactive input到本handler。

## 可观察性

本地UI只显示scope、选择中、发送中、成功/失败/unknown；daemon日志可含bot id、request id、Telegram message id，不含正文/token。selector取消不写daemon event。

## 文档影响

实现时同步`docs/architecture.md`、中英Pi使用指南、`docs/runbooks/daemon.md`、`docs/testing.md`与command help。

## 待决问题

无。用户追加说明已经决定attach默认直发、多bot使用Pi原生selector；显式compose只作为override/off控制。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T5`、`#T6`、`#T13o`
- Commits: `0b3fad0`（daemon contract）；其余从`Requirement: REQ-UI-0005` trailer查
