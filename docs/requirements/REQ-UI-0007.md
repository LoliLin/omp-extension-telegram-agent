# REQ-UI-0007: 将 Telegram stats 生命周期接入 Pi 原生 footer

- **Status:** Done（2026-08-08；真实 Pi TTY 使用原生 footer status 呈现 Telegram 统计）
- **Priority:** P1
- **Source:** 用户要求统计位于输入栏底端且完全使用 Pi 样式；后续实机反馈明确拒绝 widget 与额外 `setStatus` 行
- **依赖:** REQ-UI-0003、REQ-UI-0004

## 问题

REQ-UI-0003 规定最终 renderer 必须是 Pi `FooterComponent`；本需求负责把 attach/panel/status/断线生命周期和现有 IPC stats owner 正确接入它，并删除旧 `TelegramStatsPanel`。

## 调查结论

- `setStatus` 会多出第三行，不符合用户给出的第二行样例；此前的 UI-0007 调查结论作废。
- `setWidget(...,{placement:"belowEditor"})` 仍是插件 widget；复制 default footer 则会随 Pi 升级漂移。
- `setFooter(factory)` 是 Pi 官方 custom-footer mount point；factory 直接返回 Pi 自己导出的 `FooterComponent`，可同时保留 `footerData` 中的 git branch 与 extension statuses。

## 目标

删除 panel UI 代码，同时保留其数据复用与 socket ownership：attach 自动显示对应 Telegram stats；`/tg panel` 作为切换/独立订阅兼容命令；off/detach/断线/退出恢复默认 footer。

## 非目标

- 不再用 `setStatus` 承载 stats；`telegram-compose` 防误发身份不受影响。
- 不改变 daemon 聚合、llm_runs 或 `/tg status` 完整输出。
- 不让 Telegram footer 与默认 Pi footer 同时占两行 usage；panel off 才恢复 operator Pi usage。

## 需求

- **R1 — 删除自绘：** 删除 `TelegramStatsPanel` 及 stats `setWidget` 路径；不得新增等价自定义 component/render。
- **R2 — attach owner：** `/tg attach [bot]` 挂载 native footer 并复用 feed stats；新 attach 替换范围但不创建额外 socket。
- **R3 — panel 兼容：** `/tg panel [bot]` 选择 native footer 范围；与 active filter 相同则复用，否则只创建一个 standalone stats client。`panel off` dispose standalone 并恢复 default footer。
- **R4 — lifecycle：** snapshot、usage、status 更新触发 Pi render；detach、daemon disconnected、session shutdown restore default footer。compose status 继续由 `telegram-compose` key 安全清理。
- **R5 — details：** `/tg status [bot]` 保留 epoch/last/cumulative/hit/cost 完整通知；footer 只用 UI-0003 的原生字段。
- **R6 — 无旁路：** 不读取 terminal width，不硬截 60 列，不实现 footer theme/token formatter，不修改 Pi session entries。

## 验收标准

- **AC1:** production `rg` 无 `TelegramStatsPanel`/`tg-panel`/stats `setWidget`；fake factory 返回 `FooterComponent`。
- **AC2:** attach A/全局、panel B/off、detach/disconnect/shutdown 的 footer factory、render refresh 和 socket dispose 轨迹精确。
- **AC3:** compose开启时原生FooterComponent仍显示`TELEGRAM · SEND AS ...`或`TELEGRAM · CHOOSE BOT ON SEND` extension status；stats更新不覆盖它。
- **AC4:** `/tg status` 完整数值与 native compact mapping 来自同一 `BotStats`，baseline/live 不双计。
- **AC5:** 窄/宽 terminal 直接调用 Pi FooterComponent render 均不抛错；无项目 truncate/render 代码。
- **AC6:** 目标测试、全量测试、typecheck、cache golden 与真实 Pi smoke 通过。

## 约束

- Cache impact: **NONE**；TUI-only，token impact 0。
- footer owner/key/socket 必须单例；任何 cleanup 幂等。

## 命令语义

- `/tg attach A`：观察 A 并自动显示 A 原生 stats footer。
- `/tg attach`：观察全部并显示 aggregate footer。
- `/tg panel B`：feed 可保持 A，但 footer 切为 B；需要一个 standalone stats socket。
- `/tg panel off`：仅关闭 Telegram stats footer/standalone client，不 detach feed。
- `/tg detach`：断开 feed并恢复 default footer。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs` T9a/T9b
- Commits: 从 `Requirement: REQ-UI-0007` trailer 查

## 完成证据

- production 已删除 `TelegramStatsPanel` 与 stats `setWidget`；attach/panel factory 直接返回 `FooterComponent`。
- active feed 复用与单一 standalone owner、panel off、attach 切换、detach、两类 disconnect、shutdown 均由 fake host 锁定，不累积 socket/footer。
- Telegram stats 更新只刷新内存 telemetry view；完整 `/tg status` 与 Pi session/provider/cache 路径保持不变。
