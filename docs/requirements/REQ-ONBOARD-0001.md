# REQ-ONBOARD-0001: clone 到 `/tg config` 的开箱体验与双语用户文档

- **Status:** Implemented（T13a–T13f 已实现；待 T14 真实 smoke 与总验收记录）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：clone 后运行 `bun run pi`、完成 `/tg config` 即可使用；优先写有类型和注释的本机 config.ts 而非 JSON；README / 用户指南 / 机器维护指南分层；提供公开提示词模板但不提交实际部署提示词；中文与 English 文档用 mdBook + GitHub Actions 发布；用户指南增加以成本优势为重点的设计概览
- **依赖:** REQ-PLAT-0001、REQ-DOC-0001、REQ-OPS-0002

## 问题

当前仓库不能兑现“clone 后直接进入 Pi 配置”的用户旅程：

- `package.json` 和 lockfile 使用 `file:../pi/packages/*`，要求仓库旁边恰好存在开发者本机的 Pi 源码；公开 npm registry 已有同版本 `@earendil-works/pi-*` packages，当前本机耦合没有产品必要性。
- Pi extension 能在配置缺失时注册 `/tg`，但只有静默空补全和后续 config error；没有 `/tg config`，用户必须手工复制并同时理解 `.env`、JSON、persona path 和 provider 字段。
- `bots.config.json` 既无类型提示也不适合写解释性注释，不能成为主要的用户配置体验。
- README 只有中文且以内部文档索引为主体，没有独立用户指南、English 入口或可发布站点。
- `personas/xiaoxue.md`、`personas/xiaoyu.md` 是当前部署实际提示词并仍被 Git 跟踪；这与“实际提示词不要 commit”直接冲突。
- AGENTS.md 已是高信号 agent 路由，但没有指向一篇面向机器维护者的完整指南。

## 调查结论

- 当前 Pi extension API 已提供 `registerCommand` 与原生 `ctx.ui.input/select/confirm/editor`；配置向导不需要自绘表单组件。
- `loadConfig()` 同时要求 config、persona 和全部 secret 已存在，不能作为向导的增量写入 API；应先建立独立 draft/validate/write 边界，再让 daemon 继续只消费完整 `AppConfig`。
- 新的主要用户配置采用 ignored `telegram.config.ts` + tracked `telegram.config.example.ts`，默认导出 `defineConfig({...})`。它提供注释、类型检查和编辑器补全；现有 `bots.config.json` 保持只读兼容。两者同时存在时必须报清晰歧义，不能静默选择过期文件。
- TS config 是本地受信任代码，Node/Pi 与 Bun daemon 都会执行它；不能下载或加载远程 config。向导生成纯声明对象，不把 token 写进模块，也不尝试用脆弱的 AST rewrite 修改任意用户表达式。
- mdBook 的一个 `book.toml` 对应一个 language/source/build；中英双语应各有独立 book root，共享一个语言入口页，不在同一 SUMMARY 中混排两种语言。
- GitHub Pages 官方 workflow 由 checkout、configure-pages、upload-pages-artifact、deploy-pages 组成，并需要最小 `pages: write` / `id-token: write` 权限。构建必须先验证两个 book 与内部链接，再上传单一静态 artifact。
- 从未来 HEAD 移除真实 persona 不会清除既有 Git 历史；历史清理会改写提交并影响协作者，不能在本需求中偷偷执行。

## 目标

一个没有本机 Pi sibling、没有项目配置的新用户可以 clone 仓库，运行 `bun run pi`，在 Pi 内完成 `/tg config`，随后看到已连接的 Telegram 原生 feed。主要配置是一份可注释、可类型检查的本机 TypeScript 文件。README 与发布后的中英用户指南覆盖准备、配置、使用、设计优势和排障；真实部署提示词不再出现在新 commit / checkout 中。

## 非目标

- 不自动创建 BotFather bot、Telegram 群或 LLM provider 账号；向导只解释并接收用户已取得的值。
- 不做 Web 管理后台、远程 secret store、多租户或单进程多群。
- 不把所有内部 architecture/cache/data-model 文档翻译并复制到用户手册；用户概览链接权威深入文档。
- 不自动重写任意手写 TypeScript config 的 AST；已有 config 只做 validate、原文编辑或明确备份后替换。
- 不执行来自 URL、聊天或仓库外不受信路径的 config 模块。
- 不在本需求中改写 Git 历史。移除当前 tracked persona 只影响后续 HEAD；若用户要彻底从历史删除，必须另行明确授权、轮换敏感内容并协调 force-push。
- 不把当前私人 deployment 的 token、peer id、用户名、persona 文本或绝对路径改造成“示例”。

## 需求

