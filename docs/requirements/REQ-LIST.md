# REQ-LIST

> 总清单。agent 完成一项：把 `[ ]` 改 `[x]` 并在条目末尾注明 commit。验收标准等细节在链接的 REQ 文档里。
> 全局约束：开发任何功能都要评估 cache hit 率与 token 成本影响（`../engineering/development-guide.md` 第三节）；每篇 REQ 的「约束」节必须有 Cache impact。

## 修复（2026-08-07 code review）

- [x] [REQ-SEC-0001](REQ-SEC-0001.md) run_js 沙箱威胁模型与隔离加固（P0）（commit 3c6c348）
- [x] [REQ-AGENT-0001](REQ-AGENT-0001.md) agent 触发/flush 生命周期串行状态机（P0）（commit a549335）
- [x] [REQ-TG-0001](REQ-TG-0001.md) Telegram ingestion 与 poller 可靠性（P1）（commit a806e8d）
- [x] [REQ-IPC-0001](REQ-IPC-0001.md) IPC 与 TUI 健壮性（P1）（commit d0d5d56）
- [x] [REQ-OPS-0001](REQ-OPS-0001.md) 配置校验、进程管理与仓库卫生（P1）（commit ca55ec0）
- [x] [REQ-TEST-0001](REQ-TEST-0001.md) 测试体系修复（P2）（commit c8fcd67）

## 功能

- [x] [REQ-OBS-0001](REQ-OBS-0001.md) 结构化全链路日志、只读诊断报告与 agent debug 门禁（P0，commit `5891ac0`）
- [x] [REQ-CONF-0001](REQ-CONF-0001.md) 配置体系：任意数量 bot、persona 外置（P1）（commit 3027e95）
  （附注：AC1允许的三bot dry-run已通过完整composition/IPC链；当前无第三token的真实C仍是PLAT-0001 AC7文档化opt-in）
- [x] [REQ-STICKER-0001](REQ-STICKER-0001.md) 固定 sticker set 支持（P2）（commit 84da315）
  （附注：T14脱敏审计确认两只bot都已有固定set内与set外真实发送，且short_id都映射到各自file_id）
- [x] [REQ-UI-0004](REQ-UI-0004.md) Telegram 前端成为真正的 Pi 原生 transcript 插件（P0）（commit 19819c9）
- [x] [REQ-UI-0001](REQ-UI-0001.md) 用 Pi 原生组件呈现 Telegram 消息与媒体（P1，依赖 UI-0004）（commit 19819c9）
- [x] [REQ-UI-0002](REQ-UI-0002.md) 原生 transcript 中 attach / more / detach 与任意 bot 过滤（P1，依赖 UI-0004）（commit 19819c9）
- [x] [REQ-UI-0003](REQ-UI-0003.md) 用 Pi 原生 FooterComponent 呈现实时可观测性（P1，commit `bf19671`）
- [x] [REQ-UI-0009](REQ-UI-0009.md) Footer 使用数据库全生命周期 telemetry 并补齐原生指标（P1，commit `d20ea5c`）
- [x] [REQ-UI-0005](REQ-UI-0005.md) attach 后用 Pi editor 直发；多 bot 复用 Pi 原生选择框（P1，commits `0b3fad0`、`4e29d45`、`d640de8`）
- [x] [REQ-UI-0006](REQ-UI-0006.md) 媒体识别完成后在原生 UI 下方显示视觉理解（P1，commits `132118c`、`16f69a2`）
- [x] [REQ-ROUTE-0001](REQ-ROUTE-0001.md) 忙碌 bot 跳过概率采样；配置名称是绕过 gate 的强制回复关键词（P1，commits `440b0c7`、`627d576`）
- [x] [REQ-UI-0007](REQ-UI-0007.md) 用 Pi 原生 footer status 呈现 Telegram 统计（P2，commit `bf19671`）
- [x] [REQ-UI-0008](REQ-UI-0008.md) 为 `/tg` 提供原生分级命令补全（P2，commit `967a6db`）
- [x] [REQ-CMD-0001](REQ-CMD-0001.md) Telegram 群内 help/status、手动 compact、参数调整与可配置管理员白名单（P1，commit `c0e5f26`）
- [x] [REQ-TG-0002](REQ-TG-0002.md) Bot 获得响应机会后显示 Telegram 原生处理状态（P1，commit `25e76bb`）
- [x] [REQ-TG-0003](REQ-TG-0003.md) Telegram Rich Messages 接收、持久化与有界投影（P1，incoming commit `1efd544`；agent 出站由 REQ-TG-0004 取代）
- [x] [REQ-REPLY-0001](REQ-REPLY-0001.md) 直接回复 bot 的消息保证进入对应模型上下文（P1，commit `df107f7`）
- [x] [REQ-OPS-0002](REQ-OPS-0002.md) 从 Pi 一键受控重启全部 bot 服务（P1，commit `3d7f9b3`）
- [x] [REQ-UI-0011](REQ-UI-0011.md) 用 Pi 原生 stack 优化聊天卡片信息层级、trailing 对齐与窄终端退化（P2，commit `614d6d3`）
- [x] [REQ-SEARCH-0001](REQ-SEARCH-0001.md) 用 TinyFish 读取群友链接并增强检索（P1，commit `0c450cd`）


