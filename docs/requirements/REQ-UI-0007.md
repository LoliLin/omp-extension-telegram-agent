# REQ-UI-0007: 用 Pi 原生 footer status 呈现 Telegram 统计

- **Status:** Proposed（2026-08-08 已调查，未实现）
- **Priority:** P2
- **Source:** 用户新增 REQ-LIST：「把统计数据弄成原生 Pi 的样式放在输入栏底端；不要自己搓样式」
- **依赖:** REQ-UI-0003、REQ-UI-0004

## 问题

当前 telemetry 虽用 Pi `Container/Text` component factory，但仍由项目自建 `TelegramStatsPanel` 并通过 `setWidget` 放在 editor 上方；布局、label 与样式仍是插件自定义。用户要的是 Pi 默认输入区底部状态栏的原生外观，而不是另一个 Telegram 卡片。

## 调查结论

- Pi 的 `ctx.ui.setStatus(key,text)` 专门用于 persistent footer status。默认 `FooterComponent` 在 cwd/usage/model 下方渲染 extension status，并统一做 control sanitization、key ordering、theme 与 terminal-width truncation。
- `setWidget(...,{placement:"belowEditor"})` 只是把自定义 widget 移到下方，仍然是项目自绘，不满足“原生 Pi 样式”。
- `setFooter()` 会替换整个默认 footer，反而复制 Pi 的 cwd/model/context/usage 布局；不应使用。
- footer extension statuses 是单行。完整多 bot 数据应保留 `/tg status [bot]`，常驻 status 只放高信号紧凑摘要。

## 目标

删除自定义 stats panel；Telegram 连接状态与高信号 telemetry 通过 Pi 默认 footer 的 extension status 行显示在 editor 下方，并自动服从 Pi theme、宽度与生命周期。

## 非目标

- 不替换默认 footer，不复制 Pi 自己的 model/context/cwd/token 统计。
- 不新增 telemetry schema 或趋势图。
- 不把全部多 bot 历史强塞进一行；详细数据继续由 `/tg status` 通知提供。

## 需求

- **R1 — 原生入口：** 常驻 Telegram stats 只使用 `ctx.ui.setStatus`；不得为 stats 调 `setWidget`/`setFooter`，不得保留 `TelegramStatsPanel` 自定义 component。
- **R2 — 紧凑格式：** filtered attach/panel 显示 bot id、connection、epoch、last context、hit ratio、累计 cost 的有界单行摘要；无 run/断线/detached 有明确短状态。
- **R3 — 全局视角：** 多 bot 时按配置顺序生成短段并交给 Pi footer 自己 truncate；不得读取 terminal columns 或调用项目 truncate。完整明细由 `/tg status [bot]`。
- **R4 — 命令兼容：** `/tg panel [bot]` 可暂时作为“开启/切换 footer stats”的兼容别名，`/tg panel off` 调 `setStatus(...,undefined)`；文案和 autocomplete 说明新语义。
- **R5 — 数据复用：** active feed 继续复用自己的 stats；standalone status subscription 有唯一 owner，off/filter switch/session shutdown 均 dispose socket。
- **R6 — 更新与清理：** snapshot、usage、connection lifecycle 更新同一个 status key；detach 是否保留 stats 由命令语义明确，但 session shutdown 必须清除。

## 验收标准

- **AC1:** fake Pi host 只观察到 `setStatus` 更新/清除，stats 路径不调用 `setWidget` 或 `setFooter`。
- **AC2:** Pi 默认 footer 在宽/窄终端都正常渲染；换 theme、resize、多个 extension status 共存时不崩、不覆盖他人 key。
- **AC3:** attach A → live usage → detach、panel B → off、daemon disconnect、session shutdown 的文本和 socket ownership 均有测试。
- **AC4:** 全局三 bot stats 由 Pi host截断；插件生产代码无 terminal width、hard 60 columns 或自定义 truncate。
- **AC5:** `/tg status` 仍能显示完整数值，聚合与 `llm_runs` 一致。
- **AC6:** `bun test`、`bun run check`、cache golden 与真实 Pi footer TTY smoke 通过。

## 约束

- Cache impact: **NONE**。纯 TUI status，不进入 Pi session/provider context。
- Token impact: 0；复用 IPC stats，不新增 LLM 调用。
- extension status key 必须 namespace 化且稳定，例如 `telegram.stats`，不得覆盖其他插件。

## 例子与边界 case

- `Telegram A · connected · ep6 · ctx 40.2K · hit 93.2% · $0.026`
- 无 run：`Telegram A · connected · no runs`
- 三 bot 过宽：插件提供有界文本，最终截断交给 Pi FooterComponent。

## 可观察性

本需求本身是常驻 observability；断线与 stale stats 必须在同一原生 status 行可见。

## 文档影响

`docs/architecture.md`、`docs/runbooks/daemon.md`、`docs/testing.md`；实现后更新 REQ-UI-0003 的后继关系。

## 待决问题

- 全局 attach 默认展示所有 bot 的紧凑段，还是只展示 connection + aggregate。实现前用 80-column TTY 比较后拍板。

## 追溯

- Plans: 实现前建立
- Commits: 从 `Requirement:` git trailer 查
