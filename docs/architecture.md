# 架构

> 描述当前代码真正做了什么。架构变化时同步更新。

## Process model

```
                Telegram
               /        \
      Poller A(小雪)   Poller B(小雨)
               \        /
                \      /
            daemon (单进程, 长驻)
                 │
   ┌─────────────┼──────────────┐
   │             │              │
 ingestion    Agent A/B      SQLite
 (normalize/  (AgentSession  (bun:sqlite
  dedupe/      ×2, SDK)       或 node:sqlite)
  persist)        │              │
   └───── router ─┘              │
                 │               │
              IPC (Unix socket JSONL)
                 │
               TUI (独立进程, 可随时 attach/detach)
```

- **daemon**：唯一长驻进程。持有 Telegram poller、两个 AgentSession、SQLite、IPC server
- **TUI**：独立短生命周期进程，通过 IPC 拉历史 + 订阅实时事件；退出不影响 daemon

## 运行时与依赖

- 运行时：**Bun**（Phase 1 会做 Pi SDK × Bun 兼容性 smoke test；不兼容则降级 Node 26 + node:sqlite 并更新本文档）
- Pi：本地源码 `../pi`（commit f562a1a, v0.84.1, dist 已构建），通过 `file:../pi/packages/*` 依赖 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core`、`pi-tui`；传递依赖经 symlink realpath 从 `../pi/node_modules` 解析
- Telegram：raw Bot API（fetch long polling），无第三方 SDK

## Telegram ingestion

- 每个 bot token 一个 getUpdates long-polling 循环（offset 持久化在 SQLite）
- 每条 update：原样存 raw_updates（bot identity + update_id 唯一）→ normalize 成 canonical message（chat_id + message_id 唯一，双 bot 收到的同一条群消息只存一条）→ edit 存 revision
- Bot 自己 send 成功后，Telegram 返回的 Message 立即落库（发送→DB→TUI 事务链）

## Routing（Phase 5）

- deterministic：`u = HMAC(router_secret, chatId + ":" + messageId)` → u < pA → A；pA ≤ u < pA+pB → B；否则 nobody
- 优先级：明确 @mention > reply target > 名字关键词 > 概率 routing
- Bot 消息不进 trigger（只进 transcript）
- busy 时进 pending queue，settle 后合并 burst

## Agent（Phase 3）

- 每 bot 一个 `createAgentSession()`：独立 SessionManager（sessionDir 分开）、独立 DefaultResourceLoader（`systemPromptOverride` = persona）、共享一个 ModelRuntime
- 触发/flush 是 BotRuntime 本地持有的串行状态机（REQ-AGENT-0001）：`idle →(trigger) flushing →(drain) idle`；`flushing` 在进入 flush 时同步置位（不等 SDK 事件），在途期间的 trigger 只合并为 `pendingTrigger`，flush 循环结束后统一再跑一轮（burst 合并）；flush 全链路 try/catch，失败只落 agent_events `error`（stage=flush），消息保持未曝光由后续 trigger 重试；消息只在 `sendUserMessage` 成功后 markExposed；daemon shutdown 时 `stop()` 有界（30s）等待在途 flush 再 dispose
- 唤醒：`session.sendUserMessage(serialized)`，一次 flush 一批（burst 由 pendingTrigger 合并，不走 SDK 队列）
- 群消息序列化为固定紧凑 grammar（见 docs/cache.md），append-only
- tools：`send`（terminate:true）、`search`、`run_js`（Phase 6 起）；禁用 coding agent 默认文件工具
- local assistant text（未调 send）→ agent_events + TUI，不进群

## run_js sandbox 威胁模型（REQ-SEC-0001）

- **威胁**：run_js 输入来自 LLM，LLM 上下文来自群消息 → 群成员可经 prompt injection 让 bot 执行攻击者构造的 JS。最坏情况是读到 daemon 同 uid 可读的 `.env`（全部 bot token / API key）并联网外发。
- **防到什么**：vm context 由 `Object.create(null)` 创建且 `codeGeneration: { strings: false, wasm: false }`，context 内**不存在任何 host realm 对象/函数**——`console.log.constructor` / `this.constructor.constructor` / `Function` / `eval` 全部拿不到 host `Function`，逃逸链在第一步就断。console/日志在 context 内部 bootstrap；结果只在 context 内 `JSON.stringify` 后以字符串跨界（primitive 跨界安全）。child 进程 env 被 scrub（仅 PATH，无 secret）、隔离 tmp cwd、`--smol` 限内存、同步代码 vm timeout 3s、进程级 5s SIGKILL 兜底、输出 4KB 上限。
- **残余风险（明确承认）**：
  1. node:vm 官方声明不是安全边界；若引擎层 0day/未知向量打穿 realm 隔离，child 仍以 daemon uid 运行，可读 `.env`、可联网。缓解：child env 不含 secret（secret 只存在于 daemon 进程内存与磁盘 `.env`），但这不防「直接读磁盘文件」。
  2. `--smol` 是内存使用倾向而非硬 rlimit；内存硬上限依赖 5s SIGKILL 兜底。
  3. SIGKILL 只杀直接 child；若 vm 被打穿后 spawn 孙进程，孙进程脱离超时范围。
  4. vm timeout 只约束同步代码；异步 microtask 膨胀由 SIGKILL 兜底（实测 Bun 下约 vm timeout 即被打断）。
- **为什么可接受**：纵深防御（realm 隔离 + codegen 禁用 + env scrub + 资源限制 + 超时）使攻击需要未知引擎漏洞而非已知技术；单人项目、威胁源限于群成员 prompt injection。OS 级隔离（低权用户 / seatbelt / seccomp）列为后续增强，非当前威胁模型的必要项。

## SQLite

- 见 docs/data-model.md。WAL 模式，直接 SQL

## TUI（Phase 4）

- `@earendil-works/pi-tui`：`TuiAltScreen` + `ScrollView(follow:"end")` + transcript Container
- 每条群消息一个组件；bot 内部行为以 `Bot X · LOCAL` 标记
- IPC：Unix socket JSONL，daemon 为 server；协议 = hello / history 分页拉取 / event 订阅

## Vision（Phase 7）

- lazy：图片落库即显示，只有 bot 被唤醒且图片需进上下文时才识别
- 识别结果持久化、双 bot 共享（vision cache）
- photo 与 sticker 用不同 prompt 语义

## Provider context flow

- 稳定 prefix：system prompt（persona + 群聊规则 + 消息 grammar 说明 + 格式化规则）+ 固定顺序 tool schema
- 动态 suffix：新群消息 / reply 依赖 / vision 结果 / sticker candidates / tool outputs，只追加
- exposure tracking 保证已出现内容不重复序列化
- compaction → 新 Context Epoch（明确的 cache boundary）

## 配置

- `.env`（`key: value` 冒号格式，本项目 loader 自己解析）+ `.env.example`
- env 变量：bot tokens ×2、group peer id、deepseek key/model/reasoning effort、tinyfish key、auxiliary_visual_model、router_secret、gpg_key_passphrase（仅开发用）
- 模型相关数值（contextWindow/价格/threshold/reserve）放 `config/models.json`（Phase 8）
