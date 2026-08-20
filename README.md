# omp Telegram Agent

[中文](README.md) · [English](README.en.md)

让几个各有性格的 AI bot 长期住进你的 Telegram 群：按概率接话、回复点名、发动态 sticker、看图和视频，像真实的群友。你在本机的 [omp](https://omp.sh) 终端里观察和控制一切。

## 特性

- **多 bot persona**：一个群 1..N 只 bot，各自独立人格、模型、回复概率与冷却；确定性 HMAC 路由，不靠模型决定谁接话。
- **Telegram 原生**：群消息、编辑、引用、媒体（photo/sticker/video）全部入本地 SQLite；`send`、`search`、`run_js` 三个固定工具，不引入文件系统工具。
- **省成本**：provider prefix cache 让稳定上下文不重复计费；routing/去重/状态/统计都是确定性代码，零模型调用；compaction 用专用 aux 模型按"状态"压缩历史。
- **omp 原生观察**：`/tg attach` 在 omp transcript 里看完整群聊、LOCAL 事件与实时 agent 活动卡；attached footer 显示 Telegram usage/model，不占用 provider 上下文。
- **可运维**：daemon 常驻、`/tg restart` 原位恢复 feed、`bun run debug` 一键脱敏诊断、结构化 JSONL 日志。

## 快速开始

需要：

- [Bun](https://bun.sh/) 与 [omp](https://omp.sh)（≥ 17.4.0）
- 一个 Telegram supergroup，以及至少一个 [BotFather](https://t.me/BotFather) token（bot 须加入群并关闭 privacy mode，否则看不到普通群消息）
- 可选：视频识别需要主机安装 `ffmpeg`（含 `ffprobe`）；缺失时其余功能与图片识别照常工作

安装插件（本地开发可用 `omp plugin link <本仓库路径>`）：

配置、`.env`、persona 与 `data/` 默认放在工作目录 `~/.omp/agent/telegram/`（可用环境变量 `TELEGRAM_AGENT_DIR` 覆盖）；persona 模板随插件分发，不随配置修改。

```bash
omp install <repository-url>
```

在 omp 里依次完成两件事：

1. 用 omp 的模型命令登录 provider 并选择默认模型——认证由 omp 保管，不进本仓库。
2. 执行 `/tg config` 启动配置向导：先本地预检 `provider/model:thinking`（不发模型请求），再填群 ID、bot token、persona；验证通过后 daemon 自动就绪并打开 all-bots feed。

去群里 @ 你的 bot 试试；`/help` 查看群命令。

> 注意：omp 的输入框没有密码遮罩，粘贴 token 时请用私密终端，不要录屏。

## 日常使用

### omp 内（/tg 命令）

| 命令 | 作用 |
|---|---|
| `/tg attach [bot]` | 打开全局或单 bot 的实时 feed |
| `/tg more` / `/tg detach` | 加载更早历史 / 断开 live socket |
| `/tg compose [bot\|off]` | 编辑器以某个 bot 身份直接发消息 |
| `/tg status [bot]` | 查看 Telegram usage 与模型状态 |
| `/tg start` `/tg restart` `/tg stop` | daemon 生命周期；restart 原位恢复 feed |
| `/tg status-daemon` | 查看 daemon 进程状态 |
| `/tg config` | 配置向导（验证/编辑/备份替换） |

### CLI

```bash
bun run start      # 后台启动 daemon
bun run status     # 查看状态
bun run restart    # 改配置后重启生效
bun run stop       # 停止
bun run debug      # 一键脱敏诊断报告
```

群里 `/help`、`/status` 对所有成员可用；管理员（`telegram_admins`）额外可用 `/compact`、`/set`——`/set` 把新值直接写回配置文件，重启后仍生效。

## 配置

配置只有一套：

- **`telegram.config.ts`**：全部非 secret 设置（群、bots、provider/model、routing、compaction、vision、retention），每个字段带注释。复制 [telegram.config.example.ts](telegram.config.example.ts) 修改即可；加一只 bot 就是在 `bots` 数组加一项。
- **`.env`**：项目持有的 secret（bot token、TinyFish、router_secret），`key: value` 冒号格式，Git ignored。
- **omp auth store**：provider 认证（`/login` 之后由 omp 保管），项目不复制 credential。

详细字段见[配置指南](docs/user-guide/zh/src/configuration.md)。

## 工作原理（一分钟版）

daemon（单进程、常驻）持有 SQLite 与 IPC server：Telegram 长轮询 → canonical 消息落库 → 确定性路由 → 每 bot 一个 omp `AgentSession` 按需思考。omp 里的扩展通过 IPC 拉历史、订阅实时事件，展示层完全在 omp 侧，关闭 omp 不影响 daemon。架构细节见 [docs/architecture.md](docs/architecture.md)。

## 安全与隐私

- secret 不进日志、数据库、session 或 provider 上下文；`.env` 不入库。
- `run_js` 在沙箱中执行（无文件/网络/进程/env 访问），威胁模型见架构文档。
- 群消息渲染前剥离 ANSI/OSC 控制序列，防终端注入。

## 需要帮助

- 常见问题：[故障排查](docs/user-guide/zh/src/troubleshooting.md)
- daemon 运维（重启、日志、诊断）：[daemon runbook](docs/runbooks/daemon.md)
- 完整用户指南：[中文](docs/user-guide/zh/src/README.md) · [English](docs/user-guide/en/src/README.md)

## 参与开发

从 [AGENTS.md](AGENTS.md) 与[开发指南](docs/engineering/development-guide.md)开始；文档总索引在 [docs/index.md](docs/index.md)。验证漏斗：`bun test` → `bun run check` → `bun run lint` → `bun run docs:check`。

项目采用 BSD 2-Clause 协议，见 [LICENSE](LICENSE)。
