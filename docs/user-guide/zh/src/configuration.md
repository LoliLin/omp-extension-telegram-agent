# 配置与添加 bot

`/tg config` 是推荐入口。需要添加 bot 或调整高级项时，编辑 ignored `telegram.config.ts`，然后执行 `bun run restart` 或 Pi 中的 `/tg restart`。

## 文件边界

| 文件 | 保存什么 | 是否提交 |
| --- | --- | --- |
| `telegram.config.ts` | 群、bot、provider/model、env key、routing、tools | 否 |
| `.env` | Telegram/provider/TinyFish token 与 router secret | 否 |
| `personas/*.local.md` | 真实 deployment persona | 否 |
| `telegram.config.example.ts` | public typed schema example | 是 |
| `personas/template.*.md` | public generic persona templates | 是 |

`.env` 使用项目自己的冒号格式，不是 dotenv 的等号格式：

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
llm_api_key: REPLACE_WITH_PROVIDER_KEY
router_secret: REPLACE_WITH_RANDOM_LOCAL_SECRET
```

## 最小单 bot 配置

```ts
import { defineConfig } from "./src/config-schema.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  api_key_env: "llm_api_key",
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

每个 bot 的 Telegram poller、agent session、state、provider runtime 与 telemetry 都隔离；共享的是目标群与 canonical SQLite history。

## Provider 与 tools override

deployment 顶层的 `provider`、`model`、`api_key_env` 是默认值。单 bot 可覆盖；如果切换到不同 provider，必须同时显式填写这三个字段，避免 credential 串用。同 provider 只换 credential 时可只覆盖 `api_key_env`。

`tools`：

- `send`：允许 agent 发 Telegram Rich Message / sticker；
- `search`：需要 `.env` 中由 `tinyfish_key_env` 指定的 TinyFish key；
- `run_js`：启用受限的确定性计算工具。

首次向导把 search 关闭。先补 credential，再显式开启；不要把 API key 直接写进 TypeScript。

## Routing 与管理命令

- mention > reply > 配置名称 > probability；bot 消息不会触发 bot-to-bot run。
- `sampling_cooldown_ms` 只约束 probability 路径；默认 2000，0 表示关闭冷却。
- `telegram_admins` 默认空，拒绝 Telegram 群内 `compact/set/reset`。需要时优先加入你自己的正整数 numeric user ID；不要复制示例占位值。
- Telegram `set/reset` 写入 SQLite override，不改 TypeScript；`reset` 恢复文件基线。

## Legacy 与多群

`bots.config.json` 继续可加载，但新配置优先 TypeScript。默认 TS 与 legacy JSON 同时存在会 fail-fast；`bots_config` 只接受显式 `.ts` / `.json`。

一份 deployment 只有一个 `group_peer_id`。多个群必须使用隔离工作目录及 data/session/DB/pid/socket，不能在同一 checkout 只切 `bots_config` 并行运行。

下一步：[在 Pi 中聊天和观察](using-pi.md)。
