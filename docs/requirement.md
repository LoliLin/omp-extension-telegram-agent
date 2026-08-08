# Pi Telegram Group Chat Agent

## 先理解我们到底在做什么

我们要做的是一个真正“住在 Telegram 群里”的 AI 群友。

用户平时在 Telegram 群里聊天。群里有两个 AI Bot，它们各自有不同的人设，就像两个不同的人：

* 有自己的说话方式和性格；
* 看得到群友的正常聊天；
* 看得到另一个 Bot 曾经说过什么；
* 有时候参与聊天，有时候觉得没必要说话；
* 被人明确叫到名字、@ 或直接回复时，会认真看并决定怎么回应；
* 可以回复文字，也可以像普通群友一样发 sticker；
* 遇到图片和 sticker 能理解它们表达的内容；
* 必要时可以搜索资料、做一点简单计算。

它不是一个“每收到一条消息就机械回答”的客服机器人。

更接近这样的日常体验：

```text
Alice: 这个东西是不是又坏了

Bob: 感觉是 API 抽风

Bot A 在后台看到了，但觉得没必要插话。

Alice: @BotB 你看看？

Bot B: 我查一下。

Bot B 在本地调用 search，自己产生了一些思考文本。
这些过程可以在 TUI 里看到，但群里的人看不到。

Bot B 最后调用 send：

Bot B: 看起来确实是上游接口的问题。
```

如果用户关掉终端里的 TUI：

```text
Telegram Bot 仍然继续运行。
```

几个小时或者几天后重新打开 TUI：

```text
之前和期间发生的群聊仍然全部在那里，
Bot 当时做过的思考、tool call、回复也可以查看。
```

因此这个项目实际上有三个世界：

```text
Telegram 群
    用户真正聊天的地方

本地持久化历史
    项目自己记住从开始运行以后看到的一切

Pi / LLM
    只在真正需要 Bot 思考时，看到经过精简的必要上下文
```

这三者必须清楚分离。

---

# 一、项目最重要的目标

按优先级：

1. 正确、稳定，可以长期运行
2. 尽可能保持 LLM prompt prefix 稳定，提高 provider cache reuse
3. 尽可能减少 cache miss tokens
4. 减少无意义的 LLM 调用和 provider-visible context
5. 架构和代码保持简单
6. 充分复用 Pi 已有能力
7. TUI 清楚、实用
8. 其他功能

其中：

# Cache stability 是核心工程指标

任何新功能在实现前后，都必须检查：

```text
它有没有让本来稳定的 provider prefix 发生变化？
```

特别关注：

* system prompt
* persona
* tool schema
* tool description
* tool 顺序
* 历史消息 serialization
* message 顺序
* thinking/reasoning replay
* compaction
* 动态字段插入位置

如果一个功能可以通过：

```text
只在新的 suffix 后面追加内容
```

实现，就优先采用这种方法，而不是修改已经存在的 prefix。

核心原则：

```text
Never rewrite an existing cached prefix
when appending new information can solve the same problem.
```

同时不要为了 cache 做过度复杂的系统。

Cache 优化应该让结构更简单，而不是发展成第二套大型框架。

---

# 二、模型只是实现细节

当前 Bot 使用：

```text
DeepSeek official API
model: deepseek-v4-flash
thinking: medium
```

当前可以针对它做 cache 优化。

但是未来可能替换成：

* DeepSeek 其他模型
* OpenAI
* Anthropic
* 其他 Pi provider

因此：

```text
Telegram architecture
local persistence
TUI
routing
message representation
agent lifecycle
```

都应该与具体模型解耦。

DeepSeek context-window optimizer 只是一个很小的辅助功能。

模型相关配置统一放在 provider/model config 中。

例如：

```text
contextWindow
cacheReadPrice
cacheMissPrice
outputPrice
compactionThreshold
responseReserve
```

价格、context window、reasoning behavior 可以随模型变化。

项目架构本身不能依赖：

```text
DeepSeek 永远是 1M context
DeepSeek 永远 1:50
```

---

# 三、当前 context threshold

当前开发阶段：

```text
initial compaction threshold = 128K tokens
```

这是一个 provisional default，而不是永久常量。

原因：

对于当前 Telegram Agent 的估计 workload：

```text
compaction 后基础 context ≈ 10K
summary ≈ 6K
平均每个 Bot turn 长期新增 context ≈ 2K–8K
```

128K 是一个兼顾：

```text
cache miss
compaction frequency
cached-read cost
context continuity
```

的合理初始点。

不要花大量开发时间做复杂的在线 optimizer。

只需要：

1. 正确记录 telemetry
2. 提供一个简单分析脚本
3. 根据真实数据给出推荐 threshold

例如：

```text
scripts/analyze-context-window.ts
```

可以读取真实运行数据，模拟：

```text
64K
96K
128K
192K
256K
...
```

以及根据数据自动产生候选点。

最终输出：

```text
estimated cost / turn
cache miss / turn
cache read / turn
compaction interval
```

即可。

它是一个小工具，不是 runtime 核心组件。

---

# 四、开发方式：先研究 Pi，再实现

当前目录旁边：

```text
../pi
```

