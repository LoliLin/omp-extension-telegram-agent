# Runbook：daemon 起停与 bot 配置

## 配置

- `bots.config.json`（项目根，或设 env `bots_config` 指向其他路径）：bot 清单与参数。复制 `bots.config.example.json` 后编辑。
  - `group_peer_id`：群的裸正数 peer id（`-100...` 形式会被自动归一化）
  - 每 bot：`id`（`[A-Za-z0-9_-]+`，唯一）、`name`、`token_env`（指向 `.env` 里的 token key）、`persona_path`（绝对路径 / `~` / 相对项目根，可放仓库外）、`routing_p`（Σ≤1）、可选 `model` / `reasoning_effort` / `compaction_threshold` / `compaction_keep_recent` / `sampling_cooldown_ms` / `tools`（`{send, search, run_js}` 开关）/ `sticker_sets`（Telegram sticker set 名数组）
  - `sampling_cooldown_ms` 默认 2000，可全局设置并由单 bot 覆盖；必须有限且 `>=0`，0 关闭概率冷却。它只影响 probability routing，mention/reply/name 不会被静默吞掉。
- `.env`（`key: value` 冒号格式）：只放 secret——bot tokens、`deepseek_api_key`、`tiny_fish_api_key`、`router_secret`、`gpg_key_passphrase`（仅签名用）
- 改配置后重启 daemon 生效（无热重载）

## 启动

```bash
bun run src/main.ts start          # 后台运行，日志 data/daemon.log
bun run src/main.ts start --foreground   # 前台（调试用）
bun run src/main.ts status         # 状态（pid 校验：cmdline 必须是本项目 daemon）
bun run src/main.ts stop           # SIGTERM 优雅停止
```

- 首启可能较慢：sticker set 下载 + vision 预识别（114 个 sticker 约 10–15 分钟，一次性；之后秒起）。`start` 会在 60s 内等 socket；没等到会提示用 `status` / `daemon.log` 确认，不会误报失败。
- 每 bot 启动日志的 `sticker-catalog` 行会报告 `catalog/sendable/missing_file_id`；`missing_file_id>0` 的条目不会暴露给该 bot。检查 set 名/token 权限或 Telegram `getStickerSet` 失败，不要复制另一个 bot 的 file_id。
- 配置错误会在启动期逐条列出（stderr / daemon.log），不会静默跑坏配置。
- 双 start 竞态由排他 pid 锁挡住：第二个立即报「daemon already running」。

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
/tg status A            # 一次性 usage 通知
/tg status-daemon       # daemon 进程状态
```

- Telegram feed 是 Pi transcript 中一个 TUI-only custom entry；滚动、resize、选择、editor 与图片布局由 Pi fullscreen host 负责。
- attach 永远是只读操作；只有显式 `/tg compose <bot-id>` 后，interactive editor 提交才会发 Telegram。当前 Pi footer 会持续显示 `TELEGRAM · SEND AS <id/name>`；`compose off` 后输入恢复交给 Pi agent。
- compose 仅支持纯文本。附件会被阻止；明确失败会把原文放回 editor。若 ACK 超时或 daemon 在发送中断线，结果可能未知：先检查群聊，不要直接重发；插件不会自动重试，并会安全关闭 compose。
- RPC/extension source 不受 compose 影响。attach 切换、detach、daemon 断线或 Pi 退出都会关闭 compose；bot token 始终只在 daemon 内。
- photo/sticker 被现有 lazy vision 流程识别后，同一 native media card 会在下方原位出现 `视觉理解 · ...`；无需重新 attach。它不为 UI 主动调用模型，未触发 bot 的媒体仍保持图片/fallback。
- attach 自动让 Pi 自己的 `FooterComponent` 显示对应 Telegram `↑/↓/R/CH/$/context/model`；`/tg panel` 可单独切换范围，`panel off` 恢复 operator Pi session usage。完整 epoch/累计明细仍用 `/tg status [bot]`。
- 当前 `/tg` 子命令没有参数补全；原生分级 completion 方案见 `REQ-UI-0008`，尚未实现。
- 关闭 Pi 或 `/tg detach` 不影响 daemon。

## 新增一个 bot

1. `.env` 加一行 token：`my_bot_token: 123:...`
2. `bots.config.json` 的 `bots` 数组加一项（id 唯一、`token_env` 指向新 key、persona 文件存在）
3. 重启 daemon → 启动日志会列出新 bot；Pi 中 `/tg attach <id>` 可单独观察
4. 需要固定 sticker 目录就加 `sticker_sets`；不需要就不写（无目录 bot 的 system prompt 与 v1 逐字节一致）

## 故障排查

- `status` 说 not running 但进程在：pid 文件是残留 → `stop`/`start` 会自动清理/接管
- 面板无数据：尚无 llm_runs（bot 从未被触发）
- `/tg attach` 报「unknown bot id」：id 拼错，错误信息会列出全部配置的 id
- `/tg compose` 报 no connected feed：先 `/tg attach [bot]`，确认 transcript 已收到 snapshot；compose 不会自行启动 daemon
- 发送提示 unknown outcome：原文会恢复且 compose 自动关闭；先在 Telegram 群确认是否已出现，再决定是否重发
