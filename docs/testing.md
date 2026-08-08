# 测试策略与状态

> 当前真实测试状态，不是计划书。本文件是测试与验证的唯一权威来源。

## 验证漏斗（由便宜到贵，按序跑到能覆盖改动的那层）

1. **目标**：`bun test test/<相关文件>` —— 直接覆盖被改行为的最小测试
2. **全量 unit**：`bun test`（unit + replay，不触网络）+ `bun run check`（tsc --noEmit）
3. **e2e**：`bun run scripts/e2e-agent.ts` / `e2e-compaction.ts`（需 `.env`，触真实 DeepSeek / Telegram）
4. **真实群 / 长运行 smoke**：跨边界或稳定性改动才需要；观察 daemon.log、遥测、内存

## 测试选择规则

- 能确定性复现的 bug fix 必须有回归测试。
- 契约变化（IPC 协议 / schema / 序列化 grammar）需要跨边界测试。
- Agent 行为测可观察轨迹与结果，不断言 prompt 字符串。
- provider cache 相关改动必须跑 `test/cache.test.ts` golden；golden 失败是报警，先查原因，不要随手更新。
- 涉时间序列化的测试必须 pin TZ（bun test 强制 UTC，参考 test/cache.test.ts）。
- 不得为了通过而删除或削弱断言。

## 失败诊断

改源码前先定位失败来源：1) 被改的行为 2) 过期的生成物 / golden 3) 缺 bootstrap / build 产物 4) 环境或工具链不一致（TZ、bun 版本）5) flaky / 外部依赖（Telegram、DeepSeek、TinyFish、codex）6) 与本次改动无关的既有失败。外部 / 既有失败单独报告，不混入本次结论。

## 测试分层

unit / integration / replay / real Telegram / restart / provider-cache / long-running smoke

## 运行命令

```bash
bun test                # unit + replay（不涉及网络）
bun run check           # tsc --noEmit
bun run scripts/e2e-agent.ts        # 真实链路 e2e（需 .env）
bun run scripts/e2e-compaction.ts   # compaction e2e（需 .env）
bun run scripts/e2e-compaction-manual.ts  # 手动 compact() 验证 compaction_end 成功/失败路径（需 .env；1M window 下 threshold e2e 已无法廉价触发自动 compaction）
```

## 当前状态

