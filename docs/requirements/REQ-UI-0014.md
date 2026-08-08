# REQ-UI-0014: 群友照片不依赖 vision 即时进入 Pi 原生卡片

- **Status:** Implemented（2026-08-08；unit/full/typecheck/cache验证通过，真实群新photo smoke留T14后再勾选）
- **Priority:** P1
- **Source:** 用户新增 REQ-LIST：「群友发的图片不展示」
- **依赖:** REQ-UI-0001、REQ-UI-0006、REQ-UI-0012、REQ-UI-0013

## 问题

Telegram photo已被normalize、入库并在卡片显示`[photo]`，但`media.local_path`只在某只bot的provider batch触发`ensureVision()`时写入。若该消息未抽中bot、目标busy/cooldown或模型尚未需要它，Pi收到的`MsgItem.mediaPath=null`，因此原生`Image`没有任何字节可渲染。

只读生产统计验证了该路径：97条photo identity中仍有8条`local_path`为空；已缓存photo均存在且最大约553 KiB，低于既有1 MiB TUI source guard。问题位于下载时机，不是Pi Image、Kitty PNG转换或photo尺寸配置。

## 调查结论

- Telegram `getFile`返回短期有效`file_path`，官方Bot API download上限当前为20 MB；`file_id`是per-bot，项目已有`media_file_ids`映射，不能拿`file_unique_id`直接下载。
- Poller offset与canonical message已在`onMessage`前durable commit。媒体下载属于可失败side effect，不能反过来卡住offset或回滚消息。
- snapshot/history已经从`media.local_path`读取最终值；live card缺少的是下载完成后的additive identity通知。
- Pi显示层已有1 MiB source guard、异步`convertToPng`、LRU和原位card rebuild。修复应只把本地path及时送进这条现有链。
- 实现后photo precache与provider vision共用同一个按DB/media identity合并的Telegram download promise；≤1 MiB静态文件用hash basename、0600临时文件与同目录rename安装。因而UI与vision并发也只下载一次，且媒体身份不出现在缓存文件名。
- daemon在placeholder broadcast之后才调用非阻塞queue；启动只取`media.rowid`最新100条missing photo。queue固定最多2 active、128 pending，stop会abort自己的网络请求并在每个await边界拒绝迟到DB/IPC写入。

官方参考：<https://core.telegram.org/bots/api#getfile>。

## 目标

任何新入库的静态Telegram photo在不触发LLM/vision的情况下由后台有界下载器写入本地cache；当前Pi feed收到完成通知后更新同一卡片并继续完全交给Pi原生`Image`渲染。daemon重启可补齐最近遗留的未下载photo。

## 非目标

- 不为了UI调用辅助视觉模型，不改变视觉描述时机或prompt。
- 不内联video/audio/document/animation，不播放动画。
- 不绕过Pi 1 MiB source guard、capability detection或PNG converter。
- 不把图片字节/base64放进SQLite、IPC、日志、Pi session或provider context。

## 需求

- **R1 — durable-first：** canonical ingest和offset成功后才调度photo下载；download失败不得重放update、阻塞poller、改变routing或删除message。
- **R2 — 有界本地cache：** 按`file_unique_id`去重in-flight，使用收到该媒体的bot对应`file_id`调用`getFile/downloadFile`。只接受PNG/JPEG/WebP/GIF静态扩展与≤1 MiB字节；同目录临时文件+rename原子安装，mode 0600。
- **R3 — 队列与恢复：** live队列去重、最多128 pending、并发≤2；overflow只留下DB missing状态。启动后按最新rowid最多补齐100条`kind=photo AND local_path IS NULL`，后续重启继续，不无界扫库或阻塞ready。
- **R4 — additive IPC：** 下载完成发布`media_ready {fileUniqueId, mediaPath}`。旧client忽略未知frame；新timeline以有界identity cache处理update-before-message，给所有匹配卡片补path，不追加timeline/Pi session entry。
- **R5 — Pi原位显示：** feed只重建匹配slot并请求host render；JPEG/WebP/GIF仍走UI-0012的Pi `convertToPng`，PNG直接走`Tui.Image`，photo继续使用UI-0013尺寸。
- **R6 — vision复用：** `ensureVision()`优先复用合法`local_path`，不得对已经precache的photo再次`getFile/downloadFile`；视觉描述仍在provider提交前按既有同步边界完成。
- **R7 — 失败与生命周期：** 401/404/timeout/oversize/坏扩展/写盘失败只做有界脱敏诊断并保持`[photo]`fallback；queue stop后不启动新任务，shutdown有界等待active任务，不能在DB close后写入。
- **R8 — 隐私：** IPC path仅走现有owner-only Unix socket；UI只显示media label，不显示绝对path。日志不含token、file_id、图片内容或完整path。

## 验收标准

- **AC1:** fake Poller/queue：一条最终route为nobody的photo先broadcast可读placeholder，随后恰好一次download、原子local_path与`media_ready`，同一Pi卡片出现原生Image且entry数不变。
- **AC2:** 两bot看到同一`file_unique_id`、重复schedule与并发vision只产生一次有效文件；vision复用path且describe仍只一次。
- **AC3:** restart fixture预置missing photo，backfill完成后snapshot直接含path；101+ missing只调度最新100，队列/并发边界可观察。
- **AC4:** media_ready先于append、晚于append、重复、同identity多消息、history page与disconnect都有回归；cache数量/TTL有界。
- **AC5:** oversize、unsupported extension、getFile缺path、download/write/rename失败与shutdown时无unhandled、无partial target、offset/message仍durable、卡片保留fallback。
- **AC6:** Pi forced Kitty/iTerm2/null路径继续使用既有converter/Image/fallback测试；生产extension不增加terminal protocol或自绘renderer。
- **AC7:** targeted、全量、typecheck、cache golden和真实群新photo smoke通过；真实smoke记录local path是否出现与同card render，不保存/贴出私人图片。

## 约束

- Cache impact: **NONE**。下载与`media_ready`只在SQLite local cache/owner-only IPC/Pi TUI side channel；provider bytes、vision调用、context epoch和每turn token不变。
- 兼容性: SQLite列不变；IPC只新增可忽略frame。旧daemon/client组合继续显示placeholder或snapshot缓存。
- 性能: 网络并发2、pending128、startup batch100、source≤1 MiB；不得同步阻塞poller、daemon ready或render。
- 数据: 只写`data/media`与既有`media.local_path`，target原子安装；不删除已有cache。
- 安全 / 隐私: data仍Git ignored，文件0600，socket0600，不输出媒体标识或内容。

## 例子与边界 case

- 普通群友发JPEG但两bot都在cooldown：消息立即入库/显示label，下载完成后原卡片出现photo；没有LLM call。
- 同一photo由第二只bot的duplicate update看到：补充per-bot mapping，但不下载第二份。
- 1.2 MiB photo：保留`[photo]`与未来vision文字，不绕过现有TUI内存边界。

## 可观察性

只记录`media_cache_ready/skip/error`类别、kind、bytes bucket与queue depth；不得记录file id/path/content。测试以download count、文件mode、IPC frame和Pi entry/render count为证据。

## 文档影响

实现时更新architecture的media pipeline、IPC注释、data model的`local_path`语义、双语troubleshooting、testing、devlog/handoff。

## 待决问题

无。若未来要显示>1 MiB photo，应另行设计downsample/内存预算，不能顺手抬高guard。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T13g/T13l`
- Commits: 从 `Requirement: REQ-UI-0014` git trailer查；真实behavior hash在T14 completion record写入
