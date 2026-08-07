# REQ-UI-0004: Telegram 前端 pi 插件化——复用 pi 成果，废弃全部自绘前端

- **Status:** Approved
- **Priority:** P1
- **Source:** 2026-08-07 用户明确要求：「所有前端相关的轮子都应该在做成 pi 的插件之后废弃」「可以用 pi 命令跑起来」

## 背景与教训

REQ-UI-0001 的意图是「写成 pi 的插件 / 扩展来复用 pi 主程序的成果」，但第一版实现错误地以 R1 研究名义判断「插件形态不适合独立观察者」，转向自绘：`src/tui/index.ts` 用 `ProcessTerminal` + `TuiAltScreen` 自己实现了终端初始化、渲染循环、输入循环、alt-screen 管理、滚动检测——这些全部是 pi 主程序已经做好且持续演进的轮子。用户明确否决该方向。

**原则：前端所有轮子（终端初始化 / 渲染循环 / 输入分发 / 主题 / 图像协议 / 状态栏）一律由 pi 提供；本项目前端 = pi 扩展 + 薄的数据/协议层。自绘 TUI 在插件形态落地后删除，不留双轨。**

## 问题

1. 自绘 TUI 重复实现 pi 已有能力：alt-screen、渲染循环、键盘输入循环、resize 处理、图像 placement 生命周期——维护成本高且与 pi 演进脱节。
2. 观察入口割裂：`bun run src/main.ts attach` 是独立进程，无法与 pi 会话共存（开 pi 就看不到群，看群就开不了 pi）。
3. 自绘代码量 ~400 行，其中终端/渲染/输入 ~60% 是 pi 已有能力的重复实现。

## 目标

- `pi`（项目目录）→ `/tg attach [bot-id]`：pi 界面内全屏群历史（实时流 / 分页 / LOCAL 标记 / kitty 图像），q/esc 返回 pi，daemon 不受影响。
- `/tg panel [bot-id]`：pi 界面常驻遥测 widget（复用 REQ-UI-0003 的数据通道）。
- `/tg status [bot-id]`：一次性遥测汇总。
- 自绘 TUI（`src/tui/index.ts`、`main.ts attach`）删除；仓库中不再有 ProcessTerminal / TuiAltScreen 使用点。
- 扩展内**不**自行实现 pi 已有的东西：渲染循环、输入循环、alt-screen、主题系统、图像协议——全部用 pi-tui 组件（Text/Container/ScrollView/Image）与 `ctx.ui.custom` / `ctx.ui.setWidget` 呈现。

## 非目标

- 不改 daemon / IPC 协议（复用 REQ-IPC/UI-0002/0003 已落地的协议：hello filter / 复合游标 / usage 推送 / mediaPath）。
- 不做 pi 之外的 Web/原生前端。
- 不把 pi 扩展作为 daemon 的替代（daemon 仍是后台常驻进程）。

## 需求

- **R1:** 项目内 pi 扩展（`.pi/extensions/tg-extension.ts` 或等价，自动发现路径），注册 `/tg` 命令族：`attach [bot-id]` / `panel [bot-id]` / `status [bot-id]`。
- **R2:** 数据/协议层提取为共享模块（如 `src/tui/engine.ts`）：IPC 客户端（hello filter / snapshot / 分页复合游标 / append / usage）、去重、渲染文本函数（消息行 / LOCAL 事件 / 面板行）、媒体路径解析。扩展与（如有）其他消费者共用；daemon 协议零变化。
- **R3:** `attach` 视图：`ctx.ui.custom` 返回 pi-tui 组件树（ScrollView + Container + Text/Image）；实时 append、滚到顶部加载更早、日期分隔、消息/事件去重、`Bot X · LOCAL` 标记、kitty 图像内联（Image 组件，非 kitty 自动降级）；q / esc 关闭（done），daemon 存活。
- **R4:** `panel`：`ctx.ui.setWidget` 常驻遥测（每 bot 或过滤单 bot：epoch / 最近 run / 累计 tokens / 成本 / hit ratio），usage 推送实时刷新；`status`：一次性汇总（notify 或 overlay）。
- **R5:** 废弃删除：`src/tui/index.ts`、`src/main.ts` 的 attach 分支及相关 CLI 文档；`grep` 验证仓库无 ProcessTerminal / TuiAltScreen / TuiMainScreen 残留。
- **R6:** 安装与文档：项目 `.pi/extensions/` 自动发现即插即用；runbook 写两种入口（daemon 起停照旧；观察一律 `pi` → `/tg …`）；research.md 修正 R1 结论。
- **R7:** 扩展容错：daemon 未运行时报错并提示 `bun run src/main.ts start`；连接断开时视图内提示，daemon 重启后可重试；非法 bot-id 列出配置清单（沿用 main.ts 现有校验逻辑，迁入扩展）。

## 验收标准

- **AC1:** 项目目录运行 `pi` → `/tg attach` 全屏群历史（消息 / LOCAL / 分页 / 实时流）与 `/tg attach A` 单 bot 过滤行为与自绘版一致（对照 REQ-UI-0001 AC2、REQ-UI-0002 AC1）；q/esc 返回 pi 会话；daemon 独立存活。
- **AC2:** `/tg panel` 常驻 widget 与 `llm_runs` 一致（抽一次 run 比对）；新 run 1s 内刷新；跨 attach/detach 累计正确。
- **AC3:** `git grep -E "ProcessTerminal|TuiAltScreen" src/` 无结果；`src/tui/index.ts` 与 `main.ts attach` 分支已删除；`bun test` 全绿 + `bun run check` 通过。
- **AC4:** cache golden 逐字节不变（provider payload 零变化）。
- **AC5:** 无 pi 会话时 daemon 起停/配置校验等非前端路径行为不变（REQ-OPS/CONF 回归）。

## 约束

- Cache impact: **NONE**（纯前端形态变化；若实现中触 provider payload = 边界 bug）。
- 协议兼容：复用现有 IPC 协议与 `src/ipc.ts` 类型，不新增 daemon 侧字段（除非确有必要，且按同 commit 双改原则）。
- 废弃删除必须在插件形态验收通过后同 commit 完成（不留双轨）。

## 例子与边界 case

- daemon 未启动时 `/tg attach`：报错提示启动命令，不崩溃。
- attach 中途 daemon 重启：视图提示断开，重新执行 `/tg attach` 恢复。
- 三 bot 配置下 `/tg attach C`：只显示 C 的 LOCAL 事件（服务端过滤，同 REQ-UI-0002）。
- 非 kitty 终端：图像降级为占位符 + vision 描述（Image 组件内置）。

## 可观察性

- 扩展加载与命令执行日志走 pi 自身日志。

## 文档影响

- `docs/architecture.md`（TUI 小节重写为 pi 插件形态）、`docs/runbooks/daemon.md`（入口更新）、`docs/research.md`（R1 结论修正：插件形态成立）、`docs/testing.md`（前端测试策略：engine 单测 + 扩展加载测试 + 手动 /tg 验证）。

## 待决问题

无。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
