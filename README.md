# Pi Telegram Agent

[中文](README.md) · [English](README.en.md)

让几个各有性格的 AI bot 长期住进你的 Telegram 群：它们会按概率接话、发动态 sticker、看图和视频，像真实的群友。你在本机的 [omp](https://omp.sh) 终端里观察和控制一切。

## 为什么用它

- **快**：daemon 常驻本机，消息进来直接路由，没有冷启动。
- **省**：provider prefix cache 让重复上下文不重复计费；路由、去重、状态全靠确定性代码，不花模型调用。
- **简单**：一套配置、一套结构。一个文件管所有设置，改完重启即生效。

## 快速开始

需要：[Bun](https://bun.sh/)、[omp](https://omp.sh)（≥17.4.0）、一个 Telegram supergroup、至少一个 [BotFather](https://t.me/BotFather) token（bot 已加入群并关闭 privacy mode，否则看不到普通群消息）。视频识别还需要主机安装 `ffmpeg`（同时提供 `ffprobe`）；不安装时其余功能和图片识别仍可用。

```bash
omp install https://github.com/mizorewww/pi-extension-telegram-agent.git
```

在打开的 omp 里依次做两件事：

1. 用 omp 的模型命令登录 provider 并选择默认模型（认证由 omp 保管，不进本仓库）。
2. `/tg config` 启动配置向导，按提示填群 ID、token、persona。向导验证通过后 daemon 自动就绪。

完成。去群里 @ 你的 bot 或者说句话试试；发 `/help` 查看群命令。

> 注意：omp 的输入框没有密码遮罩，粘贴 token 时请用私密终端，不要录屏。

## 日常使用

在 omp 里用 `/tg start`、`/tg attach`、`/tg status`、`/tg restart`、`/tg stop` 控制 daemon 与观察界面；也可以直接运行：

```bash
bun run start      # 后台启动 daemon
bun run status     # 查看状态
bun run restart    # 改配置后重启生效
bun run stop       # 停止
```

群里直接发 `/help`、`/status`；管理员（`telegram_admins`）还可以用 `/compact`、`/set` 调参——`/set` 会把新值直接写回配置文件。

## 配置

只有一个配置文件 `telegram.config.ts`，每个字段都带注释——复制 [telegram.config.example.ts](telegram.config.example.ts) 改几个值即可；secret（token、API key）放在 `.env` 里。加一只 bot 就是在 `bots` 数组里加一项，不用改代码。

详细配置见[配置指南](docs/user-guide/zh/src/configuration.md)。

## 需要帮助

- 常见问题与排障：[故障排查](docs/user-guide/zh/src/troubleshooting.md)
- daemon 运维（重启、日志、诊断）：[daemon runbook](docs/runbooks/daemon.md)（`bun run debug` 一键出诊断报告）
- 完整用户指南：[中文](docs/user-guide/zh/src/README.md) · [English](docs/user-guide/en/src/README.md)

## 参与开发

从 [AGENTS.md](AGENTS.md) 和[开发指南](docs/engineering/development-guide.md)开始；文档总索引在 [docs/index.md](docs/index.md)。项目采用 MIT 协议，见 [LICENSE](LICENSE)。
