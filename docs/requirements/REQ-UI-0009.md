# REQ-UI-0009: Footer 使用数据库全生命周期 telemetry 并补齐原生指标

- **Status:** Specified（2026-08-08 已调查；待实现 cache-write/detail 增量）
- **Priority:** P1
- **Source:** 用户在 REQ-LIST 追问 footer token 是否为启动以来全部，并要求在可能时展示更多有用统计
- **依赖:** REQ-UI-0003、REQ-UI-0007

## 问题

当前 UI 已把 IPC `BotStats` 交给 Pi `FooterComponent`，但文档没有把累计起点说清，也没有用回归测试锁定 daemon/Pi 重启后的 lifetime 语义。Pi 原生 footer 还支持 `W`（cache write），而 `llm_runs` 虽记录 reasoning/latency，却没有持久化 cache write，也没有在 `/tg status` 中充分呈现这些明细。

## 调查结论

- daemon `loadStats()` 对 `llm_runs` 做无时间下界的 `COUNT/SUM`；因此当前 `↑/↓/R/$` 是**当前数据库 telemetry 保留期内、从第一条 LLM run 开始**的累计值，不是本次 Pi attach 或 daemon 进程启动后的局部值。它跨 daemon/Pi restart、context epoch 与 compaction 保留。
- snapshot 带 `lastId=MAX(llm_runs.id)`；timeline 只叠加 `id > lastId` 的 live usage，所以 baseline 与连接竞态不会双计。
- context 百分比必须取最近一次 run 的当前 context occupancy；把历史 `context_tokens` 相加后显示为 context 会失真。
- Pi `FooterComponent` 的标准 usage 行原生支持 `↑ input / ↓ output / R cache read / W cache write / CH / cost / current context / model / reasoning`。当前适配已提供除 `W` 外的全部字段；不得为 runs/epoch/latency/reasoning total 另造 footer 行。
- `llm_runs` 已有 `reasoning_tokens`、`latency_ms`；这些更适合进入完整 `/tg status`。新增 `cache_write` 后，原生 footer 可在非零时自动显示 `W`，不复制任何 renderer。

## 目标

把“数据库首次 telemetry 以来累计、跨重启不归零”固化为可测试契约；补齐 Pi 原生 footer 能表达的 cache-write 指标，并让 `/tg status` 提供其余有价值的 lifetime/latest 明细。

## 非目标

- 不提供“仅本次 daemon 进程”或任意时间窗口 dashboard；需要窗口分析继续使用 SQLite/分析脚本。
- 不把累计 `context_tokens` 冒充当前 context occupancy。
- 不新增 footer 第三行、自定义 renderer、图表或 session-name/status hack。
- 不回填历史 provider 没有记录的 cache-write；未知历史值按 0，不能估算。

## 需求

- **R1 — lifetime 定义：** filtered stats 聚合该 bot 在当前 SQLite `llm_runs` 中的全部保留行；global stats 只聚合当前配置 bots 的全部保留行。daemon restart、Pi restart、attach/detach、epoch/compaction 均不得归零。
- **R2 — baseline/live 精确性：** snapshot 的 aggregate 与 `lastId` 必须来自同一同步查询边界；live 只累计更大 id，每个 run 恰好一次。重连以 DB snapshot 重新建立权威基线。
- **R3 — 最大原生字段集：** footer 映射 `↑=ΣcacheMiss`、`↓=ΣoutputTokens`、`R=ΣcacheRead`、非零时 `W=ΣcacheWrite`、`CH=read/(miss+read+write)`、`$=Σcost`；context/model/reasoning 仍来自最新 run/选中 bot。字段显示、隐藏、精度与窄屏降级全部由 Pi `FooterComponent` 决定。
- **R4 — telemetry 持久化：** `llm_runs` 新增 `cache_write INTEGER NOT NULL DEFAULT 0`；新 run 写 provider `usage.cacheWrite`。现有 DB 用幂等 migration 加列，历史行保持 0。
- **R5 — additive IPC：** `UsageRun`/`BotStats` additive 暴露 cache write、reasoning、latency、first-run time 与 latency sample totals；新 client 对旧 daemon 缺字段按 0/null，旧 client可忽略新字段。
- **R6 — 完整详情：** `/tg status [bot]` 明确标注 lifetime scope，并展示 runs/since/current epoch、latest context/read/miss/write/output/reasoning/latency/cost，以及 lifetime token/cache/cost/reasoning 与平均 latency；无 run/null latency 时文案确定且不出现 NaN。
- **R7 — 原生/上下文边界：** footer 仍直接返回 Pi `FooterComponent`，不得新增 production footer `render()` 或额外 status line；telemetry 只进 IPC/TUI，不写 Pi session、不改 provider payload。

## 验收标准

- **AC1:** 同一 file DB 在 daemon A 写入 epoch 1、关闭后由 daemon B 读取，再加入 epoch 2 live run；footer totals 等于所有行一次且只一次，detach/reattach 数值不归零。
- **AC2:** fixture 含 miss/read/write/output/cost 时，真实 Pi `FooterComponent` render 出现 `↑/↓/R/W/CH/$`，CH 使用含 write 的原生分母；write=0 时 Pi 自己隐藏 `W`。
- **AC3:** 旧 schema file 经 `openDb()` migration 后保留原 llm_runs 行、`cache_write=0`，第二次 migration 幂等；新 run 精确持久化并 live push cacheWrite/reasoning/latency。
- **AC4:** `/tg status` 对单 bot、global、零 run、null latency 输出稳定；global 使用配置 bot 集合，不把 DB 中已移除 bot 混入。
- **AC5:** cache golden/provider message hashes 逐字节不变；Pi session entries 在 telemetry 更新前后相同。
- **AC6:** targeted DB/runtime/IPC/plugin tests、`bun test`、`bun run check` 与真实 Pi footer/status restart smoke 通过。

## 约束

- Cache impact: **NONE**。这是 provider response telemetry 的持久化/展示补全，不改变 system prompt、tool schema/order、message/summary grammar 或 provider request bytes；不 bump `CACHE_SCHEMA_VERSION`。
- Token impact: 0；不新增模型请求或 provider-visible context。
- DB migration 必须幂等、保留现有数据；cache-write 历史未知值不可伪造。
- footer 宽度优先级由 Pi 决定；“更多统计”不能以破坏原生样式为代价。

## 可观察性

- footer 是 lifetime token/cost + latest context 的紧凑原生视图。
- `/tg status` 是完整 lifetime/latest 数值权威。
- 时间窗口、epoch 对比与成本分析继续使用 `llm_runs` / `scripts/analyze-context-window.ts`。

## 文档影响

`docs/data-model.md`、`docs/architecture.md`、`docs/runbooks/daemon.md`、`docs/testing.md`。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs` T10a/T10b
- Commits: 从 `Requirement: REQ-UI-0009` trailer 查
