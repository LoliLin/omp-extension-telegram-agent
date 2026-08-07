# REQ-IPC-0001: IPC 与 TUI 健壮性

- **Status:** Approved
- **Priority:** P1
- **Source:** 2026-08-07 code review

## 问题

1. **文本腐蚀**：`src/ipc.ts` 的 `FrameDecoder` 每次 push 新建非 streaming `TextDecoder`，多字节字符被 socket chunk 边界切开后变 U+FFFD——daemon→TUI 全是中文消息且 snapshot 帧几十 KB 必然分 chunk，TUI 文本被静默腐蚀。
2. **socket 写边界**：`ipc-server.ts` 未处理 `socket.write` 返回 **-1**（已关闭）的情况，`subarray(-1)` 把帧截成最后 1 字节并让队列永久卡住；出站队列无上限，TUI 被 Ctrl+Z 挂起时 daemon 内存无界增长。
3. **分页丢消息**：history 分页用 `ts < beforeTs` 严格小于，Telegram 秒级精度下同秒多条消息很常见——与边界条目同 ts 的消息在任何一页都不返回。
4. **本机暴露面**：unix socket 无鉴权、权限随 umask，本机任何进程发 `hello` 即可拉走全部群聊时间线；`history limit` 未夹取，传 1e9 让 daemon 整表读进内存。
5. **终端注入**：TUI 把群消息原文直接拼进终端输出，群成员可用 ANSI/OSC 转义清屏、改色，支持 OSC 52 的终端上可写剪贴板。

## 目标

IPC 传输字节正确、背压有界、分页不丢；本机攻击面最小化；TUI 显示不受群消息内容控制。

## 非目标

- 不改 IPC 协议帧格式（JSONL）与 hello/history/event 语义。
- 不做跨机器访问（unix socket 本机的前提不变）。

## 需求

- **R1:** `FrameDecoder` 实例持有一个 `TextDecoder`，用 `decode(chunk, {stream:true})`；flush 时机正确处理。
- **R2:** `socket.write` 返回 <0 时把该 socket 从 listeners 移除并丢弃其队列；出站队列设字节上限（如 1MB），超限主动 `socket.end()` 并移除。
- **R3:** history 分页改用 `(ts, message_id)` 复合游标（agent_events 用 `(ts, rowid)` 或等价稳定键），同 ts 消息不丢不重。
- **R4:** socket 文件创建后 `chmod 600`；`history limit` 服务端夹取到 `[1, 500]`。
- **R5:** TUI 渲染任何群消息 / 事件 payload 前 strip 控制字符（保留 `\n`）。
- **R6:** `FrameDecoder` 接收缓冲设上限（如 4MB），超限断开连接。
- **R7:**（附带 minor）snapshot 与 broadcast 竞态导致的重复条目由客户端按 messageId/eventId 去重；`prependItems` 翻页时补日期分隔线。

## 验收标准

- **AC1:** 构造一条含多字节字符的帧按随机 chunk 边界切开喂给 FrameDecoder，解码结果与原文逐字节一致（回归测试）。
- **AC2:** 同一秒内 3 条消息 + 更多历史，翻页拉取后全集与 messages 表一致（无丢无重）。
- **AC3:** 模拟 listener 卡死（write 返回 0），队列超限后 daemon 断开该连接且内存有界；write 返回 -1 后 broadcast 不再向该 socket 堆积。
- **AC4:** socket 文件权限为 600；`limit=1e9` 的 history 请求返回被夹取的结果。
- **AC5:** 含 `\x1b[2J` 等转义序列的群消息在 TUI 中显示为无害文本。
- **AC6:** `bun test` 全绿 + AC1/AC2 回归测试；`bun run check` 通过。

## 约束

- Cache impact: **NONE**（UI/IPC only；按 cache invariant 5，任何 provider payload 变化即边界 bug）。
- 兼容：协议帧格式不变，旧 TUI / 新 daemon 可互操作（R3 游标格式变化需双向兼容或在同一 commit 同时改两侧）。

## 例子与边界 case

- TUI 在 snapshot 返回途中收到 broadcast → 重复条目去重（R7）。
- attach → 立即 Ctrl+Z → 10 分钟群消息 → daemon 内存平稳。

## 可观察性

- listener 被踢（队列超限）时 daemon log 一行 warn。

## 文档影响

- `docs/architecture.md`（IPC 小节：权限、背压、游标）、`docs/testing.md`。

## 待决问题

无。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
