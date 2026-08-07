# Runbook：daemon 起停与 bot 配置

## 配置

- `bots.config.json`（项目根，或设 env `bots_config` 指向其他路径）：bot 清单与参数。复制 `bots.config.example.json` 后编辑。
  - `group_peer_id`：群的裸正数 peer id（`-100...` 形式会被自动归一化）
  - 每 bot：`id`（`[A-Za-z0-9_-]+`，唯一）、`name`、`token_env`（指向 `.env` 里的 token key）、`persona_path`（绝对路径 / `~` / 相对项目根，可放仓库外）、`routing_p`（Σ≤1）、可选 `model` / `reasoning_effort` / `compaction_threshold` / `compaction_keep_recent` / `tools`（`{send, search, run_js}` 开关）/ `sticker_sets`（Telegram sticker set 名数组）
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
- 配置错误会在启动期逐条列出（stderr / daemon.log），不会静默跑坏配置。
- 双 start 竞态由排他 pid 锁挡住：第二个立即报「daemon already running」。

## 观察

```bash
bun run src/main.ts attach          # 全局视角（群消息 + 全部 bot 内部行为）
bun run src/main.ts attach A        # 单 bot 视角（群消息 + 仅 A 的 LOCAL 事件）
```

- 底部面板：每 bot 的 epoch / 最近 run context / 累计 token / 成本 / hit ratio（与 llm_runs 一致）
- `q` / Ctrl+C 退出，daemon 不受影响

## 新增一个 bot

1. `.env` 加一行 token：`my_bot_token: 123:...`
2. `bots.config.json` 的 `bots` 数组加一项（id 唯一、`token_env` 指向新 key、persona 文件存在）
3. 重启 daemon → 启动日志会列出新 bot；`attach <id>` 可单独观察
4. 需要固定 sticker 目录就加 `sticker_sets`；不需要就不写（无目录 bot 的 system prompt 与 v1 逐字节一致）

## 故障排查

- `status` 说 not running 但进程在：pid 文件是残留 → `stop`/`start` 会自动清理/接管
- 面板无数据：尚无 llm_runs（bot 从未被触发）
- attach 报「unknown bot id」：id 拼错，错误信息会列出全部配置的 id
