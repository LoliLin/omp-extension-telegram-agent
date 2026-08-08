# REQ-UI-0001: 用 Pi 原生组件呈现 Telegram 消息与媒体

- **Status:** Done (2026-08-08)
- **Priority:** P1
- **Source:** 用户要求“完全用 Pi 的组件来渲染 Telegram 聊天，同时美观、减少代码”
- **依赖:** REQ-UI-0004

## 问题

当前 engine 拼接 ANSI 字符串，extension 再切成行；这绕过 Pi theme 与消息组件，还导致图片在手写 viewport 中被降级。

## 目标

群消息、bot 消息、LOCAL 事件、日期分隔与媒体全部由 Pi 组件树表达，并随 Pi theme 与 fullscreen transcript 自适应。

## 非目标

- 不解析 Telegram entities 为富文本。
- 不支持 tgs/webm 动画播放；保留文本/vision 描述降级。
- 不改变模型看到的 Telegram 序列化内容。

## 需求

- **R1:** 人类消息、bot 消息和 LOCAL 事件使用可区分但统一的 Pi theme 色彩；不得硬编码 ANSI 颜色。
- **R2:** sender、username、message id、时间、reply、edited、正文、media kind/emoji/vision 描述完整呈现；不可信文本先走现有 `sanitize()`。
- **R3:** 可读且不超过 1 MiB 的 PNG/JPEG/WebP/GIF 使用 Pi `Image`；其他媒体或无图像能力时使用 Pi 自带 fallback，并继续显示媒体语义描述。
- **R4:** 文本换行、宽度裁切、背景填充和图片高度均由 Pi 的 `Text`/`Markdown`/`Box`/`Image` 处理，项目不得自行输出宽度受限行。
- **R5:** 日期分隔与 prepend 历史页保持时间顺序，snapshot/live 去重。

## 验收标准

- **AC1:** 组件级测试证明 text message、reply+edited、LOCAL tool event、date separator 分别返回 Pi 组件且可在窄宽度 render，不超宽、不抛错。
- **AC2:** 图片 fixture 产生 Pi `Image` 组件；不支持格式、缺文件、超 1 MiB 均稳定降级。
- **AC3:** Telegram/agent 文本中的 ANSI/OSC 控制序列不能改变 Pi UI。
- **AC4:** 真实 Pi fullscreen smoke 中消息卡片随 theme 显示；Kitty-capable 终端由 Pi 管理图片 placement/cropping。
- **AC5:** cache golden 不变；`bun test` + `bun run check` 通过。

## 约束

- Cache impact: **NONE**。
- 媒体不进入 provider context；组件只消费 IPC 已有 `mediaPath` / `mediaDesc`。
- 初次读媒体保持 1 MiB 上限，失败不得阻塞 transcript。

## 例子与边界 case

- 多行长文本：Pi `Text` 负责 wrap。
- sticker webm/tgs：显示 `[sticker 😀] · <vision 描述>`，不伪装为已内联。
- 非 Kitty 终端：Pi `Image` 自己生成尺寸/文件名 fallback。

## 可观察性

组件构建失败只降级为错误卡片，不使 Pi renderer 崩溃。

## 文档影响

`docs/architecture.md`、`docs/testing.md`。

## 待决问题

无。

## 追溯

- Plans: `../plans/completed/PLAN-20260808-native-pi-telegram-ui.md`
- Commits: 从 `Requirement:` git trailer 查

## 完成证据

- component 测试覆盖 text、LOCAL、窄宽度、控制序列与原生 `Image`；真实 Pi fullscreen smoke 通过。
- `bun test` 149/149、`bun run check`、cache golden 均通过。
