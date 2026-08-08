# REQ-OPS-0002: 从 Pi 一键受控重启 Telegram daemon

- **Status:** Done（2026-08-08；implementation `3d7f9b3`）
- **Priority:** P1
- **Source:** 用户追加 `REQ-LIST`：「做bot一键重启功能」
- **依赖:** REQ-OPS-0001、REQ-UI-0008、REQ-UI-0004

## 问题

Pi 插件已有 `/tg start`、`/tg stop`、`/tg status-daemon`，但没有原子 restart。用户必须先 stop、猜测优雅停机何时完成、再 start；过早 start会撞 pid/socket，忘记 start则所有 bot持续离线。当前架构中所有配置 bot、poller、AgentSession、SQLite 与 IPC共享一个 daemon进程，所以在进程内“只热重启一个 bot”会制造共享资源和状态边界，而不能可靠满足恢复服务的目标。

## 目标

一个 `/tg restart` 操作把当前 deployment 的全部配置 bot受控恢复到 ready：验证旧 PID归属，优雅停机并等待退出/资源释放，复用规范 start readiness，再恢复调用前的 Pi feed观察范围。daemon本来未运行时，同一命令直接启动。

## 非目标

- 不在共享 daemon内热重建单个 BotRuntime/poller/session。
- 不 force-kill 外部/无法验证身份的 PID，不删除数据库/session/cache。
- 不从 Telegram群命令远程重启主机进程；群内 control plane仍以 REQ-CMD-0001 的安全命令表为准。
- 不在 restart期间保留 compose中的未确认发送，也不自动重发任何 editor文本。
- 不做配置热重载；restart只是让磁盘配置在新进程启动时生效。

## 需求

- **R1 — 单一运维入口：** `bun run src/main.ts restart` 是规范 CLI；Pi command tree新增原生可补全的 `/tg restart`，且只委托该 CLI，不复制 PID/启动逻辑。
- **R2 — 身份与锁：** 若 pid存在且存活，必须先用 REQ-OPS-0001 的项目 daemon identity检查；foreign PID必须拒绝signal。并发 restart必须由有界 control lock串行，第二个调用明确返回“restart already in progress”，不能产生两个新daemon。
- **R3 — 优雅停止：** 对确认属于本项目的旧 daemon只发一次 SIGTERM，等待 pid死亡、pid file释放与IPC socket消失；等待上限覆盖 daemon既有35秒hard timeout并额外留小幅余量。超时则失败，绝不继续spawn第二个daemon。
- **R4 — 规范启动：** 旧进程完全退出后复用与 `start` 相同的 detached spawn、日志和60秒ready socket检查。成功输出新PID；初始化仍在继续时只报告 starting，不谎报 ready；child早退回显脱敏log tail。
- **R5 — stopped语义：** daemon原本未运行时restart等价于start；dead stale pid可安全清理；alive foreign pid按R2拒绝。旧socket不得被当成新daemon ready证据。
- **R6 — Pi生命周期：** `/tg restart` 开始前关闭compose，任何在途manual-send按unknown outcome规则处理且不重试。成功后若调用前有active feed/filter，插件自动重新建立同一filter的timeline连接与footer telemetry；失败时保留已展示transcript并给出可执行诊断。
- **R7 — 有界反馈：** Pi先显示 restarting状态，结束后显示 ready/starting/failed与PID或日志位置；不得显示token、env值、persona全文。命令可在无TUI模式运行CLI，但feed恢复只在interactive Pi中发生。
- **R8 — 状态安全：** restart不得修改SQLite持久格式、exposure、context epoch或cache schema；daemon正常shutdown负责flush/close，新的process从现有持久状态恢复。

## 验收标准

