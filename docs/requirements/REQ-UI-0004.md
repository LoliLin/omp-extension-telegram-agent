# REQ-UI-0004: Telegram 前端成为真正的 Pi 原生 transcript 插件

- **Status:** Done (2026-08-08)
- **Priority:** P0
- **Source:** 2026-08-08 用户纠正：现有实现把手写 viewport 藏进 `ctx.ui.custom`，不等于“完全用 Pi 组件渲染 Telegram 聊天”

## 问题

当前 `.pi/extensions/tg-extension.ts` 虽然注册了 `/tg`，但 `TgAttachView` 仍自行维护 `lines`、`scrollTop`、终端高度、分页轮询、键盘导航和 `render(): string[]`；`src/tui/engine.ts` 还自行拼 ANSI 颜色与展示文本。它只是运行在 Pi 扩展回调里，聊天窗口本身仍是自绘。

错误实现的直接证据：

- 生产 UI 代码从旧独立 TUI 的 389 行变成 extension + engine 的 617 行，没有减少。
- 图片因手写 viewport 主动降级，未交给 Pi 的 transcript 图片生命周期管理。
- 项目依赖的 Pi 0.84.1 已提供 fullscreen transcript 与 Kitty viewport cropping；完成态应直接接入这些宿主能力。

## 目标

Telegram 观察器是可安装、可自动发现的 Pi package。`/tg attach` 在 Pi 自己的 transcript 中挂载一个 TUI-only Telegram feed；Pi 拥有滚动、resize、输入、主题和图片 placement，项目只负责 IPC 数据、状态和 Pi 组件组合。

## 非目标

- 不把 daemon、Telegram ingestion 或 Agent runtime 搬进 Pi 进程。
- 不改 SQLite、IPC wire format、provider prompt、消息序列化 grammar。
- 不修改 `../pi` 上游源码来增加私有扩展 API。
- 不把每条 Telegram 消息复制成 Pi session entry；Pi session 只保存一次 attach 锚点，真实历史仍以 SQLite 为权威。

## 需求

- **R1 — Pi package 与版本闭环：** `package.json` 声明 `pi.extensions` 与 `pi-package`；项目提供使用本地依赖版本的启动命令。宿主 Pi 低于 0.84.1 时必须明确提示版本不兼容，不得静默走手写降级路径。
- **R2 — 原生 transcript 接入：** extension 使用 `registerEntryRenderer` + `appendEntry` 挂载一个 TUI-only feed。聊天主视图不得使用 `ctx.ui.custom`、自定义 `render()`、`handleInput()`、行缓冲、scrollTop、终端 rows/columns 或 `truncateToWidth`。
- **R3 — 组件边界：** feed 只组合 Pi 导出的 `Container`、`Box`、`Text`、`Markdown`、`Image`、`Spacer` 等组件并使用 callback 提供的 `theme`；宿主 transcript 负责滚动、resize、选择、快捷键与 Kitty placement/cropping。
- **R4 — 薄数据层：** IPC 客户端只做 hello/filter、snapshot、复合游标分页、实时 append、去重、usage 聚合与媒体文件读取；不得含 ANSI 主题、消息卡片文本布局或终端逻辑。模块归属改为 `src/plugin/`，不再叫 `src/tui/`。
- **R5 — 生命周期：** `/tg attach [bot-id]` 建立唯一 live feed；`/tg more` 取一页更早历史；`/tg detach` 断开 live feed 但保留屏幕内容；session shutdown/reload 必须 dispose socket/timer。公共 extension API 不提供宿主 transcript 的 scroll-top 事件，因此分页使用显式命令，不回退到轮询宿主内部状态。
- **R6 — session 有界：** 一次 attach 最多追加一个自定义 Pi entry；snapshot、历史页和实时消息只存在于该 entry 的内存组件树，不逐条写入 Pi session，不进入 LLM context。
- **R7 — 命令与运维：** 保留 `/tg panel|status|start|stop|status-daemon`；daemon 未运行、IPC 断开、非法 bot id、旧 Pi 版本都给出可执行的恢复提示。
- **R8 — 删除 hack：** 删除 `TgAttachView`、`unitLines`、ANSI 样式常量、手写消息行渲染与 attach 的 polling viewport；extension + 数据层生产代码总行数必须低于当前 617 行基线。

