# REQ-OPS-0001: 配置校验、进程管理与仓库卫生

- **Status:** Done（2026-08-08；配置校验、PID锁与受控进程运行已验收）
- **Priority:** P1
- **Source:** 2026-08-07 code review（.env.example 与 .gitignore 问题已核实）

## 问题

1. **配置模板即坏配置**：`.env.example` 全部用 `KEY=value`，而 `src/config.ts` 的 parser 只认 `key: value` 冒号格式——照模板复制的人启动时全部 required 报 missing。模板里 peer id 注释「negative number for groups」会把人引向 `-100...`，而 runtime 里 send 路径用 `Number(`-100${groupPeerId}`)` 计算 chat id，配成负数得 NaN，**所有 send 静默失败**。
2. **数值零校验**：`routing_p_a/p_b`、`compaction_threshold/keep_recent` 裸 `Number()`，配错得 NaN → routing 全不命中 / compaction 行为未定义，无任何报错。
3. **敏感数据无 ignore 保护**：`.gitignore` 没有 `data/`，`agent.db`（全部聊天记录）、`sessions/`（provider context）一次 `git add data/` 即进库。
4. **pid 文件机制薄弱**：daemon 在数秒初始化后才写 pid → 双重 start 竞态（两个 daemon 抢同一 token、第二个 `rmSync` 第一个的 socket）；`stop` 按裸 pid 发 SIGTERM，pid 被 OS 复用时杀错进程。
5. **GPG passphrase 上命令行**：`scripts/git-gpg.sh` 用 `--passphrase`，签名瞬间本机 `ps` 可见；`.env` 缺该行时 `set -e` 无提示退出。

## 目标

配置错误在启动期响亮报错；进程管理不误杀、不双开；敏感运行数据不可能被误提交。

## 非目标

- 不做配置热重载。
- 多 bot 配置体系是 REQ-CONF-0001 的范围，这里只修现有加载与校验。

## 需求

- **R1:** `.env.example` 改为冒号格式，peer id 注释改为「裸正数 peer id」并给出获取方法。
- **R2:** `loadConfig` 启动期校验：所有数值项 `Number.isFinite` + 范围检查（routing 概率 ∈ [0,1] 且 pA+pB ≤ 1；threshold/keep_recent > 0）；peer id 归一化（strip `-100` 前缀与负号）或显式拒绝并给出正确格式；错误信息指出具体 env key 与期望值。
- **R3:** `.gitignore` 增加 `data/`。
- **R4:** pid 文件在 daemon 最早时机以排他方式创建（`openSync(wx)` 或等价锁），再开始慢初始化；`stop`/`status` 校验 pid 对应进程的 cmdline 属于本项目 daemon 再操作，进程不存在时清理残留 pid 文件。
- **R5:** `git-gpg.sh` 改 `--passphrase-fd` / `--passphrase-file`；`.env` 缺 `gpg_key_passphrase` 时输出明确错误。
- **R6:**（附带 minor）`main.ts start` 在 daemon 就绪前不打印成功（等一行 ready 输出，或至少提示用 status/log 确认）。

## 验收标准

- **AC1:** 用修正后的 `.env.example` 复制填写，daemon 正常启动。
- **AC2:** 分别给定 `routing_p_a: abc`、`routing_p_a: 0.9 + p_b: 0.9`、`telegram_group_peer_id: -1004402809405`，启动即报错且错误信息点名 key；`-100...` 形式若选择归一化则行为与裸正数完全一致（含 send）。
- **AC3:** `git check-ignore data/agent.db data/sessions data/media` 成立。
- **AC4:** 连续两次 `start`：第二个立即报「已在运行」退出，socket 文件不被删除，`attach` 正常。
- **AC5:** pid 文件写入一个被复用的无关进程 pid，`stop` 拒绝操作并报错。
- **AC6:** `bun test` 全绿；`bun run check` 通过。

## 约束

- Cache impact: **NONE**。
- 兼容：既有正常使用的 `.env`（裸正数 peer id、合法数值）行为完全不变。

## 例子与边界 case

- `.env` 中 peer id 三种写法（`4402809405` / `-4402809405` / `-1004402809405`）的归一化结果一致。
- daemon 异常退出残留 pid 文件 → 下次 `start` 正常接管。

## 可观察性

- 配置校验失败时 stderr 逐条列出所有错误（而非第一个就退出）。

## 文档影响

- `docs/architecture.md`（配置小节）、`docs/runbooks/`（daemon 起停 runbook，借 R4/R6 落地第一篇）。

## 待决问题

- peer id 选「归一化」还是「显式拒绝非裸正数」？倾向归一化（对用户更宽容），开工前确认。

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
