# REQ-UI-0006: 在媒体下方实时显示辅助视觉模型理解

- **Status:** Implemented（2026-08-08 T7 transport + T8 native card merge 已实现；真实 Pi live media smoke 留到 T14）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「用户发的 image/sticker 识别完成后，在 UI 下方插入辅助视觉模型的理解文字；不动上下文，仅 UI」
- **依赖:** REQ-UI-0001、REQ-UI-0004

## 问题

history/snapshot 会从 `media.vision` 填充 `MsgItem.mediaDesc`，所以重新 attach 后可见已有描述；但 live message 初次广播时通常尚未识别。`ensureVision()` 完成只更新 SQLite，没有 IPC update，已挂载的 Telegram card 不会刷新，除非重连。

## 调查结论

- 视觉结果已按 `file_unique_id` 持久化并跨 bot 共享；无需为 UI 建第二套 cache。
- 当前识别由 bot flush 的 lazy vision 路径触发。复用这一结果不会增加模型调用；若为 UI 主动 eager 识别，会改变成本与运行语义，不应在本需求中暗中引入。
- native feed 已是内存组件树，可以在收到 additive `vision_update` 后更新所有引用同一 media 的 card 并 invalidate；无需追加 Pi session entry。
- `MsgItem` 目前没有 `file_unique_id`，只带 path/description。实时关联需要增加不敏感的 media identity 字段或稳定 message identity 映射。

## 目标

当现有辅助视觉识别完成并持久化后，所有正在显示该 image/sticker 的 Telegram message card 在媒体正下方出现一段 Pi theme 文本；纯展示更新不改变 Pi session 或任一 bot 的 provider context。

## 非目标

- 不为 UI 主动触发额外视觉模型请求；识别时机仍由现有 lazy/cache 流程决定。
- 不改变 `serializeMessages`、system prompt、exposure、context epoch 或 vision prompt。
- 不支持在 UI 编辑视觉结果。
- 不把描述追加为新的 Telegram 消息或 Pi user message。

## 需求

- **R1 — additive identity：** `MsgItem` 增加 `fileUniqueId`（或等价稳定关联键）；旧 client 忽略新字段仍可工作。
- **R2 — 完成通知：** `ensureVision` 成功写库后，daemon 发布 additive `vision_update { fileUniqueId, text }`。广播归属在 media/daemon 边界，不从 extension 轮询 DB。
- **R3 — 原生 card 更新：** timeline client 合并 update，feed 对所有匹配 message invalidate；`Text`/`Box` 在图片或 sticker fallback 正下方显示 `视觉理解 · <text>`，颜色来自 Pi theme。
- **R4 — 安全与一致性：** 描述走现有 `sanitize()`；snapshot/history 与 live update 使用同一字段与文案。重复 update 幂等，乱序 update 可在 message 到达前短暂缓存且内存有界。
- **R5 — 上下文隔离：** 不调用 Pi message API，不 append 新 entry，不修改 provider serialization；只更新现有 TUI-only feed 的内存 state。
- **R6 — 失败/不支持：** vision 失败、unsupported、空文本时不伪造理解；可显示 muted 状态或保持占位，错误只进现有 LOCAL/daemon observability。

## 验收标准

- **AC1:** live photo 先显示图片/占位，随后收到 `vision_update` 后同一卡片下方出现描述，无需 detach/attach。
- **AC2:** 同一 `file_unique_id` 被多条消息引用时全部更新；重复 update 不重复插入文本。
- **AC3:** update 先于 message、消息已在 older page、识别失败、空文本与 ANSI/OSC 内容都有回归测试。
- **AC4:** Pi session entry 数量不因视觉 update 增长；cache golden、system/tools/message hashes逐字节不变。
- **AC5:** 不新增视觉 provider call；telemetry 对比显示 UI 开关不改变 vision 请求数与 token 成本。
- **AC6:** `bun test`、`bun run check` 与真实 Pi live media smoke 通过。

## 约束

- Cache impact: **NONE**。只复用已经持久化的视觉结果并更新 TUI-only state。
- IPC 变化 additive；pending update map 必须有数量/时间上限。
- UI 文本不能泄露本地路径或视觉 provider 原始响应元数据。

## 例子与边界 case

- JPEG 可内联：`Image` 下方显示理解。
- webm/tgs 不可内联：fallback 下方仍可显示已有理解。
- 识别发生在消息翻页前：以后 `/tg more` 加载该消息时直接从 snapshot 字段显示。

## 可观察性

测试可统计 `vision_update` received/applied/dropped；生产默认不记录完整理解文本。

## 文档影响

`docs/architecture.md` Vision/Pi UI 小节、`docs/testing.md`、IPC reference。

## 待决问题

- 是否未来增加“为了 UI eager 识别”开关。若需要，必须另开需求并单独评估模型调用、token 与预算，不能并入本需求。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs` T7/T8
- Commits: `132118c`（transport）；presentation commit 从 `Requirement: REQ-UI-0006` trailer 查
