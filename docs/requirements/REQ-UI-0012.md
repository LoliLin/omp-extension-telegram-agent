# REQ-UI-0012: Pi 原生媒体在 Kitty/Ghostty 中正确显示

- **Status:** Approved（2026-08-08 已调查，未实现）
- **Priority:** P1
- **Source:** 用户新增 `REQ-LIST`：「Kitty(libghostty) 没显示正确媒体」
- **依赖:** REQ-UI-0001、REQ-UI-0004、REQ-UI-0006

## 问题

Telegram feed 已经把本地缓存交给 Pi 原生 `Image`，但在 Kitty 与使用 Kitty graphics protocol 的 Ghostty/libghostty 终端中图片完全不显示。问题不在终端能力检测，而在插件传给原生组件的 payload 格式：

- 当前 Pi `detectCapabilities()` 已把 Kitty、Ghostty、WezTerm 与 Warp识别为 `images: "kitty"`；无需项目自行识别终端或输出 escape sequence。
- 项目 `readMediaImage()` 会把 Telegram `.webp` sticker、`.jpg/.jpeg` photo 和 GIF 原样编码，然后直接 `new Tui.Image(base64, mime, ...)`。
- 当前 Pi `renderImage()` 对 Kitty路径固定发送 `f=100`。Kitty官方协议规定 `f=100` payload必须是PNG；JPEG/WebP/GIF原始字节不是合法payload，终端可以静默拒绝。
- Pi TUI文档称 `Image` 支持PNG/JPEG/GIF/WebP，指组件能解析这些文件头和在相应后端使用它们；Pi coding-agent自己的`ToolExecutionComponent`仍会在Kitty路径先调用公开导出的`convertToPng()`，转换完成后才创建`Image`。本插件遗漏了这层native integration pattern。
- 生产媒体缓存与复现吻合：sticker主要是WebP，photo主要是JPEG；因此不仅贴纸，照片也会受影响。

## 目标

继续完全使用当前 Pi 的 capability detection、`convertToPng()` 与 `Tui.Image`：Kitty/Ghostty路径只把PNG交给原生`Image`，转换异步、去重且有界，完成后请求Pi host重绘同一张聊天卡片。其他终端继续遵循Pi自身的native image/fallback行为，不新增任何终端协议hack。

## 非目标

- 不自行拼接 Kitty/iTerm escape sequence，不 fork/patch `../pi`，不复制 Pi terminal-image renderer。
- 不引入 Sharp、Canvas、Sixel、chafa、外部转换进程或新的图像依赖；使用当前 Pi coding-agent公开导出的Photon/WASM转换能力。
- 不承诺视频、`.webm` animated sticker、音频或任意document内联；本需求只覆盖Pi `Image`声明的PNG/JPEG/GIF/WebP静态预览。
- 不实现动画播放。GIF/animated WebP在当前native转换边界显示确定性的静态PNG预览即可。
- 不改变vision识别时机、下载策略、SQLite media schema、IPC payload或provider上下文。

## 需求

- **R1 — Pi能力为唯一权威：** 终端能力只读`@earendil-works/pi-tui`的`getCapabilities()`。`images === "kitty"`时执行格式归一化；iTerm2/unsupported等路径继续交给Pi原生行为，项目不维护第二套terminal allowlist。
- **R2 — Kitty只接收PNG：** PNG可直接进入`Tui.Image`；JPEG/GIF/WebP必须先经`@earendil-works/pi-coding-agent`公开`convertToPng(base64,mime)`成功转换，绝不以`f=100`发送原格式字节。转换后仍由`Tui.Image`拥有尺寸、placement、scroll crop、resize、theme与cleanup。
- **R3 — 异步原位刷新：** render路径不得同步执行WASM转换。首次遇到非PNG时立即保留现有media label/fallback并启动一次promise；成功后只rebuild受影响的native card并调用host `requestRender()`，不append新session entry、不改变scroll/filter/footer。
- **R4 — 去重与有界缓存：** 相同本地媒体revision的并发/重复卡片共享一个in-flight转换；结果使用有界LRU（最多32项、总base64最多32 MiB、单项最多8 MiB）。key至少包含path与file size/mtime，文件替换后不能复用旧PNG。eviction只影响展示缓存，不删磁盘媒体。
- **R5 — 失败退化：** converter不可用、decode失败、输出超限或feed已dispose时不得出现unhandled rejection、无效Kitty payload或无限重试。卡片保留可读media kind/emoji与Pi theme文本fallback；失败状态在同一file revision内记忆，只有revision变化才重试。
- **R6 — 生命周期：** feed detach/restart/session shutdown使旧转换completion失效；迟到promise不能重建已关闭feed或请求悬空TUI。新feed可复用安全的已完成cache，但不能继承旧feed callback。
- **R7 — 安全与边界：** 继续沿用现有1 MiB source read上限、extension-only本地路径与`basename`展示；不把base64、绝对路径、file id、图像字节写入IPC/DB/log/provider。dynamic文本仍sanitize。
- **R8 — 原生组件约束：** 最终可见图像必须由`Tui.Image`创建；项目代码只负责选择/异步准备合法payload与触发host render，不实现尺寸计算、光标移动、图像id、crop或terminal escape。

