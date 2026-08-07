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
- [ ] [REQ-UI-0001](REQ-UI-0001.md) 基于 pi-tui 插件化重做 Telegram 历史界面（P2）
  （重新打开 2026-08-07：第一版只做了自绘 TUI + kitty 图像，未按 REQ 意图做成 pi 插件形态；以 REQ-UI-0004 的实现为准）
- [ ] [REQ-UI-0004](REQ-UI-0004.md) Telegram 前端 pi 插件化——复用 pi 成果，废弃全部自绘前端（P1，用户 2026-08-07 明确要求）
- [ ] [REQ-UI-0002](REQ-UI-0002.md) attach 到任意已配置的 bot（P2）
  （重新打开 2026-08-07：服务端过滤与协议已落地并有测试（commit 014ec4c），但前端形态随 REQ-UI-0004 迁移为 pi 插件，插件内行为待真实 pi 会话验证）
- [ ] [REQ-UI-0003](REQ-UI-0003.md) TUI 底部可观测性面板（P2）
  （重新打开 2026-08-07：stats 数据通道已落地并有测试（commit 014ec4c），但面板前端随 REQ-UI-0004 迁移为 pi 插件 widget，待真实 pi 会话验证）

## 顺序与依赖

实施顺序：SEC → AGENT → TG / IPC / OPS → TEST → CONF → STICKER → UI。

- REQ-UI-0002 依赖 REQ-CONF-0001
- REQ-UI-0001 的 R2–R5 依赖其 R1（pi-tui 插件机制研究）
- REQ-STICKER-0001 的 R3 与 REQ-AGENT-0001 的 R7（send 先校验后发）协同
