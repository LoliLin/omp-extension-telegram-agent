# REQ-TG-0001: Telegram ingestion 与 poller 可靠性

- **Status:** Done（2026-08-08；ingest/edit/dedupe/poller/restart已验收）
- **Priority:** P1
- **Source:** 2026-08-07 code review（revision bug 已实证）

## 问题

1. **二次编辑丢历史**：`src/telegram/ingest.ts` 的 revision 主键用 `existing.edit_date ?? m.edit_date`，消息第二次编辑时与上一条 revision 撞 `(chat_id, message_id, edit_date)` 主键，被 `INSERT OR IGNORE` 静默丢弃——中间版本永久丢失，违反 `docs/data-model.md` 对 message_revisions 的承诺。已实证。
2. **出错即丢消息**：`poller.ts` 中 `ingestUpdate` 抛异常后 offset 照常推进，该消息永远不进 messages 表、永不触发 router。
3. **单点故障放大**：`setBotState` 在 per-update try/catch 之外，其异常会让 poller `run()` reject → daemon 顶层退出（两个 bot 一起死，pid 文件残留）。
4. **网络层脆弱**：fetch 无超时（TCP 半死时 poller 假死）；非 JSON 错误响应丢失 HTTP status；401（token 失效）按普通错误无限 backoff 而非 fail-fast。

## 目标

ingestion 的任何失败要么幂等重放、要么响亮报错；编辑历史完整；单条 update 的失败不扩散为进程级故障。

## 非目标

- 不改 raw_updates / messages 的去重设计与表结构（revision 修复不改 schema，只改 key 取值）。
- 不引入第三方 Telegram SDK。

## 需求

- **R1:** revision key 修正：被取代版本的 key 用该版本自己的时间（原始版用消息 `date`，编辑版用其 `edit_date`），保证 v1→v2→v3 全链保留；加二次编辑回归测试。
- **R2:** ingest 失败时不推进 offset；下一轮 getUpdates 重拉，由 raw_updates 去重保证幂等。连续失败次数可计数并 log warn。
- **R3:** `setBotState` 纳入 per-update try/catch；poller 主循环在每次 `await` 返回后重检 `stopped`（shutdown 中不再处理 / 写库）。
- **R4:** 非长轮询的 Bot API 调用加 `AbortSignal.timeout`；错误路径容忍非 JSON 响应并保留 HTTP status；401/404 类鉴权错误 fail-fast（抛出而非无限重试）。
- **R5:**（附带 minor）`editMessage` 更新 media 列或注释说明不支持 editMessageMedia；`insertSentMessage` 补 `recordMedia`（消除对 poller echo 的隐式依赖）；`"edit-unknown"` 提取为常量。

## 验收标准

- **AC1:** 给定一条消息被连续编辑两次，message_revisions 含 v1、v2 两条完整历史，messages 表为 v3。
- **AC2:** 给定 ingest 对某 update 注入失败，offset 不推进；修复后重启 / 下一轮重放该 update 成功落库且无重复。
- **AC3:** 给定 `setBotState` 注入失败，poller 按 backoff 继续运行，daemon 进程存活。
- **AC4:** 给定 shutdown 发生在 `await getUpdates` 期间，返回后不处理 updates、不写库，进程干净退出。
- **AC5:** `bun test` 全绿 + AC1/AC2 回归测试；`bun run check` 通过。

## 约束

- Cache impact: **NONE**。
- 兼容：R1 只影响新写入的 revision key；已有 dev db 的旧 revision 行保留即可（dev 数据，不做迁移）。
- Secret：错误信息不得包含 token（保持现状）。

## 例子与边界 case

- edit 先于原始消息到达（`edit-unknown` 路径）在 R1 后仍正确去重。
- Telegram 返回 502 HTML 页面（中间代理）：poller 报出 status 并按 backoff 重试，不抛 SyntaxError。
- token 失效（401）：daemon 响亮失败，而不是静默假死。

## 可观察性

- ingest 连续失败计数进 log；鉴权失败有明确的 fatal 日志行。

## 文档影响

- `docs/data-model.md`（revision key 语义澄清）、`docs/testing.md`。

## 待决问题

无。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
