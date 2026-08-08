# LLM 开发指南

> 本项目的日常开发流程，也是 docs/ 内唯一的流程文档。给 LLM 派活、LLM 执行、验收、提交，都按这个来。
> 验证命令见 `../testing.md`，路由与硬约束见根 `AGENTS.md`。

## 原则

给 LLM 一个**可验证的工作契约**，而不是模糊的愿望，也不是逐行的实现脚本。

## 一、任务包（派活时给齐）

一个好任务包含：

1. 需求 / 工作项说明（临时小任务也要说清是什么）
2. 期望的可观察结果
3. 相关背景与当前行为（给文件路径和文档名，不要贴大段上下文）
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

> 60 秒内对同一 immutable 对象的重复读取不得产生第二次上游请求；cache 失败不得改变返回的错误语义；内存增长必须有界。覆盖 hit / 过期 / 上游失败 / 并发相同读取四个测试。不改公开接口。

### Prompt 反模式

- “做到生产可用”但不给标准
- “重构一下”但不给要保持的 invariant 和目标结果
- “修掉所有 bug”但不给范围
- 既要实现又要重设计，且不给优先级
- 只关心外部行为却规定内部实现
- 贴大段复制的上下文，而不是给仓库路径和文档名

## 二、开发循环（每个任务）

1. **摸底**：读受影响边界的文档章节（只读必要的），搜现有模式，确认归属层（根 `AGENTS.md` 第 4 节）；任何新功能/行为改动先读[Debug指南](debugging-guide.md)并写清 Debug impact。
2. **计划**：非平凡工作（多文件 / 跨边界 / 改持久格式 / 行为变化）先把任务拆成 commit-sized 步骤再实现；用户授权提交时，task 粒度必须同时是 commit 边界（一个可独立 review/revert 的结果）。琐碎改动跳过。
3. **实现**：一次做一个内聚 task，按验证漏斗逐层验证（`docs/testing.md`）。
4. **自审**：diff 对照验收标准逐条过，检查 cache impact（见下）与 debug 成功/no-op/失败路径。
5. **提交**：用户授权后，每个 task 通过目标验证就立即做原子签名 commit（规范见第五节）；不得积压多个 task 后合并提交。
6. **报告**：明确说出未验证区域、假设、遗留风险。

## 三、Cache 与成本（每个任务必做，全局要求）

本项目第一优先级是 **provider cache hit 率**与**整体 token 成本**。开发任何功能——包括纯修复——都必须回答两个问题：

1. **会不会改变任何 provider 可见字节？**
   - `NONE` — 不触 provider payload，报告里写明。
   - `INTENTIONAL` — 触了 cache-visible 协议：bump `CACHE_SCHEMA_VERSION`，确保完整 fingerprint 在 restore 前轮换 session/context epoch，更新 `docs/cache.md`，跑 `test/cache.test.ts` golden 确认新 hash 是预期的。
   - 意外变化 = golden test 失败，这是设计上的报警，不要随手更新 golden 让它过。
2. **对 hit 率和成本的影响是正还是负？** 负影响必须有明确理由；正影响（提高 hit 率、降低每 turn 成本）用遥测验证，不靠感觉。

设计取向（SHOULD）：

- 确定性、跨 bot 共享且变化频率低的内容优先放**稳定 prefix**；persona 随后，动态内容只以 append-only、有界 suffix 追加。大型本地目录即使稳定，也应先权衡 prefix 体积与每轮相关性。
- 能用确定性代码（router / SQL / 规则）解决的判断，不花 LLM token。
- 每 bot turn 的新增 provider-visible token 必须有界；无界增长的设计一票否决。
- UI-only 改动若改变了 provider payload，是边界设计 bug，不是 cache 变化。

验证依据是 `llm_runs` 遥测与 `bun run debug`，改完看数据说话。

### 方案最小化检查

写代码前逐项回答；能删就先删，确有必要才增加：

1. 能否少一层抽象或一个持久状态，直接放进现有职责拥有层？
2. 能否复用 Pi 原生组件/runtime或仓库现有接口，避免平行框架、wrapper链和自建协议？
3. 能否用确定性代码替代一个tool、一次模型调用或一段provider-visible指令？
4. 能否删除一个动态字段，或把队列、并发、结果、历史与每turn token设为明确上限？
5. 当前需求是否只属于一个群deployment？未经明确需求与namespace/migration方案，不得扩成同目录多群、多租户或热加载。

