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

公开只读命令：`/tg help`、`/tg bots`、`/tg status [bot]`。

`telegram_admins` allowlist 才能运行：

```text
/tg compact <bot|all>
/tg set <bot> routing_p <0..1>
/tg set <bot> cooldown_ms <0..3600000>
/tg reset <bot> <routing_p|cooldown_ms>
```

这些命令由确定性control plane消费，不进入persona/provider context。`compact`会调用现有辅助摘要模型，可能产生费用；busy bot不会被abort。

## 真实验证

默认 `bun test` 不调用 Telegram/provider（明确env-gated测试除外）。需要真实网络时，脚本强制选择bot：

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

所以，在同一checkout中并行设置不同`bots_config`不会形成两个deployment。它可能把一个群的history送入另一个群的模型context、用错误offset跳过update，或让两个daemon争抢同一PID/socket。

第二个群应使用独立clone或worktree，并分别保存`.env`、config、persona和Telegram bot tokens；同时隔离整个`data`/DB、session、PID/lock/socket与daemon工作目录。不要只复制DB，也不要让两个目录指回同一data路径。

这种边界符合项目的极简原则：用文件系统隔离这个已有、可检查的安全边界，而不是为尚未要求的多租户场景增加namespace、热加载和第二套控制面。完整原则见[成本设计概览](design-cost.md)；技术权威见[项目说明](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/project.md)。

下一步：[故障排查](troubleshooting.md)。