## 验收标准

- **AC1:** forced Kitty capability + WebP fixture首帧不包含携带WebP的`f=100` sequence；fake converter resolve为PNG后，同一card render包含Pi生成的Kitty image sequence，解码payload有PNG signature，conversion恰好1次。
- **AC2:** JPEG、GIF、WebP分别覆盖转换成功；PNG覆盖0次转换并直接使用。两个相同file revision的消息、vision rebuild、history prepend与width render共享转换结果，不重复调用converter。
- **AC3:** `TERM_PROGRAM=ghostty`/`GHOSTTY_RESOURCES_DIR`由当前Pi检测为Kitty capability的契约有集成断言；项目不出现自建Ghostty/Kitty env判断。forced iTerm2与images-null路径不调用converter，并保持Pi Image/fallback输出。
- **AC4:** converter reject/null、输出超过8 MiB、文件在转换中变更、feed detach后完成各有测试：无unhandled、无无效`f=100`、无重复转换loop；用户仍能看到media kind/emoji或明确fallback。
- **AC5:** 缓存超过32项或32 MiB按LRU淘汰；pending promise有界且同key合并。测试不依赖真实WASM；另有一条使用Pi真实`convertToPng`把仓库WebP fixture转成PNG并验证signature/尺寸。
- **AC6:** `bun test test/tg-extension.test.ts test/tg-engine.test.ts`、`bun run check`、cache golden与`git diff --check`通过；IPC/DB/provider golden不变。
- **AC7:** 真实Pi smoke在可用Kitty或Ghostty/libghostty终端attach含WebP sticker与JPEG photo的feed：两者可见、resize/scroll/vision更新后仍在原卡片、无裸escape/flicker；不支持的`.webm`继续显示文本占位。

## 约束

- Cache impact: **NONE**。纯Pi extension display preparation；system/tool/message/summary grammar、provider-visible bytes、context epoch与LLM/vision调用数不变。
- Token / 成本: 每turn新增0 token、0 provider call。转换只在支持Kitty graphics的本地TUI按唯一media revision发生一次。
- 兼容性: 不改SQLite、IPC、`TimelineItem`或Pi entry data；继续兼容Pi native iTerm2/unsupported fallback。
- 性能: WASM转换异步；source≤1 MiB，cache≤32项/32 MiB、单项≤8 MiB，无render-loop转换。
- 安全 / 隐私: base64只存在本机有界内存，不落日志/session/provider；路径继续只显示basename。

## 例子与边界 case

- `.webp` sticker + Ghostty：Pi判定`kitty`，插件异步转PNG，随后`Tui.Image`输出`f=100`；视觉理解文本仍在图片下方。
- `.jpg` photo + Kitty：同样转PNG，不把JPEG magic bytes伪装成`f=100`。
- `.png` photo + Kitty：直接创建`Tui.Image`，不加载converter。
- `.gif`：显示静态PNG预览；本需求不新增动画timer。
- `.webm` animated sticker：不进入Image converter，保持`[sticker]`/vision文字，不声称支持视频。
- tmux中运行Ghostty：当前Pi把images设为null，项目服从Pi fallback，不绕过宿主的tmux安全决策。

## 可观察性

不新增持久telemetry。测试以converter call count、cache size/bytes、Pi render sequence格式与host render count为证据；转换失败只允许有界、脱敏的UI fallback，不打印图像内容或完整路径。

## 文档影响

实现时修正`docs/architecture.md`媒体内联说明、补`docs/testing.md`的Kitty/Ghostty矩阵，并更新`docs/devlog.md`与`docs/handoff.md`。Pi/Kitty官方参考：<https://github.com/earendil-works/pi/blob/main/packages/tui/README.md>、<https://sw.kovidgoyal.net/kitty/graphics-protocol/>。

## 待决问题

无。实现跟随当前Pi自身`ToolExecutionComponent`的公开`convertToPng`模式；不再为旧Pi或不存在的非PNG Kitty payload写兼容hack。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10w/T10z`
- Commits: 从`Requirement: REQ-UI-0012` git trailer查
