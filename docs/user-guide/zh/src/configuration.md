# 配置与添加 bot

`/tg config` 是推荐入口。需要添加 bot 或调整高级项时，编辑 ignored `telegram.config.ts`，然后执行 `bun run restart` 或 Pi 中的 `/tg restart`。

## 文件边界

| 文件 | 保存什么 | 是否提交 |
| --- | --- | --- |
| `telegram.config.ts` | 群、bot、可选 Pi 模型选择、routing、tools | 否 |
| `.env` | Telegram/TinyFish token 与 router secret | 否 |
| `personas/*.local.md` | 真实 deployment persona | 否 |
| `telegram.config.example.ts` | public typed schema example | 是 |
| `personas/template.*.md` | public generic persona templates | 是 |

`.env` 使用项目自己的冒号格式，不是 dotenv 的等号格式：

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
router_secret: REPLACE_WITH_RANDOM_LOCAL_SECRET
```

## 最小单 bot 配置

```ts
import { defineConfig } from "./src/config-schema.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
    sticker_sets: [],
    tools: { send: true, search: false, run_js: true },
  }],
});
```

完整注释和高级默认见仓库根的 `telegram.config.example.ts`。TypeScript config 是受信本机代码；只编辑你自己维护的文件，不执行来源不明的片段。

## 添加第二或第三只 bot

1. 在 `.env` 增加独立 token key。
2. 从 public template 复制新的 ignored persona。
3. 在 `bots` 数组追加对象；`id` 必须唯一且只含字母、数字、`_`、`-`。
4. 执行受控 restart，并在 Pi 用 `/tg attach <id>` 与 `/tg status <id>` 验证。

```ts
{
  id: "helper",
  name: "Nori",
  token_env: "helper_bot_token",
  persona_path: "personas/helper.local.md",
  routing_p: 0,
  tools: { send: true, search: false, run_js: true },
}
```

`routing_p: 0` 只关闭普通消息的概率抽样；mention、直接 reply 和配置名称仍是明确触发。所有 bot 的 `routing_p` 总和必须 `<= 1`，配置顺序决定确定性概率桶顺序。

每个 bot 的 Telegram poller、agent session、模型选择、state 与 telemetry 都隔离；共享的是一个 Pi model runtime/auth snapshot、目标群与 canonical SQLite history。

## Pi 模型与 tools override

省略顶层模型字段时，所有 bot 继承 Pi 合并后的默认 provider、model 与 thinking level。高级 deployment 可在顶层或单 bot 用 `provider` + `model` 选择另一个 catalog entry；切换 provider 时两者必须同时填写。`reasoning_effort` 也可作为选择覆盖。认证始终来自 Pi，不来自本配置或 `.env`。改变 Pi login/default model 后执行受控 restart。

`tools`：

- `send`：允许 agent 发 Telegram Rich Message / sticker；
- `search`：启用同一个TinyFish工具的有界网页检索与单页读取，需要 `.env` 中由 `tinyfish_key_env` 指定的TinyFish key；
- `run_js`：启用受限的确定性计算工具。

首次向导把 search 关闭。启用前把 TinyFish credential 加入 `.env`（默认key名为`tiny_fish_api_key`）；它与 Pi 模型认证无关。启用后agent可显式搜索，或在回答确实需要页面内容时读取一个public HTTP(S) URL；不会自动抓取群里的每条链接，也不支持登录态、cookie或private/local地址。

## Routing 与管理命令

- mention > reply > 配置名称 > probability；bot 消息不会触发 bot-to-bot run。
- `routing_p` 是普通 human 消息的**回应机会**，不是最终群发言配额。每条 eligible 消息只生成一个确定性值并至多落入一个累计桶；当总和为 1 时，每条 eligible 消息恰有一个 probability target。
- `sampling_cooldown_ms` 只约束 probability 路径；默认 2000，0 表示关闭冷却。
- probability target busy 或 cooldown 时会直接 skip，不改投另一只 bot；mention/reply/name 走明确触发路径。即使成功开始，persona 仍可选择沉默，发送也可能失败，所以群内公开消息比例无需等于 `routing_p`。
- `telegram_admins` 默认空，拒绝 Telegram 群内 `compact/set/reset`。需要时优先加入你自己的正整数 numeric user ID；不要复制示例占位值。
- Telegram `set/reset` 写入 SQLite override，不改 TypeScript；`reset` 恢复文件基线。

只读检查当前 deployment：

```bash
bun run scripts/analyze-routing.ts            # 使用默认 data/daemon.log
bun run scripts/analyze-routing.ts --no-log   # 只重放 SQLite
```

报告只显示 `bot-1`、`bot-2` 等序号，分别列 current-effective assignment、daemon started/busy/cooldown、LLM run 与最终 public message。日志只覆盖当前进程且可能轮转，因此始终标为 `partial`；缺失则是 `unavailable`，不是 0。当前配置重放历史消息是反事实审计，不能证明旧时配置。命令不写数据库、不调用模型，正文只在本地 SQLite 内折叠成触发类别，不进入脚本内存或输出。也可把单个自定义日志路径作为唯一参数传入。

## Legacy 与多群

`bots.config.json` 继续可加载，但新配置优先 TypeScript。默认 TS 与 legacy JSON 同时存在会 fail-fast；`bots_config` 只接受显式 `.ts` / `.json`。

一份 deployment 只有一个 `group_peer_id`。多个群必须使用隔离工作目录及 data/session/DB/pid/socket，不能在同一 checkout 只切 `bots_config` 并行运行。

下一步：[在 Pi 中聊天和观察](using-pi.md)。
