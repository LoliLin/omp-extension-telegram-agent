# PLAN-20260809-observability-debugging: 建立可关联的本地debug系统

- **Status:** Completed
- **Requirements:** REQ-OBS-0001, REQ-SEND-0003, REQ-SEARCH-0002

## 结果

daemon所有生产日志统一为安全有界JSONL并轮转；关键响应链有稳定生命周期事件；`bun run debug`能只读关联数据库与日志并给出机械异常；以后每项新功能必须遵守debug指南。

## 现状摸底

- 当前daemon核心、runtime、poller、IPC、media共约40处裸`console.*`，格式不统一，错误偶尔拼接原对象。
- durable业务证据已存在于routing claims、agent events、llm runs、cursor/visibility/obligation，无需新建平行telemetry DB。
- daemon controller把stdout/stderr append到单个`data/daemon.log`，没有rotation；startup failure只做正则脱敏tail。
- REQ-SEND-0003可由现有表定位，但缺少turn-local visibility/preflight的稳定日志，人工关联成本过高。

## 方案

1. 在`src/observability/`建立无依赖JSONL logger、字段净化与固定rotation helper；生产模块调用结构化事件，scripts/CLI可保留人类输出。
2. 在现有职责边界加生命周期事件，不复制业务状态、不记录内容；报告直接只读聚合现有SQLite与最后一段JSONL。
3. 以debug guide作为单一权威，AGENTS/development/REQ模板只链接并设置检查点；测试机械锁脱敏、上限、rotation、分类与source审计。
4. 全部离线验证后先检查既有context是否仍与effective fingerprint兼容；只对兼容且非空session调用compact，否则按cache invariant由新epoch隔离。最后受控restart并记录唯一daemon状态。

## 任务

- [x] **T1** — 实现安全JSONL logger与有界0600 rotation并迁移daemon生产日志；validates: AC1–AC3；涉及:`src/observability/`, `src/daemon/`, `src/agent/`, `src/telegram/`, `src/media/`, tests
- [x] **T2** — 实现只读debug报告、异常分类与CLI，覆盖关键成功/失败/沉默链路；validates: AC2/AC4；涉及:`src/observability/`, `scripts/`, `package.json`, tests
- [x] **T3** — 建立debug指南和新功能强制门禁并同步架构/测试/运维文档；validates: AC5–AC6；涉及:`AGENTS.md`, `docs/`
- [x] **T4** — 全量验证、受控restart并处理全部配置bot的旧context identity，归档计划与状态；validates: AC6及用户运维要求；涉及: runtime deployment与完成文档
- [x] **T5** — 恢复legacy omission的TinyFish provider可见性，并让debug报告可审计完整provider结构、按显式开关读取本地完整内容；validates: REQ-SEARCH-0002；涉及:`src/config.ts`, `src/observability/`, `scripts/`, tests/docs

## 验证计划

| 范围 | 命令 / 检查 | 覆盖 |
|---|---|---|
| logger/rotation | `bun test test/observability.test.ts` | AC1–AC3 |
| report | `bun test test/debug-report.test.ts` | AC4 |
| source audit | `rg 'console\\.(log|warn|error)' src` allowlist test | AC2 |
| cache | `bun test test/cache.test.ts` | AC6 |
| 全量 | `bun test` + `bun run check` + `bun run docs:check` | AC5–AC6 |
| deployment | `bun run restart` +只读status/DB/log检查 | 新代码生效 |
| context cleanup | 检查A/B fingerprint/session size，再检查最终epoch/manifest/provider inventory | 用户明确授权的真实操作；不得强制恢复不兼容prefix |

## 风险与失败模式

- logger自身抛错影响业务：sink必须best-effort、序列化无throw，测试循环/BigInt/Error输入。
- 过量日志放大I/O：事件只在边界而非token/chunk/heartbeat，每条/每字段有硬上限，rotation固定。
- 脱敏制造虚假安全：指南禁止传内容，logger再做key/value二次防线；fixture审计敏感canary。
- 诊断查询拖慢live DB：readonly连接、固定since/limit、只用现有索引，不扫message正文。
- restart/compact产生外部成本：代码与离线验证全部通过后再执行；按bot顺序，失败不伪造完成。

## 迁移 / 兼容性

不改业务schema/IPC/provider grammar。新daemon只追加JSONL；旧log轮转保留且debug reader按legacy处理。

## Cache impact

日志/debug/PID/reply修复为NONE。TinyFish visibility恢复是INTENTIONAL deployment tool-schema变化并开启新epoch；未新增自动调用。manual compact在空session的本地preflight被拒绝，未调用摘要模型。

## 文档更新

- [x] debug guide / AGENTS / development / REQ template
- [x] architecture / data-model / testing / maintainer/runbook / index
- [x] devlog / handoff / REQ-LIST

## 完成记录

- 验证证据: 454 tests / 5179 assertions；typecheck、cache v8 golden、docs与diff check通过；最终唯一daemon PID 40594 running/socket，A/B provider inventory均为`send,search`。
- 需求状态已更新: yes
- 运维记录: 旧fingerprint已失效，Pi对A新空session的manual compact返回`Nothing to compact`且未调用摘要模型；未强制恢复不兼容prefix。A/B均通过新epoch隔离旧污染，旧session文件保留。诊断期间双实例由最终restart完整回收。
- 行为提交: `6afaa8d`（同轮reply）、`5891ac0`（日志/debug/TinyFish）、`6082b8e`（daemon ownership）。
- 后续工作项: 无。
