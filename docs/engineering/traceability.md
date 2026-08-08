# 追溯：需求 → 计划 → 提交

## 目标

任何时候都能机械地回答两个问题：

1. 哪些代码改动实现了 `REQ-X`？
2. 这个 commit 为什么存在？

## 模型

```text
需求 -> 计划 -> 任务 -> 提交
REQ-XXX-0042
  -> PLAN-20260807-refresh-token-rotation
       -> T1 -> commit a1b2...
       -> T2 -> commit c3d4...
```

需求是意图，commit 是可逆的实现单元，粒度不同，不要强行一一对应。

## 分层追溯（本项目实际）

- **Phase 1–9 的历史工作**：追溯靠 `docs/devlog.md`（每条记录做了什么 / 为什么 / 改了哪些文件 / 测试结果）+ git log。老 commit 没有 trailer，不补。
- **新工作**：有 REQ / PLAN 的，用 git trailer；临时小改动（typo、小 bug fix）只需 devlog 一条，不强制 trailer。

## Git trailer（新工作）

基于 REQ / PLAN 的非机械 commit，message 末尾加：

```text
Requirement: REQ-CACHE-0012
Task: PLAN-20260807-sticker-catalog#T3
```

一个内聚改动确实服务多个需求时重复 `Requirement:` trailer。机械性提交（纯格式化、重命名搬运）用：

```text
Work-Type: mechanical
```

trailer 放末尾而不是 subject——trailer 稳定且机器可读。subject 描述代码改动本身，不是任务标题。

## 原子提交边界

大任务在 active PLAN 里先拆成 commit-sized tasks，再开始实现。一个 commit 必须同时满足：

1. **一个结果**：只完成一个可观察行为或一个纯机械变化，可独立 review / revert。
2. **自包含**：实现、对应测试、该行为必需的 contract 文档一起提交；不能提交会让主分支暂时无法 typecheck 的“半边改动”。
3. **已验证**：提交前目标测试通过；任务全部结束后再补全量 `bun test` + `bun run check`。
4. **显式暂存**：脏工作树按路径或 patch 暂存并检查 staged diff；禁止用 `git add -A` 顺手夹带别的 task 或用户改动。
5. **签名**：授权后的 commit 使用 repo GPG 配置签名；签名失败不得降级为 unsigned。

行为改变与机械重构通常分开；但同一行为必需的测试和文档不要人为拆到“后续补” commit。已完成一个 plan task 就提交，不把多个 task 积压成一个大提交。

## Commit message 规范

```text
<Imperative verb> <concrete code outcome>

<optional body: why / invariant / verification, not a file list>

Requirement: REQ-...
Task: PLAN-...#Tn
```

- subject 使用英文祈使句、首字母大写、末尾无句号，建议 ≤72 字符。
- subject 写具体代码结果，例如 `Filter sticker candidates by bot sendability`；不用 `Update files`、`Fix bugs`、`REQ-STICKER-0002` 这类无法单独说明结果的标题。
- docs-only / mechanical commit 可用明确 scope（如 `Document ...`），并用 `Work-Type: mechanical`；行为 commit 不使用 Conventional Commit 前缀作为强制格式。
- body 可省略；需要时说明“为什么”、兼容/cache invariant、关键验证，不重复 diff 文件清单。
- trailer 前保留一个空行；有 REQ 时写 `Requirement:`，有 PLAN task 时写 `Task:`；一个 commit 服务多个需求时重复 `Requirement:`，但 `Task:` 应指向唯一 commit-sized plan task。无 REQ 的临时 task 可只有 `Task:`；纯机械且无 REQ/PLAN 时写 `Work-Type: mechanical`。

示例：

```text
Filter sticker candidates by bot sendability

Keep the stable catalog and dynamic suffix aligned with the same per-bot
file_id invariant. Targeted sticker and cache tests pass.

Requirement: REQ-STICKER-0002
Task: PLAN-20260808-complete-new-reqs#T3
```

## 查询

查某个需求的全部 commit：

```bash
git log --all --format='%H %s%n%(trailers:key=Requirement,valueonly)' \
  | grep -B1 -A1 'REQ-CACHE-0012'
```

查单个 commit 的 trailer：

```bash
git show -s --format='%(trailers)' <sha>
```

不维护手写的映射表——trailer + 需求 / 计划文件就是唯一事实来源，需要报告时从 git 生成。