- **R1 — 可移植启动：** 项目依赖必须从可获取的版本化来源安装，不能要求 `../pi` sibling。新 clone 在已安装 Bun 的前提下运行 `bun run pi` 即可完成必要的幂等依赖准备并启动项目 Pi；显式 `bun install --frozen-lockfile` 仍可作为 CI / 排障路径。
- **R2 — 无配置也能进入向导：** `/tg config` 必须在 `telegram.config.ts`、legacy JSON、`.env` 或 persona 不存在 / 无效时仍出现在帮助和补全中；它使用 Pi 原生 dialog API，不要求 daemon 已启动，也不进入 provider context。
- **R3 — 可表达的本机配置：** 首选 ignored `telegram.config.ts`，通过 tracked `defineConfig` helper 提供 schema 类型、默认值说明和注释；example 不含 secret。legacy `bots.config.json` 继续可加载并给出迁移入口，`bots_config` override 明确支持的扩展名。Node/Pi 与 Bun 对同一文件解析结果必须一致。
- **R4 — 最小首配：** 首次向导先显示并本地预检Pi默认provider/model/thinking，再收集deployment group、一个Telegram bot的id/name/token和persona template选择；不重复询问模型认证。高级routing/tools/sticker/compaction使用有注释的明确默认，可在完成后编辑config或重跑向导。
- **R5 — 安全、原子、可取消：** Telegram token只写ignored `.env`，config只引用其env key并继承Pi模型设置；persona写ignored deployment文件。所有目标先在内存中校验，再以同目录临时文件 + rename原子落盘。取消、validation failure或写入失败不能留下半份配置；已有config默认不覆盖，重跑提供“验证现有 / 用Pi editor编辑原文 / 备份后替换”，不得无损承诺无法兑现的自动merge。
- **R6 — 完成即就绪：** Pi默认模型/catalog/auth预检失败必须发生在写入前并引导`/login`、`/model`；写入后必须使用生产loader做最终校验，成功后通过既有受控进程路径启动/重启daemon，并恢复或建立all-bots feed。Telegram/network readiness失败时保留已验证文件，给出可执行诊断，不打印secret、不伪报成功。
- **R7 — 提示词隐私与模板：** 后续 HEAD 不跟踪当前真实部署 persona；`personas/` 默认忽略本地 `.md`，只通过显式 negate 规则跟踪通用中文 / English template 与说明。example config 只引用 template 或用户向导生成的 ignored 文件。代码、测试、文档不得复制实际 persona 内容。
- **R8 — 双语 README 与用户指南：** README 在首屏提供中文 / English 对等入口、三步 quick start、真实能力和边界，并链接对应用户指南。两个指南按 installation → Telegram/Pi model 准备 → `/tg config` → Pi 聊天 → 日常运维 → 排障组织；命令与 schema 由代码 / examples 验证。
- **R9 — 成本设计概览：** 中英用户指南各有一篇大纲式 design 文档，用用户语言解释 deterministic routing、stable provider prefix/cache、bounded context、compaction、lazy media vision、side-channel UI/telemetry 如何减少调用和 token；每节链接 `docs/cache.md` / `docs/architecture.md` 等权威细节，不复制实现全文，也不承诺未经遥测证明的百分比。
- **R10 — 机器维护入口：** AGENTS.md 保持短，只增加面向 agent / maintainer 的稳定链接；机器维护指南拥有开发循环、REQ/PLAN/原子签名 commit、cache invariant、验证与发布更新流程，并链接现有权威文档而不复制易漂移细节。
- **R11 — mdBook 与 Pages：** 中文 / English 各自可用 mdBook build；仓库提供本地 build/link-check 命令和 GitHub Actions Pages workflow。workflow 固定依赖版本、最小权限、并发取消和纯静态 artifact；PR 只 build/check，不部署，默认分支成功后才部署。
- **R12 — 友好失败语义：** 所有onboarding错误指出失败字段、保留了什么和下一条安全动作；Telegram token永不出现在notification、process args、日志、test fixture、GitHub Actions output或生成站点，provider key根本不进入项目向导。

## 验收标准

- **AC1:** 在没有 `../pi`、`node_modules`、`.env`、config 和本地 persona 的隔离 checkout 中，`bun run pi` 能启动并加载 `/tg config`；依赖 lock 可复现，package manifest 无 `file:../pi`。
- **AC2:** extension host test 在 config loader 抛错时仍列出并 dispatch `config`；TUI fake dialog 可完整走通，取消任一步时目标文件字节不变。
- **AC3:** `telegram.config.example.ts` 含逐字段注释并通过 typecheck；同一 fixture 经 Bun loader 与项目 Pi 使用的 Node runtime 得到等价 normalized config。legacy JSON fixture 保持通过；双 config 存在时 fail-fast 并列出两个路径。
- **AC4:** config writer tests覆盖fresh write、existing-file deny、validate existing、editor原文round-trip、confirmed backup+replace、invalid peer/bot identity/token/persona、临时rename failure与final `loadConfig()`；fresh `.env`只有Telegram token，成功secret文件mode为0600，captured stdout/notifications不含输入secret。
- **AC5:** 成功向导经 fake process/readiness 与 fake timeline 证明 daemon ready、all-bots feed 重连；启动失败不回滚有效配置、不声称已连接，并给出 `status` / retry 指令。
- **AC6:** `git ls-files personas` 只返回公开模板 / 说明，`git check-ignore` 能证明任意本地 persona 被忽略；`rg` 审计 examples、tests、README、book 不含当前部署 persona 文本或 credential。完成报告明确既有历史仍含旧文件。
- **AC7:** 中文和 English README 都能在首屏到达对应 quick start / guide；fresh-user dry run 中无需阅读 `docs/architecture.md` 即可完成首配，内部开发索引退居 maintainer 入口。
- **AC8:** 两个 mdBook 在 CI 使用同一命令成功构建，link checker 对 README、SUMMARY 和生成站点无断链；语言入口可从任一语言切换到另一语言。
- **AC9:** 两篇 design overview 都覆盖 R9 六个成本机制并链接到权威深入文档；不得出现无法由 telemetry / source 支持的成本数字。
- **AC10:** Pages workflow 在 pull request 只验证，在默认分支使用官方 Pages actions 部署；权限审计只有构建所需 read 和部署所需 `pages/id-token` write，无 secret 注入。
- **AC11:** AGENTS.md 可在一跳内到达机器维护指南；指南能在一跳内到达 development、traceability、testing、cache、documentation 与 release/Pages 流程。
- **AC12:** targeted tests、双语 docs build/link check、`bun test` 与 `bun run check` 全部通过；真实 fresh-clone Pi + Telegram smoke 若受外部 credential 限制，必须在 T14 明确列出而不能代替确定性测试。

