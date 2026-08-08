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

## 直接发送

`attach` 后 Pi editor 默认直接发 Telegram：单 bot filter 直接使用该 bot；全局 feed 若有多个 bot，每次提交都会打开 Pi 原生选择框；只有一个 bot 时不弹框。

```text
/tg attach friend       # 直接以 friend 发送
/tg attach              # 多 bot 时每条消息选择身份
/tg compose friend      # 可选：固定为 friend，连续发送不再选择
/tg compose off         # 暂时把 editor 交还 Pi
/tg compose             # 恢复当前 feed scope
```

footer 会显示 `SEND AS ...` 或 `CHOOSE BOT ON SEND`。取消选择会恢复逐字节相同的原文且不发送。compose 只拦截 interactive editor；RPC 或 extension 输入仍交给 Pi。附件不会被偷偷降级成只发 caption。

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
- vision默认关闭。显式开启后，照片与sticker的视觉描述只在真实bot run需要时按deployment budget生成；UI本身不会额外触发vision provider。
- inline image 是否可见取决于 Pi terminal capability与本地媒体准备；文字、media label和视觉描述仍是可读 fallback。

## 网页搜索与链接读取

为当前bot启用`tools.search`并配置TinyFish key后，agent可按需调用同一个工具：用query取得最多5条短结果，或读取一条public HTTP(S)链接。群里的链接不会被自动抓取；只有回答需要页面正文时才显式调用。

网页正文先受8,000字符本地护栏约束，再受2,048 provider tokens上限约束，并带有固定“不可信网页内容”边界。页面里的命令不会成为agent指令；登录态、userinfo、localhost、private/link-local地址会在请求前拒绝。事件和日志只保留hostname、字符数和固定结果类别，不保留URL path/query/fragment或正文。

## Pi 内 daemon 命令

```text
/tg start
/tg restart
/tg stop
/tg status-daemon
```

`/tg restart` 会关闭 compose 和旧 IPC，受控替换整个 deployment。明确 ready 后恢复已有 feed；失败时保留 transcript 并给出诊断。

下一步：[日常运维](operations.md)。