极简不允许削弱transaction、幂等、timeout、兼容迁移、脱敏、可观察性、类型检查或回归测试。最小方案仍须完整满足验收标准；只是拒绝没有证据的未来抽象。

## 四、何时写哪种文档

| 情况 | 动作 |
|---|---|
| 接口 / invariant / schema / 工作流变了 | 同步 `architecture.md` / `cache.md` / `data-model.md` / `testing.md` |
| 新功能 / 行为变化 | 按 `debugging-guide.md` 复用或扩展结构化事件、诊断与回归 |
| 可重复的运维操作 | `docs/runbooks/` 加一篇 |
| 用户旅程 / 命令 / 配置变化 | 双语 user-guide 同一 task 同步（见第六节） |

写作规范见 `documentation-guide.md`。一个事实只在一个地方是权威，其余链接。开发过程记录靠 git 历史（原子提交 + 清晰的 message），不维护单独的过程文档。

## 五、提交规范

大任务先拆成 commit-sized tasks 再开始实现。一个 commit 必须同时满足：

1. **一个结果**：只完成一个可观察行为或一个纯机械变化，可独立 review / revert。
2. **自包含**：实现、对应测试、该行为必需的 contract 文档一起提交；不能提交会让主分支暂时无法 typecheck 的“半边改动”。
3. **已验证**：提交前目标测试通过；任务全部结束后再补全量 `bun test` + `bun run check` + `bun run lint`。
4. **显式暂存**：脏工作树按路径或 patch 暂存并检查 staged diff；禁止用 `git add -A` 顺手夹带别的 task 或用户改动。提交前检查 `git diff --cached --check`、完整 staged diff 与 `git status --short`。
5. **签名**：授权后的 commit 使用 repo GPG 配置签名；签名失败停下诊断，不得降级为 unsigned。提交后用 `git log -1 --show-signature` 确认 `Good signature`。

行为改变与机械重构通常分开；但同一行为必需的测试和文档不要人为拆到“后续补” commit。已完成一个 task 就提交，不把多个 task 积压成一个大提交。不做破坏性 git 操作（`reset --hard` / force push / 改写历史 / amend 已完成的原子提交）。

### Commit message

```text
<Imperative verb> <concrete code outcome>

<optional body: why / invariant / verification, not a file list>

Work-Type: mechanical
```

- subject 使用英文祈使句、首字母大写、末尾无句号，建议 ≤72 字符。
- subject 写具体代码结果，例如 `Filter sticker candidates by bot sendability`；不用 `Update files`、`Fix bugs` 这类无法单独说明结果的标题。
- body 可省略；需要时说明“为什么”、兼容/cache invariant、关键验证，不重复 diff 文件清单。
- 纯机械提交（格式化、重命名搬运、文档整编）在 message 末尾加 trailer `Work-Type: mechanical`，trailer 前空一行；行为 commit 不加。

## 六、用户文档与双语同步

修改用户旅程、命令、配置、错误恢复或产品边界时，`docs/user-guide/zh` 与 `docs/user-guide/en` 必须在同一 task 同步；README 只保留最短成功路径。内部 invariant 留在 architecture/cache/data-model，不复制到用户文档。

本地与 CI 固定使用 mdBook 0.5.4：

```bash
bun run docs:build  # 构建中文、English 与语言入口到 build/docs
bun run docs:check  # 重新构建并检查 source、生成 HTML、fragment 与语言切换
```

发布只通过 `.github/workflows/docs-pages.yml`：PR 与 `main` push 都跑同一个 `bun run docs:check`；只有 `main` push 进入 `github-pages` environment 并 deploy。不要手工改 `gh-pages` 分支或上传未检查目录。

## 七、完成定义

简版：验收标准满足、测试和 `bun run check` 过、diff 干净无无关改动、文档同步、cache impact 已评估（NONE / INTENTIONAL + 理由）、Debug impact 已按 `debugging-guide.md` 验证、风险如实报告。完整版见根 `AGENTS.md` 第 8 节。