## Bug

- [x] [REQ-SEARCH-0002](REQ-SEARCH-0002.md) 旧配置省略 `tools.search` 时不得让 TinyFish 从 provider context 消失（P0，commit `5891ac0`）
- [x] [REQ-OPS-0003](REQ-OPS-0003.md) foreground daemon 必须与后台 daemon 使用同一 PID 身份规则（P0，commit `6082b8e`）
- [x] [REQ-SEND-0003](REQ-SEND-0003.md) 本轮 provider 可见消息必须可被 `reply_to` 精确引用（P0，commit `6afaa8d`）
- [x] [REQ-STICKER-0002](REQ-STICKER-0002.md) 固定目录与动态候选必须按 bot 可发送性隔离（P0，commit `8eb3b97`）
- [x] [REQ-SEND-0001](REQ-SEND-0001.md) 统一 message/sticker/reply_to、tool-local 用法与 terminating 最小结果（P1，commit `8efd5ba`）
- [x] [REQ-UI-0010](REQ-UI-0010.md) 恢复 Pi 原生 feed 的即时刷新与流式 Agent 输出（P1，commit `f85045f`）
- [x] [REQ-SEND-0002](REQ-SEND-0002.md) Telegram 远端提交后不得因本地失败而重复发送（P0，commit `bd4be62`）
- [x] [REQ-UI-0012](REQ-UI-0012.md) 用Pi原生PNG转换与Image修复Kitty/Ghostty媒体显示（P1，commit `49e3067`）
- [x] [REQ-UI-0014](REQ-UI-0014.md) 群友照片不依赖 vision 即时进入 Pi 原生卡片（P1，commit `50eec13`）
- [x] [REQ-UI-0013](REQ-UI-0013.md) 用Pi原生Image语义化缩小sticker卡片、保持photo尺寸（P2，commit `533c9ec`）
- [x] [REQ-ROUTE-0002](REQ-ROUTE-0002.md) 验证 0.66/0.34 概率桶频率并区分回应机会与公开发言（P1，commit `a1321f1`）
- [x] [REQ-VISION-0001](REQ-VISION-0001.md) 群内动态媒体在 provider 提交前同步识别，目录 sticker 保持后台处理（P1，commits `f4ff63b`、`6efd768`、`8b2d410`）
- [x] [REQ-PLAT-0002](REQ-PLAT-0002.md) 复用 Pi 的模型设置与认证，取消项目 provider API key（P0，commits `0859490`、`f30e22c`、`c95c695`、`f4ff63b`）
- [x] [REQ-TG-0004](REQ-TG-0004.md) 将 Agent Markdown 映射为 Telegram entities，修复 RichMessage paragraph 整段粗体（P1，commit `3b56fa4`）


## 代码库与文档

- [x] [REQ-PLAT-0001](REQ-PLAT-0001.md) 收口为通用、快速、简洁的可配置 bot 平台（P1，commits `51b77f9`、`37499d0`；真实第三 bot 为文档化 opt-in）
- [x] [REQ-DOC-0001](REQ-DOC-0001.md) README 从用户视角解释平台、配置、使用与边界（P1，commit `37499d0`）
- [x] [REQ-ONBOARD-0001](REQ-ONBOARD-0001.md) clone → `bun run pi` → `/tg config`、TypeScript 本机配置、提示词隐私与双语 mdBook 用户文档（P1，commits `77a7d34`、`88e75d1`、`5dbf199`、`a0736f8`、`37499d0`、`27aca5a`）
- [x] [REQ-DOC-0002](REQ-DOC-0002.md) 明确单目录单群与极简省 token 的项目哲学（P1，commit `dfc23b5`）
- [x] 重构：[review-260808](review-260808.md)（commits `8c23c92`、`dbdc438`、`15c82cc`、`f50f10d`、`ea066c0`、`b7477b6`、`6977b02`）

## 顺序与依赖

全部需求均已完成；实现、验证与未执行的外部 credential 可选项记录在各 REQ、`../testing.md` 与已完成计划中。

