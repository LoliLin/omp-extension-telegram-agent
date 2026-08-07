# 需求清单

新需求按 `REQ-TEMPLATE.md` 建文件，ID = `REQ-<领域>-<NNNN>`。状态与进展以各文件头部的 Status 字段为准。

| ID | 标题 | Priority | Status | 来源 |
|---|---|---|---|---|
| REQ-SEC-0001 | run_js 沙箱威胁模型与隔离加固 | P0 | Approved | code review（逃逸已实证） |
| REQ-AGENT-0001 | agent 触发/flush 生命周期收敛为串行状态机 | P0 | Approved | code review（生产已丢消息） |
| REQ-TG-0001 | Telegram ingestion 与 poller 可靠性 | P1 | Approved | code review |
| REQ-IPC-0001 | IPC 与 TUI 健壮性 | P1 | Approved | code review |
| REQ-OPS-0001 | 配置校验、进程管理与仓库卫生 | P1 | Approved | code review |
| REQ-TEST-0001 | 测试体系修复 | P2 | Approved | code review |
| REQ-CONF-0001 | 配置体系重构——多 bot 与每 bot 全参数可配 | P1 | Draft | 用户 REQ-LIST #2 |
| REQ-STICKER-0001 | 固定 sticker set 支持 | P2 | Draft | 用户 REQ-LIST #3 |
| REQ-UI-0001 | 基于 pi-tui 插件化重做 Telegram 历史界面 | P2 | Draft | 用户 REQ-LIST #1 |
| REQ-UI-0002 | attach 到任意已配置的 bot | P2 | Draft | 用户 REQ-LIST #4 |
| REQ-UI-0003 | TUI 底部可观测性面板 | P2 | Draft | 用户 REQ-LIST #5 |

## 建议实施顺序

1. **REQ-SEC-0001 → REQ-AGENT-0001**（P0：安全 + 正在发生的数据损坏）
2. **REQ-TG-0001 / REQ-IPC-0001 / REQ-OPS-0001**（P1 修复，可并行）
3. **REQ-TEST-0001**（给后续功能开发铺路：golden 补全 + e2e 可信）
4. **REQ-CONF-0001**（功能类地基，UI-0002 依赖它）
5. **REQ-STICKER-0001 / REQ-UI-0001 / REQ-UI-0002 / REQ-UI-0003**（功能增强）

## 依赖关系

- REQ-UI-0002 ← REQ-CONF-0001
- REQ-UI-0001 的 R2–R5 ← 其自身的 R1（pi-tui 插件机制研究）
- REQ-STICKER-0001 的 R3 与 REQ-AGENT-0001 的 R7（send 先校验后发）有协同

## 全局约束（所有 REQ 适用）

开发任何功能都必须评估对 **provider cache hit 率**与**整体 token 成本**的影响，细则见 `../engineering/development-guide.md` 第三节。每篇 REQ 的「约束」节必须填写 Cache impact。
