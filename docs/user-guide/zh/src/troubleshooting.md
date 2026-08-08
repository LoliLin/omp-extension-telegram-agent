# 故障排查

先从症状选择安全的下一步；不要删除data、pid或socket来“试一下”。完整进程恢复规则见[daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md)。

## `bun run pi` 无法启动

运行：

```bash
bun install --frozen-lockfile
bun run pi --version
```

预期版本是项目锁定的 Pi 0.84.1。若安装失败，保留错误输出并修复registry/network；不要改成未锁定的全局 Pi 来掩盖问题。

## `/tg config` 不在菜单中

确认你从仓库根运行 `bun run pi`，并且 package discovery 加载了 `.pi/extensions/tg-extension.ts`。`config` 是静态命令，不依赖已有 config；若完全缺失，优先排查Pi/package加载，而不是手工创建空JSON。

## 向导拒绝配置

- 字段错误：按notification列出的字段修复；值不会回显。
- `bots_config` missing/invalid：创建指定 `.ts`/`.json` source，或从 `.env` / process移除override后重试。
- 同时存在默认TS与legacy JSON：保留一份，或用明确override选择；不要按mtime猜。
- 已有文件：选择validate/editor，或明确确认backup-replace；取消不会改字节。

## 配置有效但 daemon 未 ready

```text
/tg status-daemon
/tg restart
```

再检查 `data/daemon.log`。常见原因是Telegram token/provider key错误、网络不可达、model不在Pi catalog或bot未加入目标群。有效配置会保留；不需要重新粘贴secret。

## `daemon starting` 很久

配置了sticker sets时首次catalog/vision准备可能较慢。运行`bun run status`并观察脱敏日志。如果child仍alive，controller不会把60秒等待上限误报成ready；只有socket真实可连接才算ready。

## Telegram 401 或没有群消息

- 401：轮换或修正对应bot token，确认`token_env`指向正确key，再restart。
- 普通群消息不可见：在BotFather关闭该bot group privacy，确认bot已加入正确supergroup。
- bot不能发言：检查Telegram群权限；不需要为了普通读取授予多余管理员权限。

## Telegram 409 / duplicate poller

同一个token正在被另一进程长轮询。运行`bun run restart`；controller会验证并回收当前deployment的真实daemon与孤儿。不要盲目`kill` pid file中的数字，也不要并发start。

## Pi feed 或 compose 断开

- `no connected Telegram feed`：先`/tg attach [bot]`，等snapshot连接完成。
- `unknown bot id`：使用`/tg `补全，或检查配置id。
- compose unknown outcome：先查群，不自动重试；确认缺失后再发。
- `/tg detach`或关闭Pi不会停止daemon；重新`/tg attach`即可。

## 图片没有内联显示

Pi根据当前terminal capability选择Kitty/iTerm2/native fallback。先确认media label/视觉描述是否存在，再检查本地媒体文件、terminal图像能力和当前项目Pi版本。不要在插件里手写terminal escape或绕过Pi组件。若可稳定复现，记录terminal、tmux状态、媒体种类与是否有本地path，不要附带token或私人图片本体。

## 仍无法恢复

收集以下非敏感信息：

- `bun run status` 输出；
- `bun run pi --version`；
- `data/daemon.log`中手工复核过的脱敏末尾；
- 失败命令、bot id、是否是fresh/legacy/custom `bots_config`；
- 是否使用tmux、Kitty/Ghostty/iTerm2。

不要提交 `.env`、真实persona、完整群消息、token、API key或未脱敏绝对路径。