- **AC1:** fake process controller覆盖 running→SIGTERM→exit→spawn→ready；事件顺序严格，spawn只发生一次且在旧pid/socket释放之后。
- **AC2:** daemon stopped/stale pid时restart成功启动；foreign live pid、shutdown timeout、child early exit时不spawn或不误报成功，错误可操作且脱敏。
- **AC3:** 两个并发restart中恰好一个持有control lock，另一个立即失败；最终至多一个daemon pid且socket可连接。
- **AC4:** Pi command help/completion/parser都包含单个leaf `restart`；handler只调用 `src/main.ts restart`，成功/失败notification级别正确。
- **AC5:** attached A/all feed在fake restart后自动以原filter重连并收到snapshot/stats；compose被关闭，旧in-flight send不自动重发；无active feed时不额外创建transcript entry。
- **AC6:** real smoke在daemon运行与停止两种起点各执行一次 `/tg restart`；最终`status-daemon` running、每bot poller无409、旧PID退出、新PID ready、SQLite/session数据保留。
- **AC7:** `bun test`、`bun run check`、cache golden与`git diff --check`通过。

## 约束

- Cache impact: **NONE**。纯进程控制/Pi UI；不改provider request、system/tool/message/summary grammar，不新增LLM call/token。
- 兼容性: `start/status/stop`命令保持；`restart`是additive CLI/Pi command。SQLite/IPC帧格式不变。
- 安全 / 隐私: 复用PID身份校验，绝不signal foreign process；日志反馈有界且不含secret。
- 运维: restart是deployment-wide。若未来要per-bot hot restart，必须先为shared ModelRuntime/IPC/poller/session定义独立lifecycle ADR，不能偷换本需求语义。

## 例子与边界 case

- daemon pid 100运行，`/tg restart`：关闭compose→SIGTERM 100→等待退出→spawn 101→socket ready→原A feed重连。
- daemon已停：直接spawn，不把“没有旧进程”当错误。
- pid file指向无关编辑器：拒绝signal并提示检查stale pid；不启动第二个daemon覆盖现场。
- 旧daemon在35秒hard timeout后才退出：restart继续等待到运维上限；只有确认退出后才spawn。
- 新daemon正在首次sticker初始化，60秒仍无socket但child存活：返回starting与status/log指引，不声称ready。

## 可观察性

CLI/Pi输出阶段：`stopping old pid`、`waiting`、`starting new pid`、`ready|starting|failed`。daemon log维持既有启动/关停记录；不新增消息正文或secret日志。

## 文档影响

`docs/project.md`、`docs/architecture.md` Process model、`docs/runbooks/daemon.md`、`docs/testing.md`、Pi `/tg` help。

## 待决问题

无。当前架构下“一键重启bot服务”明确等价于deployment-wide daemon restart。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10p`
- Commits: implementation `3d7f9b3`；其余从 `Requirement:` git trailer 查

## 实现证据

- `DaemonController`统一start/restart readiness；restart lock按控制进程PID排他且可回收，旧进程只在同仓库cwd/绝对entry匹配后才会收到一次SIGTERM。
- 除pid file owner外会枚举同仓库孤儿daemon。真实deployment发现遗留PID `9316`与当前PID并存，restart同时优雅停止两者、等待所有PID/pid file/socket消失，再启动唯一替代进程；命令文本型decoy有回归保证不被误判。
- readiness不再只看socket pathname：旧socket先清理，新进程必须拥有有效pid identity且Unix socket可真实connect，才报告`ready`；60秒后仍存活则只报告`starting`。early exit只回显15行/4096字符的credential-redacted log tail。
- Pi `/tg restart`异步委托CLI，先关闭compose并dispose旧IPC（pending send沿用unknown outcome/no retry），原位保留transcript；ready后同一A/all filter与原生footer重连，跨client snapshot按canonical identity去重。
- 真实smoke覆盖running→restart、stopped→restart及Pi attached A：`75075→5090`后暴露孤儿，修复后`5090+9316→6329`且跨30秒无新409；stopped→`6795`、Pi `6795→6903`，SQLite数据保留，重连后snapshot/status/live message/连续stream均可见。
- Cache impact: **NONE**；cache v5 golden不变，DB/IPC/provider grammar与token/call数不变。
