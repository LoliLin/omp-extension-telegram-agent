# 测试策略与状态

> 当前真实测试状态，不是计划书。本文件是测试与验证的唯一权威来源。

## 验证漏斗（由便宜到贵，按序跑到能覆盖改动的那层）

1. **目标**：`bun test test/<相关文件>` —— 直接覆盖被改行为的最小测试
2. **全量 unit**：`bun test`（unit + replay，不触网络）+ `bun run check`（tsc --noEmit）
3. **e2e**：`bun run scripts/e2e-agent.ts --bot <id>` / `e2e-compaction.ts --bot <id>`（需 `.env`，触真实配置provider / Telegram）
4. **真实群 / 长运行 smoke**：跨边界或稳定性改动才需要；观察 daemon.log、遥测、内存

## 测试选择规则

- 能确定性复现的 bug fix 必须有回归测试。
- 契约变化（IPC 协议 / schema / 序列化 grammar）需要跨边界测试。
- Agent 行为测可观察轨迹与结果，不断言 prompt 字符串。
- provider cache 相关改动必须跑 `test/cache.test.ts` golden；golden 失败是报警，先查原因，不要随手更新。
- 涉时间序列化的测试必须 pin TZ（bun test 强制 UTC，参考 test/cache.test.ts）。
- `bun test`即使检测到真实`.env`也不得调用外网或付费API；`bunfig.toml` preload只放行loopback fake upstream。尤其禁止把真实 TinyFish 调用留在任何 tracked test；真实服务只能用明确 opt-in e2e 或一次性脚手架，脚手架验收后立即删除，不能按 credential 存在自动启用。
- 不得为了通过而删除或削弱断言。

## 失败诊断

改源码前先定位失败来源：1) 被改的行为 2) 过期的生成物 / golden 3) 缺 bootstrap / build 产物 4) 环境或工具链不一致（TZ、bun 版本）5) flaky / 外部依赖（Telegram、DeepSeek、TinyFish、codex）6) 与本次改动无关的既有失败。外部 / 既有失败单独报告，不混入本次结论。

## 测试分层

unit / integration / replay / real Telegram / restart / provider-cache / long-running smoke

## 运行命令

```bash
bun test                # unit + replay（不涉及网络）
bun run check           # tsc --noEmit
bun run scripts/smoke-pi.ts --bot <id>              # 当前bot的Pi provider/model smoke（需 .env）
bun run scripts/e2e-agent.ts --bot <id>              # 真实链路 e2e（需 .env）
bun run scripts/e2e-compaction.ts --bot <id>         # compaction e2e（需 .env）
bun run scripts/e2e-compaction-manual.ts --bot <id>  # 手动 compact() 验证 compaction_end 成功/失败路径（需 .env；1M window 下 threshold e2e 已无法廉价触发自动 compaction）
bun run scripts/analyze-routing.ts                    # 只读、零网络的current-effective routing审计
bun run scripts/benchmark-vision.ts --photo <local.jpg> --sticker <local.webp> --runs 3  # opt-in Pi视觉聚合基准
```

## 当前状态

