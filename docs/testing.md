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
- `bun test`即使检测到真实`.env`也不得调用外网或付费API；`bunfig.toml` preload只放行loopback fake upstream。真实服务只能用明确opt-in e2e/一次性脚手架，不能按credential存在自动启用。
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
| GPG 签名提交 | ✅ | 2026-08-07 验证 good signature |
| Bun × Pi SDK 兼容性 smoke | ✅ | 2026-08-07 smoke-pi.ts 真实调用成功 |
| Telegram ingestion/dedupe/restart | ✅ | 2026-08-07 bun test 12/12 + 真实群 e2e + restart 全通过 |
| unified terminating send（REQ-SEND-0001） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/send-tool.test.ts` + sticker/flush/cache 34 targeted：唯一 message/sticker/reply_to schema、persona/protocol 去重、description-only hash drift、一次组合网络调用与本地 details、固定 `ok` result；Pi agent-loop harness 证明 providerCalls=1/turn_end=1。cache schema v4 golden/check 通过；真实群三种组合留 T14。 |
| send commit boundary（REQ-SEND-0002） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/send-commit.test.ts` 以双连接真实 SQLite lock 复现 Telegram `#19614` 已创建后 `SQLITE_BUSY`：create/broadcast 各一次，terminal `committed/no_retry`，poller recovery 最终一行；另锁 transient retry、sticker-only closed DB、message→sticker rejected/unknown partial（含返回Message却缺id）、timeout/socket/non-JSON/429/5xx、preflight 零调用与 exposure/broadcast/event/typing 隔离。Pi agent-loop degraded result仍 providerCalls=1。相关 33 pass / 190 assertions；全量 268 / 3949、typecheck、cache v5 golden与 diff check通过。真实组合发送并入 T14。 |
| Telegram群内控制（REQ-CMD-0001） | ✅ unit / ⏳ real group smoke | 2026-08-08 T10m1–T10m3 command/cache targeted 45 pass / 374 assertions。除strict entity/auth/state/compact外，fake Poller→suffix目标BotApi→reply_parameters→canonical DB→fake IPC完整锁定一次执行/一次create/一次broadcast；command+reply跨epoch不进suffix，async handler失败不回退offset，BotCommand payload及逐botbest-effort失败脱敏。全量302 / 4298、typecheck、cache v5 golden与diff check通过；非管理员status/set拒绝及`@aac6fef` set→reset/compact真实群留T14。 |
| local assistant 不进群 | ✅ | e2e：assistant_text/thinking 只进 agent_events |
| Pi 原生 Telegram attach/detach | ✅ | 2026-08-08 项目 Pi 真实 fullscreen TTY：`/tg attach A` 显示 #19061–#19063，`/tg more` prepend 到 #18961，`/tg detach` 断开后内容保留；退出 Pi 不影响 daemon |
| deterministic routing property tests | ✅ | 2026-08-07 33/33 + 真实群双 bot 实况 |
| probability busy/cooldown scheduler（REQ-ROUTE-0001） | ✅ | 2026-08-08 46 targeted：fake monotonic clock + 100-message burst；A/B 独立并发、busy/cooldown fast-skip、不改投、不设 pending、不补抽、1999/2000 ms deadline、explicit coalesce/bypass、0ms override；另锁 `routing_p=[0,0]` 的“我叫小雨”→B/name→explicit busy/cooldown path；cache golden 不变。 |
| 脱敏routing审计（REQ-ROUTE-0002） | ✅ unit + current deployment replay | 2026-08-08 `test/router.test.ts` + `test/analyze-routing.test.ts` 覆盖100,000连续id互斥0.66/0.34、duplicate canonical、probability/mention/reply/name/bot、started/busy/cooldown、empty/1/N-bot、override、missing/truncated/unknown log、readonly拒写与privacy denylist。验收快照只读重放2,046个probability样本为1,372/674（67.06/32.94%）；daemon partial started 580/289（66.74/33.26%），public 406/374（52.05/47.95%），口径分离。 |
| run_js sandbox isolation | ✅ | 2026-08-07 REQ-SEC-0001 加固后覆盖逃逸回归向量；真实TinyFish测试已从该文件删除。 |
| TinyFish query/fetch（REQ-SEARCH-0001） | ✅ offline + one-time smoke | 2026-08-08 `test/search.test.ts` 29 pass / 76 assertions：现行query请求与本地1,000/5/120/200上限、精确单URL POST、50秒/1 MiB/8,000字符、untrusted boundary、public URL/IP table（含非十进制IPv4与IPv4-mapped IPv6）、0-network invalid/dual/empty、三tool顺序与telemetry denylist。一次性真实search/`example.com` fetch只断言shape/bounds并通过，随后删除脚手架；永久测试由preload机械阻断外网，`.env`存在也不消耗额度。cache schema 5→6且只有version/tools hash变化。 |
| flush/compaction 状态机（REQ-AGENT-0001） | ✅ | 2026-08-07 test/flush.test.ts + test/search.test.ts：慢 vision 并发触发不重复序列化、send 失败不标 exposed 可重试、compaction 失败/中止/空摘要不错切 epoch、exposure 与 kept tail（N≠40）对齐、search 10s 超时与响应护栏、send 先校验后发 |
| ingestion/poller 可靠性（REQ-TG-0001） | ✅ | 2026-08-07 test/ingest.test.ts + test/poller.test.ts：二次编辑 revision 全链（v1 按原始 date、v2 按首次 edit_date 作 key）、ingest 失败不推进 offset 且重放无重复、setBotState 失败走 backoff poller 存活、stop 发生在长轮询期间则丢弃返回批次、401 fail-fast |
| vision lazy/cache | ✅ | 2026-08-07 真实群 sticker/photo 语义正确，双 bot file_id 映射 |
| provider前视觉gate（REQ-VISION-0001 T13k1a–T13k1c） | ✅ fake + real opt-in smoke | 2026-08-08 1/2/3 uncached media deferred fixture锁并发峰值1/2/2、第三项第二波、release前0 provider submit、release后单次suffix直接含描述；failure/unsupported单次fallback且exposed后不重写，persistent cache零Telegram/describe。同identity in-flight只下载/识别一次；catalog两路后台不阻塞且当前prompt/hash snapshot不变。vision telemetry/report精确allowlist且无identity/path/description。benchmark unit 4 cases覆盖strict args、p50/p95/token/cost/gate、failure/reasoning与path redaction；current Pi各n=1 photo 3312ms、sticker 4309ms、reasoning均0且2×gate通过（n=1不代表分布）。 |
| vision update transport（REQ-UI-0006 T7） | ✅ | 2026-08-08 50 targeted pass：新描述写库后 identity-only callback、concurrent/cache 共用且 describe call=1、empty/unsupported 不发布、snapshot identity/trim、additive IPC 向所有 listener 广播；sticker/flush/timeline regression 与 `bun run check` 通过。native card merge/real smoke 留 T8/T14。 |
| native live vision card（REQ-UI-0006 T8） | ✅ unit / ⏳ real smoke | 2026-08-08 44 plugin/timeline/IPC pass：update-before-live、later history、256-entry bound、重复幂等、同 uid 多卡片原位更新、`视觉理解` 置于 media 下方、ANSI/OSC sanitize、Pi entry 不增长；`bun run check` 通过。真实 live photo/sticker 留 T14。 |
| durable photo readiness（REQ-UI-0014 T13l） | ✅ unit / ⏳ real group smoke | 2026-08-08 photo-cache/vision/poller/IPC/timeline/extension/cache 108 pass / 930 assertions：canonical+offset先durable、placeholder→0600 atomic path→`media_ready`、同identity/双bot/并发vision一次下载、最新100回填、两路active/128 pending、oversize/格式/network/write/rename/shutdown失败、256项乱序cache、history/disconnect与同entry Pi Image原位更新。全量383 / 4911、typecheck与cache v5 golden通过；真实群新photo留T14后才勾选。 |
| IPC/插件数据层健壮性（REQ-IPC-0001） | ✅ | 2026-08-08 test/ipc.test.ts 14 条 + test/tg-engine.test.ts 5 条：streaming FrameDecoder、多字节边界、复合游标、队列上限、socket 600、过滤/stats、ANSI/OSC strip，以及真实 Unix socket snapshot/live/more/断线 |
| manual send daemon contract（REQ-UI-0005 T5） | ✅ | 2026-08-08 62 targeted pass：request-id concurrent dedupe/conflict/bounded cache、bot/text/4096-code-point boundary、401/error/unknown outcome、send→DB→broadcast、poller echo dedupe、ACK-loss drop、旧 observer IPC 兼容；typecheck/cache golden 通过。 |
| Pi editor compose（REQ-UI-0005 T6） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/tg-extension.test.ts` + `test/tg-engine.test.ts` + IPC 共 39 pass：interactive handled/单发、read-only/off/RPC/extension continue、附件/空文本、明确失败恢复、in-flight 防重、ACK timeout unknown/no retry、footer identity、disconnect/detach/shutdown cleanup，以及真实 Unix socket ACK matching；`bun run check` 通过。真实 Pi/Telegram 留 T14。 |
| 配置校验/进程管理（REQ-OPS-0001） | ✅ | 2026-08-07 test/config.test.ts 12 条：坏数值/概率和>1/非正数 threshold/坏 peer id 全部错误一次列出；peer id 三种写法归一化一致；.env.example 冒号格式可解析；data/ 被 git ignore；pid 锁排他（fixture 进程持锁，第二个 acquire 退出且锁不被动）+ 死 pid 接管 + 异进程 pid 拒绝 |
| deployment-wide受控重启（REQ-OPS-0002） | ✅ unit + real CLI/Pi | 2026-08-08 controller/extension/config/timeline targeted覆盖严格signal→全PID/pid/socket释放→单spawn→socket connect、stopped/stale/foreign/malformed/timeout/early-exit/starting、并发control lock、credential redaction、同仓库孤儿枚举与shell decoy、Pi A/all filter+footer原位重连及snapshot去重。真实running/stopped/Pi三路径完成；现场回收孤儿PID 9316后跨30秒无新409，SQLite与live stream保留；cache v5不变。 |
| 测试体系修复（REQ-TEST-0001） | ✅ | 2026-08-07：TinyFish 真实调用迁到 env gate（无 .env 时 skip）；cache golden 补 tools hash（7b1983d95e25，与 Phase 6 历史一致）+ compaction summary prompt hash；is_bot 判断下沉到 routeMessage 单一权威点（daemon 前置判断移除）；e2e 脚本按断言 exit code（compaction 未发生 exit≠0、轮询替代固定 sleep、e2e-agent 无 run 完成 exit≠0、manual 版 epoch 未推进 exit≠0）；analyze 脚本同步真实 compaction/回落（60 runs 回放：3 次真实 compaction 正确识别、幻影 0）；盲区补测：run_js 代码长度上限/同步异常、serialize vision 替换/(edited)/text+media/跨天分隔、ingest forward_origin/sender_chat |
| 配置体系（REQ-CONF-0001 / ONBOARD T13b） | ✅ | 2026-08-08 `telegram.config.ts`与legacy JSON走同一validator/normalizer；Bun和Node+jiti加载同一typed fixture结果等价，双默认文件/坏override扩展fail-fast，typed example真实加载并纳入typecheck。既有单/三bot、外置persona、provider、概率/数值验证保持；私有persona默认ignore且`git ls-files personas`只允许README与中英模板。cache schema仍v5，golden fixture改用公开模板。 |
| provider 配置（REQ-PLAT-0001 T11） | ✅ historical compatibility | 2026-08-08 T11曾支持项目provider credential；REQ-PLAT-0002现已取代该认证边界。legacy key字段仅由loader接受后丢弃，canonical deployment只选择Pi catalog中的provider/model。 |
| Pi auth/settings/shared runtime（REQ-PLAT-0002 T13j1–T13j4） | ✅ fake + real aggregate smoke | 2026-08-08 canonical schema/examples/`.env.example`不含provider key；legacy字段引用不存在env仍被丢弃。真实SettingsManager fixture覆盖global/project defaults与missing/invalid；隔离auth fixture覆盖API-key/OAuth；N bot fake锁一次runtime、0次credential injection与same/cross-provider选择。fresh向导在dialog前本地preflight，只显示`provider/model:thinking`，失败零写入；生成config继承Pi且`.env`只有Telegram token。视觉使用同一shared runtime。当前Pi credential的DeepSeek text smoke为ok、795ms、8 input / 1 output / 0 reasoning token；Luna low photo/static-sticker匿名smoke均ok且0 reasoning，只保留usage/latency/cost聚合。全量372 / 4836、typecheck与cache v5 golden通过。 |
| N-bot composition（REQ-PLAT-0001 T12） | ✅ fake / ⏳ opt-in real C | 2026-08-08 1/2/3-bot真实config loader→identity state→独立runtime→Poller→router→IPC global/filter stats全链；`--bot C`与未知id fail-fast。新增6 tests / 61 assertions；真实C token当前不存在，runbook已记录完整smoke/回滚清单。 |
| portable Pi launcher（REQ-ONBOARD-0001 T13a） | ✅ bootstrap / ⏳ real Telegram credential smoke | 2026-08-08 四个 Pi package 精确锁定 registry 0.84.1、lock 无 file dependency；launcher fake fresh/installed/failure 共4 tests，项目与无 `.env`/config/persona/node_modules/sibling Pi 的隔离目录均以 `bun run pi --version` 输出0.84.1。 |
| atomic onboarding config（REQ-ONBOARD-0001 T13c/T13j3） | ✅ core | 2026-08-08 `test/onboarding-config.test.ts` 8 cases覆盖fresh三文件+final loader/0600、`.env`仅Telegram token、生成config无模型字段、existing deny、peer/bot identity/token/persona validation、第二次rename失败全rollback、confirmed全量backup+env merge、existing validate/editor exact round-trip+confirmed replace、duplicate env key及provider-key surface审计。events仅phase/相对path；secret不进config/event/error。 |
| Pi native `/tg config`（REQ-ONBOARD-0001 T13d/T13j3） | ✅ fake host / ⏳ real Telegram credential smoke | 2026-08-08 extension+core覆盖loader失败仍有help/completion/dispatch；Pi model/auth在第一个dialog前preflight，固定失败category引导`/login`/`/model`且零目标文件；成功只显示模型，不询问provider/key。Pi原生select/input/confirm/editor完整首配，7个fresh dialog取消点零写入，existing editor取消逐字节不变；fake restart仅明确ready才attach，失败保留有效配置并脱敏token。 |
| 双语用户、机器文档与Pages（DOC-0001 / ONBOARD T13e/T13f） | ✅ local build/link + workflow contract / ⏳ 首次main deploy | 2026-08-08 中英README与各7章guide覆盖首配、配置、Pi、运维、排障和六项cost design；AGENTS一跳到maintainer开发/签名提交/发布流程。固定mdBook 0.5.4真实生成21个HTML；18个Markdown/92 links与生成站点600 links（含fragment、404资源、双向语言入口）通过。workflow action用不可变SHA，PR仅check/upload，main deploy最小pages/id-token权限且无secret；首次远端run需合并后由GitHub执行。docs targeted 4 pass / 24 assertions、typecheck通过。 |
| 固定 sticker set（REQ-STICKER-0001） | ✅ | 2026-08-07 test/sticker.test.ts 10 条：catalog 加载（media/short_id/file_id）、确定性序列化（含 [未识别]）、120 上限截断、坏 set 名不阻塞、send 解析 catalog id、动态候选排除 catalog sticker + 位置锁定在消息之后、visionless short_id 不崩；golden：目录块 hash 锁定（CACHE_SCHEMA_VERSION=2）；真实群冒烟：双 set 下载（114+98 个 sticker）vision 后台预识别 |
| sticker per-bot 可发送性（REQ-STICKER-0002） | ✅ unit / ⏳ real smoke | 2026-08-08 `test/sticker.test.ts` 用 A:s144 与 B:s241–s244 复现生产泄漏，锁 fixed/dynamic/shared/A-only mapping；部分 set fetch、candidate invariant preflight 与 cache v3 golden 一并覆盖。真实群各 bot 自身目录发送留到总验收。 |
| Pi 原生 transcript（REQ-UI-0001/2/4） | ✅ | 2026-08-08：package discovery/version guard、TUI-only custom entry、restore 不重连、单例 attach/more/detach、filter/cleanup、原生 `Image`；生产代码无手写 viewport/`handleInput()`/ANSI；真实 Pi fullscreen attach/more/detach smoke 通过。611 行是 `19819c9` 完成 UI-0004 时的基线，后续 compose/vision/footer 功能独立追踪，不把新增需求误算为旧 hack。 |
| Kitty/Ghostty原生媒体兼容（REQ-UI-0012） | ✅ unit / ⏳ real terminal smoke | 2026-08-08 extension/engine 50 pass / 469 assertions：forced Kitty首帧不发送raw WebP，完成后同一卡片的Pi Kitty payload解码为PNG signature；JPEG/GIF/WebP转换、PNG零转换、duplicate/vision/history/width去重、Ghostty/tmux/iTerm2/null能力、WebM fallback、reject/null/坏PNG/8 MiB上限、file revision、32项/32 MiB LRU、32 pending与detach/restart lifecycle均覆盖。真实Pi converter把仓库2×2 WebP转为PNG；全量279 / 4041、typecheck、cache v5 golden与diff check通过。真实Kitty/Ghostty sticker/photo resize/scroll留T14。 |
| 紧凑Pi原生sticker（REQ-UI-0013） | ✅ unit / ⏳ real terminal smoke | 2026-08-08 extension/engine 51 pass / 586 assertions：forced Kitty方形sticker锁24×12 placement，photo保持32×16实际placement（56×16上限）；40/80/120列逐行不溢出，label/emoji/vision保留，WebP异步转换后的原位卡片也保持24×12。全量287 / 4196、typecheck、cache v5 golden与diff check通过；真实Kitty/Ghostty视觉smoke留T14。 |
| Pi 原生 telemetry footer（REQ-UI-0003/7 T9b） | ✅ unit / ⏳ real smoke | 2026-08-08 targeted 53 pass：factory 返回真实 `FooterComponent`，精确 `↑13k ↓817 R20k CH60.6% $0.002 1.5%/1.0M`、global aggregate/latest model、24/80 列、compose status、session 不变、active/standalone 单 owner 与全 lifecycle restore；无 production stats widget/custom renderer，typecheck/cache golden 通过。真实 Pi TTY 留 T14。 |
| Pi 原生 `/tg` 分级补全（REQ-UI-0008 T10） | ✅ unit / ⏳ real smoke | 2026-08-08 targeted extension/cache 28 pass：共享递归 tree 驱动 help/parser/completion，A/B/C 动态 id/name、off、partial/whitespace、leaf、config error 与 future third-level 均覆盖，所有 suggestion 可被同 parser 接受；typecheck/cache golden 通过。真实菜单 Tab/选择留 T14。 |
| lifetime telemetry completeness（REQ-UI-0009 T10b） | ✅ unit / ⏳ real smoke | 2026-08-08 DB/runtime/IPC/plugin/cache targeted 70 pass：legacy file migration 幂等、cacheWrite/reasoning/latency persist+push、file DB close/reopen + daemon rebuild、removed bot exclusion、baseline/live once、Pi 原生 `W/CH`、session isolation、status detail/zero run；typecheck/cache golden 通过。真实 deployment restart/footer/status 留 T14。 |
| Pi feed 即时刷新与 assistant stream（REQ-UI-0010 T10i） | ✅ unit / ⏳ real smoke | 2026-08-08 flush/IPC/timeline/extension/cache targeted 75 pass / 592 assertions：start/update/end不落库、无matching listener不构造snapshot、thinking/text/tool-only args完整快照、A/B filter、pre-hello不推送、update-before-start、32 active/64 tombstone bounds、ANSI/OSC、end/disconnect、单 anchor entry，以及 `panel off` 后每次 feed change仍调用 host render；typecheck/cache v4 golden通过。真实首个 partial/连续刷新留 T14。 |
| Telegram response typing lease（REQ-TG-0002 T10j） | ✅ unit / ⏳ real smoke | 2026-08-08 activity/flush/sticker/router/cache 54 targeted pass / 2640 assertions：立即调用与0/4/8/12秒上界、per-bot隔离、单timer/in-flight、stop/restart、failure streak恢复/脱敏、accepted/skip/coalesce、text/sticker/组合send、pending reacquire、flush/stop清理、负数group payload与private draft=0均覆盖；typecheck/cache v4 golden通过。真实>5秒run与send/沉默自然清除留T14。 |
| Rich Message 收发（REQ-TG-0003 T10k/T10l） | ✅ unit / ⏳ real smoke | 2026-08-08 data plane覆盖nested inline、list/table/details/media/unknown、bounds、migration/edit/echo与projection-only；outbound targeted 61 pass / 730 assertions覆盖精确`sendRichMessage` payload、heading/list/code/table/quote、reply、canonical/broadcast/exposure、确定性400/404单次plain fallback、timeout/429/5xx/non-JSON/persistence不重发、manual compose保持plain与private draft=0。typecheck/cache v5 golden通过。真实rich/reply留T14。 |
| Direct reply provider delivery（REQ-REPLY-0001 T10o） | ✅ unit / ⏳ real trace | 2026-08-08 ingest/router/runtime/poller/cache targeted 70 pass / 2680 assertions：embedded parent sender/canonical fallback、bot sender隔离、reason+id dispatch、canonical+obligation transaction rollback、idle/busy/cooldown/stopping、provider failure retry、45 normal+1 reply首批、45 replies 40+5、A/B file reopen recovery、already-exposed reconciliation、legacy migration、无Telegram fallback与cache v5逐字节不变。真实群分别reply A/B并核对provider `#id`留T14。 |
| compaction（threshold→summary→epoch） | ✅ | 2026-08-07 e2e-compaction 强制触发，epoch 持久化+重启恢复；REQ-AGENT-0001 后补 e2e-compaction-manual：成功路径 epoch 4→5、kept tail 41 条精确重标（N≠40），失败路径（Nothing to compact）epoch 不动 + error 落库 |
| cache regression（prefix hash 稳定） | ✅ | 2026-08-07 golden 3/3（bun test 强制 UTC，测试内 pin TZ） |
| threshold 分析脚本 | ✅ | 2026-08-07 50 runs 回放，hit ratio 90.0%，当前规模下各候选均不触发 compaction |
| 长运行 smoke | ⏳ Phase 9 | - |
| 当前全量回归 | ✅ | 2026-08-08 `bun test`：383 pass / 0 fail / 4911 assertions；`bun run check` 通过；cache v5 golden 6/6；双mdBook 18 Markdown/98 links与21 HTML/608 links通过 |

## 已知 flaky

（暂无）

## Fixture replay

`test/fixtures/`（Phase 2 建立）：normal text / reply / selected quote / mention / text_mention / bot message / edit / photo / sticker / two-bot visibility / duplicate update。
