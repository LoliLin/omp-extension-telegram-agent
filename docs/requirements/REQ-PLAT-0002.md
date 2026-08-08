# REQ-PLAT-0002: 复用 Pi 的模型设置与认证

- **Status:** Done（2026-08-08；实现与真实脱敏 smoke 均通过）
- **Priority:** P0
- **Source:** 用户新增 REQ-LIST：「直接复用 Pi 的配置，不要在项目配置里填写 API key；已经用 Pi 登录 DeepSeek 和 Codex」
- **依赖:** REQ-PLAT-0001、REQ-ONBOARD-0001

## 问题

项目当前虽然使用 Pi 的 `ModelRuntime`，却仍要求 `telegram.config.ts` 用 `api_key_env` 指向 `.env` 中的 provider key，并在每只 bot 启动时调用 `setRuntimeApiKey()`。这绕过了 Pi 已有的 `auth.json`、OAuth refresh、provider catalog 与默认模型设置；`/tg config` 还会再次询问 provider key，形成第二套认证生命周期。

## 调查结论

- 项目固定的 Pi 0.84.1 中，`ModelRuntime.create()` 默认读取 Pi agent 目录的 `auth.json`、`models.json`，并通过 `hasConfiguredAuth()` / `completeSimple()`统一处理 API key、OAuth 与 refresh。
- `SettingsManager.create(projectRoot, getAgentDir())`会合并 Pi global/project settings，并公开 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`。
- 当前机器的非敏感元数据确认：Pi 已配置 `deepseek` API-key credential 与 `openai-codex` OAuth credential；默认模型为 `deepseek/deepseek-v4-flash`，`openai-codex/gpt-5.6-luna`支持 image input。检查过程没有读取或打印 credential 值。
- 2026-08-08 completion smoke 使用当前 Pi credential 各执行一次脱敏真实请求：DeepSeek text 为 `ok`、795ms、8 input / 1 output / 0 reasoning token、$0.0000014；Codex Luna low image 的 photo/static-sticker 样本均为 `ok`、0 reasoning token。只记录 status/usage/latency/cost 聚合，没有输出 prompt、response、媒体、路径或 credential。
- 调查时的 `configureBotModelRuntime()`曾先把项目 secret 注入 runtime；实现现已删除该重复来源。多 bot 共享一个 Pi `ModelRuntime`，每 bot 的模型选择不复制 credential。
- `auxiliary_visual_model`表达的是任务模型选择，不是认证。它可以显式选择 Pi catalog 中的视觉模型与 low reasoning，但必须使用同一个 Pi runtime/auth。

## 目标

Pi 成为 LLM provider、模型目录和认证的唯一事实来源。项目配置只保留 Telegram deployment 行为，以及可选的“选择哪一个 Pi 模型”覆盖；不再收集、解析、保存或注入聊天/视觉 provider API key。默认聊天模型与推理等级直接继承当前 Pi 设置。

## 非目标

- 不复制、迁移、导出或显示 Pi `auth.json` 内容；不实现第二套 login/OAuth UI。
- 不在 daemon 运行中热切换 Pi 模型或认证；用户改变 Pi 设置后受控重启即可。
- 不删除多 bot 的可选模型选择能力；不同 persona 仍可选择 Pi 中已认证的不同 provider/model。
- 不把 Telegram token、TinyFish key或router secret移入 Pi；这些不是模型 provider credential。
- 不支持旧版 Pi API；项目只针对锁定的 Pi 0.84.1。

## 需求

- **R1 — 单一认证源：** daemon只通过默认 `ModelRuntime.create()`读取Pi credential；生产代码不得调用`setRuntimeApiKey()`、读取provider key env或把credential复制到project data/session。
- **R2 — Pi 默认模型：** deployment未写`provider`/`model`/`reasoning_effort`时，从Pi合并后的`defaultProvider`/`defaultModel`/`defaultThinkingLevel`解析。缺任一模型字段时给出可操作错误，提示先在Pi完成login/model选择。
- **R3 — 选择而非认证：** 顶层或per-bot `provider`+`model`可作为显式选择覆盖，但只能解析到Pi catalog且对应provider已配置auth；覆盖不带key/env。多bot可共享一个runtime并发请求。
- **R4 — 配置收口：** canonical TypeScript schema、tracked examples、`.env.example`、双语文档与新向导不再出现`api_key_env`、`deepseek_key_env`或provider secret。为避免破坏现有ignored deployment，loader可接受这些legacy字段但必须完全忽略，也不得要求对应env存在。
- **R5 — 向导预检：** `/tg config`在写文件前只显示Pi解析出的非敏感`provider/model/thinking`，不询问provider id/model/key；Pi默认或auth不可用时零写入失败，并引导用户退出向导后使用Pi原生login/model流程。
- **R6 — 视觉复用：** 辅助视觉调用通过同一个Pi runtime和credential执行；canonical model ref为`provider/model:effort`，本deployment默认/示例为`openai-codex/gpt-5.6-luna:low`。模型必须支持image input，输出/timeout/cost边界由REQ-VISION-0001约束。
- **R7 — 脱敏失败：** unknown model、unauthenticated provider、OAuth refresh和provider错误只记录provider/model与固定category；不得记录auth header、token、credential对象或上游含secret body。
- **R8 — 生命周期：** shared runtime在pid lock之后、Telegram runtime之前创建一次；任一必需模型preflight失败时daemon fail-fast且不开始polling。shutdown不修改Pi credential。

## 验收标准

- **AC1:** fake `ModelRuntime`证明N bot只创建一个runtime，0次`setRuntimeApiKey`；每bot请求仍使用自己的provider/model，same-provider与cross-provider并发互不串模型。
- **AC2:** isolated Pi settings/auth fixture覆盖默认模型、project override、API-key credential、OAuth credential、missing default、unknown model与unauthenticated provider；错误只含非敏感model identity。
- **AC3:** legacy config即使引用不存在的`api_key_env`也可加载，且`AppConfig`/`BotConfig`、daemon对象、日志和测试snapshot均没有provider secret或env key字段。
- **AC4:** fresh `/tg config`完整流程不出现provider/key输入，只把Telegram token写入`.env`；Pi preflight失败时`.env`/config/persona均不存在或逐字节保持原状。
- **AC5:** tracked source/doc审计对`api_key_env|deepseek_key_env|providerApiKey|setRuntimeApiKey`只允许出现在明确legacy兼容测试/REQ历史，不出现在生产路径、example或用户步骤。
- **AC6:** 使用当前Pi credential做一次DeepSeek text completion与一次Codex Luna low image completion，只输出status/usage/latency聚合；不输出prompt、response、图片、路径或credential。
- **AC7:** targeted config/onboarding/runtime/vision、全量、typecheck、cache golden通过；现有provider-visiblesystem/tools/message/summary bytes逐字节不变。

## 约束

- Cache impact: **NONE**。认证来源、runtime共享和默认选择发生在provider请求外；同一显式provider/model下cache-visible grammar不变。用户主动改变Pi默认模型是配置边界，不伪装成同一模型cache。
- Token / 成本: 0新增provider call；shared runtime减少重复availability/auth初始化。向导预检只读本地metadata，不调用LLM。
- 兼容性: 锁定Pi 0.84.1；legacy provider-key字段仅解析后丢弃，不再生效。行为变化在启动时明确报告，绝不静默回退项目secret。
- 安全 / 隐私: Pi credential文件仍由Pi拥有；项目只读取非敏感provider/model/auth-status接口。
- 运维: 更新Pi login/default model后执行`/tg restart`或`bun run restart`；不要求编辑`.env`。

## 例子与边界 case

- canonical新配置不写模型字段：两只bot都继承Pi当前默认DeepSeek模型与thinking。
- bot B显式选`openai-codex/gpt-5.6-luna`：只改变选择，OAuth仍来自Pi；项目中没有Codex token。
- legacy ignored配置仍写`api_key_env: "old_key"`且`.env`已删除该key：loader忽略字段，使用Pi credential，不报missing env。
- Pi只有login但没有default model：向导/daemon要求用户在Pi选择model，不猜第一个catalog model。

## 可观察性

启动日志只显示每bot最终`provider/model/reasoning`与auth source类别`stored/environment`，不显示credential类型细节之外的数据。真实smoke只保留status、usage、latency与错误category聚合。

## 文档影响

实现时更新architecture/config boundary、runbook、`.env.example`、typed/legacy examples、双语configuration/installation/troubleshooting、testing、devlog/handoff。

## 待决问题

无。若未来需要daemon内交互式Pi login，应直接接Pi公开login UI另开REQ，不在Telegram向导复制认证流程。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13g/T13j`
- Behavior commits: `0859490`（移除项目 credential）、`f30e22c`（Pi defaults/shared runtime）、`c95c695`（keyless onboarding）、`f4ff63b`（shared Pi vision executor）
- 完整查询：从 `Requirement: REQ-PLAT-0002` git trailer 查