## 验收标准

- **AC1:** `bun run pi` 使用项目声明的 Pi 版本，在项目目录自动加载 `/tg`；低于 0.84.1 的宿主由版本 guard 给出升级提示。
- **AC2:** `/tg attach` 后，Telegram feed 作为 Pi transcript 的自定义 entry 出现；Pi 的 fullscreen 滚动、鼠标滚轮、resize 和返回 editor 均继续工作，用户无需进入/退出另一个手写窗口。
- **AC3:** `rg` 在插件生产代码中找不到 `class TgAttachView|scrollTop|viewportRows|handleInput\(|truncateToWidth|\x1b\[`；聊天 entry renderer 返回 Pi 组件树。
- **AC4:** snapshot、live append、`/tg more`、`/tg detach`、单 bot 过滤与断线提示都有自动化测试；任意时刻最多一个 live feed/socket。
- **AC5:** Pi session 文件只增加 attach 锚点，不随 Telegram 消息数线性增长；custom entry 不进入 provider context，cache golden 逐字节不变。
- **AC6:** `wc -l .pi/extensions/tg-extension.ts src/plugin/timeline.ts` 小于 617；`bun test`、`bun run check`、`test/cache.test.ts` 通过。
- **AC7:** 真实 Pi TTY smoke 看到至少一条真实群消息；若有可读 PNG/JPEG/WebP/GIF，交由 Pi `Image` 内联，非图片能力终端显示 Pi 自带 fallback。

## 约束

- Cache impact: **NONE**。UI custom entry 必须是 TUI-only，不参与 LLM context；任何 provider-visible 差异均为边界 bug。
- IPC 兼容：wire format 不变；分页继续用现有复合游标。
- 性能：初始 snapshot 和每次 `/tg more` 各最多 100 条；媒体文件仍有 1 MiB 上限。
- 安全：只读取 daemon 已经通过 IPC 提供的本地 media path；不新增远程输入执行面。
- 运维：规范入口是 `bun run pi`，保证使用项目声明的依赖版本。

## 例子与边界 case

- 已 attach A 时再次 `/tg attach B`：先 dispose A，再挂载 B，始终只有一个 live socket。
- `/tg more` 到最早记录：状态显示“已到最早记录”，不再发请求。
- session reload：历史 attach entry 以 detached 摘要呈现，不自动建立多个 socket；用户显式 `/tg attach` 才连接。
- daemon 中途退出：feed 保留已有内容并显示断线状态；重启后重新 `/tg attach`。

## 可观察性

- Pi footer status 显示 Telegram attached/detached/disconnected 与过滤 bot。
- widget 显示 usage；连接失败保留可执行恢复命令。

## 文档影响

- `docs/research.md`、`docs/architecture.md`、`docs/testing.md`、`docs/runbooks/daemon.md`、`docs/handoff.md`、`docs/devlog.md`。

## 待决问题

无。0.84.1 public API 不暴露宿主 transcript scroll-top，显式 `/tg more` 已作为兼容公共 API 的分页交互。

## 追溯

- Plans: `../plans/completed/PLAN-20260808-native-pi-telegram-ui.md`
- Commits: 从 `Requirement:` git trailer 查

## 完成证据

- `bun test`：149 pass / 0 fail；`bun run check` 通过；cache golden 6/6。
- 真实 Pi fullscreen TTY：`/tg attach A`、`/tg more`、`/tg detach` 均通过，真实群消息与原生组件可见。
- 静态边界检查无 `TgAttachView` / scroll state / `handleInput()` / ANSI；生产代码 611 行，低于 617 行基线。
