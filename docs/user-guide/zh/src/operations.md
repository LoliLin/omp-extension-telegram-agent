# 日常运维

## 规范命令

```bash
bun run start
bun run status
bun run restart
bun run stop
```

- `start`：后台启动并等待pid/socket readiness；配置错误会在任何 bot polling 前失败。
- `restart`：串行停止同 deployment 的pid owner与孤儿进程，等PID、pid file与socket释放后只启动一次替代进程。
- `status`：验证PID确实属于当前仓库daemon，不只相信pid file。
- `stop`：SIGTERM优雅停止所有bot、agent与IPC资源。

日志位于 `data/daemon.log`。controller只回显有界、credential-redacted末尾；不要把完整 `.env` 或未经检查的日志贴进 issue。

## 配置变更

配置不热重载。编辑 `telegram.config.ts`、`.env` 或 persona 后运行：

```bash
bun run restart
```

已有配置也可在 Pi 运行 `/tg config` 进行验证或受保护编辑。replace 会留下本机 `.bak-<nonce>`；确认新 deployment ready 后再按你的备份策略处理，不要在同一任务顺手删除。

## 数据与备份

默认持久资源在 `data/` 与项目本机 session 目录。SQLite 是 canonical history；Telegram 不是历史恢复来源。

备份前：

1. `bun run stop`；
2. 确认 `bun run status` 不再报告 running；
3. 复制整个 deployment 的配置、persona、data 与 session 资源到访问受控的位置；
4. 保护 `.env` 和 private persona，不上传公共 artifact。

不要只复制DB后在同一目录并行启动两份daemon。

## Telegram 群内控制

公开只读命令：`/help`、`/status`。

`/status` 使用 Telegram 富消息按 bot 展示 runtime 状态、provider/model/reasoning、当前 context/window/%、最近主对话请求、SQLite 保留期累计、缓存命中率、延迟/费用、路由与最近一次 compact；统计数字使用千位分隔。它与 Pi footer、`/tg status` 共用[统一 telemetry 口径](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/telemetry.md)：`CH = R / (↑ + R + W)`，没有 cache read/write 样本时显示 `—`，当前 context 绝不使用历史 prompt 求和。若 Telegram 在创建消息前明确拒绝富消息方法或格式，daemon 会改发一次独立生成的纯文本版本；超时、限流和服务端错误等结果不确定时不会重发，以免重复回复。

`telegram_admins` allowlist 才能运行：

```text
/compact
/set <routing_p|cooldown_ms> <value>
```

命令默认作用于接收消息的 bot，带 `@bot_username` 后缀时定向到对应 bot。这些命令由确定性 control plane 消费，不进入 persona/provider context。`compact` 会调用现有辅助摘要模型，可能产生费用；busy bot 不会被 abort。`set` 写穿 `telegram.config.ts`，新值重启后仍然生效。

## 真实验证

默认 `bun test` 不调用 Telegram/provider；test preload 会机械拒绝一切非 loopback 网络访问。需要真实网络时，脚本强制选择bot：

```bash
bun run scripts/smoke-pi.ts --bot friend
bun run scripts/e2e-agent.ts --bot friend
bun run scripts/e2e-compaction-manual.ts --bot friend
```

这些操作可能产生费用或群消息。运行前先读[daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md)，记录bot、预期副作用与回滚步骤。

## 为什么必须隔离工作目录

当前一个工作目录只支持一个群 deployment。这不是临时的UI限制：以下资源都由工作目录拥有，并没有deployment namespace：

- 单一`group_peer_id`和SQLite canonical history，包括每只bot的consumed cursor、visible refs与reply obligation；
- agent session与context epoch；
- 每只poller的Telegram update offset，以及共享router secret；
- daemon PID、control lock与Unix socket。

所以，在同一checkout中只换配置文件并行运行不会形成两个deployment。它可能把一个群的history送入另一个群的模型context、用错误offset跳过update，或让两个daemon争抢同一PID/socket。

第二个群应使用独立clone或worktree，并分别保存`.env`、config、persona和Telegram bot tokens；同时隔离整个`data`/DB、session、PID/lock/socket与daemon工作目录。不要只复制DB，也不要让两个目录指回同一data路径。

这种边界符合项目的极简原则：用文件系统隔离这个已有、可检查的安全边界，而不是为尚未要求的多租户场景增加namespace、热加载和第二套控制面。完整原则见[成本设计概览](design-cost.md)；技术权威见[项目说明](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/project.md)。

下一步：[故障排查](troubleshooting.md)。