是 Pi 的源码。

第一步记录：

```bash
git -C ../pi rev-parse HEAD
```

后续关于 Pi 的判断都对应这个 commit。

研究采用：

```text
rg
→ 找 symbol
→ 阅读相关函数附近代码
→ 得出结论
```

不需要为了“熟悉代码库”而读取大量无关文件。

---

# 五、首先研究这些 Pi 内容

## 1. Extension API

阅读：

```text
../pi/packages/coding-agent/docs/extensions.md
```

重点查找：

```text
extension lifecycle
long-lived resources
session_start
session_shutdown
context
before_provider_request
message_start
message_update
message_end
agent_settled
tool_execution_start
tool_execution_end
sendUserMessage
appendEntry
registerEntryRenderer
registerMessageRenderer
setActiveTools
custom tools
terminate
```

目标：

搞清楚一个 Telegram external event 如何进入 Agent，以及 Agent 的完整生命周期。

---

## 2. Headless runtime / SDK / RPC

阅读：

```text
../pi/packages/coding-agent/docs/sdk.md
../pi/packages/coding-agent/docs/rpc.md
../pi/packages/coding-agent/src/core/agent-session.ts
```

只继续读取真正被调用的必要文件。

回答：

```text
长期 daemon 中直接持有 AgentSession 是否合适？

两个 Bot 能否分别持有独立 AgentSession？

TUI 如何与 runtime 分开？

是否可以通过已有 SDK/RPC/event API 获取：
assistant streaming
thinking
tool calls
tool results
usage
session events
？
```

选择：

```text
代码最少
生命周期最清楚
最容易持久化
最容易测试
```

的方案。

---

## 3. Provider serialization

阅读：

```text
../pi/packages/ai/src/api/openai-completions.ts
../pi/packages/ai/src/types.ts
```

重点：

```text
convertMessages
tool serialization
reasoning serialization
DeepSeek compatibility
usage parsing
cache usage
```

真正需要研究的是：

```text
最终 provider 收到什么
```

而不是：

```text
Pi 内部看起来存了什么
```

---

## 4. Compaction

阅读：

```text
../pi/packages/coding-agent/docs/compaction.md
../pi/packages/coding-agent/src/core/compaction/compaction.ts
../pi/packages/coding-agent/src/core/session-manager.ts
```

确认：

```text
什么时候自动 compact
如何判断 token 数
summary 怎么生成
哪些历史被保留
哪些被替换
extension/API 能干预到什么程度
```

评估默认 compaction 对普通群聊是否合适。

---

## 5. terminating tool

阅读：

```text
../pi/packages/coding-agent/examples/extensions/structured-output.ts
```

确认：

```text
terminate: true
```

的精确行为。

特别确认：

```text
send tool 返回 terminate 后
是否会产生额外 provider request
```

---

## 6. 外部事件触发

阅读：

```text
../pi/packages/coding-agent/examples/extensions/send-user-message.ts
```

确认 Telegram 收到消息以后如何触发 Agent。

---

## 7. Pi TUI

阅读：

```text
../pi/packages/tui/README.md
../pi/packages/tui/src/tui.ts
../pi/packages/tui/src/components/markdown.ts
```

再根据实际调用链读取必要组件。

重点：

```text
scrolling transcript
Markdown
Image
layout
stream updates
component lifecycle
```

目标是复用 Pi 的 TUI rendering infrastructure。

---

# 六、Research Gate

研究之后，把结果写入：

```text
docs/research.md
```

至少回答：

1. 长期运行的 Bot runtime 最适合怎样承载 Pi AgentSession？
2. 两个 Bot 如何拥有独立 persona 和 provider history？
3. TUI 如何退出而 runtime 继续运行？
4. Telegram event 如何唤醒 Agent？
5. Pi 最终发送给 provider 的 message/tool payload 是什么？
6. DeepSeek thinking/tool-call history 在 Pi 中如何 replay？
7. Pi 如何暴露 provider usage 和 cache read/miss？
8. `send` 如何成为 terminating tool？
9. Pi compaction 的真正行为是什么？
10. 普通聊天是否需要自定义 compaction policy？
11. TUI 可以复用哪些 Pi components？
12. 哪些能力可以完全在项目自身完成？

然后选出最小架构并继续。

---

# 七、文档是项目状态的一部分

这个项目会经历长时间 LLM 开发。

LLM 自己的上下文可能：

```text
变长
被压缩
重启
切换 Agent
```

所以：

# 不允许依赖“模型记得之前做过什么”

项目本身必须包含足够文档，让任何新的 Agent 只读取这些文档和必要源码，就能继续开发。

建立：

```text
docs/
  project.md
  research.md
  architecture.md
  data-model.md
  cache.md
  testing.md
  devlog.md
  handoff.md
```

---

# 八、各文档用途

## `docs/project.md`

项目长期不容易变化的信息：

```text
项目是什么
用户体验
核心目标
scope
主要约束
术语
```

---

## `docs/research.md`

记录对 Pi / Telegram / provider 的研究结果。

每条关键结论应带：

```text
source file / doc
symbol/function
结论
为什么影响设计
```

---

## `docs/architecture.md`

