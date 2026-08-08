# 数据模型

> 描述当前 schema 真正表达的内容。schema 变化时同步更新。

存储：SQLite（WAL），单文件 `data/agent.db`（路径可配）。直接 SQL，无 ORM。

## 表概览（Phase 1 skeleton 起逐步落地）

### raw_updates — 原始 Telegram update

- `(bot_id, update_id)` 唯一（bot identity + update_id 去重）
- 存完整原始 JSON：debug / replay / 未来字段升级 / 修 normalization bug

### messages — canonical 群消息

- `(chat_id, message_id)` 唯一 —— 多个 bot 收到同一条群消息只存一条
- 元数据：send_time、thread_id、sender_id、display_name、username、sender_tag、sender_chat、is_bot、text、caption、entities(JSON)、`rich_message`(JSON)、reply_to_message_id、quote(JSON)、forward_origin(JSON)、edit_time、media 引用
- Rich Message：`rich_message`保存原始Telegram structure，UTF-8 JSON上限256 KiB；超限/不可序列化时只存 `{truncated,reason,raw_bytes?}` 有界诊断。`text`保存无LLM projector的纯文本结果（16层、500 blocks、4096 nodes、32768 Unicode code points），保持heading/list/table/details/caption阅读顺序；URL、file id与未知metadata不进projection。IPC/Pi/provider只读`text`，不传source。
- edit：messages 表永远是最新版，旧版进 message_revisions；rich edit同时保存旧/新projection与source

### message_revisions — 编辑历史

- `(chat_id, message_id, edit_time)` 唯一；存该版本完整 text/entities/rich_message source
- revision 行的 key 是**被取代版本自己的时间**：原始版本用消息 `date`，编辑过的版本用它当时的 `edit_date`（REQ-TG-0001；此前用旧 edit_date 会在第二次编辑撞主键静默丢中间版本）

### media — 媒体身份与本地缓存（Phase 7）

- `file_unique_id` 为主身份；存 file_id(per bot)、mime、尺寸、本地路径
- vision 结果按 file_unique_id 缓存，所有配置 bot 共享

### agent_events — bot 内部行为

- 每条：bot、时间、kind（assistant_text / thinking / tool_call / tool_result / vision / usage / compaction / error）、payload(JSON)
- TUI 的 `Bot X · LOCAL` 区域数据源

### llm_runs / telemetry — provider 遥测

- 每条 provider response 记录 context/input(cache miss)/cache read/cache write/output/reasoning/latency/cost、model/epoch 与 system/tools/messages hashes；`cache_write` 在 REQ-UI-0009 加入，旧库幂等 migration 为 `NOT NULL DEFAULT 0`，历史未知值不伪造。
- footer/status 的 lifetime totals 对当前配置 bot 聚合本表全部保留行，因此跨 daemon/Pi restart 与 compaction/epoch；current context 只取最新 run，不累加历史 occupancy。

### bot_state — 每 bot 运行状态

- session 文件路径、context epoch、update offset、exposure 水位线等 KV
- bot_id 为 TEXT，任意 bot id 可用（REQ-CONF-0001 泛型化：bot_state / agent_events / llm_runs / raw_updates 的 bot 列均为 TEXT，bot 清单来自 bots.config.json，代码无 A/B 假设）

### aliases — 无 username 用户的稳定短 alias

- `(chat_id, user_id) → u<N>`，单调分配，永久稳定

## ID / dedupe 规则

- update 唯一性：`(bot_id, update_id)`；重复 update 直接跳过
- 消息唯一性：`(chat_id, message_id)`；多个 bot 各收到一次 → 后续副本视为 duplicate
- restart：offset 从 bot_state 恢复，Telegram 重发的旧 update 被 raw_updates 去重
- bot 自发消息：plain/rich send返回都经同一normalize立即落库；随后poller也会收到同一条 → 按 (chat_id, message_id)去重，不重复

## 序列化

LLM 看到的序列化 grammar 见 docs/cache.md；数据库保存完整机器可处理时间（unix seconds），序列化时才格式化 HH:mm:ss。
