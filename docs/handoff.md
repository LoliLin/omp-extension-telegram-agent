# Handoff

> 始终保持很短。新 Agent 第一步读这里。

## 当前 phase

Phase 9 收尾 — REQ-LIST 全部勾选（真实 pi TTY 全链路验证完成）。剩余：真实群长运行观察。

## 已完成

- 全部 REQ 完成：REQ-LIST.md 全勾（UI-0001/2/3/4 基于真实 pi 验证；CONF/STICKER 附注的 AC1/AC2/AC3 真实群项由用户豁免或待长运行）
- 前端已是 pi 插件形态（REQ-UI-0004）：自绘 TUI 删除，`/tg attach|panel|status|start|stop|status-daemon` 全部真实验证通过

## 正在做

- 真实群长运行观察：daemon 运行健康（无新 error）；`bun run src/main.ts start` 启动

## 使用方式（用户）

```bash
bun run src/main.ts start        # 后台 daemon（或 pi 里 /tg start）
pi                              # 项目目录
  /tg attach [bot-id]           # 全屏群历史（q/esc 返回）
  /tg panel [bot-id]            # 常驻遥测 widget（/tg panel off 关闭）
  /tg status [bot-id]           # 一次性遥测
  /tg stop                      # 停止 daemon
bun run src/main.ts stop        # 或 CLI 停止
```

## 关键平台事实（pi 扩展开发，踩坑记录）

- pi 二进制 bundled 的 pi-tui：只有 Text/Container/Image/Markdown/Spacer 可用；ScrollView/VStack/HStack 不存在 → attach 视图自管理行缓冲 + tui.terminal.rows
- jiti 扩展环境无 Bun 全局 → 用 node:net / node:child_process
- jiti 里 process.stdout.rows/cols = 0 → 尺寸从 ctx.ui.custom 的 tui.terminal 拿；widget 行固定截 60
- custom/widget 行超宽直接崩 pi → 所有输出行 truncateToWidth
- setWidget 用数组形式（工厂形式不渲染）
- 图像内联降级：kitty placement 无法跟随自管理视口 → 占位符 + vision 描述

## 最后测试状态

bun test 145/145 ✅ + bun run check ✅；真实 pi TTY：attach/panel/status/start/stop 全验证。见 docs/testing.md。

## 已知问题

- 后台 vision 预识别未完成前目录 sticker 显示 [未识别]，重启后补全（设计如此）
- attach 视图图像为占位符（bundled ScrollView 缺失，见上）
- bun test 强制 UTC：涉时间序列化的测试必须 pin TZ（cache.test.ts 已处理）