记录当前真实架构。

包括：

```text
process model
daemon
AgentSession
Telegram ingestion
routing
SQLite
TUI
IPC
vision
tools
provider context flow
```

架构发生变化时同步更新。

---

## `docs/data-model.md`

记录：

```text
SQLite schema
ID semantics
dedupe rules
Telegram normalization
message serialization
media identity
edit handling
```

---

## `docs/cache.md`

记录：

```text
cache invariants
provider payload structure
static prefix
dynamic suffix
context epoch
compaction
CACHE_SCHEMA_VERSION
telemetry
当前 threshold
测试结果
```

任何可能影响 cache 的改动都更新这里。

---

## `docs/testing.md`

不是计划书，而是当前真实测试状态。

记录：

```text
测试场景
运行命令
最后一次结果
已知 flaky 行为
真实 Telegram integration test
restart test
cache test
```

---

## `docs/devlog.md`

append-only 开发日志。

每完成一个明显步骤，追加：

```text
date/time
做了什么
为什么
改了哪些文件
测试结果
cache impact
下一步
```

旧记录保留。

---

## `docs/handoff.md`

这是最重要的恢复文件。

始终保持很短。

任何一个新 Agent 开始工作时，第一步应该能从这里知道：

```text
当前 phase
已经完成什么
正在做什么
下一步是什么
当前架构决定
重要文件
最后测试状态
当前已知问题
```

每完成一个小阶段立刻更新。

这个文件的目标是：

```text
即使当前 LLM context 现在立刻消失，
下一次 Agent 也可以在几分钟内恢复工作。
```
---

# 九、每一个开发步骤都留下痕迹

工作循环：

```text
read handoff
↓
完成一个小而完整的步骤
↓
测试
↓
检查 cache impact
↓
更新对应正式文档
↓
append devlog
↓
更新 handoff
↓
下一步
```

文档必须描述：

```text
当前代码真正做了什么
```

而不是描述未来希望它做什么。

代码与文档冲突时：

修正文档或代码，使二者重新一致。

---

# 十、推荐总体结构

优先验证下面的简单结构：

```text
                  Telegram
                 /        \
             Bot A        Bot B
                \          /
                 \        /
               long-lived daemon
                       │
        ┌──────────────┼───────────────┐
        │              │               │
   Telegram       Agent A/B         SQLite
   ingestion       sessions        persistence
        │              │               │
        ├──── router ──┤               │
        │              │               │
        └──────────────┴───────────────┘
                       │
                    local IPC
                       │
                       ▼
                    Pi TUI
```

Daemon 是长期运行的核心。

TUI 是一个可以随时进入和退出的客户端。

---

# 十一、长期运行

目标体验：

```text
启动 daemon
→ Telegram Bot 一直在线
→ 消息持续落库
→ Agent 按规则运行
```

用户可以：

```text
打开 TUI
查看
退出 TUI
```

退出 TUI 以后：

```text
daemon
Telegram
SQLite
Agent
```

继续正常运行。

再次打开：

```text
加载已有历史
连接实时事件
继续显示
```

提供明确的：

```text
start
status
attach/open-tui
stop
```

操作方式。

实现形式选择最简单可靠的方式。

---

# 十二、Telegram 是传输层，本地 DB 是历史事实来源

Telegram 不承担完整历史恢复职责。

从项目开始运行之后：

```text
所有实际看到的 Telegram updates
```

都持久化到本地。

优先：

```text
bun:sqlite
```

使用直接 SQL。

---

# 十三、数据库需要表达的信息

具体 schema 可以根据实现进一步简化，但需要覆盖：

```text
raw updates
canonical messages
message revisions
media
vision results
agent events
LLM runs
bot/session state
Telegram update offsets
```

---

# 十四、Raw update

保留收到的 Telegram Update 原始 JSON。

用途：

```text
debug
replay
未来 Telegram 字段升级
修复 normalization bug
```

Update 唯一性考虑：

```text
bot identity + update_id
```

---

# 十五、Canonical message

Telegram 群消息统一成一份 canonical message。

同一个群消息可能同时被 Bot A、Bot B 收到。

本地 transcript 只应该有一条。

消息 identity 使用 Telegram 自己的：

```text
chat_id
message_id
```

并保存必要元数据：

```text
send time
message/thread id
sender ID
display name
username
sender tag
sender chat
bot flag
text
caption
entities
reply relation
selected quote
forward origin
edit time
media
```

---

# 十六、消息编辑

消息发生 edit：

TUI 默认显示最新版。

同时保留 revision history，使 debug/replay 仍然可靠。

---

# 十七、Bot 自己发送的消息

`send` 成功以后，Telegram 返回的 Message 立即写入数据库。

这使：

```text
发送成功
→ DB 已经知道
→ TUI 已经知道
```

形成一个完整事务链。

---

# 十八、三种历史严格分开

## Telegram transcript

真实群聊：

```text
human messages
Bot A 已发送 messages
Bot B 已发送 messages
```

## Agent event history

本地内部行为：

```text
assistant local text
reasoning
search
run_js
send tool call
tool result
vision
usage
compaction
errors
```

## Provider-visible context

