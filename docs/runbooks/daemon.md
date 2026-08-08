# Runbook：daemon 起停与 bot 配置

## 配置

- `bots.config.json`（项目根，或设 env `bots_config` 指向其他路径）：bot 清单与参数。复制 `bots.config.example.json` 后编辑。
  - `group_peer_id`：群的裸正数 peer id（`-100...` 形式会被自动归一化）
  - deployment 默认模型：`provider` + `model` + `api_key_env`；缺省为 `deepseek` + `deepseek-v4-flash` + `deepseek_api_key`。`api_key_env`只是指向`.env`的key名，不放secret值。
  - 每 bot：`id`（`[A-Za-z0-9_-]+`，唯一）、`name`、`token_env`（指向 `.env` 里的 token key）、`persona_path`（绝对路径 / `~` / 相对项目根，可放仓库外）、`routing_p`（Σ≤1），可选覆盖 `provider` / `model` / `api_key_env` / `reasoning_effort` / compaction / cooldown / `tools`（`{send, search, run_js}` 开关）/ `sticker_sets`（Telegram sticker set 名数组）。切换provider时必须同时给model和api_key_env；同provider可只换key。
  - `sampling_cooldown_ms` 默认 2000，可全局设置并由单 bot 覆盖；必须有限且 `>=0`，0 关闭概率冷却。它只影响 probability routing，mention/reply/name 不会被静默吞掉。
  - `telegram_admins`：Telegram群内控制白名单，接受正整数user id或规范化`@username`；推荐固定numeric id。缺省/空数组会拒绝所有`compact/set/reset`，但不影响公开`help/bots/status`。
- `.env`（`key: value` 冒号格式）：只放 secret——bot tokens、配置引用的provider API keys、`tiny_fish_api_key`、`router_secret`、`gpg_key_passphrase`（仅签名用）
- 改配置后重启 daemon 生效（无热重载）
- 一份配置/daemon只对应一个`group_peer_id`。同一checkout的`data/`、pid、socket与DB是共享deployment资源，不能只换`bots_config`并行跑第二个群；多群当前必须使用彼此隔离的工作目录与data目录，不能共享DB/session/socket/pid。

## 启动

```bash
bun run src/main.ts start          # 后台运行，日志 data/daemon.log
bun run src/main.ts start --foreground   # 前台（调试用）
bun run src/main.ts restart        # deployment-wide 优雅重启全部配置 bot
bun run src/main.ts status         # 状态（pid 校验：cmdline 必须是本项目 daemon）
bun run src/main.ts stop           # SIGTERM 优雅停止
```

- 首启可能较慢：sticker set 下载 + vision 预识别（114 个 sticker 约 10–15 分钟，一次性；之后秒起）。`start` 会在 60s 内等 socket；没等到会提示用 `status` / `daemon.log` 确认，不会误报失败。
- 每 bot 启动日志的 `sticker-catalog` 行会报告 `catalog/sendable/missing_file_id`；`missing_file_id>0` 的条目不会暴露给该 bot。检查 set 名/token 权限或 Telegram `getStickerSet` 失败，不要复制另一个 bot 的 file_id。
- 配置错误会在启动期逐条列出（stderr / daemon.log），不会静默跑坏配置。
- 双 start 竞态由排他pid锁挡住；并发restart由`data/daemon.control.lock`串行，第二个立即报`restart already in progress`。
- restart会验证同仓库进程身份，并回收同一deployment里缺失于pid file的孤儿daemon；foreign PID与仅在参数中提到daemon路径的shell命令不会收到signal。旧PID、pid file与socket全部消失后才spawn，新socket必须可真实连接才报告ready。
- 首次初始化超过60秒但child仍存活时只报告starting；child早退会显示`data/daemon.log`中有界且脱敏的末尾，不会输出token/env值。

## 观察

```bash
bun run pi                          # 从项目依赖启动 Pi，自动加载 Telegram extension
```

进入 Pi 后：

```text
/tg attach              # 全局视角：群消息 + 全部 bot LOCAL 事件
/tg attach A            # 单 bot 视角：群消息 + 仅 A 的 LOCAL/usage
/tg compose A           # 显式让原生 editor 以 A 身份发送纯文本
/tg compose off         # 关闭发送模式，editor 恢复提交给 Pi agent
/tg more                # 显式加载一页更早历史
/tg detach              # 断开实时订阅，已显示内容保留
/tg panel A             # 将 Pi 原生 footer 切到 A 的 Telegram usage
/tg panel off           # 恢复当前 Pi session 的默认 footer
/tg status A            # lifetime + latest usage/latency 详细通知
/tg restart             # 优雅重启deployment并恢复当前feed filter/footer
/tg status-daemon       # daemon 进程状态
```

