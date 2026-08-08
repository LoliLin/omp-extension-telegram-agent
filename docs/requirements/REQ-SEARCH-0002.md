# REQ-SEARCH-0002: 保持旧部署的 TinyFish provider 可见性

- **Status:** Done（workspace；未授权 commit）
- **Priority:** P0
- **Source:** 生产群反馈：模型声称只有 `send`，看不到既有 TinyFish `search`

## 问题

历史部署的 `bots.config.json` 创建于 `tools.search` 默认启用时期，因此省略该字段。`15c82cc` 将省略语义改成禁用，但 onboarding 只对新生成配置显式写 `search:false`；结果是旧部署重启后悄悄从 provider tool schema 删除 `search`。数据库与历史 Pi session 证明 TinyFish 曾成功返回完整 `toolResult`，因此问题不在结果投影，而在注册前的配置归一化。

## 要求与验收

- **R1 / AC1:** 旧配置省略 `tools.search` 时归一化为启用；显式 `false` 仍禁用。
- **R2 / AC2:** 新 onboarding/example 继续显式写 `search:false`，不改变新部署的安全默认。
- **R3 / AC3:** 当前两个 bot 显式声明 `search:true`；重启后 provider-visible tool inventory 都包含 `search`。
- **R4 / AC4:** debug 工具默认展示完整 provider 结构元数据（system/tools/messages及工具结果身份），内容默认省略；只有显式本地敏感开关才输出可重建的完整 system prompt 与消息内容，且不写 daemon 日志。
- **R5 / AC5:** 回归测试同时锁定 omission 与 explicit false，并检查诊断输出不会把内容意外放进默认模式。

## Debug impact

- 成功：provider inventory 对 A/B 显示 `search`，TinyFish 调用后出现同 call id 的 assistant tool call、`toolResult`及 follow-up run。
- 无操作：显式 `search:false` 时 inventory 不含该工具，这是配置结果而非故障。
- 失败：`search` 配置启用但 inventory 缺失，报告 `provider_tool_missing`；tool result 与 follow-up 不配对时报告对应结构异常。
- 敏感内容：默认报告只给角色、类型、长度、hash、tool name/call id；完整内容必须显式请求，仅写 stdout。

## Cache impact

INTENTIONAL。受影响旧 bot 从无 `search` schema 恢复为既有固定 `send, search` 前缀，context fingerprint 改变并开启新 epoch；新配置显式关闭时字节不变。每 turn 恢复 TinyFish schema 的固定 token 成本，但不会新增自动工具调用；debug 本身零 LLM token。