当前 LLM 真正看到的上下文。

三者互相有关，但不是一份东西。

---

# 十九、LLM 看到的 Telegram 格式

主模型只看一个简洁稳定的文本格式。

不要把 Telegram JSON 直接给模型。

例如：

```text
--- 2026-08-07 ---
[17:31:42] #18452 Alice (@alice · tag:admin): 这个实现是不是有问题？
[17:31:55] #18453 Bob (u17) ↪ #18452: cache prefix 会变
[17:32:03] #18454 BotB (@bot_b · bot): 应该保持 append-only
[17:32:19] #18455 Alice (@alice) ↪ #18454 quote="append-only": @BotA 你怎么看？
```

序列化 grammar 必须固定。

---

# 二十、时间

数据库保存完整机器可处理时间。

LLM serialization：

每条消息：

```text
HH:mm:ss
```

例如：

```text
[17:31:42]
```

日期变化时插入：

```text
--- 2026-08-08 ---
```

这样：

* 模型容易理解
* token 少
* 不需要它理解 Unix timestamp

---

# 二十一、消息 ID

显示：

```text
#18452
```

这是实际 Telegram message ID 的短表达。

它可以直接用于：

```text
reply_to
```

---

# 二十二、用户身份

优先显示：

```text
Display Name (@username)
```

没有 username 时：

本地为该 Telegram user ID 分配一个短、稳定 alias：

```text
u17
```

数据库仍然保存真正 numeric ID。

LLM 日常不需要反复看到长数字。

---

# 二十三、sender tag

存在时才输出：

```text
tag:xxx
```

它属于对聊天理解可能有帮助的身份元数据。

不存在时不产生占位字段。

---

# 二十四、reply

父消息已经在当前 context：

```text
↪ #18452
```

足够。

父消息不在当前 context：

可以带一段很短的 reference：

```text
↪ #18452 @alice "必要片段"
```

这样无需为了 reply 把大量旧历史重新复制进来。

---

# 二十五、selected quote

Telegram 用户如果真正选择了 parent message 的一部分作为 quote：

保留它。

例如：

```text
quote="append-only"
```

这是很高价值的 conversational metadata。

---

# 二十六、forward / edit / topic

这些属于 optional metadata。

只有存在并且对理解消息有意义时才序列化。

原则：

```text
没有信息价值的字段 = 0 token
```

---

# 二十七、Telegram entity normalization

Telegram 的：

```text
mention
text_mention
bot_command
reply
```

在 ingestion 阶段统一解析。

Routing 使用正规化结构。

模型不参与决定：

```text
这条消息是不是在叫 BotA？
```

---

# 二十八、两个 Bot

两个 Bot 各自拥有：

```text
Telegram token
persona
AgentSession
provider history
context epoch
cache telemetry
pending queue
```

persona 独立。

它们共享：

```text
Telegram transcript
media
vision cache
必要的公共 runtime infrastructure
```

---

# 二十九、Routing

Routing 是轻量 deterministic runtime logic。

普通 human message：

```text
A
B
nobody
```

三者之一。

两个 Bot 不分别独立 `Math.random()`。

使用同一个 deterministic value：

```text
u = HMAC(routerSecret, chatId + messageId)
```

然后：

```text
u < pA
→ A

pA <= u < pA+pB
→ B

otherwise
→ nobody
```

这样：

```text
restart
replay
duplicate update
```

仍然得到同一结果。

---

# 三十、明确叫某个 Bot

优先级：

```text
明确 @mention
↓
reply target
↓
configured Bot name keyword
↓
normal probability routing
```

明确目标：

```text
100% 给目标 Bot 一个 response opportunity
```

这里的 100% 指：

```text
让该 Bot 阅读并思考
```

最终是否发送 Telegram 消息仍然由 Bot 自己决定。

---

# 三十一、Bot-to-Bot

Bot A 和 Bot B 的 Telegram message 都进入共同 transcript。

因此之后：

```text
human: @BotB 你觉得刚才 BotA 说得对吗？
```

BotB 可以看到相关 BotA 消息。

但 Bot 本身的消息属于：

```text
被观察到的聊天历史
```

而不是：

```text
新的 Agent trigger
```

Trigger source 只来自满足 routing 条件的 human interaction。

这样两个 Bot：

```text
彼此知道对方说了什么
```

同时不会自己互相聊到停不下来。

---

# 三十二、Bot 可以保持沉默

一个 Agent run 中：

模型可以产生普通 assistant text。

例如：

```text
这条没必要插话。
```

只要本轮最终没有调用：

```text
send
```

Telegram 群里就不会出现消息。

这段 local assistant text：

```text
存进 agent events
显示在 TUI
```

相当于 Bot 的内部活动/说给自己听的话。

这种设计还能省一次多余 tool call。

---

# 三十三、send tool

主 Agent 的发送能力统一成一个 tool：

```text
send({
  reply_to?: number,
  sticker?: string,
  message?: string
})
```

典型操作：

```text
send({ message })
send({ reply_to, message })
send({ sticker })
send({ reply_to, sticker })
```

保持 schema 小而长期稳定。

`reply_to` 是 modifier。

---

