# PLAN-20260808-native-pi-telegram-ui: 用 Pi 原生 transcript 与组件重做 Telegram 前端

- **Status:** Done
- **Requirements:** REQ-UI-0004, REQ-UI-0001, REQ-UI-0002, REQ-UI-0003

## 结果

项目以 Pi package 形式加载；Telegram feed 是 Pi transcript 中一个 TUI-only custom entry，消息、媒体和 stats 都由 Pi 组件与 theme 渲染。项目不再持有 viewport、滚动、输入、宽度或 ANSI 主题代码。

## 现状摸底

- 旧 extension 把手写 viewport 放进 `ctx.ui.custom`，生产 UI 从独立 TUI 的 389 行增长到 617 行，并没有成为原生 transcript。
- `ctx.ui.custom` 只替换 editor container，不是 transcript API；把聊天塞进去仍需自行处理 viewport。
- `registerEntryRenderer` + `appendEntry` 可创建不进入 LLM context 的 TUI-only entry；一个 entry 内可维护内存组件树，避免每条 Telegram 消息污染 Pi session。
- public API 不暴露宿主 transcript 的 scroll-top 事件，因此分页使用显式 `/tg more`。
- 现有 IPC filter、复合游标、usage baseline/lastId 可复用，wire format无需变化。

## 方案

extension 在 attach 时追加一个带 instance id 的 custom entry。entry renderer 从内存 activation map 取得 IPC timeline，返回只含 Pi 组件的动态 feed；session restore 时旧 entry 只显示 detached 摘要，不自动重连。Pi host transcript 负责 scrolling、resize、input 与 image placement。面板使用 `setWidget` component factory。

## 任务

- [x] **T1** — 重新打开并重写四篇 UI REQ，记录 API 调查；validates: UI-0004 AC1/AC3
- [x] **T2** — 将 `src/tui/engine.ts` 收敛为无展示逻辑的 `src/plugin/timeline.ts`；validates: UI-0004 R4、UI-0002 AC3、UI-0003 AC5
- [x] **T3** — 实现 Pi package、native custom entry feed、组件卡片、单例 attach/more/detach；validates: UI-0004 AC1–AC5、UI-0001、UI-0002
- [x] **T4** — 用 component-factory widget 重做 panel/status 与资源清理；validates: UI-0003 AC1–AC5
- [x] **T5** — 更新回归测试并跑验证漏斗；validates: 全部 AC
- [x] **T6** — 同步 architecture/testing/runbook/devlog/handoff，复核代码量和 cache impact；validates: UI-0004 AC6/AC7

## 验证计划与结果

| 范围 | 命令 / 检查 | 结果 |
|---|---|---|
| 目标 | `bun test test/tg-engine.test.ts test/tg-extension.test.ts test/ipc.test.ts test/cache.test.ts` | 35 pass / 0 fail |
| 全量 | `bun test` + `bun run check` | 149 pass / 0 fail；tsc 通过 |
| 静态边界 | 禁止手写 viewport/keyboard/ANSI symbol 的 `rg` | 0 命中 |
| 代码量 | `wc -l .pi/extensions/tg-extension.ts src/plugin/timeline.ts` | 611 行，低于 617 基线 |
| 真实 Pi | `/tg attach A`、`/tg more`、`/tg detach` | fullscreen TTY 通过；真实消息、prepend、detach 均可见 |

## 风险与失败模式

- session restore 重复建 socket：activation id 只存在于当前内存；恢复 entry 一律 detached，已有测试锁定。
- prepend 破坏宿主私有滚动状态：不访问私有状态，改用显式命令，由 Pi transcript 保持滚动。
- daemon 中途断开：feed 保留内容并显示 disconnected；用户重新 attach 恢复。

## 迁移 / 兼容性

IPC、DB、provider grammar 均未改变。旧自绘 TUI engine 删除；Pi 命令新增 `/tg more` 与 `/tg detach`，`/tg attach|panel|status|start|stop|status-daemon` 保留。

## Cache impact

**NONE**。custom entry 是 TUI-only，不进入 LLM context；cache golden 6/6 通过。

## 文档更新

- [x] `docs/research.md`
- [x] `docs/architecture.md`
- [x] `docs/testing.md`
- [x] `docs/runbooks/daemon.md`
- [x] `docs/devlog.md`
- [x] `docs/handoff.md`

## 完成记录

- 验证证据: 见上表；真实 Pi smoke 使用运行中的 Telegram daemon。
- 需求状态已更新: yes
- 后续工作项: REQ-STICKER-0002、REQ-ROUTE-0001、REQ-UI-0005/0006/0007/0008、REQ-PLAT-0001 仅完成调查与文档，未实现。
