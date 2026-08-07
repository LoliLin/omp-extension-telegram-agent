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