# 三十四、send 是当前 Agent run 的终点

模型决定真正向 Telegram 发送以后：

```text
send
↓
Telegram API
↓
保存真实 Message
↓
terminate
↓
agent idle
```

`send` 使用 Pi 的 terminating semantics。

目标：

```text
发送以后不为了查看“发送成功”再进行一次 LLM 调用
```

Tool result 保持很小和稳定。

Telegram 返回的完整对象进入本地数据库，而不是重新塞给主模型。

---

# 三十五、工具

主 Bot 的模型只需要三种实际能力：

```text
search
run_js
send
```

这样 tool surface 很小。

---

# 三十六、Search和fetch

使用 TinyFish。

主模型看到一个很小的接口，例如：

```text
search({
  query: string
})
```

结果经过 runtime 精简，只保留少量高价值信息：

```text
title
url
short snippet
```

对结果数量和文本长度设明确上限。

目标：

```text
让 search 帮模型得到答案
而不是把网页原文变成上下文垃圾
```

---

# 三十七、run_js

模型可以运行简单 JS/TS：

```text
Bun
```

主要用途：

```text
计算
JSON
regex
小型算法
数据转换
```

它运行在隔离环境。

这个环境只提供完成纯计算所需能力：

```text
temporary isolated workspace
timeout
memory limit
stdout/stderr limit
restricted process capability
restricted host filesystem
```

需要测试隔离边界。

普通：

```text
1 + 1
JSON processing
regex
sorting
```

应正常。

访问 host secrets/files/process 则不能越过 sandbox。

---

# 三十八、Vision

Vision 是 runtime 的辅助能力。

不是主 Bot 长期 tool schema 的核心组成部分。

当前：

```text
使用本机已有 Codex authentication
调用配置好的辅助视觉模型
reasoning low
```

具体 model 放 config。

未来同样可以替换。

---

# 三十九、Vision lazy execution

图片进入 Telegram：

```text
落库
TUI 可以显示
```

这一步不意味着立即跑 vision。

只有：

```text
某个 Bot 真正被唤醒
+
图片真正需要进入该 Bot 当前上下文
```

才进行识别。

例如：

```text
10:00 发图片
没人叫 Bot
→ 0 vision calls

10:10 有人 reply 图片并 @BotA
→ 第一次 vision

之后再次引用
→ 使用 persistent vision cache
```

---

# 四十、普通图片和 sticker 使用不同语义

## Photo

辅助模型关注：

```text
实际可见内容
重要 OCR
界面/error
人物或物体
对当前聊天真正有用的信息
不确定信息
```

输出短。

例如：

```text
IDE screenshot. TypeScript error at sendRichMessage():
reply_parameters type mismatch.
```

---

## Sticker

Sticker 被定义为：

```text
一种聊天反应/表达
```

辅助模型关注：

```text
communicative intent
emotion
intensity
gesture
visible text
suitable conversational use
```

例如：

```text
intent=mocking agreement
emotion=smug/amused
intensity=medium
```

这样主模型会把它理解为：

```text
群友发了一个表达“得意赞同”的 sticker
```

而不是把 sticker 画面当成用户真实环境。

---

# 四十一、Vision cache

同一个媒体的识别结果在两个 Bot 之间共享。

持久化。

重启以后继续使用。

Sticker catalog 也保存 semantic description。

Telegram 中真正发送需要的 Bot-specific file identity 单独维护。

---

# 四十二、Sticker candidate

Sticker library 可能越来越大。

主模型每轮只看到与当前聊天相关的少量候选。

例如：

```text
Available stickers:
s12 = smug agreement
s44 = mild panic
s91 = confused stare
```

Tool schema 始终保持：

```text
sticker?: string
```

candidate 属于本轮 dynamic context。

---

# 四十三、Telegram 富文本

调查：

```text
Pi TUI 当前实际支持的文本格式
∩
Telegram 当前 Rich Text/Rich Message 能力
```

定义一个小而稳定的发送 subset。

目标是：

```text
同一段 Bot message
在 Telegram 和 TUI 中都有合理效果
```

优先考虑日常真正有价值的：

```text
plain paragraphs
bold
italic
strikethrough
inline code
code blocks
links
lists
quotes
```

其他格式只有在两边都稳定、实现简单、实际有价值时再加入。

主模型仍然输出：

```text
message: string
```

而不是大型 Telegram Rich Message AST。

---

# 四十四、本地 TUI

TUI 是整个系统的“观察窗口”。

打开之后首先加载本地数据库。

用户应该能看到：

```text
完整 Telegram 历史
Bot 内部 assistant text
thinking/reasoning
tool calls
tool results
vision events
cache/usage/error 等必要 runtime 状态
```

---

# 四十五、聊天历史

“完整历史”是指：

```text
本地数据库从 Bot 开始运行以来保存的完整历史
```

UI 实现可以采用分页/virtualization。

例如：

```text
打开先显示最近历史
scroll up
→ 加载更老记录
```

不需要一次把几十万条历史全部构造成内存组件。

---

# 四十六、TUI 中要能区分真实发言和本地行为

例如：

