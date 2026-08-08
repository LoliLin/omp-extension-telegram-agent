# REQ-TEST-0001: 测试体系修复（网络隔离、golden 补全、e2e 可信）

- **Status:** Done（2026-08-08；全量guard、cache golden与e2e退出语义已验收）
- **Priority:** P2
- **Source:** 2026-08-07 code review

## 问题

1. **`bun test` 实际触网络**：`test/runjs.test.ts` 在 unit 套件里真实调用 TinyFish API，与 `docs/testing.md`「unit 不触网络」矛盾——离线 / 无 key 环境全量测试失败，且消耗 API quota。
2. **cache golden 只锁了一半协议面**：`test/cache.test.ts` 锁了 system prompt + 消息序列化 grammar，但 tool schema / tool 顺序 / compaction 摘要 grammar 同样是 cache-visible 协议（`docs/cache.md`），无任何 golden——tool 定义漂移只有账单能发现。
3. **「bot 消息不触发」invariant 无测试兜底**：该 invariant 由 `daemon/index.ts` 调用点的 `is_bot` 前置判断保证，`routeMessage` 本身不检查；重构调用点即可引入 bot 互相触发死循环，没有测试拦得住。
4. **e2e 脚本永不 fail**：`e2e-agent.ts` 未 settled 也 exit 0；`e2e-compaction.ts` 连断言都没有，固定 45s sleep 慢且 flaky。
5. **分析脚本系统性偏差**：`analyze-context-window.ts` 忽略已发生的真实 compaction（`llm_runs` 有 epoch / compaction 列却没用），真实回落被当 0 增长，候选阈值越小越容易触发「幻影 compaction」，compaction 次数与成本被高估。

## 目标

测试给人的安全感与实际保障一致：unit 真离线、cache 协议面全锁、e2e 结果可信、分析工具不误导。

## 非目标

- 不追求覆盖率数字；只补有真实风险的盲区。
- 不重写现有高质量测试（router 属性测试、cache golden 思路保持）。

## 需求

- **R1:** TinyFish 真实调用彻底移出 `bun test`；测试preload在任何`.env`状态下阻断非loopback fetch。真实调用只允许用户明确授权的opt-in e2e或一次性脚手架，验证后删除，不得按key存在自动启用。
- **R2:** cache golden 增加：tool schema 序列化 hash（含顺序）与 compaction 摘要 prompt grammar hash；任一漂移即测试失败。
- **R3:** 「bot 消息不触发」下沉到 `routeMessage` 内部判断（单一权威点），或至少加一条 daemon 层路由测试；两种方案开工时择一。
- **R4:** e2e 脚本按断言结果决定 exit code；`e2e-compaction.ts` 轮询 compaction 事件（带超时）替代固定 sleep。
- **R5:** `analyze-context-window.ts` 检测真实 context 回落 / epoch 变化时同步重置模拟 context；输出标注数据中含真实 compaction 的区间。
- **R6:**（附带盲区补测）run_js：4KB 截断、代码长度上限、运行时异常路径；serialize：vision 替换后占位、`(edited)`、text+media、跨天分隔；ingest：edit-before-original、forward_origin、sender_chat。

## 验收标准

- **AC1:** 无`.env`时`bun test`全绿；存在真实`.env`时也机械拒绝外网并保持全绿、零付费调用。
- **AC2:** 手动改动任一 tool 的 description 或调整注册顺序，golden 测试失败；改回后恢复绿。
- **AC3:** 构造 is_bot=true 的消息进路由层，任何配置下都不产生 trigger（测试锁定）。
- **AC4:** `e2e-compaction.ts` 在 compaction 未发生时 exit≠0；正常时 exit=0 且耗时不含固定 sleep。
- **AC5:** 用含真实 compaction 的遥测数据跑分析脚本，compaction 计数不再出现幻影触发（用合成数据集验证）。
- **AC6:** `bun run check` 通过。

## 约束

- Cache impact: **NONE**（只加测试与脚本修复，不改 provider payload；R2 是锁定现状而非改变现状）。
- 不得为了让 AC1 通过而删除协议覆盖；真实网络用例改为loopback fake，付费smoke只保留脱敏结果记录，不保留自动调用。

## 例子与边界 case

- e2e 在 DeepSeek 偶发 500 时：报告失败原因并以非零退出，不静默「通过」。

## 可观察性

- 不适用（测试自身）。

## 文档影响

- `docs/testing.md`（分层表与实际行为重新一致）。

## 待决问题

- R3 选「下沉 routeMessage」还是「daemon 层测试」？倾向前者（invariant 应有单一权威点），开工时确认。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
