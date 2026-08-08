# REQ-VISION-0001: cache-visible 视觉结果在 provider 提交前同步确定

- **Status:** Completed（2026-08-08；fake、全量与匿名真实基准均通过）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「群聊图像与未识别sticker要在bot读上下文前同步；目录sticker保持异步；用Codex 5.6 Luna low并按成本/延迟数据取舍」
- **依赖:** REQ-AGENT-0001、REQ-STICKER-0001、REQ-UI-0006、REQ-PLAT-0002

## 问题

UI会在视觉结果落库后异步刷新，sticker catalog也在daemon启动后后台预识别；从外部看容易推断provider先收到`[未识别]`、下一轮又被改写，破坏append-only cache prefix。需要区分三条不同路径并用测试锁住真正的provider边界。

## 调查结论

- 动态群消息路径已经同步：`flush()`先`await ensureBatchVision(batch)`，再`serializeMessages()`，最后`session.sendUserMessage()`。慢vision期间新trigger只coalesce；没有同一消息先placeholder后改写provider history。
- Pi `vision_update`只是识别落库后的TUI side channel，不进入Pi session或provider payload，对cache hit没有影响。
- configured sticker catalog在`init()`中先建立一次system prompt snapshot，后台识别不会原位修改当前AgentSession prefix；可能影响的是未来restart重建出的catalog，而不是当前epoch内的每turn hit。
- 当前两个configured catalog共220项，pending=0。现有llm_runs聚合cache hit约98.7%；多个historical system hash还包含本轮大量已记录schema/persona变更，不能归因于异步UI。
- T13k1b实现后按同一只读口径复核：configured catalog仍为220项、pending=0，历史`llm_runs`聚合hit ratio为98.74%；审计只输出聚合数，不输出bot/media/system hash或内容。
- T13k1c新增显式双fixture、每类1–10次的匿名benchmark；输出只含model、成功率、p50/p95、token、cost、bytes bucket、outcome与2倍baseline gate。实现后当前deployment各1次复测：photo 3,312ms / 994 input / 53 output / 0 reasoning / $0.000262；static sticker 4,309ms / 332 input / 70 output / 0 reasoning / $0.000150，两者均成功并低于7,738ms / 5,376ms gate。每类n=1时p50=p95，只是验收smoke，不宣称分布。
- 把全部catalog vision改为startup阻塞可能让首次ready等待数分钟并破坏polling/onboarding可用性；在没有cache miss证据时不应把side-channel异步一刀切成全局阻塞。
- 2026-08-08用Pi现有OAuth、`openai-codex/gpt-5.6-luna`、`reasoning=low`做了不输出内容的两次真实基准：50,429-byte photo为3,869ms / 1,027 input / 64 output / 0 reasoning / $0.0002822；24,710-byte WebP sticker经Pi本地转PNG后为2,688ms / 346 input / 46 output / 0 reasoning / $0.0001244。另一个WebM sticker按预期不适合静态vision。样本各1，不能外推百分位，但说明单项是秒级而非零延迟。

## 目标

把“任何将进入当前provider动态消息的photo/sticker vision必须在首次提交前resolve或受控失败”变成可测试invariant；通过Pi共享认证的Luna low执行同一次必要识别，并以最多2路并发降低多媒体batch墙钟时间。明确UI/本地下载继续异步且不得改provider bytes；保留catalog后台可用性，但当前session的system prompt对象构建后不可被completion改写。

## 非目标

- 不让daemon为整个sticker set的远程视觉调用阻塞ready，不把TUI下载/渲染变成同步I/O。
- 不保证vision成功；失败时当前batch使用既有确定性placeholder，后续不得改写已提交消息。
- 不增加vision调用数、cache schema或调用预算；本需求会把执行器从Codex CLI子进程收口到Pi `ModelRuntime`并固定Luna low边界。
- 不用当前高hit ratio宣称因果或固定百分比收益。

## 需求

