# REQ-OBS-0001: 结构化全链路日志与 agent debug 门禁

- **Status:** Done（workspace；未授权 commit）
- **Priority:** P0
- **Source:** REQ-SEND-0003 生产诊断暴露的可观察性缺口

## 问题

当前项目同时依赖自由文本 `console.*`、SQLite `agent_events`、`llm_runs`与业务表。已有信息足以人工定位REQ-SEND-0003，但需要多次临时SQL和日志正则；日志格式、字段、边界、关联方式与轮转没有统一契约，新功能也没有被要求提供可诊断证据。

`data/daemon.log`只追加不轮转；部分错误直接串行化`Error`或原始参数，容易泄露路径、URL、上游正文或secret。相反，flush packing、tool preflight等关键状态又没有稳定事件，agent无法机械区分传输失败、模型沉默与本地拒绝。

## 目标

建立一个默认安全、有界、可关联、可测试的本地debug系统；让人和coding agent用一个只读入口判断每条响应机会停在哪个边界，并把debug设计纳入以后每项功能的完成定义。

## 非目标

- 不接入外部日志/telemetry SaaS，不上传本地数据。
- 常规日志/默认报告不记录消息正文、persona、prompt、provider response、thinking、token、完整URL/path或stack；显式单bot本机取证可只向stdout展示当前provider投影。
- 不新增provider tool、模型调用或多群/多租户机制。
- 不让日志成为业务正确性的持久权威；SQLite业务状态与session仍是authority。

## 需求

- **R1 — 结构化日志:** daemon生产日志必须使用统一JSONL envelope：schema、timestamp、level、component、event与有界fields；level/component/event可检索，非法字段、深层对象、控制字符和超长值被拒绝或归一化。
- **R2 — 默认脱敏:** secret-like字段名与Telegram/provider credential形态必须在sink前脱敏；业务调用不得把正文、prompt、response、query、URL/path或stack交给logger。
- **R3 — 生命周期覆盖:** ingestion/poller、routing/claim、runtime flush/packing/provider、tool/send、Telegram commit、IPC、media与daemon lifecycle至少各有稳定事件；response opportunity必须能用bot/message/run/epoch等现有非正文身份关联，并明确started/skipped/silence/preflight_failed/committed/degraded。
- **R4 — 有界存储:** daemon log启动前按固定上限轮转，保留数量有界、文件权限0600；foreground仍输出同一JSONL格式。SQLite telemetry继续沿用既有retention。
- **R5 — 诊断报告:** `bun run debug -- [--bot <id>] [--since <duration>]`只读打开当前deployment，输出有界、脱敏JSON，包含daemon状态、cursor/high-water/obligation、最近claims/runs/events/logs和机械异常摘要；不得触网络、provider、Telegram或写DB。
- **R5a — Provider context:** 默认报告必须给出provider/model/api/cache、完整tool schema和每条active message的role/type/长度/hash/tool identity，正文省略；`--show-provider-content --bot <id>`才输出完整system与当前compaction-aware message content，并明确它是pre-adapter重建而非历史HTTP抓包。
- **R6 — agent指南:** 新增权威debug指南，给出证据梯、事件字典、关联步骤、隐私红线、复现/回归模板；根AGENTS与development guide强制任何新功能在设计前阅读并填写Debug impact，完成前验证成功/失败/沉默路径可诊断。
- **R7 — 兼容:** 既有`agent_events`/`llm_runs`、IPC、provider payload与Telegram语义保持兼容；legacy daemon log行可被debug报告忽略或作为有界legacy记录处理。

## 验收标准

- **AC1:** logger fixture对正常fields输出单行可解析JSON；secret key/token、控制字符、深层/超长输入不会原样出现，且输出有严格byte/field上限。
- **AC2:** production-source审计不再存在daemon runtime的裸`console.*`（CLI与离线scripts除外）；关键响应链测试可观察route、flush pack、provider settle/silence、reply preflight与send outcome事件。
- **AC3:** 超过上限的daemon.log在受控spawn前轮转为有界代数，所有文件mode 0600；重复轮转不超保留数。
- **AC4:** 内存/file SQLite fixture生成route-started、silent run、preflight failure、degraded send与pending obligation后，debug报告正确分类且不含fixture正文、token、绝对路径或URL。
- **AC5:** `AGENTS.md`、REQ template、development guide与debug guide形成可执行闭环；文档门禁通过。
- **AC6:** cache golden完全不变，全量unit/typecheck通过；自动测试继续零外网。

## 约束

- Cache impact: **NONE**；日志与诊断完全位于provider payload外，禁止改tool/system/serializer/summary grammar。
- 兼容性: 不改IPC与消息grammar；优先复用既有SQLite列与事件，不为日志新建平行业务数据库。
- 性能 / token成本: 每日志事件字段/bytes有硬上限；诊断查询有limit与索引边界；0新增LLM call/provider token。
- 安全 / 隐私: 本地日志仍按敏感运维数据处理，0600；脱敏是纵深防御，不授权调用者传内容。
- 数据 / 迁移: 无业务schema migration；daemon.log轮转可保留最近固定代数。
- 运维: restart后启用结构化日志；旧自由文本日志不会被重写。

## 例子与边界 case

- route started但120秒内无`llm_runs`：报告`route_without_run`，不是“Telegram发送失败”。
- run完成、`public_send_count=0`且有`assistant_text`：报告`model_silence`。
- `tool_result isError`且对应`reply_not_visible`安全category：报告`tool_preflight_failed`，不输出tool args正文。
- `send_degraded outcome=committed`：报告remote commit成立且禁止重试。
- daemon.log含历史自由文本：报告只收最后有界行并标legacy，不尝试从正文推断业务状态。

## 可观察性

本REQ本身定义权威日志/诊断契约；稳定事件字典与操作步骤放`docs/engineering/debugging-guide.md`，代码事件名由logger调用与测试锁定。

## 文档影响

新增debug guide；同步AGENTS、development guide、REQ template、architecture、data model、testing、maintainer/runbook、index、devlog与handoff。

## 待决问题

无外部sink。若未来需要导出bundle或远端采集，必须另开REQ并重新评估内容与consent边界。

## 追溯

- Plans: `PLAN-20260809-observability-debugging`
- Commits: 从`Requirement: REQ-OBS-0001` trailer查；当前用户未授权commit。
