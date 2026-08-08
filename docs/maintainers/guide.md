# 机器维护指南

> 面向 coding agent 与 maintainer。根 [AGENTS.md](../../AGENTS.md) 是常载规则；本页把完整开发循环、提交、验证和文档发布入口连起来，不替代各权威文档。

## 开始一个任务

1. 读 [handoff](../handoff.md) 与相关 [REQ-LIST](../requirements/REQ-LIST.md) 项。
2. 按 [architecture](../architecture.md) 确认归属层；涉及持久化时读 [data model](../data-model.md)，涉及provider-visible bytes时读 [cache](../cache.md)。
3. 先搜现有模式，并过一遍 [development guide 的方案最小化检查](../engineering/development-guide.md#方案最小化检查)：能否少一层、一个tool、一次模型调用或一个动态字段。多文件、跨边界或行为变化再在 `docs/plans/active/` 建 commit-sized task。
4. 按 [development guide](../engineering/development-guide.md) 一次完成一个内聚结果：实现、测试、必需文档、自审、提交。

需求、架构、计划、runbook和过程日志的生命周期见 [documentation guide](../engineering/documentation-guide.md)。一个事实只有一个权威来源，其余位置使用链接。

## Cache 与 token 检查

每个任务必须明确：

- **NONE**：不改变任何provider-visible byte；在devlog说明为什么。
- **INTENTIONAL**：system/persona/tool order或schema、消息/摘要grammar等cache-visible协议改变；必须升级`CACHE_SCHEMA_VERSION`，让完整fingerprint在restore前建立新session/epoch，更新[cache](../cache.md)并验证golden。

UI、operator command、日志和telemetry属于side channel。若纯UI任务改变provider payload，这是边界错误，不是可忽略的小变化。任何每turn新增内容必须有界；确定性代码能完成的工作不花LLM token。

## 验证漏斗

规范命令与当前状态只以 [testing](../testing.md) 为准：

1. `bun test test/<相关文件>`；
2. `bun test`；
3. `bun run check`；
4. 需要真实网络时再执行带显式`--bot <id>`的e2e；
5. 跨终端、daemon或Telegram边界的任务记录真实smoke与未验证项。

不能通过删除断言、放宽类型或关闭安全控制让验证变绿。确定性bug必须有回归测试。

## 原子签名提交

[Traceability](../engineering/traceability.md) 是commit message与trailer的权威来源。固定流程：

1. 一个PLAN task对应一个可独立review/revert的结果；行为和无关机械清理分开。
2. 只用显式路径或patch暂存，禁止`git add -A`；保留用户和其他任务的改动。
3. 检查`git diff --cached --check`、完整staged diff与`git status --short`。
4. 使用`git commit -S`；签名失败不得降级为unsigned。
5. subject用英文祈使句描述具体代码结果，首字母大写、末尾无句号、建议不超过72字符。
6. 基于REQ/PLAN的message末尾放连续trailers：

```text
Requirement: REQ-...
Task: PLAN-...#Tn
```

7. 用`git log -1 --show-signature`确认`Good signature`，并用`git show -s --format='%(trailers)' HEAD`机械检查追溯。

任务结束后追加 [devlog](../devlog.md)、更新短 [handoff](../handoff.md)，再提交；不要攒多个task做一个大commit。

## 用户文档与双语同步

用户入口：

- 中文：[README](../../README.md) 与 [用户指南](../user-guide/zh/src/README.md)
- English: [README](../../README.en.md) and [user guide](../user-guide/en/src/README.md)

修改用户旅程、命令、schema、错误恢复或产品边界时，两种语言必须在同一task同步。README只保留最短成功路径；详细配置、使用、运维、排障和成本机制放guide。内部invariant继续留在architecture/cache/data-model，不复制到用户文档。

## 文档构建与 Pages 发布

双语book source位于：

- `docs/user-guide/zh/src/`
- `docs/user-guide/en/src/`

本地与CI固定使用mdBook 0.5.4。首次本地构建前安装相同版本：

```bash
cargo install mdbook --version 0.5.4 --locked
bun run docs:build  # 只构建中文、English与语言入口到build/docs
bun run docs:check  # 重新构建并检查source、生成HTML、fragment与语言切换
```

发布只通过 [Documentation workflow](../../.github/workflows/docs-pages.yml)：

1. pull request、手工运行与`main` push都执行同一个`bun run docs:check`，并上传已检查的单一纯静态artifact；
2. 只有`main` push进入`github-pages` environment并deploy，PR不获得deploy job；
3. build权限只有`contents: read`，deploy job才有`pages: write`和`id-token: write`；workflow不读取deployment secret；
4. 所有actions使用不可变commit SHA，mdBook archive固定版本和SHA-256；同一ref的新run会取消旧run；
5. 仓库管理员只需在GitHub Settings → Pages把Source设为“GitHub Actions”。workflow不会请求PAT或偷偷自动修改仓库设置。

修改任一用户章节时同步另一语言，先运行`bun run docs:check`，再开PR。合并后的environment URL是发布结果的权威地址；不要手工改`gh-pages`分支或上传未检查目录。构建与断链基线见 [testing](../testing.md)。

## 完成前检查

- 验收标准逐条满足，REQ只在全部验证后打勾。
- `git diff`没有无关改动或secret/private persona。
- 架构、cache、data model、runbook与用户文档按真实变更同步。
- devlog写明cache impact；handoff能让新agent继续下一task。
- 报告真实smoke、外部credential限制、遗留风险和假设，不用unit test冒充真实Telegram验证。