| 场景 | 状态 | 最后结果 |
|---|---|---|
| review-260808 context/cost 重构 | ✅ deterministic + CI | 2026-08-09 分层验证覆盖immutable event migration/delta、百万event索引读取、monotonic cursor与separate visibility、reply commit reconcile、durable routing claim、12k/4096 token packing、vision deployment budget、retention、session fingerprint、固定extension顺序、payload HMAC divergence、assistant `[no_send]`、向导固定预检模型并关闭reasoning/search/run_js/vision、schema v8 golden及CI frozen install/cache/full/typecheck；未调用真实provider、TinyFish或Telegram。 |
| GPG 签名提交 | ✅ | 2026-08-07 验证 good signature |
| Bun × Pi SDK 兼容性 smoke | ✅ | 2026-08-07 smoke-pi.ts 真实调用成功 |
| Telegram ingestion/dedupe/restart | ✅ | 2026-08-07 bun test 12/12 + 真实群 e2e + restart 全通过 |
| unified terminating send（REQ-SEND-0001） | ✅ unit + real Telegram | 2026-08-08 唯一 message/sticker/reply_to schema、固定 `ok`/terminate 与 providerCalls=1 回归通过；T14 只读聚合确认两只 bot 都有真实 text、映射目录 sticker、message+sticker 与 reply 发送记录。 |
| send commit boundary（REQ-SEND-0002） | ✅ deterministic failure + real send | 2026-08-08 双连接真实 SQLite lock精确复现remote commit后`SQLITE_BUSY`且create/broadcast各一次、poller最终一行；33 targeted / 190 assertions覆盖unknown/partial/no-retry。T14真实组合发送与canonical聚合通过，不在生产群故意注入本地故障。 |
| local assistant 不进群 | ✅ | e2e：assistant_text/thinking 只进 agent_events |
| Pi 原生 Telegram attach/detach | ✅ | 2026-08-08 项目 Pi 真实 fullscreen TTY完成 filtered attach、older-page prepend与detach；内容保留且退出 Pi 不影响 daemon。 |
| deterministic routing property tests | ✅ | 2026-08-07 33/33 + 真实群双 bot 实况 |
| probability busy/cooldown scheduler（REQ-ROUTE-0001） | ✅ | 2026-08-08 46 targeted：fake monotonic clock + 100-message burst；A/B 独立并发、busy/cooldown fast-skip、不改投、不设 pending、不补抽、1999/2000 ms deadline、explicit coalesce/bypass、0ms override；另锁 `routing_p=[0,0]` 的“我叫小雨”→B/name→explicit busy/cooldown path；cache golden 不变。 |
| 脱敏routing审计（REQ-ROUTE-0002） | ✅ unit + current deployment replay | 2026-08-08 `test/router.test.ts` + `test/analyze-routing.test.ts` 覆盖100,000连续id互斥0.66/0.34、duplicate canonical、probability/mention/reply/name/bot、started/busy/cooldown、empty/1/N-bot、override、missing/truncated/unknown log、readonly拒写与privacy denylist。验收快照只读重放2,046个probability样本为1,372/674（67.06/32.94%）；daemon partial started 580/289（66.74/33.26%），public 406/374（52.05/47.95%），口径分离。 |
| run_js sandbox isolation | ✅ | 2026-08-07 REQ-SEC-0001 加固后覆盖逃逸回归向量；真实TinyFish测试已从该文件删除。 |
| TinyFish query/fetch（REQ-SEARCH-0001） | ✅ offline + one-time smoke | 2026-08-08 `test/search.test.ts` 29 pass / 76 assertions：现行query请求与本地1,000/5/120/200上限、精确单URL POST、50秒/1 MiB/8,000字符、untrusted boundary、public URL/IP table（含非十进制IPv4与IPv4-mapped IPv6）、0-network invalid/dual/empty、三tool顺序与telemetry denylist。一次性真实search/`example.com` fetch只断言shape/bounds并通过，随后删除脚手架；永久测试由preload机械阻断外网，`.env`存在也不消耗额度。cache schema 5→6且只有version/tools hash变化。 |
| flush/context/compaction 状态机 | ✅ | 2026-08-09 `test/flush.test.ts`等锁定最多256 recent + 64 obligation event、reply优先token packing、custom-message持久化后cursor commit、startup structured reconcile、overflow consumed但不visible、send ids visibility、compaction只替换structured visible refs/epoch且cursor不回退、失败/空摘要不改状态。 |
| ingestion/poller 可靠性 | ✅ | 2026-08-09兼容既有revision/offset/stop/401回归，并新增message/edit/metadata/media_update immutable delta、migration backfill high-water、second-bot enrichment幂等与`(chat_id,ingest_seq)`索引路径。 |
| vision lazy/cache | ✅ | 2026-08-07 真实群 sticker/photo 语义正确，双 bot file_id 映射 |
| provider前视觉gate（REQ-VISION-0001） | ✅ fake + historical real smoke | 2026-08-09现行默认disabled；启用fixture锁每轮foreground 2、deployment并发2、每群每小时24/每日200 budget，reply媒体优先、persistent/in-flight cache、failure/unsupported/budget fallback与非空结果只追加media_update。2026-08-08真实Pi各n=1仅是历史opt-in样本，不代表schema v8部署分布。 |
| vision update transport（REQ-UI-0006 T7） | ✅ unit + real Pi | 2026-08-08 50 targeted pass 锁定 identity-only IPC、单次 describe、乱序/重复与脱敏；T14 真实 Pi 原生媒体卡片观察到持久 vision 文本原位出现。 |
| native live vision card（REQ-UI-0006 T8） | ✅ unit + real Pi | 2026-08-08 44 plugin/timeline/IPC pass 覆盖 256 项有界缓存、同 identity 多卡、sanitize 与零 entry 增长；T14 live card/vision smoke 通过。 |
| durable photo readiness（REQ-UI-0014 T13l） | ✅ unit + real Telegram/Pi | 2026-08-08 108 targeted / 930 assertions覆盖 durable-first、两路/128队列、最新100回填及失败边界；T14 直连 Telegram 新 photo 最终只有一条 canonical identity，缓存文件存在且 mode 0600，Pi 使用同一原生卡片更新。 |
| IPC/插件数据层健壮性（REQ-IPC-0001） | ✅ | 2026-08-08 test/ipc.test.ts 14 条 + test/tg-engine.test.ts 5 条：streaming FrameDecoder、多字节边界、复合游标、队列上限、socket 600、过滤/stats、ANSI/OSC strip，以及真实 Unix socket snapshot/live/more/断线 |
| manual send daemon contract（REQ-UI-0005 T5） | ✅ | 2026-08-08 62 targeted pass：request-id concurrent dedupe/conflict/bounded cache、bot/text/4096-code-point boundary、401/error/unknown outcome、send→DB→broadcast、poller echo dedupe、ACK-loss drop、旧 observer IPC 兼容；typecheck/cache golden 通过。 |
| Pi editor compose（REQ-UI-0005 T6/T13o） | ✅ unit + real Pi/Telegram | 2026-08-08 100 targeted / 1156 assertions覆盖 scope/sticky/select/cancel/unknown/no-retry；T14 filtered attach 后从 Pi editor 直发 marker，SQLite 只出现一条目标 bot canonical row。 |
| 配置校验/进程管理（REQ-OPS-0001） | ✅ | 2026-08-07 test/config.test.ts 12 条：坏数值/概率和>1/非正数 threshold/坏 peer id 全部错误一次列出；peer id 三种写法归一化一致；.env.example 冒号格式可解析；data/ 被 git ignore；pid 锁排他（fixture 进程持锁，第二个 acquire 退出且锁不被动）+ 死 pid 接管 + 异进程 pid 拒绝 |
| deployment-wide受控重启（REQ-OPS-0002） | ✅ unit + real CLI/Pi | 2026-08-08 controller/extension/config/timeline targeted覆盖严格signal→全PID/pid/socket释放→单spawn→socket connect、stopped/stale/foreign/malformed/timeout/early-exit/starting、并发control lock、credential redaction、同仓库孤儿枚举与shell decoy、Pi A/all filter+footer原位重连及snapshot去重。真实running/stopped/Pi三路径完成；现场回收孤儿PID 9316后跨30秒无新409，SQLite与live stream保留；cache v5不变。 |
| 测试体系修复（REQ-TEST-0001） | ✅ | 2026-08-07：TinyFish 真实调用迁到 env gate（无 .env 时 skip）；cache golden 补 tools hash（7b1983d95e25，与 Phase 6 历史一致）+ compaction summary prompt hash；is_bot 判断下沉到 routeMessage 单一权威点（daemon 前置判断移除）；e2e 脚本按断言 exit code（compaction 未发生 exit≠0、轮询替代固定 sleep、e2e-agent 无 run 完成 exit≠0、manual 版 epoch 未推进 exit≠0）；analyze 脚本同步真实 compaction/回落（60 runs 回放：3 次真实 compaction 正确识别、幻影 0）；盲区补测：run_js 代码长度上限/同步异常、serialize vision 替换/(edited)/text+media/跨天分隔、ingest forward_origin/sender_chat |
| 配置体系（REQ-CONF-0001 / ONBOARD T13b） | ✅ | 2026-08-08 `telegram.config.ts`与legacy JSON走同一validator/normalizer；Bun和Node+jiti加载同一typed fixture结果等价，双默认文件/坏override扩展fail-fast，typed example真实加载并纳入typecheck。既有单/三bot、外置persona、provider、概率/数值验证保持；私有persona默认ignore且`git ls-files personas`只允许README与中英模板。cache schema仍v5，golden fixture改用公开模板。 |
| provider 配置（REQ-PLAT-0001 T11） | ✅ historical compatibility | 2026-08-08 T11曾支持项目provider credential；REQ-PLAT-0002现已取代该认证边界。legacy key字段仅由loader接受后丢弃，canonical deployment只选择Pi catalog中的provider/model。 |
| Pi auth/settings/shared runtime（REQ-PLAT-0002 T13j1–T13j4） | ✅ fake + historical real aggregate | Pi auth store仍是唯一credential源，legacy key字段只接受后丢弃，shared runtime与same/cross-provider选择回归保持。2026-08-09 fresh向导在dialog前预检Pi选择并把provider/model固定进config，reasoning固定off；失败零写入，`.env`仍只有Telegram token。2026-08-08真实DeepSeek/Luna数据仅为历史聚合smoke。 |
| N-bot composition（REQ-PLAT-0001 T12） | ✅ deterministic; real C opt-in documented | 2026-08-08 1/2/3-bot config→state/runtime/Poller/router/IPC 全链及 `--bot C` 通过。当前部署只有两份 token，因此未制造第三个真实 bot；按 AC7 保留 runbook smoke/回滚清单。 |
| portable Pi launcher（REQ-ONBOARD-0001 T13a） | ✅ bootstrap + real Pi | 2026-08-08 四个 Pi package 精确锁定 registry 0.84.1、lock 无 file dependency；隔离 bootstrap fixture与当前项目真实 `bun run pi` 均成功加载 extension。 |
| atomic onboarding config（REQ-ONBOARD-0001） | ✅ core | 2026-08-09 `test/onboarding-config.test.ts` 8 cases覆盖fresh三文件+final loader/0600、`.env`仅Telegram token、生成config固定预检provider/model且显式reasoning/search/run_js/vision off和成本上限、existing deny、字段校验、rename failure全rollback、backup/merge/editor round-trip及provider-key surface审计。events仅phase/相对path；secret不进config/event/error。 |
| Pi native `/tg config`（REQ-ONBOARD-0001 T13d/T13j3） | ✅ deterministic + real extension load | 2026-08-08 loader-error/help/completion、model preflight、Pi dialogs、7个取消点、原子写入与 fake readiness 全覆盖；T14 真实 Pi 加载命令/动态补全。为避免覆盖当前部署且没有新外部 credential，未重跑 fresh Telegram 写入旅程，按 AC12 明确记录。 |
| 双语用户、机器文档与Pages（DOC-0001 / ONBOARD T13e/T13f） | ✅ local build/link + workflow contract | 2026-08-08 中英 README/各7章 guide、maintainer入口、固定 actions/最小权限均验收；T14 mdBook 0.5.4 生成21个HTML，18个Markdown/98 links与生成站点620 links全部通过。首次远端 main deploy 属于仓库托管环境，不阻塞本地需求完成。 |
| sticker set与每轮候选 | ✅ | 2026-08-09 catalog仍负责media/short_id/per-bot file-id与send preflight；完整目录不进入system prefix，provider每轮最多看到8个本地相关且可发送的top-K候选，预算不足则不追加。cache v8 golden锁定system不受catalog block影响。 |
| sticker per-bot 可发送性（REQ-STICKER-0002） | ✅ unit + real Telegram | 2026-08-08 fake fixture锁 fixed/dynamic/shared/per-bot mapping 与 cache v3；T14 脱敏 join 审计确认两只 bot 都已真实发送且每次 sticker short_id 可连接到该 bot 自己的 `media_file_ids`。 |
| Pi 原生 transcript（REQ-UI-0001/2/4） | ✅ | 2026-08-08：package discovery/version guard、TUI-only custom entry、restore 不重连、单例 attach/more/detach、filter/cleanup、原生 `Image`；生产代码无手写 viewport/`handleInput()`/ANSI；真实 Pi fullscreen attach/more/detach smoke 通过。611 行是 `19819c9` 完成 UI-0004 时的基线，后续 compose/vision/footer 功能独立追踪，不把新增需求误算为旧 hack。 |
| Kitty/Ghostty原生媒体兼容（REQ-UI-0012） | ✅ protocol fixture + real Pi card | 2026-08-08 50 targeted / 469 assertions覆盖Kitty PNG wire、Ghostty/tmux/iTerm2/null capability、formats、bounds与lifecycle；真实Pi converter和T14原生photo/media卡片通过。额外终端品牌矩阵是可移植性smoke，不是自动测试。 |
| 紧凑Pi原生sticker（REQ-UI-0013） | ✅ layout fixture + real Pi card | 2026-08-08 51 targeted / 586 assertions锁sticker 24×12、photo尺寸、40/80/120列与转换后原位卡片；T14真实Pi媒体卡片通过，品牌终端视觉差异不通过自绘代码补偿。 |
| Pi 原生 telemetry footer（REQ-UI-0003/7 T9b） | ✅ unit + real Pi | 2026-08-08 53 targeted pass 锁真实 `FooterComponent`、窄宽、owner与 lifecycle；T14 受控重启后真实 Pi footer 显示 Telegram lifetime 指标与 compose status，无 custom widget。 |
| Pi 原生 `/tg` 分级补全（REQ-UI-0008 T10） | ✅ unit + real Pi TTY | 2026-08-08 28 targeted pass覆盖共享 tree、动态 N-bot、off/partial/third-level；T14 隐藏原文的 TTY 自动化分别确认一级原生菜单和 `attach` 动态 bot 二级菜单出现。 |
| lifetime telemetry completeness（REQ-UI-0009 T10b） | ✅ unit + real restart | 2026-08-08 70 targeted pass覆盖 migration、file reopen/rebuild、baseline/live去重与原生 `W/CH`；T14 受控 restart 后 cache schema 7、双 bot lifetime rows/footer 均保留。 |
| Pi feed 即时刷新与 assistant stream（REQ-UI-0010 T10i） | ✅ unit + real Pi | 2026-08-08 75 targeted / 592 assertions覆盖有界 stream、filter、乱序、sanitize与 render request；T14 真实 Pi 观察到 assistant/tool partial 在同一卡片连续刷新并正确结束。 |
| Telegram response typing lease（REQ-TG-0002 T10j） | ✅ unit + real long-run evidence | 2026-08-08 54 targeted / 2640 assertions精确锁立即调用、4秒续约、单timer、send/settle/shutdown释放与 group-only payload；T14 只读 telemetry确认两只 bot 均有超过5秒的真实处理轮次及后续成功发送，未额外启动付费 smoke。 |
| Rich Message 接收/data plane（REQ-TG-0003 T10k） | ✅ | 2026-08-08覆盖nested inline、list/table/details/media/unknown、bounds、migration/edit/echo与projection-only；incoming raw source仍有界持久化，Pi/provider只见plain projection。首版outbound RichMessage已由REQ-TG-0004取代。 |
| Markdown→Telegram entities（REQ-TG-0004 T13p） | ✅ offline + real Telegram | 2026-08-08 converter/API/runtime锁 UTF-16、结构、bounds、fallback/no-retry与 cache v7；T14 一次无模型直连 runtime smoke 恰创建1条 Telegram+canonical消息、1个`markdown_sent` event，返回 entities 含 bold/italic/code。自动测试始终由全局guard保证0真实Telegram/TinyFish调用。 |
| Direct reply provider delivery | ✅ unit + historical real aggregate | 2026-08-09 unit锁定obligation transaction、最多64条有界恢复、token预算优先、structured commit marker与crash reconcile、A/B隔离；2026-08-08只读真实聚合仍是历史链路证据。 |
| compaction（threshold→summary→epoch） | ✅ unit + historical e2e | 2026-08-09 structured details锁`consumedSeq`不变、visible tail替换、cheap compaction model/cache none、失败/空摘要不改epoch；2026-08-07 manual e2e是旧session格式的历史外部证据，本轮未发起付费复测。 |
| cache regression（prefix hash 稳定） | ✅ | 2026-08-09 schema v8 golden 7/7：中英system、legacy/event serializer、tools、compaction、extension order/context protocol；测试pin Asia/Singapore TZ。 |
| threshold 分析脚本 | ✅ | 2026-08-07 50 runs 回放，hit ratio 90.0%，当前规模下各候选均不触发 compaction |
| 长运行 smoke | ✅ aggregate evidence | 2026-08-08 只读telemetry确认两只bot都有多次超过5秒的真实run及后续send；T14不为重复证明而新增provider/TinyFish成本。 |
| T14 真实总验收 | ✅ | 受控 restart、Pi attach/editor/footer/completion/stream/media、Telegram Markdown/new-photo 与只读双 bot send/reply/sticker审计通过。T14 自身只调用 Telegram，不启动 provider/TinyFish；一次性脚手架均未留在仓库。 |
| 当前全量回归 | ✅ | 2026-08-09 `bun test`：442 pass / 0 fail / 5118 assertions（42 files，全局外网guard生效）；`bun run check`通过；cache v8 golden 7/7；mdBook 0.5.4检查18个Markdown/98 links与21个HTML/620 links通过。 |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
