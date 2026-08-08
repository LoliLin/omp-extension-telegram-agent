# REQ-DOC-0002: 明确单目录单群与极简省 token 的项目哲学

- **Status:** Done（2026-08-08；implementation `dfc23b5`）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「强调为什么一份工作目录只能安全运行一个群 deployment；强调极简、极省token和项目哲学，让以后Agent避免过度设计」
- **依赖:** REQ-DOC-0001、REQ-ONBOARD-0001、REQ-PLAT-0001

## 问题

README和guide已经写“一工作目录一群”，AGENTS也要求最小改动、确定性代码与有界token，但原因和共同哲学散落在project/architecture/cache/operations。用户容易把限制理解为临时缺功能；后续Agent也可能为一个需求引入多群热加载、第二套UI/terminal协议、额外LLM判断或无界抽象。

## 调查结论

- 当前`group_peer_id`只有一个；SQLite canonical key、poller offset、reply obligation、exposure、router secret、session目录、PID/control lock和Unix socket均由工作目录/data根拥有，不带deployment namespace。
- 在同目录只切`bots_config`并发运行会共享/竞争上述资源：可能跨群混合history/context、错用offset、争抢PID/socket或把一个群的状态暴露给另一个群。隔离worktree/checkout是简单且可验证的安全边界。
- 项目已有正确取向：Telegram/SQLite/Pi三世界分离、优先provider cache、确定性route/SQL、Pi原生组件、最小vertical slice。缺的是一段权威“为什么”与用户/Agent双向链接，而不是新架构。

## 目标

用户文档清楚解释单目录单群的技术/隐私原因和多群正确做法；项目/开发指南把“用最少状态、网络调用、provider bytes和自建组件完成可验证结果”确立为稳定设计准则。后续Agent能在动手前看到并机械检查cache/token/复杂度影响。

## 非目标

- 不实现同进程/同目录多群、多租户、热加载、资源namespace或Web后台。
- 不把“极简”解释为少测试、少错误处理、牺牲数据正确性或把所有逻辑塞进单文件。
- 不承诺未经telemetry支持的token节省百分比。
- 不复制architecture/cache全文到README。

## 需求

- **R1 — 单群原因：** 中英用户指南明确列出至少DB/history、session/exposure、poller offset、PID/socket四类未namespace资源及错误共享的后果；多群只推荐隔离工作目录和全部data/process/secret。
- **R2 — 用户哲学：** README/guide用短段落说明Telegram是聊天面、SQLite是完整事实、provider只看必要有界上下文；routing、stable prefix、lazy expensive work和Pi side channel如何减少调用/token。
- **R3 — Agent准则：** 根AGENTS保持短但明确：优先复用现有拥有层/Pi组件/确定性代码；满足AC的最小状态与接口；未经REQ不得扩成多群/多租户或新增平行框架。
- **R4 — 开发检查：** development/maintainer流程要求每个方案回答“能否删除一层/一个tool/一次模型调用/一个动态字段”，同时不允许借极简削弱测试、安全、兼容或可观察性。
- **R5 — 单一权威：** project拥有哲学与deployment边界；architecture/cache拥有技术invariant；README/双语guide只总结并链接，避免五份易漂移规则。
- **R6 — 机械验证：** 文档测试检查中英单群原因、六项成本机制、AGENTS到project/development链接和“不得过度设计”规则；双mdBook/link check保持通过。

## 验收标准

- **AC1:** 新用户从中英README各一跳到解释页，能回答“为何不能只换config并行第二群”和“怎样安全运行第二群”，无需读源码。
- **AC2:** 中英说明覆盖R1四类资源和cross-group history/context/进程冲突风险，内容语义对等。
- **AC3:** AGENTS一跳可达project/development/maintainer权威规则，并出现可执行的最小设计约束；不得增加冗长教程。
- **AC4:** design-cost/project明确六项既有节省机制且无百分比；检查工具/schema新增时必须写稳定prefix与每turn token上限。
- **AC5:** repo文案审计不把当前私人deployment、固定bot数或本机路径当产品哲学。
- **AC6:** docs targeted、双mdBook source/generated link、全量与typecheck通过。

## 约束

- Cache impact: **NONE**。只改开发/用户文档与机械文档测试，不改runtime/provider bytes。
- Token / 成本: 文档要求未来每task显式评估；本身0 provider call/token。
- 兼容性: 单目录单群是现状invariant，不改变配置或运维行为。
- 安全: 不在示例放真实peer/token/persona/path；多群隔离包含secret/data/process全部资源。
- 写作: 使用具体因果和安全动作，不用“优雅、生产级”等空泛口号。

## 例子与边界 case

- 错误：同checkout开两个daemon，仅用不同`bots_config`。两者仍争同pid/socket/DB，配置文件不同不构成隔离。
- 正确：第二个worktree拥有独立`.env`、config、persona、data/db/session/pid/socket和bot tokens。
- 极简不等于hack：Pi已有Image/Footer/dialog就复用；SQLite transaction/timeout/测试仍必须完整。

## 可观察性

文档测试与link checker是机械证据；未来代码task继续在devlog写Cache impact和token边界。

## 文档影响

实现时更新AGENTS、project、development/maintainer guide、中英README/user guide、testing、devlog/handoff。

## 待决问题

无。同目录多群若未来成为目标，必须另做数据/进程namespace ADR与migration，不能把本需求文字删除后直接实现。

## 实现证据

- `dfc23b5`：project权威原则、AGENTS/development减法检查、中英README/operations/cost guide与文档gate。
- 验证：7个docs tests / 62 assertions；双mdBook 18 Markdown / 98 links、21 HTML / 608 links；全量340 tests / 4641 assertions与typecheck通过。
- Cache impact: **NONE**；只改文档和文档测试。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13g/T13h1/T13h2`
- Commits: 从`Requirement: REQ-DOC-0002` git trailer查