```text
Alice                         17:31:42
  这个报错怎么回事？

Bot A · LOCAL                 17:31:45
  我先搜一下具体行为。

  search  "..."
    ✓ 5 results

Bot A · LOCAL
  看起来已经确认了。

Bot A                         17:31:51
  这是上游接口的一个已知行为。
```

其中：

```text
Bot A
```

表示 Telegram 真正看到的消息。

```text
Bot A · LOCAL
```

表示只有本地 TUI 看得到。

---

# 四十七、Tool rendering

默认 compact：

```text
search  "query..."
run_js  83 ms
vision  p42
send    reply #18452
```

需要时可以展开 result。

聊天界面的重点仍然是：

```text
人
消息
Agent 的行为顺序
```

---

# 四十八、Provider context 与完整聊天分离

SQLite 中可以有几十万条历史。

主模型每次不需要读这些历史。

每个 Bot 自己维护 provider-visible conversation/context state。

Context 的目标：

```text
静态信息永远在最前面
旧内容尽量 append-only
动态信息只追加
```

---

# 四十九、稳定 prefix

稳定区域主要包含：

```text
system prompt
persona
chat behavior rules
message grammar explanation
formatting rules
stable tool schemas
```

这些内容变化频率应该非常低。

---

# 五十、动态 suffix

当前聊天内容：

```text
新 Telegram messages
reply dependencies
当前图片 semantic result
当前 sticker candidates
tool outputs
```

作为新 suffix 进入。

不要因为来了新消息而重新构造整段“最近 N 条”。

---

# 五十一、Message exposure tracking

每个 Bot 记录：

```text
哪些 Telegram message 已经进入过它的 provider context
```

Bot 很久没有被触发以后再次触发：

选择：

```text
尚未 exposure 且当前相关的新消息
reply chain
必要的另一个 Bot 消息
```

按时间顺序加入新的 suffix。

已经在当前 epoch 中出现过的内容不重复序列化。

---

# 五十二、Context Epoch

把一段 append-only provider history 称为：

```text
Context Epoch
```

一个 epoch 内尽量只追加。

发生 compaction 时：

```text
Epoch N
↓
summary
↓
Epoch N+1
```

这就是明确的 cache boundary。

---

# 五十三、CACHE_SCHEMA_VERSION

定义：

```text
CACHE_SCHEMA_VERSION
```

下面这些属于 cache-visible protocol：

```text
system prompt shape
persona serialization
tool schema
tool order
message serialization grammar
compaction summary grammar
```

当确实要修改这种长期协议时：

```text
bump version
创建新的 context epoch
```

这样 cache reset 是：

```text
一次明确的版本变化
```

而不是每轮莫名其妙地 miss。

---

# 五十四、每个功能都做 Cache Impact Review

实现一个功能以后，在开发日志里写：

```text
Cache Impact:
```

至少检查：

```text
system hash changed?
tool schema hash changed?
old serialized messages changed?
old message order changed?
new dynamic data inserted before old prefix?
compaction behavior changed?
expected miss/turn changed?
```

结论：

```text
NONE
INTENTIONAL EPOCH CHANGE
INVESTIGATE
```

如果出现没有必要的 prefix mutation：

优先修正设计。

---

# 五十五、Provider telemetry

每次请求至少记录：

```text
bot
model
provider
timestamp
context epoch
context token count
cache read tokens
cache miss tokens
output tokens
latency
cost if calculable
compaction flag
```

同时计算：

```text
system hash
tool schema hash
ordered provider-message hashes
```

这些 hash 用于排查：

```text
为什么上一轮明明应该 cache hit，这一轮却 miss？
```

API key、Bot token 等 secret 不进入 telemetry。

---

# 五十六、Cache dashboard / command

提供一种很轻量的查看方式，例如 TUI 页面或 command：

```text
/cache
```

能看到：

```text
Bot A
model
epoch
context size
cache read
cache miss
miss ratio
estimated cost
last compaction
system hash short id
tools hash short id
```

以 debug/optimization 为目的。

---

# 五十七、Context analysis 小工具

实现一个很小的分析脚本。

输入真实 telemetry：

```text
context growth / turn
summary size
cache prices
output prices
compaction cost
```

估算不同 threshold。

当前默认：

```text
128K
```

跑够真实数据以后可以比较：

```text
64K
96K
128K
160K
192K
256K
...
```

输出报告。

这个脚本保持独立。

更换模型：

换 config 即可重新分析。

---

# 五十八、Compaction summary

Compaction 不等于删除真实聊天。

SQLite transcript 永远完整。

Summary 是专门为 LLM continuation 创建的 context artifact。

适合长期保留：

```text
重要人物关系
已知稳定事实
长期话题
正在讨论的问题
承诺
未解决事项
必要 message references
persona 真正会关心的信息
```

Summary 应倾向“状态”而不是“逐条复述”。

---

# 五十九、Thinking / tool history

DeepSeek thinking + tool calls 对 context serialization 有自己的协议要求。

以实际 provider API 和 Pi serialization 为准。

保存合法 tool/reasoning history时：

```text
protocol correctness
```

优先于主观认为“这个 reasoning 好像没有用了”。

使用：

```text
before_provider_request
```

