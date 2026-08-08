# REQ-UI-0003: 用 Pi 原生 widget 呈现实时可观测性

- **Status:** Done (2026-08-08)
- **Priority:** P2
- **Source:** 原 TUI 面板需求；2026-08-08 因数组字符串 widget/hard truncation 不符合原生组件要求而重新打开
- **依赖:** REQ-UI-0004

## 问题

当前 panel 每次把 ANSI 字符串数组重新传给 `setWidget`，并硬截到 60 字符；它没有使用 Pi theme/组件布局，也继承了旧 Pi 0.83 的错误探针结论。

## 目标

用 `ctx.ui.setWidget` 的 component factory 和 Pi `Container`/`Text` 组件显示实时 usage，宽度、换行与 theme 全交给 Pi。

## 非目标

- 不新增 telemetry schema。
- 不做趋势图。
- 不把 llm_runs 复制到 Pi session。

## 需求

- **R1:** 每 bot 显示 epoch、最近 run context/read/miss、累计 input/output/cost、cache hit ratio；无数据时显示明确空态。
- **R2:** widget 必须使用 component factory；不得传 ANSI 字符串数组、硬编码 60 列或自行 truncate。
- **R3:** active feed 复用同一 IPC usage 数据；独立 `/tg panel [bot-id]` 可在未 attach 时订阅；切换/关闭 panel 必须 dispose 自己拥有的 socket。
- **R4:** `/tg panel off` 移除 widget；`/tg status [bot-id]` 提供一次性 Pi 通知，均复用同一格式化逻辑。
- **R5:** baseline `lastId` 与 live usage 合并仍防双计，数值与 `llm_runs` 一致。

## 验收标准

- **AC1:** fake Pi host 证明 `setWidget` 收到 factory，factory 返回 Pi Component；不存在数组形式与 `truncateToWidth`。
- **AC2:** 一次 usage push 后 widget 在 1 秒内刷新；窄宽度 render 不抛错。
- **AC3:** attach filter、panel filter 与 stats 行一致；切换 filter 不保留旧 bot 行。
- **AC4:** panel off/session shutdown 释放 standalone stats socket；active feed 不因隐藏 panel 被断开。
- **AC5:** 聚合单测与 DB fixture 一致；`bun test` + `bun run check` + cache golden 通过。

## 约束

- Cache impact: **NONE**。
- widget 仅展示 daemon 聚合数据，不直连 DB。
- Pi host 负责宽度、wrap 与主题。

## 例子与边界 case

- 无 run：`A · ep0 · no runs yet`。
- hit denominator 为 0：显示 `hit 0.0%`。
- panel A → panel B：dispose A 订阅，只显示 B。

## 可观察性

本需求本身是可观察性入口；断线时 widget 显示恢复提示。

## 文档影响

`docs/architecture.md`、`docs/testing.md`、`docs/runbooks/daemon.md`。

## 待决问题

无。

## 追溯

- Plans: `../plans/completed/PLAN-20260808-native-pi-telegram-ui.md`
- Commits: 从 `Requirement:` git trailer 查

## 完成证据

- fake Pi host 证明 widget 使用 component factory；active feed stats 复用、standalone panel socket ownership 与 shutdown cleanup 均有回归测试。
- 全量测试、类型检查与 cache golden 通过。
