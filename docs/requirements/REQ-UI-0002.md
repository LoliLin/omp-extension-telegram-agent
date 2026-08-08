# REQ-UI-0002: 原生 transcript 中 attach / more / detach 与任意 bot 过滤

- **Status:** Done (2026-08-08)
- **Priority:** P1
- **Source:** 多 bot 观察需求；2026-08-08 随原生 transcript 架构重新打开
- **依赖:** REQ-CONF-0001、REQ-UI-0004

## 问题

现有 bot filter 的 daemon 端协议可用，但 attach 生命周期绑在手写窗口；重进、换 bot、分页与断线没有明确的单例资源所有者。

## 目标

在 Pi transcript 中可靠地挂载/停止一个 live Telegram feed，并可观察任意已配置 bot 的视角。

## 非目标

- 不做多 feed 并排。
- 不在 UI 中发送 Telegram 消息。
- 不改 daemon 的过滤语义。

## 需求

- **R1:** `/tg attach [bot-id]`：不指定时显示群消息 + 全部 LOCAL；指定时群消息仍全量、LOCAL/usage 只含该 bot。
- **R2:** 非法 bot id 列出有效 id；配置错误与 daemon 未运行分别给出诊断。
- **R3:** extension 只有一个 active feed；重复 attach 必须先 dispose 旧 socket，再创建新 entry。
- **R4:** `/tg more` 使用现有 `(ts, rank, id)` 复合游标取前一页并 prepend；并发点击只允许一个请求；到头后幂等。
- **R5:** `/tg detach` 关闭 socket，保留已渲染内容并更新状态；session shutdown 同样清理。
- **R6:** snapshot 与 broadcast 重叠仍按 `(chatId,messageId)` / `evtId` 去重。

## 验收标准

- **AC1:** `attach A` 只出现 A 的 LOCAL 与 stats；`attach` 出现全部；`attach nobody` 列出配置 id。
- **AC2:** A attached 时执行 `attach B`，测试观察到 A socket dispose，且只剩 B live。
- **AC3:** snapshot 100 条后 `/tg more` 能取更早同秒消息，无丢失、无重复；到头再次调用不发帧。
- **AC4:** `/tg detach` 和 `session_shutdown` 均释放 socket；历史 component 留在 transcript、状态为 detached。
- **AC5:** `bun test` + `bun run check` 通过；cache golden 不变。

## 约束

- Cache impact: **NONE**。
- IPC wire format 不变，旧客户端语义不变。
- 每页最多 100 条，内存增长由用户显式 `/tg more` 控制。

## 例子与边界 case

- 三 bot 配置：`/tg attach C` 正常。
- daemon 断开：旧内容可读；重启后显式重新 attach。
- 尚未 attach 执行 `/tg more` / `/tg detach`：提示当前没有 live feed，不抛异常。

## 可观察性

feed header 展示 filter；分页/连接状态由内存状态和错误通知呈现，断线或 detach 恢复默认 footer。Telegram usage 由 REQ-UI-0003/0007 的 Pi 原生 footer 呈现。

## 文档影响

`docs/architecture.md`、`docs/runbooks/daemon.md`、`docs/testing.md`。

## 待决问题

无。

## 追溯

- Plans: `../plans/completed/PLAN-20260808-native-pi-telegram-ui.md`
- Commits: 从 `Requirement:` git trailer 查

## 完成证据

- fake host 与真实 Unix socket 测试覆盖单例 attach、任意 bot filter、复合游标 more、detach 与 shutdown cleanup。
- 真实 Pi fullscreen TTY 已验证 attach A、prepend 更早历史与 detach 内容保留。
