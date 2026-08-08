# 项目说明

## 是什么

一个真正“住在 Telegram 群里”的可配置 AI 群友系统：daemon 可按配置运行 1..N 个 Telegram bot，每个 bot 有独立 persona/session/routing；当前示例部署是小雪与小雨两只 bot。它们看得到群聊和彼此发言，自主决定是否插话，能发文字和 sticker、理解图片，必要时搜索/计算。

## 三个世界（严格分离）

1. **Telegram 群** —— 用户真正聊天的地方（传输层）
2. **本地持久化历史（SQLite）** —— 从运行起看到的一切的事实来源
3. **Pi / LLM** —— 只在需要思考时看到精简上下文

## 核心目标（按优先级）

1. 正确、稳定、可长期运行
2. 保持 LLM prompt prefix 稳定（provider cache reuse）
3. 减少 cache miss tokens
4. 减少无意义 LLM 调用和 provider-visible context
5. 架构和代码简单
6. 充分复用 Pi 已有能力
7. TUI 清楚实用

**核心原则：Never rewrite an existing cached prefix when appending new information can solve the same problem.**

## 用户体验

- 启动 daemon → 配置的 bots 长期在线 → 消息落库 → Agent 按规则运行
- 用户随时在项目目录运行 `bun run pi`，用 `/tg attach [bot-id]` 在 Pi 原生 transcript 查看完整群聊、LOCAL 事件与 usage；关闭 Pi 不影响 daemon
- `/tg more` 加载更早历史，`/tg detach` 断开实时订阅，`/tg panel [bot|off]` 选择或恢复 Pi 原生 stats footer
- `/tg ` 使用 Pi 自带分级菜单补全子命令与当前配置中的 bot，不需要记忆 id
- daemon 运维：`start` / `status` / `stop`；详见 `docs/runbooks/daemon.md`

## 主要约束

- 模型是实现细节：当前 DeepSeek deepseek-v4-flash（thinking medium），架构不得依赖具体模型/context window/价格
- 当前 compaction threshold = 128K tokens（provisional default，靠 telemetry 验证，不做在线 optimizer）
- Telegram 不承担历史恢复职责，SQLite 是事实来源
- Bot-to-Bot：彼此消息进共同 transcript 可被看到，但**不互相触发**（trigger 只来自满足 routing 条件的 human 消息）
- Bot 可以保持沉默：assistant local text 存 agent events + TUI 可见，不进群

## 术语

- **Context Epoch**：一段 append-only 的 provider history；compaction = epoch boundary（Epoch N → summary → Epoch N+1）
- **CACHE_SCHEMA_VERSION**：system prompt shape / persona serialization / tool schema / tool order / 消息序列化 grammar / summary grammar 任一变化时 bump + 新 epoch
- **Exposure tracking**：每个 bot 记录哪些 Telegram message 已进入过它的 provider context，不重复序列化
- **canonical message**：Telegram 群消息的本地统一表示，identity = (chat_id, message_id)
- **LOCAL**：TUI 中标记只有本地可见的 bot 内部行为（区别于 Telegram 真实发言）

## 当前示例部署

- 小雪（Bot A，token env `teleram_hastuyuki_bot`）：温柔软糯猫娘，暖群夸夸担当，人设全文在 `personas/xiaoxue.md`
- 小雨（Bot B，token env `telegram_kosamerobot`）：清冷毒舌猫娘，技术担当，人设全文在 `personas/xiaoyu.md`
- 原始人设文本来自 docs/requirement.md 末尾，抽取后适配本项目 send tool schema

## Scope

见 docs/requirement.md（4055 行完整需求）。开发流程见 docs/engineering/development-guide.md（LLM 开发指南）：小 vertical slice、每步留痕（docs + devlog + handoff）、原子化签名 git 提交。
