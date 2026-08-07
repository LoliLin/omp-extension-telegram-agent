# REQ-UI-0001: 基于 pi-tui 插件化重做 Telegram 历史界面

- **Status:** Draft
- **Priority:** P2
- **Source:** 用户 REQ-LIST 第 1 条

## 问题

当前 TUI（`src/tui/index.ts`）虽然依赖 `@earendil-works/pi-tui` 的组件（TuiAltScreen / ScrollView / Text），但实际是自绘的独立界面：媒体只显示占位符，无法展示图像；与 pi-tui 主程序的能力演进脱节。用户判断：写成 pi 的插件 / 扩展来复用 tui 更好，且 pi-tui 原生支持 kitty 图像协议，能直接展示图片。

## 目标

Telegram 群历史界面以 pi-tui 的插件 / extension 形态实现，复用其渲染与组件能力；在支持 kitty graphics protocol 的终端中直接显示群里的图片与 sticker。

## 非目标

- 不改 daemon、ingestion、agent 行为（纯 UI 层重构）。
- 不在 TUI 里做交互式发言（观察者定位不变，除非用户另行提出）。
- 兼容非 kitty 终端的降级显示即可，不为旧终端做像素级适配。

## 需求

- **R1:** 前期研究：确认 pi-tui / pi-coding-agent 的插件机制、kitty 图像渲染 API、以及插件形态下与本项目 daemon IPC 对接的方式；结论落成研究笔记（参照 docs/research.md 的先例）。
- **R2:** 群历史视图（消息、reply、quote、edit 标记、`Bot X · LOCAL` 内部行为）在插件形态下复刻，功能不低于现状。
- **R3:** 图片 / sticker 内联显示：kitty 终端渲染真实图像；非 kitty 终端降级为现有占位符 + vision 描述。
- **R4:** attach / detach / 历史分页 / 实时事件行为与现状一致或更好（不回归）。
- **R5:** 媒体文件经 IPC 传输的路径 / 权限设计：daemon 提供本地文件路径或字节流，TUI 进程可读，不扩大本机暴露面（与 REQ-IPC-0001 R4 的 chmod 600 协同）。

## 验收标准

- **AC1:** kitty 终端中 attach 后，群内图片与 sticker 内联可见；非 kitty 终端正常降级。
- **AC2:** 历史分页、实时流、LOCAL 事件标记、退出后 daemon 存活——与现有 TUI 行为逐项对齐。
- **AC3:** cache golden 不变（provider payload 零变化，验证 cache invariant 5）。
- **AC4:** `bun test` + `bun run check` 全绿。

## 约束

- Cache impact: **NONE**（UI-only；若发现必须改 provider payload 才能实现，说明边界设计错了，停下来上报）。
- 依赖：pi-tui 插件机制的实际能力是本 REQ 的可行性前提，R1 研究不成立则回到自绘方案并把 kitty 支持以最小侵入方式加入现有 TUI。
- 成本：图像数据不得进入 provider context（显示层与模型层严格分离）。

## 例子与边界 case

- 大图 / 动图（tgs/webm）：降级策略明确，不阻塞渲染。
- 终端 window resize：图像重排不花屏。
- daemon 重启后 TUI 重连，图像仍可加载（媒体本地缓存路径稳定）。

## 可观察性

- 不适用（UI 层）；渲染失败降级时 log 一行。

## 文档影响

- `docs/architecture.md`（TUI 小节重写）、`docs/research.md` 或新研究笔记。

## 待决问题

- pi-tui 插件 API 形态（R1 的输出）。**R1 完成前不动工 R2–R5。**

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