- **R1 — provider gate：** 对batch内每个支持的、尚无持久vision的media有界等待`ensureVision`settle后才序列化；最多2个不同identity并发，`sendUserMessage`不得在任一promise pending时调用。
- **R2 — 单次序列化：** vision成功时首次suffix直接含description；失败/unsupported时首次suffix含确定性fallback。该message一旦exposed，后来的DB变化不得重发或改写旧provider entry。
- **R3 — cache hit复用：** 已有vision不调用download/describe；同identity并发调用共享in-flight。UI prefetch产生的local_path可减少下载，但不得绕过provider vision gate。
- **R4 — side-channel隔离：** `vision_update`、`media_ready`、Pi render和本地文件完成保持异步；cache golden与provider trace证明这些事件0字节进入system/tools/messages/summary。
- **R5 — catalog snapshot：** runtime只在创建AgentSession前调用一次`stickerCatalogBlock()`；后台completion不重建system prompt/session。注释与文档不得再声称后台vision已在prompt构造前完成。
- **R6 — telemetry口径：** cache分析按system hash/epoch区分显式schema/persona/catalog snapshot变化与同epoch hit；不得用UI完成顺序推断provider cache。
- **R7 — Pi视觉执行器：** 使用REQ-PLAT-0002的shared `ModelRuntime`解析`openai-codex/gpt-5.6-luna:low`；静态WebP/GIF先用Pi公开converter转PNG，JPEG/PNG直接发送，TGS/WebM确定性unsupported。单次max output 256、timeout 90秒、provider retry 0。
- **R8 — 实测边界：** production只记录kind、source/converted bytes bucket、latency、input/output/reasoning token、cost与outcome，不记录媒体identity/path/prompt/response。未来调参至少比较同一fixture的成功率、p50/p95、成本与provider input token，不能只凭体感。

## 验收标准

- **AC1:** deferred vision fixture在release前断言`sendUserMessage`调用数为0；release后首次发送恰好一次且suffix直接含vision结果，不出现先placeholder后第二次message。
- **AC2:** vision failure/unsupported也只发送一次确定性fallback并按exposure规则settle；重试trigger不重写已exposed message。
- **AC3:** cached与同identity concurrent fixture证明describe/download各至多一次；UI media-ready/vision-update先后顺序不改变captured provider bytes/hash。
- **AC4:** catalog background completion前后当前runtime `systemHash`与AgentSession system prompt引用不变；测试不真实调用远程vision。
- **AC5:** 当前deployment只读审计记录catalog pending=0及aggregate hit/miss，不输出persona/system hash值、消息或媒体内容。
- **AC6:** targeted flush/vision/cache、全量与typecheck通过；cache schema保持当前值，golden逐字节不变。
- **AC7:** fake Pi runtime锁定model/ref、`reasoning=low`、256 token、90秒abort、0 retry和text extraction；unknown/no-image/error/empty response均受控fallback且不泄露上游正文。
- **AC8:** 1/2/3 media deferred fixture证明并发峰值≤2、三项wall time按两批完成、每identity一次调用；catalog后台任务不阻塞runtime ready。
- **AC9:** opt-in匿名benchmark可复现photo/static sticker两类聚合；实现后当前deployment真实样本不劣于调查基线的2倍延迟且0 reasoning token，若外部抖动导致失败则如实记录未通过而不伪造数据。

## 约束

- Cache impact: **NONE**。这是现有provider gate的回归与side-channel边界澄清，不改变system/tool/message/summary grammar。
- Token / 成本: 0新增vision/LLM call；动态媒体只等待本来就需要的同一次vision。最多2路并发改变墙钟时间而不改变调用数；不能为了UI eager识别。
- 可用性: 单媒体沿用90秒vision timeout；全catalog不阻塞daemon ready。
- 兼容性: 不改DB/IPC/provider格式；未来若要刷新stable catalog，须明确cache boundary另开REQ。
- 安全 / 隐私: 审计只输出聚合计数/ratio，不输出图片、描述、path或hash。

## 例子与边界 case

- photo命中bot：typing可异步显示，但provider调用等待Luna low vision；完成后一次提交含描述。
- photo未命中任何bot：不做vision；UI-0014可异步下载展示，不产生provider token。
- 220项catalog首启：后台识别，不让Telegram offline数分钟；当前session prefix固定为构造时snapshot。

## 可观察性

测试记录调用顺序；production增加脱敏vision usage/latency聚合，provider主run继续沿用llm_runs hash/usage。不得新增包含vision正文的cache日志。

## 文档影响

实现时修正runtime注释、architecture/cache的视觉时序、testing、双语cost说明、devlog/handoff。

## 待决问题

catalog在未来restart吸收新vision是否需要显式epoch/hash gate，超出本次“当前provider提交前同步”范围；若生产system hash证明它造成重复miss，另开cache migration REQ，不在本任务引入持久snapshot系统。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13g/T13k`
- Behavior commits: `f4ff63b`（shared Pi vision executor）、`6efd768`（两路provider gate与脱敏遥测）、`8b2d410`（匿名真实基准）
- 完整查询：从 `Requirement: REQ-VISION-0001` git trailer 查
