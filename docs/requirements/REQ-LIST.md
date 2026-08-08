# REQ-LIST

> 总清单。agent 完成一项：把 `[ ]` 改 `[x]` 并在条目末尾注明 commit。验收标准等细节在链接的 REQ 文档里。
> 全局约束：开发任何功能都要评估 cache hit 率与 token 成本影响（`../engineering/development-guide.md` 第三节）；每篇 REQ 的「约束」节必须有 Cache impact。

## 修复（2026-08-07 code review）

- [x] [REQ-SEC-0001](REQ-SEC-0001.md) run_js 沙箱威胁模型与隔离加固（P0）（commit 3c6c348）
- [x] [REQ-AGENT-0001](REQ-AGENT-0001.md) agent 触发/flush 生命周期串行状态机（P0）（commit a549335）
- [x] [REQ-TG-0001](REQ-TG-0001.md) Telegram ingestion 与 poller 可靠性（P1）（commit a806e8d）
- [x] [REQ-IPC-0001](REQ-IPC-0001.md) IPC 与 TUI 健壮性（P1）（commit d0d5d56）
- [x] [REQ-OPS-0001](REQ-OPS-0001.md) 配置校验、进程管理与仓库卫生（P1）（commit ca55ec0）
- [x] [REQ-TEST-0001](REQ-TEST-0001.md) 测试体系修复（P2）（commit c8fcd67）

## 功能

- [x] [REQ-CONF-0001](REQ-CONF-0001.md) 配置体系：任意数量 bot、persona 外置（P1）（commit 3027e95）
  （附注：AC2–AC6 已验证；AC1「第三 bot 真实上线」待真实群验证）
- [x] [REQ-STICKER-0001](REQ-STICKER-0001.md) 固定 sticker set 支持（P2）（commit 84da315）
  （附注：AC1/AC4/AC5 已验证；AC2/AC2b「真实群发送 set 内/外 sticker」、AC3「遥测对比」待长运行验证）
- [x] [REQ-UI-0004](REQ-UI-0004.md) Telegram 前端成为真正的 Pi 原生 transcript 插件（P0）（commit 19819c9）
- [x] [REQ-UI-0001](REQ-UI-0001.md) 用 Pi 原生组件呈现 Telegram 消息与媒体（P1，依赖 UI-0004）（commit 19819c9）
- [x] [REQ-UI-0002](REQ-UI-0002.md) 原生 transcript 中 attach / more / detach 与任意 bot 过滤（P1，依赖 UI-0004）（commit 19819c9）
- [ ] [REQ-UI-0003](REQ-UI-0003.md) 用 Pi 原生 FooterComponent 呈现实时可观测性（P1，已重新调查；`19819c9` widget 不满足）
- [ ] [REQ-UI-0009](REQ-UI-0009.md) Footer 使用数据库全生命周期 telemetry 并补齐原生指标（P1，已调查/未实现）
- [ ] [REQ-UI-0005](REQ-UI-0005.md) 用 Pi 底部 editor 直接发送 Telegram 消息（P1，已调查/未实现）
- [ ] [REQ-UI-0006](REQ-UI-0006.md) 媒体识别完成后在原生 UI 下方显示视觉理解（P1，UI-only，已调查/未实现）
- [ ] [REQ-ROUTE-0001](REQ-ROUTE-0001.md) 忙碌 bot 跳过概率采样；配置名称是绕过 gate 的强制回复关键词（P1，已实现/待总验收勾选）
- [ ] [REQ-UI-0007](REQ-UI-0007.md) 用 Pi 原生 footer status 呈现 Telegram 统计（P2，已调查/未实现）
- [ ] [REQ-UI-0008](REQ-UI-0008.md) 为 `/tg` 提供原生分级命令补全（P2，已调查/未实现）
- [ ] [REQ-CMD-0001](REQ-CMD-0001.md) Telegram 群内 help/status、手动 compact、参数调整与可配置管理员白名单（P1，已调查/未实现）
- [ ] [REQ-TG-0002](REQ-TG-0002.md) Bot 获得响应机会后持续续约 Telegram 原生输入状态（P1，已核对官方 API/未实现）