或对应实际 hook/debug 路径查看 wire payload。

---

# 六十、Busy Agent / 群聊 burst

Agent 正在思考时，群里仍可能继续聊天。

所有新 Telegram message 都立刻：

```text
persist
render
route
```

如果目标 Bot 当前 busy：

加入一个小的 pending trigger queue。

当前 run settle 后：

把短时间 burst 合并成下一次 response opportunity。

目标：

```text
减少无意义的连续 LLM calls
减少 context churn
聊天行为更自然
```

---

# 六十一、Secrets

真实环境变量已经提供给你。

统一使用 env/config loader。

包括：

```text
Telegram bot tokens
DeepSeek API key
TinyFish API key
routing secret
group/chat identity
vision model config
personas
```

项目 repo 中提供：

```text
.env.example
```

只描述变量名字和格式。

runtime logs / provider context / TUI debug 中对 secret 做保护。

---

# 六十二、测试是开发过程的核心部分

鼓励大量测试。

不要只写代码然后根据类型检查认为“完成”。

测试分层：

```text
unit
integration
replay
real Telegram
restart/persistence
provider/cache
long-running smoke test
```

能自动测的尽量自动测。

---

# 六十三、Telegram fixture replay

准备一组 deterministic fixtures：

```text
normal text
reply
selected quote
mention
text_mention
bot message
edit
photo
sticker
two-bot visibility
duplicate update
out-of-order/retry if relevant
```

能够把 fixture replay 到 normalization/router/storage 层。

---

# 六十四、真实 Telegram 测试

已经提供真实 env。

在功能达到对应阶段以后，实际调用真实 Telegram Bot 做 integration tests。

至少覆盖：

```text
收消息
发消息
reply
两个 Bot
Bot-to-Bot visibility
TUI
restart
图片
sticker
```

测试产生的行为要可识别、可清理。

---

# 六十五、Persistence test

必须实际验证：

```text
daemon start
↓
收到 Telegram messages
↓
打开 TUI
↓
退出 TUI
↓
继续收到消息
↓
Bot 继续运行
↓
重新进入 TUI
↓
中间所有历史仍然正确出现
```

---

# 六十六、Restart test

实际测试 daemon restart。

验证：

```text
update offset 恢复
message dedupe
不会重复发送 Bot 回复
SQLite 状态一致
Agent session/context 可恢复
```

---

# 六十七、Routing tests

对 deterministic router 做大量 property tests。

例如任意：

```text
chat_id
message_id
```

结果必须唯一属于：

```text
A
B
nobody
```

重跑结果相同。

明确 mention/reply 的优先行为独立测试。

---

# 六十八、Send terminating test

真实/模拟测试：

```text
LLM
→ send
→ Telegram
```

确认：

```text
send 之后没有仅为了 tool result 出现的新 provider request
```

---

# 六十九、Local assistant test

模型产生：

```text
assistant local text
```

同时本轮没有 `send`。

验证：

```text
TUI 有
agent_events 有
Telegram 没有
```

---

# 七十、Vision tests

测试 lazy behavior：

```text
图片进群
Bot 未被触发
→ vision count = 0
```

随后：

```text
reply 图片 + @Bot
→ vision count = 1
```

再次引用：

```text
→ persistent cache hit
→ no new vision call
```

Sticker 同样测试 semantic prompt 区别。

---

# 七十一、run_js sandbox tests

测试：

```text
普通 arithmetic
JSON
regex
array transform
```

成功。

同时验证 sandbox 的 host isolation。

每次安全模型调整后重复这组测试。

---

# 七十二、Cache regression test

准备固定 provider conversation fixture。

每个影响 runtime/context 的修改前后比较：

```text
old message hashes
system hash
tools hash
cache miss
cache read
provider token count
```

如果一个 UI-only feature 最终改变了 provider prefix：

说明边界设计出现问题，优先调查。

---

# 七十三、长时间 smoke test

达到基础功能以后，让 daemon 连续运行。

观察：

```text
memory
SQLite growth
Telegram reconnect
provider errors
queue
duplicate messages
cache telemetry
TUI reconnect
```

修复实际长期运行暴露的问题。

---

# 七十四、开发阶段

按小的 vertical slice 推进。

## Phase 1 — Research & skeleton

完成：

```text
Pi research
docs
runtime architecture
config
SQLite skeleton
```

---

## Phase 2 — Telegram persistence

完成：

```text
one Bot
long-running ingestion
normalization
SQLite
dedupe
restart
```

此时先把“可靠记住群聊”做好。

---

## Phase 3 — Basic Agent

完成：

```text
Pi session
compact Telegram serialization
local assistant events
send
terminating behavior
usage telemetry
```

---

## Phase 4 — TUI

完成：

```text
attach/detach
history
realtime updates
agent events
scroll/load older
```

---

## Phase 5 — Two Bots

完成：

```text
two personas
two sessions
deterministic routing
Bot-to-Bot history
human-only trigger behavior
```

---

## Phase 6 — Tools

完成：

```text
TinyFish search
sandboxed run_js
```

---

## Phase 7 — Media

完成：

```text
photo
sticker
lazy vision
vision cache
sticker sending
```

---