| 场景 | 状态 | 最后结果 |
|---|---|---|
| GPG 签名提交 | ✅ | 2026-08-07 验证 good signature |
| Bun × Pi SDK 兼容性 smoke | ✅ | 2026-08-07 smoke-pi.ts 真实调用成功 |
| Telegram ingestion/dedupe/restart | ✅ | 2026-08-07 bun test 12/12 + 真实群 e2e + restart 全通过 |
| send terminating | ✅ | 2026-08-07 e2e：成功 send 后无额外 provider 请求 |
| local assistant 不进群 | ✅ | e2e：assistant_text/thinking 只进 agent_events |
| Pi 原生 Telegram attach/detach | ✅ | 2026-08-08 项目 Pi 真实 fullscreen TTY：`/tg attach A` 显示 #19061–#19063，`/tg more` prepend 到 #18961，`/tg detach` 断开后内容保留；退出 Pi 不影响 daemon |
| deterministic routing property tests | ✅ | 2026-08-07 33/33 + 真实群双 bot 实况 |
| probability busy/cooldown scheduler（REQ-ROUTE-0001） | ✅ | 2026-08-08 fake monotonic clock + 100-message burst：A/B 独立并发、busy/cooldown fast-skip、不改投、不设 pending、不补抽、1999/2000 ms deadline、explicit coalesce/bypass、0ms override；routing distribution 与 cache golden 不变。 |
| run_js sandbox isolation | ✅ | 2026-08-07 REQ-SEC-0001 加固后 66/66（含逃逸回归向量）+ 真实 TinyFish 调用 |
| flush/compaction 状态机（REQ-AGENT-0001） | ✅ | 2026-08-07 test/flush.test.ts + test/search.test.ts：慢 vision 并发触发不重复序列化、send 失败不标 exposed 可重试、compaction 失败/中止/空摘要不错切 epoch、exposure 与 kept tail（N≠40）对齐、search 10s 超时与响应护栏、send 先校验后发 |
| ingestion/poller 可靠性（REQ-TG-0001） | ✅ | 2026-08-07 test/ingest.test.ts + test/poller.test.ts：二次编辑 revision 全链（v1 按原始 date、v2 按首次 edit_date 作 key）、ingest 失败不推进 offset 且重放无重复、setBotState 失败走 backoff poller 存活、stop 发生在长轮询期间则丢弃返回批次、401 fail-fast |
| vision lazy/cache | ✅ | 2026-08-07 真实群 sticker/photo 语义正确，双 bot file_id 映射 |
| IPC/插件数据层健壮性（REQ-IPC-0001） | ✅ | 2026-08-08 test/ipc.test.ts 14 条 + test/tg-engine.test.ts 5 条：streaming FrameDecoder、多字节边界、复合游标、队列上限、socket 600、过滤/stats、ANSI/OSC strip，以及真实 Unix socket snapshot/live/more/断线 |
| manual send daemon contract（REQ-UI-0005 T5） | ✅ | 2026-08-08 62 targeted pass：request-id concurrent dedupe/conflict/bounded cache、bot/text/4096-code-point boundary、401/error/unknown outcome、send→DB→broadcast、poller echo dedupe、ACK-loss drop、旧 observer IPC 兼容；typecheck/cache golden 通过。 |
| Pi editor compose（REQ-UI-0005 T6） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/tg-extension.test.ts` + `test/tg-engine.test.ts` + IPC 共 39 pass：interactive handled/单发、read-only/off/RPC/extension continue、附件/空文本、明确失败恢复、in-flight 防重、ACK timeout unknown/no retry、footer identity、disconnect/detach/shutdown cleanup，以及真实 Unix socket ACK matching；`bun run check` 通过。真实 Pi/Telegram 留 T14。 |
| 配置校验/进程管理（REQ-OPS-0001） | ✅ | 2026-08-07 test/config.test.ts 12 条：坏数值/概率和>1/非正数 threshold/坏 peer id 全部错误一次列出；peer id 三种写法归一化一致；.env.example 冒号格式可解析；data/ 被 git ignore；pid 锁排他（fixture 进程持锁，第二个 acquire 退出且锁不被动）+ 死 pid 接管 + 异进程 pid 拒绝 |
| 测试体系修复（REQ-TEST-0001） | ✅ | 2026-08-07：TinyFish 真实调用迁到 env gate（无 .env 时 skip）；cache golden 补 tools hash（7b1983d95e25，与 Phase 6 历史一致）+ compaction summary prompt hash；is_bot 判断下沉到 routeMessage 单一权威点（daemon 前置判断移除）；e2e 脚本按断言 exit code（compaction 未发生 exit≠0、轮询替代固定 sleep、e2e-agent 无 run 完成 exit≠0、manual 版 epoch 未推进 exit≠0）；analyze 脚本同步真实 compaction/回落（60 runs 回放：3 次真实 compaction 正确识别、幻影 0）；盲区补测：run_js 代码长度上限/同步异常、serialize vision 替换/(edited)/text+media/跨天分隔、ingest forward_origin/sender_chat |
| 配置体系（REQ-CONF-0001） | ✅ | 2026-08-07 test/config.test.ts：bots.config.json 任意数量 bot / persona 外置绝对路径 / 单 bot 与三 bot 配置 / 重复 id / 坏 token_env / Σp>1 / 不可读 persona 逐条报错 / peer id 归一化；真实项目配置对真实 .env 可加载；cache golden 逐字节不变 |
| 固定 sticker set（REQ-STICKER-0001） | ✅ | 2026-08-07 test/sticker.test.ts 10 条：catalog 加载（media/short_id/file_id）、确定性序列化（含 [未识别]）、120 上限截断、坏 set 名不阻塞、send 解析 catalog id、动态候选排除 catalog sticker + 位置锁定在消息之后、visionless short_id 不崩；golden：目录块 hash 锁定（CACHE_SCHEMA_VERSION=2）；真实群冒烟：双 set 下载（114+98 个 sticker）vision 后台预识别 |
| sticker per-bot 可发送性（REQ-STICKER-0002） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/sticker.test.ts` 用 A:s144 与 B:s241–s244 复现生产泄漏，锁 fixed/dynamic/shared/A-only mapping；部分 set fetch、candidate invariant preflight 与 cache v3 golden 一并覆盖。真实群各 bot 自身目录发送留到总验收。 |
| Pi 原生 UI（REQ-UI-0001/2/3/4） | ✅ | 2026-08-08 test/tg-extension.test.ts 10 条：package discovery/version guard、TUI-only custom entry、restore 不重连、单例 attach/more/detach、component-factory widget、filter/status/cleanup、窄宽度安全、原生 `Image`；生产代码无手写 viewport/`render()`/`handleInput()`/ANSI，611 行 < 617 基线；真实 Pi fullscreen smoke 通过 |
| compaction（threshold→summary→epoch） | ✅ | 2026-08-07 e2e-compaction 强制触发，epoch 持久化+重启恢复；REQ-AGENT-0001 后补 e2e-compaction-manual：成功路径 epoch 4→5、kept tail 41 条精确重标（N≠40），失败路径（Nothing to compact）epoch 不动 + error 落库 |
| cache regression（prefix hash 稳定） | ✅ | 2026-08-07 golden 3/3（bun test 强制 UTC，测试内 pin TZ） |
| threshold 分析脚本 | ✅ | 2026-08-07 50 runs 回放，hit ratio 90.0%，当前规模下各候选均不触发 compaction |
| 长运行 smoke | ⏳ Phase 9 | - |
| 当前全量回归 | ✅ | 2026-08-08 `bun test`：149 pass / 0 fail / 2821 assertions；`bun run check` 通过；`git diff --check` 通过；cache golden 6/6 |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
