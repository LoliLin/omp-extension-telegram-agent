# REQ-UI-0003: 用 Pi 原生 FooterComponent 呈现实时可观测性

- **Status:** Done（2026-08-08；Pi 原生 footer 已通过真实 TTY 与受控重启验收）
- **Priority:** P1
- **Source:** 原 TUI 面板需求；用户实机复核要求统计必须进入 Pi 原生 `↑/↓/R/CH/$/context/model` 行，不接受 editor 上方 widget 或额外 status 行
- **依赖:** REQ-UI-0004

## 问题

当前 attach 会创建 `TelegramStatsPanel`，在 transcript 与 editor 之间显示 `connected · bot A` 和一整行自定义 label。虽然它由 Pi `Container/Text` 组成，统计行的结构、文案和位置仍由插件自建；同时 `ctx.ui.setStatus("telegram",...)` 又在默认 footer 下追加第三行。用户要求的结果是 Pi 自带 footer 第二行，例如：

```text
↑13k ↓817 R20k CH66.1% $0.002 1.5%/1.0M (auto)        deepseek-v4-flash • max
```

## 调查结论

- Pi 0.84.1 `FooterComponent` 自己从 session entries 计算 `↑ input / ↓ output / R cache read / CH / cost`，并负责 context、model、reasoning、theme、resize、truncate 和 cwd/git 行。
- `ctx.ui.setStatus` 只进入 `FooterComponent` 的 extension-status **第三行**；它适合 compose 身份等安全状态，但不能把 Telegram telemetry 注入原生统计行。
- extension API 没有“外部 usage provider”setter。精确复用原生统计行的最小方案是 `ctx.ui.setFooter` 返回 Pi 公开导出的 `FooterComponent`，给它一个只读、内存中的 telemetry session view；不得复制 `FooterComponent.render()` 或它的 token/width/theme 逻辑。
- telemetry view 只从 IPC `BotStats` 生成临时 entries，并委托真实 `ctx.sessionManager` 提供 cwd/session name、`ctx.modelRegistry` 提供 model/context window。它不 append/persist Pi entry，不参与 provider context。

## 目标

attach 或兼容 `/tg panel` 开启后，Telegram usage 由 Pi 自己的 `FooterComponent` 按原生第二行渲染；关闭后无损恢复当前 Pi session 的默认 footer。

## 非目标

- 不修改 Pi session、provider context、daemon telemetry schema或 cache grammar。
- 不复制/改写 Pi footer renderer、token formatter、theme、宽度算法。
- 不用 `setStatus` 冒充统计行；compose 身份仍可用独立 namespace status。
- 不在本需求支持图表、趋势或跨 deployment 汇总。

## 需求

- **R1 — 原生组件：** stats footer factory 必须直接返回 Pi 导出的 `FooterComponent`；生产代码不得实现 footer `render(width)`、`formatTokens`、padding/truncate、ANSI/theme 样式。
- **R2 — 精确映射：** `↑ = cacheMiss`、`↓ = outputTokens`、`R = cacheRead`、`$ = cost`；context 使用最近 run `contextTokens / selected model.contextWindow`，右侧使用该 bot 配置的 model/reasoning。REQ-UI-0009 补齐非零 `W=cacheWrite` 后，CH 按 Pi 原生 `read/(miss+read+write)`；当前 deployment write=0 时与 `read/(read+miss)` 相同。
- **R3 — 范围：** filtered attach/panel 显示该 bot 在 SQLite telemetry 保留期内的 lifetime usage（跨 daemon/Pi restart 与 epoch）；全局视角聚合配置顺序内所有 bot 的 totals，context/model 取最新 run 所属 bot；无 run 时仍由原生组件显示 `0.0%/<window>`。
- **R4 — 上下文隔离：** telemetry session view 只存在于 extension 内存；不得调用 `appendMessage`、`appendEntry`、`sendUserMessage` 或修改 `ctx.sessionManager.getEntries()` 返回的真实数据。
- **R5 — 数据正确性：** active feed 复用 snapshot+usage merge；standalone panel subscription 只有一个 owner。baseline `lastId` 继续防 live 双计，`/tg status` 保留完整明细。
- **R6 — 生命周期：** attach 自动挂 native stats footer；attach/filter 切换更新同一 owner。detach、panel off、daemon disconnect、session shutdown 恢复 `setFooter(undefined)` 并清理 standalone socket。
- **R7 — 共存：** factory 使用 Pi 提供的 `footerData`，所以 cwd/git、其他 extension statuses 与 compose identity 仍由同一个原生组件渲染；不得覆盖别的 status key。

## 验收标准

- **AC1:** fake Pi host 证明 stats 路径调用 `setFooter(factory)`，factory 返回 `FooterComponent`；不调用 stats `setWidget`，也不出现项目自有 footer renderer。
- **AC2:** fixture `cacheMiss=13000/output=817/cacheRead=20000/cost=.002` 渲染包含 `↑13k ↓817 R20k CH60.6% $0.002`，context/model/reasoning 使用 Pi 原生格式。
- **AC3:** attach A → usage push → attach B、global aggregate、detach；数值、filter 与 socket ownership 均确定，窄/宽 render 不崩。
- **AC4:** Pi session entries 在 stats update 前后逐项相同；provider/cache golden 逐字节不变。
- **AC5:** panel off、disconnect、shutdown 都调用 `setFooter(undefined)`；重新开启不累积 footer/controller/socket。
- **AC6:** `bun test`、`bun run check`、cache golden 与真实 Pi TTY footer smoke 通过。

## 约束

- Cache impact: **NONE**；IPC telemetry → TUI-only read model，provider token/cost 增量 0。
- 本仓库 pin Pi `>=0.84.1`；FooterComponent constructor/render contract 由 compile + fake-host render test 锁定，Pi 升级若不兼容必须显式适配，不能降级复制源码。

## 可观察性

- `/tg status [bot]` 是完整数值权威；native footer 是同一数据的 Pi 原生紧凑视图。
- footer 开启期间显示 Telegram usage，而不是当前 operator Pi session usage；`/tg panel off` 恢复后者。

## 文档影响

`docs/research.md`、`docs/architecture.md`、`docs/runbooks/daemon.md`、`docs/testing.md`。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs` T9a/T9b
- Invalidated implementation: `19819c9`（widget 形态保留为 transcript commit，但不再算 UI-0003 完成）
- Commits: 从 `Requirement: REQ-UI-0003` trailer 查

## 完成证据

- fake Pi host 直接实例化并渲染 Pi 导出的 `FooterComponent`；fixture 精确得到 `↑13k ↓817 R20k CH60.6% $0.002 1.5%/1.0M (auto)` 与配置 model/reasoning。
- filtered/global aggregation、24/80/180 列、compose status 共存、真实 session entries 不变、detach/disconnect/shutdown/off cleanup 均有回归测试。
- `test/tg-extension.test.ts`、timeline/IPC/cache targeted 53 tests 与 typecheck 通过；T14 受控重启后的真实 Pi TTY footer 已显示 lifetime Telegram 指标与 compose status。