- Telegram feed 是 Pi transcript 中一个 TUI-only custom entry；滚动、resize、选择、editor 与图片布局由 Pi fullscreen host 负责。
- attach 永远是只读操作；只有显式 `/tg compose <bot-id>` 后，interactive editor 提交才会发 Telegram。当前 Pi footer 会持续显示 `TELEGRAM · SEND AS <id/name>`；`compose off` 后输入恢复交给 Pi agent。
- compose 仅支持纯文本。附件会被阻止；明确失败会把原文放回 editor。若 ACK 超时或 daemon 在发送中断线，结果可能未知：先检查群聊，不要直接重发；插件不会自动重试，并会安全关闭 compose。
- RPC/extension source 不受 compose 影响。attach 切换、detach、daemon 断线或 Pi 退出都会关闭 compose；bot token 始终只在 daemon 内。
- photo/sticker 被现有 lazy vision 流程识别后，同一 native media card 会在下方原位出现 `视觉理解 · ...`；无需重新 attach。它不为 UI 主动调用模型，未触发 bot 的媒体仍保持图片/fallback。
- attach 自动让 Pi 自己的 `FooterComponent` 显示 Telegram `↑/↓/R/W/CH/$/context/model`。token/cost 是当前 SQLite `llm_runs` 首条记录以来的 lifetime 累计，跨 daemon/Pi restart 与 epoch；context 是最新 run 当前占用而非历史求和。`W` 仅在 provider 报告非零 cache write 时由 Pi 显示。
- `/tg panel` 可单独切换范围，`panel off` 恢复 operator Pi session usage。`/tg status [bot]` 另列 runs/since/epoch、latest cache/output/reasoning/latency/cost 与 lifetime totals/平均 latency。
- 在 editor 输入 `/tg ` 后按 Tab/选择使用 Pi 原生分级菜单；`attach/status/compose/panel` 的下一层会从配置动态列出 bot id/name，`compose/panel` 另有 `off`。
- 关闭 Pi 或 `/tg detach` 不影响 daemon。
- `/tg restart`先关闭compose并中止旧IPC；在途manual send按unknown outcome处理且绝不自动重发。ready后保留原transcript，自动以原A/all filter重连并恢复此前的原生footer scope；失败时保留已显示内容与可执行诊断。

## Telegram 群内控制

下列命令直接发到配置群，由daemon确定性处理；它们不会进入persona或主LLM上下文。Telegram客户端菜单不可见时仍可手工输入：

```text
/tg help
/tg bots
/tg status [bot]
/tg compact <bot|all>                       # telegram_admins only
/tg set <bot> routing_p <0..1>              # telegram_admins only
/tg set <bot> cooldown_ms <0..3600000>      # telegram_admins only
/tg reset <bot> <routing_p|cooldown_ms>      # telegram_admins only
```

- `/tg@<bot_username> ...`由该suffix bot回复；未知deployment suffix不接管。
- `set/reset`立即更新effective值并持久化SQLite override；重启后保留，reset恢复文件配置。routing总和超过1时整次拒绝。
- `compact`只接受bot id或`all`，不接受自定义instructions。busy/stopping bot不会被abort；`all`按配置顺序汇总结果。它会调用既有辅助摘要模型并产生相应费用。
- 回复始终引用原命令。命令edit只消费、不执行；replay/second-bot副本不会重复mutation或回复。发送结果未知时daemon不自动重试。

## 新增一个 bot

1. `.env` 加一行 token：`my_bot_token: 123:...`
2. `bots.config.json` 的 `bots` 数组加一项（id 唯一、`token_env` 指向新 key、persona 文件存在）
3. 重启 daemon → 启动日志会列出新 bot；Pi 中 `/tg attach <id>` 可单独观察
4. 需要固定 sticker 目录就加 `sticker_sets`；不需要就不写（无目录 bot 的 system prompt 与 v1 逐字节一致）

## Opt-in 第三个 bot 真实 smoke

这组操作会调用真实provider与Telegram，可能产生费用/群消息；默认测试不会执行。准备一个只用于验收的bot id（下例为`C`）后逐项记录结果：

1. 在`.env`加入C的Telegram token；在配置追加C、独立persona与`routing_p: 0`。若provider不同，同时显式给`provider`、`model`、`api_key_env`。
2. `bun run restart`，确认日志出现C的`getMe` identity及`provider/model`，且A/B/C都只有一个poller，没有409。
3. `bun run scripts/smoke-pi.ts --bot C`，确认当前配置的Pi provider/model完成一次headless调用。
4. `bun run scripts/e2e-agent.ts --bot C`，确认真实群出现C的run/send结果；需要compaction验收时再运行`bun run scripts/e2e-compaction-manual.ts --bot C`。
5. 在Pi执行`/tg attach C`、`/tg status C`、`/tg compose C`，确认C过滤、独立lifetime stats与手动发送；再切回全局feed确认A/B/C同时可见。
6. 在Telegram分别mention与reply C，确认只有C得到explicit response opportunity。验收后删除临时C配置并`bun run restart`；历史DB/session可保留但不会被未配置bot纳入IPC stats。

所有需要单bot身份的smoke/e2e脚本都强制`--bot <id>`；没有默认bot，未知id会在任何网络调用前失败并列出有效id。

## 故障排查

- `status` 报duplicate/orphan project daemon：运行`restart`；它只处理同仓库真实daemon entry并等待全部退出，避免Telegram long poll 409。
- malformed pid file与socket同时存在：controller会拒绝猜测；先检查`data/daemon.pid`、`data/daemon.sock`与`ps`，不要手工signal未经身份确认的PID。
- 面板无数据：尚无 llm_runs（bot 从未被触发）
- `/tg attach` 报「unknown bot id」：id 拼错，错误信息会列出全部配置的 id
- `/tg compose` 报 no connected feed：先 `/tg attach [bot]`，确认 transcript 已收到 snapshot；compose 不会自行启动 daemon
- Telegram群内mutation报权限不足：检查发送者的canonical numeric user id/`@username`是否在`telegram_admins`；display name、群匿名身份和bot身份都不会授权。
- 发送提示 unknown outcome：原文会恢复且 compose 自动关闭；先在 Telegram 群确认是否已出现，再决定是否重发
