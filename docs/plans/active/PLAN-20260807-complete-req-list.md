# PLAN-20260807-complete-req-list: 完成 REQ-LIST 剩余 8 篇

- **Status:** Active
- **Requirements:** REQ-IPC-0001, REQ-OPS-0001, REQ-TEST-0001, REQ-CONF-0001, REQ-STICKER-0001, REQ-UI-0001, REQ-UI-0002, REQ-UI-0003

## 结果

REQ-LIST 全部打勾；IPC 字节正确/背压有界/分页不丢/本机攻击面收敛；配置启动期响亮报错 + 进程管理不误杀；测试体系离线可信 + golden 全锁 + e2e 结果可信；多 bot 配置化（bots.config.json，persona 外置）；固定 sticker set 进稳定 prefix；TUI 支持 kitty 图像 + attach 指定 bot + 底部可观测性面板。

## 现状摸底

- 修复类（IPC/OPS/TEST）独立于功能类（CONF/STICKER/UI）；CONF 是 STICKER/UI-0002 的前置；UI-0001 R1 研究结论：pi-tui `Image` 组件原生支持 kitty 协议（`getCapabilities()` 探测 + 自动降级占位符），可继续用独立 TUI 进程 + 直接复用 pi-tui 组件（扩展插件形态需要运行在 pi 主程序内，不适合后台 daemon 的常驻观察者）。
- IPC 分页：merged timeline 需统一排序键 (ts, rank, id)，rank 0=evt/1=msg；旧客户端只发 beforeTs 时保持严格 `<` 语义（兼容）。
- OPS R2 校验框架与 CONF R6 合并：先做 env 版，CONF 迁移 JSON 时复用"收集全部错误"框架。
- cache golden：CACHE_SCHEMA_VERSION=1；CONF 必须证明迁移后 provider 字节不变（AC2）；STICKER 必须 bump 到 2（固定目录进 system prompt）。
- router 的 `is_bot` 前置判断在 daemon 调用点（TEST R3 下沉到 routeMessage）。
- BotConfig.usernameEnv 疑似未使用，CONF 时确认删除。
- e2e-compaction.ts 固定 45s sleep ×2 且无断言；e2e-agent.ts 永不 exit≠0。

## 方案

按 REQ-LIST 顺序逐篇实现，每篇一个内聚 commit（trailer: Requirement）。

1. **REQ-IPC-0001**：ipc.ts FrameDecoder streaming TextDecoder + 4MB 接收上限；EvtItem 增加 evtId（agent_events.id），TimelineItem 增加 cursor 字段；ipc-server write<0/队列 1MB 上限踢连接；history 复合游标 (ts, rank, id)；chmod 600 + limit clamp [1,500]；TUI strip 控制字符 + messageId/evtId 去重 + prepend 日期分隔。
2. **REQ-OPS-0001**：config.ts 校验收集框架；.env.example 冒号格式；.gitignore data/；daemon 最早时机 wx 排他 pid 锁；stop/status 校验 cmdline；git-gpg.sh passphrase-fd；start 等待 ready。
3. **REQ-TEST-0001**：runjs 网络测试 env gate；tools.ts 提取工具定义 + golden 锁 tools hash 与 compaction summary prompt；routeMessage 内部 is_bot 判断；e2e 脚本断言 exit code + 轮询替代 sleep；analyze 脚本用 epoch/compaction 列重置模拟 context；盲区补测。
4. **REQ-CONF-0001**：bots.config.json schema + 校验 + runtime/daemon/router 数组化 + 泛型 routing（累计阈值）+ example 迁移 + 文档。
5. **REQ-STICKER-0001**：每 bot sticker_set 配置 → 启动解析下载 + vision 预识别（复用 ensureVision）+ 稳定前缀目录块（bump CACHE_SCHEMA_VERSION=2）+ send 双来源 + 规模上限 120。
6. **REQ-UI-0001/2/3**：TUI 加 Image 组件渲染媒体（kitty 自动降级）；attach [bot-id]（hello filter + daemon 端过滤）；底部面板（usage 增量推送 + snapshot 累计值）。

## 任务

- [ ] **T1** — REQ-IPC-0001 全部 + 回归测试; validates: AC1–AC6
- [ ] **T2** — REQ-OPS-0001 全部 + 回归测试; validates: AC1–AC6
- [ ] **T3** — REQ-TEST-0001 全部; validates: AC1–AC6
- [ ] **T4** — REQ-CONF-0001 全部 + 迁移; validates: AC1–AC6
- [ ] **T5** — REQ-STICKER-0001 全部; validates: AC1–AC5
- [ ] **T6** — REQ-UI-0001/2/3 全部; validates: 各 AC

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| 目标 | `bun test test/<相关文件>` | T1–T6 |
| 全量 unit | `bun test` + `bun run check` | 全部 |
| e2e | `bun run scripts/e2e-compaction.ts` 等 | 边界行为 |
| 真实群 / 长跑 | 真实群观察（需要时） | 稳定性 |

## 风险与失败模式

- 风险: IPC 协议游标改动破坏旧客户端 → 兼容矩阵测试（legacy beforeTs 路径保留）。
- 风险: CONF 迁移导致 golden 漂移 → 迁移后立即跑 cache.test.ts 验证逐字节不变。
- 风险: STICKER 下载依赖真实 Telegram set 名 → 测试用 mock set 数据 + 真实群验证留给用户。
- 风险: UI-0003 面板数值口径 → 全历史 + 进程内增量，daemon 侧聚合。
