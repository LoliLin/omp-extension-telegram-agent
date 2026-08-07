# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前 phase

Phase 9 收尾 — REQ-LIST 已全部完成（8 篇在本轮补齐，见 docs/devlog.md (17)）。剩余：真实群长运行观察。

## 已完成

- Phase 1–9 全部完成：骨架、Telegram persistence、Basic Agent、TUI、双 bot routing、search/run_js、media、compaction、REQ 修复与功能全清单（REQ-LIST.md 全勾选）
- 本轮（REQ-IPC/OPS/TEST/CONF/STICKER/UI-0001/2/3）：IPC 加固（streaming decoder/背压/复合游标/600/注入防护）、配置校验与 pid 锁、测试体系（离线 + golden 全锁 + e2e 可信）、bots.config.json 多 bot 配置、固定 sticker 目录（cache schema v2）、attach 过滤 + 可观测面板 + kitty 图像

## 正在做

- 真实群长运行观察（sticker 目录 + 后台 vision 预热完成后重启验证目录语义补全、面板实时更新、双 bot 行为无回归）；daemon 此刻应处于停止状态，`bun run src/main.ts start` 启动

## 下一步（按序）

1. 等后台 vision 预识别跑完（日志 `[sticker-catalog]`，两个 set 共 212 个 sticker），重启 daemon 验证目录块语义补全（system hash 变化）
2. 长运行 smoke：daemon 跑数小时，观察 daemon.log / 遥测 / 内存 / 面板实时更新
3. 遥测对比（REQ-STICKER-0001 AC3）：`bun run scripts/analyze-context-window.ts`，观察 sticker 相关 prefix 命中

## 当前架构决定

Bun 单进程 daemon 任意数量 AgentSession（bots.config.json 驱动）；raw Bot API 长轮询；bun:sqlite；TUI 独立进程 + Unix socket IPC（chmod 600）；自定义 compaction（threshold 128K、keepRecent 20K）；send/search/run_js 固定顺序 + 每 bot tools 开关；固定 sticker 目录（CACHE_SCHEMA_VERSION=2，system prompt 稳定块）+ 动态候选（消息之后）；lazy vision（catalog 后台预识别）；deterministic routing（mention>reply>名字>累积概率）

## 重要文件

- src/config.ts（bots.config.json + .env 双源，全部错误收集校验）；bots.config.example.json
- src/agent/runtime.ts（BotRuntime：session、tools、compaction ext、exposure、epoch、usageSink）
- src/media/sticker-catalog.ts（固定目录：fetch/persist/short_id/后台 vision/序列化）
- src/agent/{serialize,prompt,tools,router}.ts（cache grammar v1 + v2 目录块，golden 锁定）
- src/daemon/{index,ipc-server,pid}.ts（schema 版本 epoch bump、per-listener filter、stats lastId、排他 pid 锁）
- src/tui/index.ts（attach filter、Image 渲染、底部面板）
- scripts/analyze-context-window.ts（真实 compaction 同步）

## 最后测试状态

bun test 134/134 ✅ + bun run check ✅；真实冒烟（start/status/stop/attach A/非法 id/面板数值）✅。见 docs/testing.md。

## 已知问题

- 后台 vision 预识别未完成前，目录 sticker 在上下文中显示 [未识别]，重启后补全（设计如此）
- panel 数值跨 daemon 重启为全历史口径（累计含旧 epoch），见 docs/cache.md
- bun test 强制 UTC：涉时间序列化的测试必须 pin TZ（cache.test.ts 已处理）
