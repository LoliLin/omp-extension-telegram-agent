# 成本设计概览

本项目不承诺固定节省百分比。provider价格、群活跃度、persona长度与模型cache行为都会变化；实际效果以Pi footer、`/tg status`和SQLite lifetime telemetry为准。

项目的“极简”是最少机制而不是最少保障：优先少一个状态、接口、网络请求和provider-visible byte，同时保留transaction、timeout、脱敏、测试与可观察性。下面六项就是这一哲学在现有系统里的具体实现，不是未来平台功能清单。

## 1. 确定性 routing 先决定是否调用模型

mention、reply、配置名称和HMAC概率桶都由本地代码判断。普通消息没有命中时不会创建provider run；目标bot busy或处于probability cooldown时也不会改投另一个bot或补抽。

这样减少的是整个无意义调用，而不是在调用后省几个token。权威行为见[架构的 Routing 章节](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)。

## 2. Stable provider prefix 复用cache

persona、固定协议和固定顺序tool schema构成稳定prefix。新消息只追加suffix，代码永不为加入动态信息而改写已经存在的prefix。

cache-visible grammar变化必须升级schema并开启新context epoch；UI、telemetry和operator命令不能偷偷改变provider bytes。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 3. 有界 context 只携带需要的信息

Telegram canonical history保存在SQLite，但模型只看到尚未expose的有界消息批次、必要reply与确定性投影。日志、raw rich JSON、UI状态和无界工具输出不会塞进provider context。

这把本地“完整事实来源”和模型“本轮必要上下文”分开。权威数据流见[架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[数据模型](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/data-model.md)。

## 4. Compaction 在明确边界换epoch

context达到配置阈值时，Pi生成摘要并保留最近尾部，然后进入新epoch。失败或空摘要不会伪造epoch；exposure跟随实际保留尾部重建。

compaction本身有辅助模型成本，因此不是每轮在线优化器。阈值和保留量由配置决定，效果用telemetry验证。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)与[测试状态](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/testing.md)。

## 5. 媒体视觉按需执行并复用结果

照片和sticker先落canonical DB。只有某个真实bot run需要媒体上下文时才调用vision；同一media identity的结果持久化并在bot之间复用。UI收到已有结果只原位更新，不为显示额外调用模型。

权威流程见[架构的 Vision 章节](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)。

## 6. UI 与 telemetry 走side channel

Pi native feed、assistant partial、footer、`/tg status`和Telegram control使用本地IPC/SQLite/control plane。它们可观察运行状态，但不进入persona或主provider context。

因此打开Pi、滚动历史、切换panel或查看usage不会消耗一次聊天模型调用。权威边界见[Pi原生transcript架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 如何评估自己的 deployment

1. 用`/tg status [bot]`记录runs、prompt miss/read/write、output、reasoning、latency与cost。
2. 比较同类活跃期，不把不同provider/persona/群规模混为一组。
3. 用`scripts/analyze-context-window.ts`回放阈值候选；不要凭感觉改compaction。
4. 任何prompt/tool/serialization改动先按[开发指南的cache流程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/engineering/development-guide.md)验证golden和epoch。
5. 设计新能力时先尝试删除一层、一个tool、一次模型调用或一个动态字段；未经明确需求，不把单群deployment扩成多租户系统。