## Bug

- [ ] [REQ-STICKER-0002](REQ-STICKER-0002.md) 固定目录与动态候选必须按 bot 可发送性隔离（P0，已复现定位/未修复）
- [ ] [REQ-SEND-0001](REQ-SEND-0001.md) 统一 message/sticker/reply_to、tool-local 用法与 terminating 最小结果（P1，已实现/待真实群总验收）
- [ ] [REQ-UI-0010](REQ-UI-0010.md) 恢复 Pi 原生 feed 的即时刷新与流式 Agent 输出（P1，已定位根因/未实现）


## 代码库与文档

- [ ] [REQ-PLAT-0001](REQ-PLAT-0001.md) 收口为通用、快速、简洁的可配置 bot 平台（P1，已完成代码库调查/未实现）
- [ ] [REQ-DOC-0001](REQ-DOC-0001.md) README 从用户视角解释平台、配置、使用与边界（P1，已调查/未实现）

## 顺序与依赖

已完成主线：SEC → AGENT → TG / IPC / OPS → TEST → CONF → STICKER-0001 → UI-0004 → UI-0001 / UI-0002 / UI-0003。

建议后续顺序：STICKER-0002（生产 bug）→ ROUTE-0001 → UI-0005 / UI-0006 / UI-0007 / UI-0008 → PLAT-0001。

- REQ-UI-0002 依赖 REQ-CONF-0001
- REQ-UI-0001 / 0002 / 0003 依赖 REQ-UI-0004 的 Pi package、版本与原生 transcript 接入
- REQ-UI-0005 依赖 REQ-UI-0004 的 input/lifecycle 边界与 REQ-CONF-0001 的任意 bot identity
- REQ-UI-0006 依赖 REQ-UI-0001 的 native media card；只消费现有 lazy vision 结果
- REQ-ROUTE-0001 依赖 REQ-AGENT-0001 的串行 flush 状态，但只 gate probability path；explicit trigger 仍可 pending coalesce
- REQ-SEND-0001 继承 ROUTE-0001 的 explicit 决策，并把公开回复、单一组合工具、persona 去重与终止成本固化在 tool schema
- REQ-UI-0007 是 REQ-UI-0003 的交互后继：stats 数据层保留，presentation 从自定义 widget 改用 Pi default footer `setStatus`
- REQ-UI-0008 使用 Pi `registerCommand.getArgumentCompletions`；命令树需吸收 UI-0005/0007 新增/调整的子命令
- REQ-UI-0009 固化 UI-0003/0007 的 lifetime 范围，并补齐 Pi 原生 cache-write 与 `/tg status` 详情；不得退回第三行或自绘 footer
- REQ-UI-0010 复用 Pi AgentSession `message_update` 与宿主 `TUI.requestRender()`；流式帧只存在于 IPC/TUI 内存，不写 DB/Pi session/provider context
- REQ-TG-0002 在 runtime 接受 response opportunity 时 acquire `typing` lease，每 4 秒续约；send 成功或 flush settle 后停止，不影响 provider/routing
- REQ-CMD-0001 是 Telegram 群内 deterministic control plane；只读命令公开，compact/set/reset 只认 deployment allowlist，命令不得进入 agent context
- REQ-STICKER-0002 是 REQ-STICKER-0001 的 per-bot sendability 回归修复，并会触发 cache schema bump
- REQ-PLAT-0001 复用 REQ-CONF-0001 已完成的 N-bot 核心，不重复重写 daemon composition
- REQ-DOC-0001 等待 PLAT-0001 的 provider/config schema 稳定后再写最终 README，避免文档抢跑
- REQ-STICKER-0001 的 R3 与 REQ-AGENT-0001 的 R7（send 先校验后发）协同