## Phase 8 — Context refinement

基于真实 telemetry：

```text
compaction
cache regression
128K baseline validation
small threshold analysis script
```

---

## Phase 9 — Stabilization

集中做：

```text
real Telegram tests
restart tests
long-running tests
error recovery
database correctness
TUI reconnect
cache verification
documentation cleanup
```

---

# 七十五、每个 Phase 的 Definition of Done

每阶段结束前：

```text
feature works
tests pass
real integration tested when applicable
docs updated
devlog updated
handoff updated
cache impact checked
obvious dead code removed
errors handled
```

然后进入下一阶段。

---

# 七十六、遇到问题时的工作方式

优先：

```text
读错误
查当前源码
复现
写测试
修复
重新测试
记录结论
```

比猜测行为更可靠。

遇到第三方 API 行为：

优先查询：

```text
官方文档
当前 SDK/source
实际 API response
```

重要结论写入 `docs/research.md`。

---

# 七十七、与用户沟通方式

这是一个允许你连续自主开发的任务。

环境、token、API 和目标已经提供。

对于普通实现细节：

```text
自己做最简单合理的工程判断
写入文档
继续
```

不需要在每个小决定上中断开发询问。

充分利用：

```text
真实 env
真实 Telegram
真实 provider
真实 Pi
```

进行测试。

目标不是尽快告诉用户：

```text
“代码已经写完”
```

而是等到：

```text
核心功能真实可用
关键 integration tests 通过
restart/persistence 验证通过
TUI attach/detach 工作
两个 Bot 工作
安全边界测试通过
cache 行为经过实际测量
文档可以让新 Agent 接手
没有已知 blocker
```

之后再通知用户已经达到：

```text
stable-to-run
```

状态。

如果测试发现问题：

继续迭代、复现和修复。

---

# 七十八、最终通知前的完整验收

最终至少人工/自动验证一次：

## 用户体验

```text
群友发消息
Bot 自然决定是否参与
明确叫 Bot 可以响应
Bot 可以不说话
Bot 可以 reply
Bot 可以 sticker
图片可以理解
另一个 Bot 的历史可以理解
```

## 生命周期

```text
TUI exit
Bot stays online

TUI reopen
history restored

daemon restart
state restored
```

## 数据

```text
无重复消息
无重复发送
edit 正确
raw update 可 replay
agent events 正确
```

## Agent

```text
local text 不会发群
send 才发群
send terminating 正确
search 正常
run_js sandbox 正常
```

## Cache

```text
正常 turn 的旧 prefix 稳定
system/tools 不发生意外变化
cache hit/miss telemetry 可见
compaction 有明确 epoch boundary
128K threshold 有真实数据验证
```

## 文档

一个新的开发 Agent：

只阅读：

```text
docs/project.md
docs/handoff.md
docs/architecture.md
docs/cache.md
```

即可知道项目当前状态并继续工作。

---

# 七十九、最终交付报告

达到稳定状态以后，再给用户一个简洁报告：

```text
1. 当前已经实现什么
2. 如何启动 daemon
3. 如何打开/退出 TUI
4. 两个 Bot 当前配置方式
5. 数据存在哪里
6. 测试了哪些真实场景
7. 最后一次测试结果
8. 当前实际 cache hit/miss 数据
9. 当前 context threshold 和测量依据
10. 仍存在的非阻塞限制
11. 代码和文档入口
```

不要把完整开发日志复制给用户。

开发日志已经在 repo 中。

---

# 八十、当前环境

以下实际值已经在当前环境/用户提供的 env 中存在。

主 Bot：

```text
provider: DeepSeek official API
model: deepseek-v4-flash
thinking: medium
```

Search：

```text
TinyFish
```

辅助视觉：

```text
使用本地已有 Codex authentication
模型和 reasoning level 使用用户给定配置
```

Telegram：

```text
Bot A token: <provided>
Bot B token: <provided>
Group/chat id: <provided>
```

Pi：

```text
../pi
```

Persona：

```text
Bot A persona:
<provided>

Bot B persona:
<provided>
```

所有已有实际 env 都用于真实 integration testing。

---

# 最后再记住这个项目的本质

这是一个：

```text
长期住在 Telegram 群里的两个 AI 群友。
```

本地程序负责：

```text
可靠地记住群聊
可靠地持续运行
让用户随时打开 TUI 看发生了什么
```

Pi/LLM 负责：

```text
在真正值得思考的时候思考
必要时使用工具
最后决定是否向群里说话
```

完整历史属于数据库。

界面属于 TUI。

模型只得到真正需要的上下文。

Cache 优化的核心不是复杂技巧，而是：

```text
稳定的东西保持稳定，
新的东西向后追加。
```

首先建立一个正确、简单、可长期运行的系统。

然后通过真实 telemetry 优化它，而不是提前围绕某一个具体模型过度设计。


## Persona privacy

真实 deployment persona 已从当前 HEAD 移除。公开、通用的中英文起始模板见 `personas/template.zh.md` 与 `personas/template.en.md`；本机定制提示词默认被 Git 忽略。既有 Git 历史仍可能包含旧文本，除非另行明确授权并协调历史重写。
