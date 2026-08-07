# REQ-<领域>-<NNNN>: <标题>

- **Status:** Draft | Approved | In Progress | Done | Superseded
- **Priority:** P0 | P1 | P2 | P3
- **Source:** <想法 / 线上问题 / 遥测发现 / 安全 / 等>

## 问题

描述可观察的问题，以及为什么重要。有证据（日志、遥测、复现步骤）就贴证据。

## 目标

必须变成真的结果。

## 非目标

明确写出相邻但本次不解决的事。

## 需求

用稳定 ID，测试和计划可以引用单条。

- **R1:** ...
- **R2:** ...

## 验收标准

每条必须可观察、可验证。

- **AC1:** Given ..., when ..., then ...
- **AC2:** ...

避免“能正常工作”“足够健壮”这类没有可观察行为的标准。

## 约束

- Cache impact（会不会动 provider 可见字节；动了就要 bump CACHE_SCHEMA_VERSION）:
- 兼容性（持久格式 / IPC 协议 / 序列化 grammar）:
- 性能 / token 成本:
- 安全 / 隐私:
- 数据 / 迁移:
- 运维:

## 例子与边界 case

有代表性的正常、异常、边界、失败例子。

## 可观察性

需要什么 telemetry / agent_events / 日志 / 用户可见的诊断？

## 文档影响

哪些文档必须跟着改（architecture / cache / data-model / testing / runbooks）。

## 待决问题

会影响验收标准或架构的问题必须先解决再开工。

## 追溯

- Plans: `PLAN-...`
- Commits: 从 `Requirement:` git trailer 查（见 `../engineering/traceability.md`）
