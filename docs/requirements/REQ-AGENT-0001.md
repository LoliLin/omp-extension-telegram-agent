# REQ-AGENT-0001: agent 触发 / flush 生命周期收敛为串行状态机

- **Status:** Done（2026-08-08；串行 flush/compaction 全链回归与生产运行已验收）
- **Priority:** P0
- **Source:** 2026-08-07 code review（生产 daemon.log 已发生真实消息丢失）

## 问题

`src/agent/runtime.ts` 的 `trigger → flush → agent run` 异步链上，`running` / `pendingTrigger` / `exposed` 三个状态没有统一所有者，异常与并发路径无防护：

1. **flush 可重入**：`trigger()` 用 `this.running`（由 SDK `agent_start` 事件置位）做门，但 flush 在 `sendUserMessage` 前有 vision 等 await（单个最长 90s），窗口内第二个 trigger 并发进入 flush → 同批消息被重复序列化。生产日志已出现 `Agent is already processing a prompt`。
2. **消息持久丢失**：`markExposed(batch)` 在 `await sendUserMessage` **之前**执行；send 失败时这批消息被标记 exposed 却从未进 context，直到下次 compaction 才重见。
3. **unhandled rejection**：`void this.flush()` 两处调用点无人 catch，Bun 下可让整个 daemon 退出。
4. **compaction_end 不区分成败**：SDK 在失败 / 中止时同样发 `compaction_end`，当前照样 epoch+1、清 exposure、按「最近 40 条」重标——而 kept tail 是按 token（默认 20K）保留的，条数启发式两个方向都错（重复序列化 or 永久丢失）。
5. **工具卡死**：`search.ts` fetch 无超时，TinyFish 挂起时 `running` 永久为 true，该 bot 对话轮无限期卡死。

## 目标

trigger / flush / compaction 收敛为一个串行化状态机；任何异常路径不丢消息、不重复序列化、不错切 epoch、不杀进程。

## 非目标

- 不改 routing 语义、不改序列化 grammar、不改 tool schema。
- 不引入消息持久化队列等重资产基础设施。

## 需求

- **R1:** flush 串行化：进入 flush 即置本地 `flushing` 标志（不等 SDK 事件），重入只置 `pendingTrigger`；flush 结束后循环检查 pending。
- **R2:** `markExposed` 移到 `sendUserMessage` 成功之后；失败时消息保持未曝光、记录 error event、由后续 trigger 重试。
- **R3:** flush 全链路 try/catch，任何失败只产生 agent_events `error`，不允许 unhandled rejection 逃逸。
- **R4:** `compaction_end` handler 读取 event payload，仅当成功（有 result 且未 aborted）才执行 epoch+1 / exposure 重置；compaction extension 得到空 summary 时抛错走失败路径，不得持久化空摘要。
- **R5:** exposure 重置与 kept tail 对齐：以 compaction 结果的 `firstKeptEntryId` 反推幸存消息集合，替代「最近 40 条」启发式。
- **R6:** 所有工具网络调用必须有超时（search 加 `AbortSignal.timeout`，run_js 已有 SIGKILL）；工具失败返回结构化错误，不得让 `running` 卡死。
- **R7:**（附带）`executeSend` 先校验全部参数（含 sticker short_id/file_id 解析）再发任何网络请求，避免 text 已发出后 sticker 校验失败导致重试双发。

## 验收标准

- **AC1:** 给定 flush 处于 vision await 中时新消息路由进来，两条消息都恰好序列化一次、按序进入 context（回归测试模拟慢 vision）。
- **AC2:** 给定 `sendUserMessage` 注入失败，消息不被标记 exposed，error event 落库，进程存活，后续 trigger 能重新发出这批消息。
- **AC3:** 给定 compaction 失败 / 中止事件，epoch 不变、exposure 不重置；给定空 summary，按失败处理。
- **AC4:** 给定 kept tail 覆盖 N 条消息（N ≠ 40），compaction 后这 N 条不重复序列化、之外的消息正常重见。
- **AC5:** 给定 search 上游挂起，10s 内工具返回错误且 bot 后续轮次正常。
- **AC6:** `bun test` 全绿 + 新增回归测试覆盖 AC1–AC4；`bun run check` 通过。

## 约束

- Cache impact: **NONE**——不改任何 provider 可见字节；exposure 语义修正是 bug fix。AC1 的「不重复序列化」正是 cache invariant 3 的修复。
- 性能：串行化不得引入可感知的触发延迟（正常路径仍是单次 flush）。

## 例子与边界 case

- 真实事故回放：daemon.log 中两次 `Agent is already processing a prompt` 的触发序列作为 AC1 的输入原型。
- shutdown 中 flush 在途：daemon 停止时应等待或安全中断，不写半状态。
- burst 合并（pendingTrigger）与串行化的交互：pending 消息在下一轮 flush 一次性发出，语义不变。

## 可观察性

- flush 失败 / compaction 失败 / 工具超时各有可区分的 agent_events `error` payload。

## 文档影响

- `docs/architecture.md`（Agent 小节状态机描述）、`docs/cache.md`（compaction exposure 重置语义）、`docs/testing.md`。

## 待决问题

无（行为修复，无架构分叉）。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
