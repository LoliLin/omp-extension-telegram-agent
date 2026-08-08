# LLM 开发指南

> 本项目的日常开发流程。给 LLM 派活、LLM 执行、验收、留痕，都按这个来。
> 追溯细节见 `traceability.md`，验证命令见 `../testing.md`，路由与硬约束见根 `AGENTS.md`。

## 原则

给 LLM 一个**可验证的工作契约**，而不是模糊的愿望，也不是逐行的实现脚本。

## 一、任务包（派活时给齐）

一个好任务包含：

1. 需求 / 工作项 ID（REQ-* / PLAN-*；临时小任务可没有，但要说清是什么）
2. 期望的可观察结果
3. 相关背景与当前行为（给文件路径和文档 ID，不要贴大段上下文）
4. 范围内 / 范围外边界
5. 验收标准（可观察、可验证）
6. 硬约束：cache invariant、兼容性、安全、性能、数据迁移
7. 模糊成本高的地方给例子和边界 case
8. 期望的验证方式
9. 文档义务（要不要动 architecture / cache / data-model / testing）
10. 是否授权创建 commit

### 不要过度指定

不要规定具体函数 / 类的实现，除非那本身就是架构约束。让 agent 自己读仓库、跟随现有模式。

反例：

> 加个 cache，弄稳一点。

正例：

> 实现 REQ-CACHE-0012：60 秒内对同一 immutable 对象的重复读取不得产生第二次上游请求；cache 失败不得改变返回的错误语义；内存增长必须有界。覆盖 hit / 过期 / 上游失败 / 并发相同读取四个测试。不改公开接口。

### Prompt 反模式

- “做到生产可用”但不给标准
- “重构一下”但不给要保持的 invariant 和目标结果
- “修掉所有 bug”但不给范围
- 既要实现又要重设计，且不给优先级
- 只关心外部行为却规定内部实现
- 贴大段复制的上下文，而不是给仓库路径和文档 ID

## 二、开发循环（每个任务）

1. **读状态**：`docs/handoff.md` + 相关需求 + 受影响边界的文档章节（只读必要的）。
2. **摸底**：搜现有模式，确认归属层（根 `AGENTS.md` 第 4 节）；任何新功能/行为改动先读[Debug指南](debugging-guide.md)并写Debug impact。
3. **计划**：非平凡工作（多文件 / 跨边界 / 改持久格式 / 行为变化）先写 `docs/plans/active/PLAN-*.md`；用户授权提交时，task 粒度必须同时是 commit 边界（一个可独立 review/revert 的结果）。琐碎改动跳过。
4. **实现**：一次做一个内聚 task，按验证漏斗逐层验证（`docs/testing.md`）。
5. **自审**：diff 对照验收标准逐条过，检查 cache impact（见下）与debug成功/no-op/失败路径。
6. **留痕**：`docs/devlog.md` 追加一条；`docs/handoff.md` 更新；接口 / invariant 变化同步 architecture / cache / data-model。
7. **提交**：用户授权后，每个 task 通过目标验证就立即显式暂存、检查 staged diff 并做原子签名 commit；不得积压多个 task 后合并提交。subject 与 trailer 规范见 `traceability.md`。
8. **报告**：明确说出未验证区域、假设、遗留风险。

## 三、Cache 与成本（每个任务必做，全局要求）

本项目第一优先级是 **provider cache hit 率**与**整体 token 成本**。开发任何功能——包括纯修复——都必须回答两个问题：

1. **会不会改变任何 provider 可见字节？**
   - `NONE` — 不触 provider payload，devlog 里写明。
   - `INTENTIONAL` — 触了 cache-visible 协议：bump `CACHE_SCHEMA_VERSION`，确保完整 fingerprint 在 restore 前轮换 session/context epoch，更新 `docs/cache.md`，跑 `test/cache.test.ts` golden 确认新 hash 是预期的。
   - 意外变化 = golden test 失败，这是设计上的报警，不要随手更新 golden 让它过。
2. **对 hit 率和成本的影响是正还是负？** 负影响必须有明确理由写进 REQ/PLAN；正影响（提高 hit 率、降低每 turn 成本）用遥测验证，不靠感觉。

设计取向（SHOULD）：

- 确定性、跨 bot 共享且变化频率低的内容优先放**稳定 prefix**；persona 随后，动态内容只以 append-only、有界 suffix 追加。大型本地目录即使稳定，也应先考虑按本轮相关性检索而不是扩大 prefix。
- 能用确定性代码（router / SQL / 规则）解决的判断，不花 LLM token。
- 每 bot turn 的新增 provider-visible token 必须有界；无界增长的设计一票否决。
- UI-only 改动若改变了 provider payload，是边界设计 bug，不是 cache 变化。

验证依据是 `llm_runs` 遥测与 `scripts/analyze-context-window.ts`，改完看数据说话。

### 方案最小化检查

写代码前逐项回答；能删就先删，确有必要才增加：

1. 能否少一层抽象或一个持久状态，直接放进现有职责拥有层？
2. 能否复用 Pi 原生组件/runtime或仓库现有接口，避免平行框架、wrapper链和自建协议？
3. 能否用确定性代码替代一个tool、一次模型调用或一段provider-visible指令？
4. 能否删除一个动态字段，或把队列、并发、结果、历史与每turn token设为明确上限？
5. 当前需求是否只属于一个群deployment？未经REQ与namespace/migration方案，不得扩成同目录多群、多租户或热加载。

极简不允许削弱transaction、幂等、timeout、兼容迁移、脱敏、可观察性、类型检查或回归测试。最小方案仍须完整满足AC；只是拒绝没有证据的未来抽象。

## 四、何时写哪种文档

| 情况 | 动作 |
|---|---|
| 新需求 / 新方向 | `docs/requirements/REQ-*.md` |
| 非平凡工作开工前 | `docs/plans/active/PLAN-*.md` |
| 有长期后果的架构取舍 | `docs/adr/ADR-*.md` |
| 接口 / invariant / schema / 工作流变了 | 同步 `architecture.md` / `cache.md` / `data-model.md` / `testing.md` |
| 每个任务结束 | `devlog.md` 追加 + `handoff.md` 更新 |
| 新功能 / 行为变化 | 按`debugging-guide.md`复用或扩展结构化事件、诊断与回归 |
| 可重复的运维操作 | `docs/runbooks/` 加一篇 |

写作规范见 `documentation-guide.md`。一个事实只在一个地方是权威，其余链接。

## 五、完成定义

见根 `AGENTS.md` 第 8 节。简版：验收标准满足、测试和 `bun run check` 过、diff 干净、文档同步、devlog/handoff 留痕、风险如实报告。
