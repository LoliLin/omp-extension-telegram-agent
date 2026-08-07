# REQ-UI-0002: attach 到任意已配置的 bot

- **Status:** Draft
- **Priority:** P2
- **Source:** 用户 REQ-LIST 第 4 条
- **依赖:** REQ-CONF-0001（多 bot 配置）；若 REQ-UI-0001 先完成则在其插件形态上实现

## 问题

当前 `attach` 是全局视角：merged timeline = 群消息 + 两个 bot 的全部 agent_events 混在一起。bot 变多（REQ-CONF-0001）后噪音线性增长，且无法专注观察单个 bot 的上下文 / 思考 / 工具调用。

## 目标

`attach` 支持指定 bot：`attach <bot-id>` 以该 bot 视角观察（群消息 + 仅该 bot 的内部行为）；不指定时保持现有全局视角。

## 非目标

- 不做多窗格同屏对比多个 bot（后续可增强）。
- 不改 agent_events 的产生逻辑，只改过滤与展示。

## 需求

- **R1:** CLI 与 IPC 协议支持按 bot 过滤：`attach [bot-id]`，hello 请求携带过滤器，daemon 端过滤 snapshot / history / broadcast 中的 agent_events（群消息始终全量）。
- **R2:** bot-id 非法时列出当前配置的 bot 清单并报错。
- **R3:** 每 bot 视角下的派生信息（该 bot 的 epoch、exposure 水位、最近一次 run 遥测）在 TUI 中可见（与 REQ-UI-0003 的面板协同，不重复实现）。
- **R4:** 协议变化向后兼容：不带过滤器的旧客户端请求行为不变。

## 验收标准

- **AC1:** 双 bot 运行中 `attach A`：只看到 bot A 的 LOCAL 事件；`attach` 看到全部；`attach nobody` 报错并列出有效 id。
- **AC2:** 过滤在 daemon 端生效（broadcast 流量随之下降，可从 IPC 帧计数验证）。
- **AC3:** 旧版本 TUI 客户端连接新 daemon 行为不变（若选择在同一 commit 改两侧，则改为：协议兼容矩阵测试通过）。
- **AC4:** `bun test` + `bun run check` 全绿；cache golden 不变。

## 约束

- Cache impact: **NONE**（UI/IPC only）。
- 兼容：R4 的协议演进遵循「同 commit 改两侧或双向兼容」原则（与 REQ-IPC-0001 一致）。

## 例子与边界 case

- 三 bot 配置下 attach 任意一个，另两个的事件不出现。
- attach 期间新 bot 上线（重启后）重新 attach 可见。

## 可观察性

- 本 REQ 本身即是可观察性增强。

## 文档影响

- `docs/architecture.md`（IPC 协议小节）、`docs/runbooks/`（观察 bot 的操作说明）。

## 待决问题

无（依赖项的决策在 REQ-CONF-0001 / REQ-UI-0001）。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
