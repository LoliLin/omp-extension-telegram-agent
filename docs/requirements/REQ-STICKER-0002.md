# REQ-STICKER-0002: 固定目录与动态候选必须按 bot 可发送性隔离

- **Status:** Implemented（2026-08-08；unit/cache/check 已验证，真实群 smoke 汇总到 T14）
- **Priority:** P0
- **Source:** 用户新增 Bug：「历史记录显示，agent 在发送固定贴纸时有问题」
- **依赖:** REQ-STICKER-0001、REQ-CONF-0001

## 问题

不同 bot 配置不同固定 sticker set 时，一个 bot 会在动态候选中看到另一个 bot 目录里的 sticker short_id，但本 bot 没有对应 `file_id`。模型选择后，`executeSend` 以 `sticker <id> is not sendable by this bot (no file_id)` 拒绝，浪费一次 tool attempt，并常诱发模型改发不相关贴纸或解释“sticker 服务抽风”。

## 调查证据与根因

- 生产 session 可重复观察到：A 选择 `s243/s241/s244/s242` 均因 no file_id 失败；B 选择 `s144` 同样失败。
- DB 证明 `s241–s244` 属于 B 的 `Mikufufu` 且只有 B 映射；`s144` 属于 A 的 `myadestes...` 且只有 A 映射。
- `stickerCandidatesBlock()` 只排除“当前 bot 自己配置的 set”，查询全局 `media`，没有按 `media_file_ids.bot_id = 当前 bot` 做可发送性 join。因此另一个 bot 的固定目录会泄漏成当前 bot 的动态候选。
- `executeSend` 的发送前校验按设计工作，没有产生半发送；bug 位于候选生成，而不是 Telegram API 或 short_id 唯一性。

## 目标

模型看到的每一个 sticker short_id 都必须能被当前 bot 发送；不同 bot 的固定目录与动态候选相互隔离，除非当前 bot 确实拥有该 media 的 `file_id` 映射。

## 非目标

- 不改变 short_id 的 rowid 命名空间。
- 不允许跳过 preflight 校验或在失败后自动换任意贴纸。
- 不合并各 bot 的 sticker 配置。
- 不在本需求改变 catalog 规模/语义描述质量。

## 需求

- **R1 — 单一可发送谓词：** 目录序列化、动态候选与 `executeSend` 共享“当前 bot 存在可用 `media_file_ids` 映射”的语义；候选查询必须按 bot id join/filter，不能仅按 set name 推断。
- **R2 — 固定目录：** 当前 bot 配置的 set 在启动 fetch 后，为目录中每个暴露 short_id 建立当前 bot 的 file_id；缺映射的条目不得进入该 bot 的稳定 prefix，并给出有界告警。
- **R3 — 动态候选：** set 外 sticker 只有在当前 bot 已观察/获取过且可发送时才进入 suffix；另一个 bot 的固定目录行不能因“不属于我的 set”自动变成我的候选。
- **R4 — preflight 保留：** tool 仍在任何 network send 前解析并验证全部 sticker/message/reply 参数；未知或不可发送 id 返回结构化错误，绝不部分发送。
- **R5 — 数据修复：** 对已有 media 不改 schema；启动可通过 `getStickerSet` 补全当前 bot 配置目录的映射。不得伪造/复制另一个 bot 的 bot-specific file_id。
- **R6 — 诊断：** telemetry/LOCAL error 区分 `candidate invariant violated` 与用户/模型提交未知 id；不得只让模型看到模糊 no file_id。

## 验收标准

- **AC1:** fixture 中 A 只映射 setA、B 只映射 setB：A prompt/candidates 不含 B-only short_id，B 同理。
- **AC2:** 一个 set 外 sticker 同时有 A/B 映射时，可作为两边动态候选并成功发送；只有 A 映射时 B 不可见。
- **AC3:** 当前真实数据中的 A→`s241/s242/s243/s244`、B→`s144` 泄漏有回归测试并消失。
- **AC4:** 固定目录 fetch 部分失败时，只有已映射条目可见；启动继续且有明确统计。
- **AC5:** invalid id 与“text + invalid sticker”仍证明零 Telegram network call；既有 R7 回归不退化。
- **AC6:** `bun test`、`bun run check`、cache golden 与真实群“每 bot 各发送一个自身目录 sticker”通过。

## 约束

- Cache impact: **INTENTIONAL**。从稳定 sticker catalog prefix 移除不可发送条目会改变 provider bytes；实现时必须 bump `CACHE_SCHEMA_VERSION`、全 bot 开新 Context Epoch，并同步 `docs/cache.md`/golden。动态 suffix 的 bot 过滤本身不另加 prefix 成本。
- Token impact: 候选减少，只会降低 miss token 与失败 tool turn，不得新增候选解释文本。
- DB schema 预计无需 migration；若实现发现必须改 schema，需另行兼容计划。

## 例子与边界 case

- A=setA、B=setB：A 不得看到 setB 目录，即使 setB rows 已存在全局 media cache。
- 群友发了 setB sticker，两个 poller 都拿到各自 file_id：若 ingestion 确实记录两边映射，则它可以成为 A 的动态候选；判断依据是映射，不是 set 所属。
- catalog 视觉描述尚未完成：是否显示 `[未识别]` 与可发送性正交。

## 可观察性

启动记录每 bot `catalog total / sendable / missing mapping`；测试直接比较候选 short_id 集合与 per-bot mapping 集合。

## 文档影响

`docs/cache.md`、`docs/architecture.md` Sticker 小节、`docs/testing.md`、`docs/runbooks/daemon.md`。

## 待决问题

无；生产历史和 DB 已足够定位根因。

## 追溯

- Plans: 修复前建立
- Commits: 从 `Requirement:` git trailer 查
