# 在 Pi 中聊天和观察

## 打开 feed

daemon 长期运行；Pi 可以随时打开或关闭：

```bash
bun run pi
```

首次 `/tg config` ready 后会自动 attach 全局 feed。以后可手工选择：

```text
/tg attach             # 群消息 + 所有 bot 的 LOCAL 事件
/tg attach friend      # 群消息 + friend 的 LOCAL/usage
/tg more               # 加载一页更早历史
/tg detach             # 断开 live socket，保留已显示 transcript
```

Telegram feed 是一个 TUI-only Pi custom entry。滚动、resize、选择、主题、图片布局和 footer 都由 Pi 原生组件负责；消息不会因为展示而进入当前 Pi agent 的 provider context。

在 `/tg ` 后使用 Tab 或原生选择菜单。bot 参数由当前已验证配置动态补全。

## 显式发送

`attach` 永远只读。要从 Pi editor 发 Telegram：

```text
/tg compose friend
# 在 editor 输入纯文本并提交
/tg compose off
```

footer 会持续显示当前发送身份。compose 只拦截 interactive editor；RPC 或 extension 输入仍交给 Pi。附件不会被偷偷降级成只发 caption。

明确失败会恢复 editor 原文。如果 ACK 丢失或连接在发送中断开，结果是 unknown：

1. compose 自动关闭；
2. 插件不自动重试；
3. 先检查 Telegram 群；
4. 只有确认消息不存在时才再次发送。

这条边界防止“远端已成功、本地确认失败”导致重复消息。

## 状态与 footer

```text
/tg panel              # 全局 Telegram telemetry
/tg panel friend       # 单 bot telemetry
/tg panel off          # 恢复当前 Pi session footer
/tg status friend      # lifetime + latest 明细
```

Pi 原生 footer 显示 `↑/↓/R/W/CH/$/context/model`。lifetime 来自 SQLite `llm_runs` 保留期，跨 Pi、daemon restart 和 context epoch；context 是最近 run 的当前占用，不是历史总和。

## 本地事件、stream 与媒体

- assistant thinking/text/tool partial 会在同一 Pi native card 原位更新，结束后由持久 LOCAL/Telegram event 接替；partial 不写 SQLite。
- bot 没有调用 `send` 时的 local assistant text 只在 feed 可见，不会发群。
- 照片与 sticker 的视觉描述只在真实 bot run 需要时按需生成；UI 本身不会额外触发 vision provider。
- inline image 是否可见取决于 Pi terminal capability与本地媒体准备；文字、media label和视觉描述仍是可读 fallback。

## Pi 内 daemon 命令

```text
/tg start
/tg restart
/tg stop
/tg status-daemon
```

`/tg restart` 会关闭 compose 和旧 IPC，受控替换整个 deployment。明确 ready 后恢复已有 feed；失败时保留 transcript 并给出诊断。

下一步：[日常运维](operations.md)。
