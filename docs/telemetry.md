# 统一 usage/status telemetry 口径

> 本文是 Pi `/tg status` 与 Telegram `/status` 的 usage 字段、计算公式和展示一致性的唯一权威来源。日志诊断见 `docs/engineering/debugging-guide.md`；provider cache 协议见 `docs/cache.md`。

## 目的与范围

两个详细界面 MUST 从同一份 SQLite `llm_runs`、daemon runtime snapshot 和同一组派生函数得到数值。界面可以因空间不同采用换行或富文本，但不能改变字段含义、统计范围或公式。普通 Pi footer 显示当前 operator session；attached feed 通过官方 `ctx.ui.setFooter` 只保留路径/分支与 extension statuses，隐藏无关的 operator usage 行，并通过 `ctx.ui.setStatus` 提供 Telegram 紧凑统计。detach 后恢复 Pi 默认 footer。

本文同时定义 provider usage 聚合与详细 runtime 状态的合并投影；Telegram runtime state、routing/cooldown 与最近 compact outcome 仍由 control/runtime 层拥有，不能反向藏进 usage 聚合。

## 唯一状态读模型

daemon 的 runtime snapshot 是 provider/model、**实际生效 reasoning effort**、context window、epoch、runtime state、routing/cooldown 与 compact outcome 的权威来源；SQLite `BotStats` 是 latest/lifetime usage 的权威来源。两者只能在共享 `BotStatusView` builder 中合并一次，再由共享字段投影生成详细状态。

- Pi `/tg status` 与 Telegram `/status` 的 plain/rich 版本 MUST 迭代同一组有序字段，不得各自维护字段清单。新增、删除或重命名详细字段只能改共享投影一次。
- daemon snapshot 通过 additive IPC 随 stats baseline 发送；`/tg status` 每次建立短连接读取新 snapshot，不能复用可能过期的 feed runtime state。
- reasoning 展示的是 Pi session 的 effective value。requested/supported/effective 只在配置校验与 debug 中同时出现；运行中的状态不得把 requested value 伪装成 effective value。

## 权威数据与两种时间范围

`llm_runs` 每行是一条成功返回 usage 的 provider response。保留期由配置控制，默认 90 天；文案中的“累计”或“lifetime”只表示当前 SQLite 保留行，不表示永久历史。

- **最近请求（latest）**：该 bot 最新一条 `compaction = 0` 的主对话 response。它提供当前上下文、epoch、miss/read/write、output、reasoning、latency 与单次费用。compaction 的辅助模型调用不能冒充当前主对话上下文。
- **保留期累计（lifetime）**：该 bot 当前保留的全部 `llm_runs`，包括主对话与 compaction provider response。它提供 runs、起始时间、prompt/output/cache/reasoning、费用与平均 latency。

新增 response 必须同时更新 SQLite 与 live IPC totals；snapshot/push 通过 `llm_runs.id` 去重。compaction usage 参与累计，但不替换 latest 主对话请求。

## 字段与公式

| 展示 | 符号 | 权威值 / 公式 | 说明 |
| --- | --- | --- | --- |
| Prompt miss | `↑` | `cache_miss` | provider 报告的非 cache prompt input |
| Output | `↓` | `output_tokens` | provider output；不计入当前 prompt context |
| Cache read | `R` | `cache_read` | 从 provider cache 读取的 prompt tokens |
| Cache write | `W` | `cache_write` | 本次写入 provider cache、但未命中的 prompt tokens |
| Cache hit | `CH` | `R / (↑ + R + W) × 100%` | 显示一位小数；只有 `R > 0` 或 `W > 0` 时有 cache 样本，否则显示 `—` |
| Prompt total | `prompt` | `↑ + R + W` | lifetime 中等于 `SUM(context_tokens)` |
| 当前上下文 | `context` | latest 主对话 `context_tokens / model.contextWindow` | 同时显示 tokens、window 与一位小数百分比；不是 lifetime prompt 总和 |
| Reasoning | `reasoning` | `reasoning_tokens` | latest 取单行；lifetime 求和 |
| Latency | `latency` / `avg` | `latency_ms` / `SUM(latency_ms) ÷ COUNT(latency_ms)` | 缺失样本显示 `—` |
| Cost | `$` | `cost` | latest 取单行；lifetime 求和 |

`context_tokens` 是发送给 provider 的 prompt tokens，即 `↑ + R + W`；`output_tokens` 单列。因此“当前上下文 16,000 / 128,000”与“累计 prompt 1,600,000”可以同时成立，二者不可互换。

若没有 latest 主对话请求，当前上下文显示 `— / <window>`；若模型目录也没有有效 `contextWindow`，window 与百分比均显示 `—`。上下文上限 MUST 来自 Pi `ModelRuntime` / model registry 的已解析模型，不在 Telegram 配置中复制第二份常量。

## 两个界面的共同字段

| 字段 | Pi `/tg status` | Telegram `/status` |
| --- | --- | --- |
| `↑ / ↓ / R / W / CH / $` lifetime | 完整数值 | 完整数值 |
| 当前 context / window / percent | latest 明细 | 每 bot 富消息小节 |
| provider/model/effective reasoning | 标题/明细 | 每 bot 富消息小节 |
| latest usage/latency/cost | 是 | 是 |
| lifetime runs/since/prompt/reasoning/avg | 是 | 是 |
| runtime state/routing/compact | 是 | 是 |

`/tg status` 与 Telegram `/status` 只是同一明细投影的两种外层渲染；二者的字段 key、顺序和数值必须来自同一个共享投影。

attached feed 的两行 footer 第一行保留 cwd、git branch 与 session name，第二行按 Pi 原生顺序显示 lifetime `↑ / ↓ / R / W / CH / $`、latest 主对话的 `context%/window`、当前 model 与 compose status。all-bots scope 只聚合当前配置 bot，并用最新主对话 run 所属 bot 的 context/model；精确整数和完整 runtime 明细仍由 `/tg status` 提供。detach、断线、restart/config 切换与 session shutdown 必须恢复默认 footer 并清除此 status。

## 格式与边界

- Telegram `/status` 的整数和费用整数部分使用英文逗号千位分隔；百分比固定一位小数。
- Pi `/tg status` 与 Telegram `/status` 的详细整数统一使用英文逗号千位分隔。
- Telegram 富消息仍受 3500 字上限；只能按完整 bot 小节省略，不能在 Markdown 中间截断。
- 格式化和查看 telemetry 不调用 provider，不改变 session、context epoch 或 cache-visible payload。

## 验证与更新触发条件

测试 MUST 守卫：latest 排除 compaction、lifetime 包含 compaction、live compaction totals 不替换 latest、`CH` 分母包含 `W`、无 cache 样本显示 `—`、当前 context 使用 latest/window 而非 lifetime sum、attached footer 只有路径/status 两行且紧凑投影保持 Pi 字段顺序，以及两个详细状态投影拥有完全相同的字段 key/顺序。

修改 `llm_runs` 字段、IPC `UsageRun` / `BotStats`、`/tg status` 或 Telegram `/status` 时必须同步本文。该模块的 Cache impact 为 **NONE**：它只读取既有 telemetry 并生成 UI/control side-channel。