- REQ-UI-0002 依赖 REQ-CONF-0001
- REQ-UI-0001 / 0002 / 0003 依赖 REQ-UI-0004 的 Pi package、版本与原生 transcript 接入
- REQ-UI-0005 依赖 REQ-UI-0004 的 input/lifecycle 边界与 REQ-CONF-0001 的任意 bot identity
- REQ-UI-0006 依赖 REQ-UI-0001 的 native media card；只消费现有 lazy vision 结果
- REQ-ROUTE-0001 依赖 REQ-AGENT-0001 的串行 flush 状态，但只 gate probability path；explicit trigger 仍可 pending coalesce
- REQ-SEND-0001 继承 ROUTE-0001 的 explicit 决策，并把公开回复、单一组合工具、persona 去重与终止成本固化在 tool schema
- REQ-UI-0007 是 REQ-UI-0003 的交互后继：stats 数据层保留，presentation 从自定义 widget 改用 Pi default footer `setStatus`
- REQ-UI-0008 使用 Pi `registerCommand.getArgumentCompletions`；命令树需吸收 UI-0005/0007 新增/调整的子命令
- REQ-UI-0009 固化 UI-0003/0007 的 lifetime 范围，并补齐 Pi 原生 cache-write 与 `/tg status` 详情；不得退回第三行或自绘 footer
- REQ-UI-0010 复用 Pi AgentSession `message_update` 与宿主 `TUI.requestRender()`；流式帧只存在于 IPC/TUI 内存，不写 DB/Pi session/provider context
- REQ-UI-0011 只重组 UI-0001/0006/0010 的现有卡片数据，复用 Pi `HStack/VStack` 与 theme；不新增生产渲染 LOC、依赖、数据字段或provider字节
- REQ-UI-0012 继续由Pi检测Kitty/Ghostty并由`Tui.Image`渲染；插件只按Pi公开模式异步把非PNG归一化为Kitty `f=100`所需PNG，不自写terminal protocol
- REQ-TG-0002 承认 private draft 原生 Thinking；当前 supergroup 使用 `typing` lease 每 4 秒续约，绝不误发 trigger sender 私聊；send 成功或 flush settle 后停止
- REQ-TG-0003 保留incoming RichMessage、raw persistence与有界projection；其首版agent outbound transport由REQ-TG-0004取代，group仍不调用private draft
- REQ-TG-0004 取代 REQ-TG-0003 的 agent 出站 transport：incoming RichMessage data plane保留，outbound改为Markdown→classic message entities；只更新单一send tool说明并bump cache schema
- REQ-REPLY-0001 保证 direct reply 的原始消息进入对应 bot provider suffix，不提供 runtime 内容兜底；嵌套父 sender、busy/catch-up 与 restart 都不得丢 obligation
- REQ-OPS-0002 按当前共享进程架构做 deployment-wide graceful restart；Pi `/tg restart` 复用 PID 身份/ready 检查并恢复原 feed，不在进程内热重建单个 bot
- REQ-CMD-0001 是 Telegram 群内 deterministic control plane；只读命令公开，compact/set/reset 只认 deployment allowlist，命令不得进入 agent context
- REQ-STICKER-0002 是 REQ-STICKER-0001 的 per-bot sendability 回归修复，并会触发 cache schema bump
- REQ-PLAT-0002 以 Pi 0.84.1 的 settings/catalog/auth 为唯一 LLM 配置源；REQ-VISION-0001 复用同一 runtime 执行 Luna low
- REQ-UI-0014 只异步准备本地显示文件，不新增 vision/LLM call；REQ-VISION-0001 只阻塞真正进入 provider batch 的动态媒体
- REQ-SEARCH-0001 保持既有 `search` tool 名称与顺序，但扩展 schema 会触发下一次 cache schema bump
- REQ-ROUTE-0002 只增加确定性审计与口径文档，当前生产重放不授权修改 HMAC 概率算法
- REQ-DOC-0002 是现状 deployment/invariant 的权威说明，不扩展为同目录多群架构
- review-260808 取代旧`exposed_ids`运行模型：immutable event cursor、current visibility与reply obligation是三套独立状态；cache-visible identity由restore前fingerprint隔离
- REQ-PLAT-0001 复用 REQ-CONF-0001 已完成的 N-bot 核心，不重复重写 daemon composition
- REQ-DOC-0001 等待 PLAT-0001 的 provider/config schema 稳定后再写最终 README，避免文档抢跑
- REQ-ONBOARD-0001 依赖 PLAT-0001 的 provider schema、DOC-0001 的用户旅程与 OPS-0002 的受控 readiness；新默认是 ignored `telegram.config.ts`，legacy JSON 保持兼容；真实 persona 只从后续 HEAD 退出，不偷偷改写 Git 历史
- REQ-STICKER-0001 的 R3 与 REQ-AGENT-0001 的 R7（send 先校验后发）协同
