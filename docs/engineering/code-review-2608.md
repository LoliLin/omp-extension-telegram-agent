# 2026-08 全面 Review 结论与 Pi 能力审计

> 2026-08 一轮覆盖全部源码与文档的 review 的结论存档（以 commit c5ae989 前后的代码为准）。目的：让未来 agent 直接复用结论，不重复调查、不重复犯错。每条给文件证据；标注"已修"的问题不要再当作现状去调查。

## 1. Cache 经济（项目核心 invariant）

- **已修**：sticker catalog snapshot hash 曾包含异步回填的 vision 文本——回填完成前每次重启 fingerprint 漂移，provider 前缀 cache 全失效。v9 修复为 catalog identity-only 固化进 system prompt，top-K 检索与 vision 回填整体删除（`src/agent/prompt.ts:6` `CACHE_SCHEMA_VERSION = 9`）。
- **已修**：top-K sticker 候选曾注入每轮最后一条 message 的 suffix，使该 message 永远无法被 cache 复用。已随 v9 一并删除。
- **保留**：`streamFunction` 猴补丁（`src/agent/runtime.ts:431-436`）向每次请求注入 `cacheRetention`，是项目中唯一的 Pi 私有缝。pi-ai 的 `StreamOptions` 有 `cacheRetention`，但 pi-coding-agent 不从 settings 透传，无公开替代。**升级 Pi 时必须验证此缝仍生效**；cache-observer 实测 payload 兜底（`src/observability/provider-context.ts`）。
- **保留**：extension 顺序是双真相源——声明常量 `TELEGRAM_EXTENSION_ORDER`（`src/agent/extensions/index.ts`）与 `runtime.ts` 的注册数组手工同步。改注册顺序必须同步常量。
- **刻意不统一**：`src/agent/token-packer.ts:15` 用 UTF-8 bytes/2 作 token 上界估算。Pi 的 estimateTokens（chars/4）对中文低估 2-3 倍，bytes/2 是刻意的保守上界，不要"统一"成 Pi 的算法。

## 2. Pi 原生能力审计（0.84.1）

结论：无整套自造轮子。逐项判定如下。

| 能力 | 现状 | 判定 |
| --- | --- | --- |
| compaction 引擎 | Pi 内建引擎 + SettingsManager 配置（`src/agent/runtime.ts:425`） | 走 Pi 公开 API |
| session JSONL 持久化 | Pi SessionManager | 走 Pi 公开 API |
| provider 调用 / retry | Pi agent stream | 走 Pi 公开 API（`cacheRetention` 注入除外，见第 1 节） |
| tool 注册 | `customTools`（`src/agent/runtime.ts:428`） | 走 Pi 公开 API |
| TUI 组件 / extension hook | `.pi/extensions/tg-extension.ts` | 走 Pi 公开 API |

逐文件判定：

- `src/agent/runtime.ts` / `serialize.ts` / `prompt.ts` / `router.ts` / `src/db/` / `src/ipc.ts`：领域逻辑或合理胶水，不是轮子。
- 已删除对 Pi 公开 API 的 duck-typing 防御——公开 API 的形状由类型系统保证，运行时防御只增加噪音。
- `src/agent/model-ref.ts` 与 Pi 的 `parseModelPattern` 功能平行，但 Pi 未导出该函数——保留，不要误判为重复轮子。
- compaction 摘要用 `completeSimple` 自建（`src/agent/runtime.ts:718-731`），因为 Pi 的 `generateSummary` 不支持自定义 system prompt——保留理由成立。
- llm_runs cache-miss 分析与 Pi cache-stats 有重叠：未来可在 debug 报告层复用 Pi 的 `computeCacheWaste`，低优先级，不紧急。

规则：新功能先查 `node_modules/@earendil-works` 各包导出，再考虑自造。

## 3. 已删除的历史包袱清单（本轮）

按类别一行一条，附删除理由；**不要把这些加回来**。

- legacy 配置：`bots.config.json` 兼容、`bots_config` env、Raw 死字段、DB override 层——配置单轨化（`telegram.config.ts` + Pi settings + `.env` secrets），删一切第二来源。
- 死代码：routing-audit 日志解析、`stickerCatalogBlock`、router 兼容包装、IPC `beforeTs`、`sendUserMessage` 兼容缝、`main.ts` attach、空目录 `src/tui/`、analyze / benchmark 脚本。
- 防御过度：vision 三重超时收敛为 SDK 单层（`src/media/vision.ts:225`）、`normalizeNonce`、`displayJson` try/catch、NativeMediaCache 常量校验；sticker / alias 分配从 COUNT+1 改 rowid。
- 测试：47 → 6，只留 invariant 与安全边界守卫（`docs/testing.md`）。
- 文档：REQ / PLAN / devlog / handoff / traceability / maintainers 过程件约 9.6k 行删除，合并为单一正式集；追溯靠原子提交 + 清晰 message。

## 4. 接受的遗留结构债（明确不做及原因）

- `src/agent/runtime.ts` God class（~1.4k 行，多职责）：拆分收益大但行为风险高，等具体需求驱动再拆。
- daemon 进程监督 5 套机制（pid 文件、pid lock、restart control lock、socket 探测、`ps` 枚举孤儿进程，见 `src/daemon/pid.ts` / `src/daemon/control.ts`）：对单进程本地 daemon 超重，但重构风险高于收益；有 daemon 稳定性需求时再处理。
- `.pi/extensions/tg-extension.ts` ~1.3k 行单文件：UI-only，不影响 provider payload，暂不拆。
- manual send 多层幂等叠加（TUI `requestId`、daemon fingerprint `src/daemon/manual-send.ts:43`、IPC 兜底）：组合行为难推理，记录待需求驱动。

## 5. 给未来 agent 的规则提炼

1. 一套设计、不留兼容层；breaking change 只要迁移干净。
2. 删代码优先于加抽象。
3. Pi 能做的不自造：先查 `@earendil-works/*` 导出。
4. cache-visible 变更必 bump `CACHE_SCHEMA_VERSION` + 更新 golden + 同步 `docs/cache.md`。
5. 防御代码只防真实可能的分支；第 3 节列出的已删防御不要加回来。
