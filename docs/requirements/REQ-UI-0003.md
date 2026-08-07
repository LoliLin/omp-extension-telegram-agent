# REQ-UI-0003: TUI 底部可观测性面板

- **Status:** Draft
- **Priority:** P2
- **Source:** 用户 REQ-LIST 第 5 条
- **依赖:** 无硬依赖；若 REQ-UI-0001 完成则在其插件形态上实现（pi 原生支持很多遥测展示）

## 问题

api 开销、context tokens、累计 token、cache hit 率等数据目前只能在 `llm_runs` 表和日志里查，日常观察一个「住在群里的 bot 健不健康、烧不烧钱」没有直接窗口。

## 目标

TUI 最下端固定一个状态面板，实时展示关键可观测性数据，attach 期间随事件更新。

## 非目标

- 不做历史趋势图 / 图表（面板是当前值与累计值，趋势分析仍靠 `analyze-context-window.ts`）。
- 不改遥测采集本身（`llm_runs` schema 不变）。

## 需求

- **R1:** 面板内容（每 bot 一栏或全局汇总，视 attach 模式）：最近一次 run 的 context tokens / cache read / cache miss / 成本（可算时）；会话累计 input/output tokens 与累计成本；hit ratio（累计 read/(read+miss)）；当前 context epoch。
- **R2:** 数据通道：daemon 在 llm_run 落库时经 IPC 推送增量；snapshot 时附带累计值；TUI 不直连 DB。
- **R3:** attach 到单 bot（REQ-UI-0002）时面板只显示该 bot；全局视角显示双 bot 并列或合计。
- **R4:** 面板渲染不得影响主滚动区行为（follow=end、分页、LOCAL 标记不回归）。

## 验收标准

- **AC1:** 面板数值与 `llm_runs` 表实时一致（抽一次 run 比对 context tokens / cache read / miss）。
- **AC2:** 新 run 发生后 1s 内面板更新，无需重进。
- **AC3:** 累计值跨 attach/detach 正确（daemon 侧累计，TUI 不负责加总）。
- **AC4:** cache golden 不变；`bun test` + `bun run check` 全绿。

## 约束

- Cache impact: **NONE**（纯展示层）。
- 成本：面板是「降低成本」的工具——hit ratio 与成本必须是最显眼的一等指标（与开发指南第三节的全局要求一致）。

## 例子与边界 case

- daemon 重启后累计值口径明确（本次进程累计 vs 全历史累计——建议显示两者或全历史，开工时定）。
- 无 run 数据时（刚启动）面板显示占位而非报错。

## 可观察性

- 本 REQ 本身即是可观察性增强。

## 文档影响

- `docs/architecture.md`（TUI / IPC 小节）、`docs/testing.md`。

## 待决问题

- 累计口径：进程级 vs 全历史（查 llm_runs 聚合）。倾向全历史 + 本次会话两行，开工时确认。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
