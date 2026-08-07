# REQ-SEC-0001: run_js 沙箱威胁模型与隔离加固

- **Status:** Approved
- **Priority:** P0
- **Source:** 2026-08-07 code review（逃逸已实证）

## 问题

`src/tools/run-js.ts` 用 `vm.createContext(sandbox)` 传入 host realm 对象（`console` 等），经典逃逸 `console.log.constructor("return process")()` 实测可拿到宿主 `process`，进而读任意文件（项目 `.env` 与 daemon 同 uid）、发起网络请求、`Bun.spawnSync` 起脱离 SIGKILL 范围的孙进程。run_js 的输入来自 LLM，LLM 的上下文来自群消息——**群成员可通过 prompt injection 以 daemon 用户身份执行任意代码并窃取全部 secret**。现有 `test/runjs.test.ts` 只断言 `typeof process === "undefined"`，对逃逸向量无效，提供了虚假安全感。node:vm 官方明确声明不是安全边界。

## 目标

消除「群消息 → run_js → 宿主 secret / 任意代码」这条路径；无法完全消除的残余风险必须文档化。

## 非目标

- 不实现完整的多租户级隔离（独立用户 / seccomp / seatbelt 可作为后续增强）。
- 不改变 run_js 对模型暴露的 tool schema 与语义（除了错误路径更健壮）。

## 需求

- **R1:** vm context 内不得存在任何 host realm 对象 / 函数。`console`/`logs` 在 context 内部用 bootstrap 脚本创建；执行结果通过第二次 `runInContext("JSON.stringify(...)")` 以**纯字符串**带出 realm（primitives 跨界是安全的）。
- **R2:** `runInContext` 加 `codeGeneration: { strings: false, wasm: false }` 加固；评估并处理与合法代码的兼容性（模板字符串不受影响，`eval`/`new Function` 被禁——这符合预期）。
- **R3:** spawn 加 `error` 事件监听（找不到可执行文件时走 `ok:false` 而非 uncaught 打死 daemon）；解释器用 `process.execPath`，不依赖被 scrub 后 PATH 里的 `bun`。
- **R4:** 资源限制补齐：child 加 `--smol` 或 rlimit 限制内存；vm timeout 只管同步代码的事实必须承认——异步 microtask 膨胀由 5s SIGKILL 兜底，文档写明。
- **R5:** 逃逸回归测试：断言 `console.log.constructor("return typeof process")()` 等已知向量拿不到 `"object"`；断言逃逸后无法读取文件系统。
- **R6:** `docs/architecture.md` 或 run-js 注释中写明威胁模型：sandbox 防到什么程度、残余风险是什么、为什么威胁模型下可接受。

## 验收标准

- **AC1:** 给定 R5 的全部已知逃逸向量，执行结果中 `typeof process === "undefined"` 且无法访问 `Bun`/`require`/文件系统。
- **AC2:** 给定 child 解释器不可执行（模拟 spawn ENOENT），run_js 返回结构化错误且 daemon 进程存活。
- **AC3:** 给定死循环与异步内存膨胀 payload，分别在超时内被终止，输出不超过 4KB，无孙进程残留。
- **AC4:** `bun test` 全绿；`bun run check` 通过。
- **AC5:** 文档中存在明确的威胁模型段落，与实现能力一致（不再声称做不到的隔离）。

## 约束

- Cache impact: **NONE**（tool 内部实现，不改 tool schema / description）。
- 安全：任何加固不得以「测试绕过」为代价；回归测试必须真实跑逃逸 payload。
- 兼容：合法 run_js 用法（算术 / JSON / regex / 数组）行为不变——现有测试保持绿。

## 例子与边界 case

- 逃逸向量：`this.constructor.constructor`、`console.log.constructor`、`({}).constructor.constructor`。
- 异步代码返回 Promise → `__RESULT__` 为 `"{}"` 的现状需在 R1 重构中顺带处理（等待 settle 或明确提示）。
- `__RESULT__` marker 与用户输出冲突：借机改为解析或移除。

## 可观察性

- run_js 执行失败 / 超时时写 agent_events `error`（现有 kind 复用）。

## 文档影响

- `docs/architecture.md`（威胁模型段落）、`docs/testing.md`（新测试）、`docs/devlog.md`。

## 待决问题

- 是否接受「node:vm + 纵深防御」作为最终形态，还是要求 OS 级隔离（低权用户 / seatbelt）？影响 R1–R4 做到什么程度。**开工前需要用户拍板。**

## 追溯

- Plans: 待建
- Commits: 从 `Requirement:` git trailer 查