## 约束

- Cache impact: **NONE**。配置向导、依赖安装、文档与 persona repo hygiene 不改变既有 provider grammar；新用户选择 persona/Pi model 是显式配置。若实现意外修改 stable prompt/tool/message/summary bytes，必须拆出独立 cache task并 bump schema。
- Token / 成本: 向导与文档不调用 LLM；runtime 每 turn 新增 0 token。design 文档只解释已有机制。
- 兼容性: 现有ignored `.env`、`bots.config.json`、外部persona path、SQLite/session/data继续有效。TS成为新默认但不能破坏legacy config；旧provider-key字段只由loader接受后丢弃。
- 安全 / 隐私: secret 只在进程内存和 mode 0600 的 ignored file；任何测试使用明显无效 fixture。TS config 是受信本地代码并必须在用户文档警示；真实 persona 从 HEAD 移除但不暗示历史已净化。
- 运维: 向导复用 REQ-OPS-0002 的串行 control/readiness，不启动第二个 daemon，不删除 data。
- 文档: 用户文档与 maintainer 文档分层；一个事实仍只有一个权威来源。

## 例子与边界 case

- Fresh clone：`bun run pi` → `/tg config` → 选择中文模板 → 填入一只 bot → daemon ready → 自动 attach。
- 用户按 Esc 取消 token 后续步骤：`.env`、TypeScript config、persona 都不存在或保持原字节。
- 已有手写 TypeScript config：选择“编辑”后 Pi editor 收到原文；取消保持原字节，保存后先验证再原子替换，注释不因字段级 rewrite 丢失。
- 同时存在 TS 与 legacy JSON：daemon / Pi 都拒绝并提示保留哪一份，不按 mtime 猜测。
- Pi default/auth错误：向导在写文件前以固定category失败，UI引导`/login`与`/model`，项目不接触或回显key。
- private persona 位于 `~/my-bot/persona.md`：合法且不会因仓库提交被带走。
- Pages PR 来自 fork：不需要 deployment secret，只执行 build/link check。

## 可观察性

- 向导只记录 phase 与成功 / 失败分类，不记录输入值；UI 明确显示目标文件相对路径、是否创建 / 保留 / 备份以及 daemon readiness。
- CI artifact 保留 mdBook build/link-check 结果；Pages deployment 使用 GitHub environment URL。
- fresh-clone smoke 记录 Pi/package 版本、命令退出码和非敏感阶段，不记录 token/group id/persona。

## 文档影响

`README.md`、English README/section、`docs/user-guide/{zh,en}/`、`docs/maintainers/`、`docs/index.md`、`AGENTS.md`、`docs/runbooks/daemon.md`、`docs/project.md`、`personas/README.md`、examples、GitHub Pages workflow。

## 待决问题

无。实现顺序固定为 provider schema → portable dependency/bootstrap → TypeScript config + persona template/privacy → atomic config core → Pi wizard/readiness → bilingual guides → mdBook/Pages，避免文档或向导引用尚不存在的字段。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10q/T13a-T13f`
- Commits: 从 `Requirement: REQ-ONBOARD-0001` git trailer 查

## T13f 实施证据（2026-08-08）

- 中文与English各有独立`book.toml`，固定mdBook 0.5.4；`bun run docs:check`使用同一构建产物检查README、SUMMARY、全部source、本地HTML target/fragment与双向语言入口。
- 真实本地构建生成21个HTML页面；18个Markdown文件的92个链接与生成站点600个链接全部通过，artifact写入无时间戳的`verification.json`。
- Documentation workflow把checkout/setup/actions固定到不可变SHA，mdBook Linux archive固定SHA-256。PR只build/check/upload；只有`main` push的deploy job拥有`pages: write`与`id-token: write`，无secret输入且同ref并发取消。
