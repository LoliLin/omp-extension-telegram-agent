# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [中文用户指南](docs/user-guide/zh/src/README.md) · [English user guide](docs/user-guide/en/src/README.md)

让 1..N 个各有 persona 的 AI bot 作为长期群友住进一个 Telegram supergroup，按概率路由接话；Pi 终端界面负责观察和控制。

设计哲学只有四条，每条都直接对应你的收益：

- **快**：daemon 常驻本机，消息进来直接路由到对应 bot，没有排队和冷启动。
- **上下文优化**：provider prefix cache 让重复的上下文不重复计费；群消息只追加增量部分。
- **简洁**：一套配置、一套结构，没有需要学习的中间概念。
- **省成本**：上面三条的结果——不调用多余模型，不重传已缓存的 token。

## 快速部署

1. 准备 Telegram supergroup ID 和至少一个 BotFather token。每只 bot 都要加入目标群，并在 BotFather 里关闭 privacy mode，否则看不到普通群消息。
2. 装好 [Bun](https://bun.sh/) 后 clone 本仓库，运行 `bun run pi`；在 Pi 里用 `/login` 登录模型 provider、`/model` 选默认模型。项目直接复用 Pi 的认证。
3. 在 Pi 输入 `/tg config`，按向导填群 ID、persona 模板和 token。向导验证后自动写入本机文件，daemon ready 后打开 all-bots feed。

> Pi 当前的输入框没有密码遮罩：Telegram token 输入时会显示，请用私密终端，不要录屏或共享屏幕。

完整步骤见[中文安装与首配](docs/user-guide/zh/src/getting-started.md)。

## 日常命令

```bash
bun run start      # 后台启动 daemon
bun run pi         # 打开 Pi 与 Telegram extension
bun run status     # 查看进程状态
bun run restart    # 优雅重启
bun run stop       # 优雅停止
```

Telegram 群里直接发 `/help`、`/status` 查看 bot 状态；`/compact`、`/set` 仅对 `telegram_admins` 里的管理员开放。

Pi 里的 `/tg` 命令（attach / compose / panel / more 等）见[在 Pi 中聊天和观察](docs/user-guide/zh/src/using-pi.md)。

## 配置

配置只有一套：`telegram.config.ts` 放全部非 secret 设置，`.env` 放 Telegram token、`tiny_fish_api_key` 等 secret，provider 和 model 的认证由 Pi 管理，不进本仓库。最小配置：

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
	group_peer_id: 1234567890, // supergroup ID
	bots: [
		{
			id: "friend",
			name: "Mochi", // 群里的显示名，也是触发关键词
			token_env: "telegram_bot_token", // .env 里的 key 名
			persona_path: "personas/template.zh.md",
			routing_p: 0.1, // 未被点名时接话的概率
			sticker_sets: [],
			tools: { send: true, search: false, run_js: true },
		},
	],
});
```

未写的字段全部有默认值（见 `telegram.config.example.ts` 的注释）。添加第二只 bot 就是在 `bots` 数组里再加一项，不需要改代码。多 bot、provider override、routing 规则见[中文配置指南](docs/user-guide/zh/src/configuration.md)。

一份工作目录只承载一个群；多群请用隔离的工作目录（原因与做法见[日常运维](docs/user-guide/zh/src/operations.md)）。

## 出错时

- `unknown bot id`：检查 `telegram.config.ts` 里的 `id`，或用 `/tg ` 的动态补全。
- `restart already in progress`：等当前重启完成，不要并发起第二个 daemon。
- Telegram `409`：同一个 token 有重复 poller，按[daemon runbook](docs/runbooks/daemon.md)做一次受控重启。
- 其他症状见[中文排障](docs/user-guide/zh/src/troubleshooting.md)。

## 成本控制

routing、去重、状态全部由确定性代码完成，不花模型调用；provider prefix cache 命中时，重复的系统提示和历史不按新 token 计费；媒体视觉理解默认关闭，开启后有预算上限；上下文超阈值才触发 compaction。实际效果用本机 telemetry（`bun run debug`）测量，机制细节见[成本设计概览](docs/user-guide/zh/src/design-cost.md)。

## 开发

修改项目从 [AGENTS.md](AGENTS.md) 和[开发指南](docs/engineering/development-guide.md)开始；文档总索引见[docs/index.md](docs/index.md)。
