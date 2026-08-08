# REQ-ROUTE-0002: 验证概率桶频率并区分回应机会与公开发言

- **Status:** Done（2026-08-08；implementation `a1321f1`）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「概率采样似乎出问题；两者互斥0.66/0.34，但看起来频率完全不同，检查」
- **依赖:** REQ-ROUTE-0001、REQ-SEND-0001

## 问题

用户从群里两只bot实际发言数量观察，感觉不符合`routing_p=[0.66,0.34]`。当前只有daemon本次进程的route counter；配置指南只写概率桶，没有明确说明routing_p控制“普通human消息的回应机会”，并不直接控制LLM run总数或公开发送数。

## 调查证据

2026-08-08 对当前SQLite与脱敏daemon log只读重放：

- effective配置确为`[0.66,0.34]`，和为1；同一HMAC值只落一个累计桶。
- 当前配置重放的2,038条`reason=probability` human消息中，bot-1=1,367（67.08%）、bot-2=671（32.92%）。
- daemon log中实际started opportunity为575/286（66.78%/33.22%）；另有busy skip 117/60、cooldown skip 93/22，均未重分配。
- 当前两只bot canonical公开消息为404/372（52.06%/47.94%）。它混合了mention/reply/name、persona选择沉默、历史配置、send失败与人工compose，不能作为概率桶样本。

因此HMAC互斥采样本身符合配置；可观察口径不足导致把“公开发言比例”误当“普通消息被分配的回应机会比例”。

## 目标

提供一个不读消息正文、不调用LLM的确定性审计命令，分别报告配置概率、probability bucket assignment、lifecycle outcome、LLM run和公开消息口径；双语配置文档明确routing_p语义。未来出现偏差时能区分算法、调度、persona沉默和样本量。

## 非目标

- 不为了让公开发言数贴近0.66/0.34而强迫模型发送、修改persona或重分配busy target。
- 不改变mention/reply/name优先级、2秒cooldown、exposure或HMAC secret。
- 不新增数据库route event表或把消息正文写入遥测。

## 需求

- **R1 — 互斥不变量：** 对每条非bot普通消息只计算一个`u∈[0,1)`并按config顺序落至最多一个累计桶；Σp=1时概率阶段没有nobody。duplicate poller update不得重复采样。
- **R2 — 审计脚本：** `bun run scripts/analyze-routing.ts`从production loader、SQLite与可选daemon log只读计算；默认使用当前effective routing config，输出bot序号/配置概率/assignment/start/busy/cooldown/run/public count与百分比。
- **R3 — 隐私：** 输出不含bot名称、用户名、peer id、router secret、message id、正文、persona/path或token；log不存在/不完整时明确标`unavailable/partial`，不伪造0。
- **R4 — 口径：** assignment只统计`reason=probability`；explicit/name/reply分别列数。bot消息单列ignored。started是response opportunity，公开message是最终结果，脚本不得把二者声称为同一分布。
- **R5 — 统计诚实：** 显示样本数和observed ratio，不用小样本判bug或给伪精确置信结论；确定性property test才验证算法。
- **R6 — 文档：** 中英配置指南明确Σp=1=每条eligible human普通消息恰有一个概率target；busy/cooldown会skip、明确触发会绕过、LLM可保持沉默，因此群内发言比例无需等于routing_p。

## 验收标准

- **AC1:** 固定secret对至少100,000个连续message id验证每条只落一个桶；`[0.66,0.34]` observed assignment在统计容差内，重复运行逐字节一致。
- **AC2:** fixture混合probability/explicit/name/reply/bot消息和started/busy/cooldown log；脚本逐栏精确，Σp=1的eligible probability无nobody。
- **AC3:** log缺失、截断、未知bot id、空DB、单bot/N-bot与override config均安全输出partial状态，无NaN/除零。
- **AC4:** captured output通过privacy denylist，且不包含fixture message id/text/name/secret/path。
- **AC5:** 当前deployment运行脚本复现约67/33 assignment与started口径；若偏离上述调查值，应先解释新增样本/override而不是改算法。
- **AC6:** `bun test test/router.test.ts test/analyze-routing.test.ts`、全量、typecheck与cache golden通过。

## 约束

- Cache impact: **NONE**。只读分析和文档，不改routing/provider payload、tool schema或context epoch。
- Token / 成本: 审计纯SQL/HMAC/regex，0 LLM call、0 provider token；不为观测增加runtime持久写。
- 兼容性: 不改变REQ-ROUTE-0001“不重分配”与explicit语义。
- 性能: 默认单次线性扫描本地message/log；输出聚合，不保留正文。
- 安全 / 隐私: secret只在内存用于HMAC，永不输出。

## 例子与边界 case

- assignment 66/34、started 66/34、公开52/48：算法正常；差异来自明确触发和模型最终选择。
- A桶命中但A busy：记assignment A + skipped_busy A，不改投B。
- Σp<1：剩余区间明确记probability nobody，不和bot消息ignored混为一栏。

## 可观察性

脚本stdout是人工审计报告，不写DB。生产route log仍只含固定metric/bot/message id；本需求不扩大日志内容。

## 文档影响

实现时更新双语configuration、architecture Routing、testing、devlog/handoff。

## 待决问题

无。当前证据不授权改变采样算法；若用户未来要求“强制公开发言比例”，必须另开与persona/send契约冲突评估的REQ。

## 实现证据

- `a1321f1`：production loader + readonly SQLite审计、16 MiB有界partial log、匿名formatter、双语口径与完整fixture/property回归。
- 验收快照：2,046个current-effective probability样本为1,372/674（67.06/32.94%）；daemon partial started为580/289（66.74/33.26%）；public为406/374（52.05/47.95%）。相对调查基线增加的是新消息/新run，分桶结论不变。
- 验证：routing targeted 22 tests / 2,390 assertions；全量347 tests / 4,700 assertions；typecheck、cache v5 golden、双mdBook 18 Markdown / 98 links与21 HTML / 608 links通过。
- Cache impact: **NONE**；命令只读、0 provider/LLM call，不改routing或provider-visible bytes。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13g/T13i1/T13i2`
- Commits: 从`Requirement: REQ-ROUTE-0002` git trailer查
