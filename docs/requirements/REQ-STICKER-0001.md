# REQ-STICKER-0001: 固定 sticker set 支持

- **Status:** Draft
- **Priority:** P2
- **Source:** 用户 REQ-LIST 第 3 条（「缓存率 up，同时 bot 能发出现在上下文的 sticker」）

## 问题

当前 sticker 候选是动态 suffix（`stickerCandidatesBlock`，≤8 条，只含当前上下文出现过的 sticker）：随消息流不断变化，每次都产生新的 cache miss 区域；且 bot 只能发上下文里恰好出现过的 sticker，表达能力受限。

## 目标

为每个 bot 配置固定 sticker set：目录内容**稳定**，序列化为稳定 prefix（或 epoch 内不变的确定性 suffix），让 sticker 语义知识参与 prefix 复用；bot 可发送 set 内任意 sticker，不再依赖上下文出现。

## 非目标

- 不做 sticker set 的在线学习 / 自动扩充（变更走配置 + 重启）。
- 不保留动态 candidates 机制（除非设计评审认为二者共存更优——见待决问题）。

## 需求

- **R1:** 配置项：每 bot 一个固定 sticker set（Telegram set name 或显式 sticker 列表）；启动时解析、下载、vision 预识别并持久化（复用现有 vision cache）。
- **R2:** sticker 目录序列化：确定性顺序 + 固定 grammar，作为 system prompt 的一部分或紧跟其后的稳定块；set 内容变化 = cache-visible 协议变化，走 `CACHE_SCHEMA_VERSION` bump 流程。
- **R3:** `send` 的 sticker 参数接受 set 内任意 short_id；无效 id 返回结构化错误（与 REQ-AGENT-0001 R7 的先校验后发送协同）。
- **R4:** 上下文中出现的 set 外 sticker 仍按现有 lazy vision 识别并序列化为占位符（观察能力不丢），只是不可用于发送。
- **R5:** 目录规模有界（如 ≤120 个 sticker）；超出时启动报错或截断策略明确，防止 prefix 膨胀反而抬高成本。

## 验收标准

- **AC1:** 固定 set 序列化进 golden：hash 锁定；set 不变时逐字节稳定。
- **AC2:** bot 成功发送一个从未在当前上下文出现过的 set 内 sticker（真实群验证）。
- **AC3:** 遥测对比：同等消息负载下，sticker 相关 cache miss tokens 较动态 candidates 方案下降（用 `analyze-context-window.ts` 或 llm_runs 对比）。
- **AC4:** set 内容变更后 bump `CACHE_SCHEMA_VERSION`，新 epoch 开启，旧 epoch 数据仍可回放。
- **AC5:** `bun test` + golden + `bun run check` 全绿。

## 约束

- Cache impact: **INTENTIONAL**——本 REQ 的核心就是 cache 工程变更；必须 bump `CACHE_SCHEMA_VERSION` 并同步 `docs/cache.md`。
- 成本：目录进入稳定 prefix 提高 hit 率，但也抬高每 turn 的 cache_read 基数——R5 的规模上限与 AC3 的实测对比是决策依据。
- 兼容：现有 sticker 相关 DB 表（media / file_id 映射）尽量复用。

## 例子与边界 case

- set 内含 tgs/webm（不支持识别）：按现有 unsupported 语义处理并在目录中标注。
- 上下文出现 set 外 sticker：占位符 + vision 描述照常，send 引用它返回错误。
- 两个 bot 配置不同 set：各自 prefix 独立稳定。

## 可观察性

- llm_runs 可区分 sticker 目录带来的 cache_read 基数变化（system hash 变化即 bump）。

## 文档影响

- `docs/cache.md`（grammar + CACHE_SCHEMA_VERSION）、`docs/architecture.md`（Vision/Sticker 小节）、personas 中 sticker 使用说明。

## 待决问题

- 目录放 system prompt 内还是首个稳定 suffix 块？（前者更稳，后者更灵活）
- 动态 candidates 机制保留还是替换？倾向替换（单一机制），开工前确认。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
