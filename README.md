# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [中文用户指南](docs/user-guide/zh/src/README.md) · [English user guide](docs/user-guide/en/src/README.md)

让 1..N 个可配置 AI bot 作为长期群友住进一个 Telegram supergroup，并在 Pi 原生 transcript 中观察、配置和操作它们。

一份 deployment 对应一个群。每个 bot 都有独立 token、persona、provider/model、session、routing、tools 与 telemetry；添加 bot 不需要修改生产代码。daemon 在本机长期运行，关闭 Pi 不会让 bot 下线。

## 三步启动

1. 准备 Telegram supergroup ID 与至少一个 BotFather token。每只 bot 都要加入目标群并关闭 BotFather privacy mode，才能看到普通群消息。
2. 安装 [Bun](https://bun.sh/)，clone 本仓库后运行 `bun run pi`。先用 Pi 原生 `/login` 登录模型 provider，再用 `/model` 选择默认模型；项目直接复用这份 Pi 设置与认证。
3. 在 Pi 输入 `/tg config`，确认显示的 Pi 模型、选择公开 persona 模板并填写 Telegram 配置。向导验证并原子写入本机文件；daemon 明确 ready 后会自动打开 all-bots feed。

> Pi 当前的原生 `input` dialog 没有密码遮罩。向导中的 Telegram token 输入时会显示，请使用私密终端，不要录屏或共享屏幕。模型认证只由 Pi 管理，`/tg config` 不会再次询问或保存 provider key。

完整准备步骤见[中文安装与首配](docs/user-guide/zh/src/getting-started.md)。

## 它提供什么

- Telegram raw Bot API 长轮询、SQLite canonical history 与 1..N 个隔离 agent session。
- mention / reply / 配置名称触发，以及有冷却和可用性 gate 的确定性概率 routing。
- Telegram Rich Message、sticker、按需媒体视觉理解、可选 search 与受限 JavaScript 计算。
- Pi 原生 transcript、图片组件、footer telemetry、分级命令补全和 editor compose；插件不自绘 viewport 或终端协议。
- append-only provider context、stable prefix cache、bounded suffix 与 compaction，避免无意义调用和重复 token。

当前边界：一份工作目录只能安全运行一个群 deployment；多群必须隔离工作目录、data、DB、session、pid 与 socket。本项目不是 SaaS、多租户平台，也没有配置热重载。配置文件不同不会给共享history、offset或进程资源增加namespace；原因与第二个群的安全做法见[日常运维：多群](docs/user-guide/zh/src/operations.md#为什么必须隔离工作目录)。

## 日常使用

```bash
bun run start      # 后台启动 daemon
bun run status     # 查看受控进程状态
bun run pi         # 打开项目 Pi 与 Telegram extension
bun run restart    # 优雅重启整个 deployment
bun run stop       # 优雅停止
```

Pi 中输入 `/tg ` 后可用原生命令补全：

| 命令 | 结果 |
| --- | --- |
| `/tg config` | 首配、验证、编辑或明确备份替换本机配置 |
| `/tg attach [bot]` | 只读观察全局或单 bot feed |
| `/tg compose <bot>` | 让 interactive editor 显式以该 bot 身份发纯文本 |
| `/tg compose off` | 把 editor 交还给 Pi agent |
| `/tg more` / `/tg detach` | 加载更早历史 / 断开 live feed |
| `/tg panel [bot\|off]` | 切换或恢复 Pi 原生 footer telemetry |
| `/tg status [bot]` | 查看 lifetime 与 latest usage 明细 |
| `/tg start` / `restart` / `stop` / `status-daemon` | 在 Pi 内管理 daemon |

`attach` 永远只读。只有显式 `compose` 才会发送 Telegram；若发送结果未知，插件会恢复原文并关闭 compose，但不会自动重试。先检查群里是否已经出现消息，避免重复发送。

## 配置文件

`/tg config` 是推荐入口。手工配置时：

```bash
cp telegram.config.example.ts telegram.config.ts
cp .env.example .env
cp personas/template.zh.md personas/friend.local.md
```

- `telegram.config.ts`：受信本机 TypeScript，保存非 secret schema 与 env key 名；可写注释并获得类型提示。
- `.env`：本项目自己的 `key: value` 冒号格式，只保存 Telegram token、可选 TinyFish key 与 router secret；模型 credential 不在这里。
- `personas/*.local.md`：本机 persona；默认被 Git 忽略。
- `bots.config.json`：只读兼容旧 deployment；新配置优先使用 TypeScript。

单 bot 最小配置、添加第二/第三 bot、provider override 与 routing 规则见[中文配置指南](docs/user-guide/zh/src/configuration.md)。tracked example 不含有效 credential 或私人 persona。

## 出错时

- `/tg config` 在写入前报告 Pi model 未就绪：退出向导，用 Pi `/login`、`/model` 修复后重试；不会留下配置文件。
- `/tg config` 写入后 daemon 未 ready：配置会保留。运行 `/tg status-daemon`，检查 `data/daemon.log`，修正 Telegram/network 后运行 `/tg restart`。
- `unknown bot id`：使用 `/tg ` 的动态补全或检查 `telegram.config.ts` 中的 `id`。
- `restart already in progress`：等待当前受控 restart 完成，不要并发启动第二个 daemon。
- Telegram `409`：通常表示同一 token 有重复 poller；按[daemon runbook](docs/runbooks/daemon.md)执行受控 restart。
- compose 报 unknown outcome：先查 Telegram 群，确认未发送后再重试。

更多恢复步骤见[中文排障](docs/user-guide/zh/src/troubleshooting.md)与[daemon runbook](docs/runbooks/daemon.md)。

## 为什么更省调用与 token

项目优先用确定性代码做 routing、去重、状态与 UI，把稳定 provider prefix 保持不变；动态群消息只追加有界 suffix，媒体视觉按需执行，context 超阈值才 compaction。设计没有承诺固定节省百分比，效果以本机 lifetime telemetry 为准。

阅读[成本设计概览](docs/user-guide/zh/src/design-cost.md)了解六个机制和权威实现文档。

## 开发与维护

用户不需要先读内部架构文档。要修改项目时，从 [AGENTS.md](AGENTS.md) 与[机器维护指南](docs/maintainers/guide.md)开始；当前状态见[handoff](docs/handoff.md)，完整索引见[docs/index.md](docs/index.md)。

当前 HEAD 只跟踪公开 persona 模板；旧 Git 历史仍可能包含已经移除的 deployment persona。仓库没有改写历史，也不能替代必要的 credential 轮换。
