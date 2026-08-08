# REQ-OPS-0003: 统一 foreground daemon PID 身份

- **Status:** Done（workspace；未授权 commit）
- **Priority:** P0
- **Source:** 最终restart验证期间，sandbox status误删foreground pid/socket并引发双poller 409

## 问题与要求

`start --foreground`在同一进程导入daemon，但OS命令行为`bun run src/main.ts start --foreground`；旧PID检查只承认`daemon/index.ts`，会把活进程当foreign/stale。身份解析必须严格承认direct daemon与完整foreground形态，同时拒绝缺少`start --foreground`及shell文本碰瓷。e2e compaction也必须在runtime fingerprint前恢复与daemon相同的Telegram control effective config。

## 验收

- deterministic command-shape测试覆盖direct、foreground、缺参数和shell decoy。
- 同权限域最终`status`识别唯一daemon PID；restart能枚举并回收所有同仓库孤儿。
- 结构化日志可区分ready、shutdown与`telegram_poller.poll_conflict`，不记录token。

## Debug impact

- success: `status`返回running且pid/socket一致；日志只有一个当前`daemon.ready`实例。
- failure: pid存在但identity不匹配时拒绝signal；同仓库孤儿由restart列出，不静默再spawn。
- 权限边界: sandbox对外部进程的`kill(pid,0)`可能EPERM，生产status必须在daemon同权限域执行。

## Cache impact

NONE。仅本地进程识别与e2e配置组合；provider bytes、session grammar、LLM调用和token不变。
