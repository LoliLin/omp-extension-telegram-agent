# 成本设计概览

本项目不承诺固定节省百分比。provider价格、群活跃度、persona长度与模型cache行为都会变化；实际效果以Pi footer、`/tg status`和SQLite telemetry保留窗口为准。

项目的“极简”是最少机制而不是最少保障：优先少一个状态、接口、网络请求和provider-visible byte，同时保留transaction、timeout、脱敏、测试与可观察性。下面七项就是这一哲学在现有系统里的具体实现，不是未来平台功能清单。

## 1. 确定性 routing 先决定是否调用模型

mention、reply、配置名称和HMAC概率桶都由本地代码判断。普通消息没有命中时不会创建provider run；目标bot busy或处于probability cooldown时也不会改投另一个bot或补抽。

这样减少的是整个无意义调用，而不是在调用后省几个token。权威行为见[架构的 Routing 章节](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)。

## 2. Stable provider prefix 复用cache

共享协议位于最前，persona与固定顺序tool schema随后，让多只bot尽可能共享逐字节相同的prefix。新消息只追加suffix；完整sticker目录不会扩大system prompt。

fingerprint覆盖Pi/provider/model/cache policy、protocol、persona、serializer、compaction、extensions与tools。cache-visible内容变化必须升级schema，并在restore前创建新session/epoch；旧session文件保留，但不会用不同identity恢复。UI、telemetry和operator命令不能偷偷改变provider bytes。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 3. 有界 context 只携带需要的信息

Telegram canonical history与immutable event stream保存在SQLite。每只bot用单调cursor消费event，另一组visible refs只描述当前context仍真正包含完整内容的消息。模型每轮只收到token有界、direct reply优先的event batch；日志、raw rich JSON、UI状态和无界工具输出不会进入provider context。

默认新增suffix上限是12,000 tokens，单event上限4,096；sticker inventory每轮在本地检索，最多加入8个相关且当前bot可发送的候选。这把本地“完整事实来源”和模型“本轮必要上下文”分开。权威数据流见[架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[数据模型](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/data-model.md)。

## 4. Compaction 在明确边界换epoch

context达到配置阈值时，Pi生成摘要并保留最近尾部，然后进入新epoch。失败或空摘要不会伪造epoch；structured details替换visible refs，业务消费cursor永不回退，也不会重放已压缩历史。

compaction使用配置的廉价task model且关闭provider cache retention，因此不是每轮在线优化器。阈值和保留量由配置决定，效果用telemetry验证。权威规则见[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)与[测试状态](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/testing.md)。

## 5. 媒体视觉按需执行并复用结果

照片和sticker先落canonical DB，vision默认关闭。显式开启后，deployment scheduler会分别限制foreground媒体数、并发、每群每小时调用和每日调用。结果按media identity持久化并在bot之间复用，以immutable media-update event追加而不是改写旧context；UI使用缓存结果原位更新，不额外调用模型。

权威流程见[架构的 Vision 章节](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)。

## 6. 网页只按需读取且结果有界

搜索与读取网页复用一个tool，不增加第四项稳定schema。query只返回最多5条短结果；url只有模型明确需要时才发出一次网络请求，正文先受8,000字符本地护栏约束，再受2,048 provider tokens上限约束。群链接不会eager fetch，所以未使用网页能力的turn没有额外网络请求或动态token。

页面正文是不可信数据，URL安全和日志脱敏在确定性代码中完成，不用额外模型调用。单次fetch仍会产生TinyFish请求并把有界正文加入当前动态context，实际成本取决于调用频率与页面长度。

## 7. UI 与 telemetry 走side channel

Pi native feed、assistant partial、footer、`/tg status`和Telegram control使用本地IPC/SQLite/control plane。它们可观察运行状态，但不进入persona或主provider context。

因此打开Pi、滚动历史、切换panel或查看usage不会消耗一次聊天模型调用。权威边界见[Pi原生transcript架构](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md)与[Cache工程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md)。

## 如何评估自己的 deployment

1. 用`/tg status [bot]`记录runs、有效public send、prompt miss/read/write、output、reasoning、latency与cost；“lifetime”只表示配置的SQLite保留窗口。
2. 比较同类活跃期，不把不同provider/persona/群规模混为一组。
3. 用`scripts/analyze-context-window.ts`回放阈值候选；不要凭感觉改compaction。
4. 任何prompt/tool/serialization改动先按[开发指南的cache流程](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/engineering/development-guide.md)验证golden和epoch。
5. 同时比较每个有效公开回复与每个run的成本；沉默或发送失败的run仍产生provider成本。
6. 设计新能力时先尝试删除一层、一个tool、一次模型调用或一个动态字段；未经明确需求，不把单群deployment扩成多租户系统。
