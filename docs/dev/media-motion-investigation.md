# 动态贴纸、视频视觉与媒体回收调查

> 适用范围：`docs/dev/req.md` 在 2026-08-09 提出的动态媒体需求。本文记录开发前的证据、设计边界和验收标准；实现完成后的稳定行为分别以 `docs/architecture.md`、`docs/cache.md` 与 `docs/data-model.md` 为准。

## 结论

1. Telegram Bot API 的 `sendSticker` 原生接受静态 `.WEBP`、animated `.TGS` 与 video `.WEBM` sticker。当前发送路径已经复用 bot 对应的 `file_id`，不存在静态格式限制；缺口是入库和 catalog 丢弃了 `is_animated` / `is_video`，模型无法知道哪些 short id 是动态贴纸。
2. Pi vision 一次请求可以携带多个 image content block。视频无需逐帧调用模型：本地用 `ffprobe` 读取时长、用 `ffmpeg` 取最多三张 JPEG，再在一次 vision 请求中按时间顺序提交。
3. `media.local_path` 是可再生的本地 cache，不是业务事实。成功 compaction 已经原子替换 `bot_visible_messages`，因此同一 commit boundary 后可以删除没有活跃引用的文件，同时保留 canonical message、媒体 identity、bot-specific `file_id` 与已有 `vision`。

## 产品边界

### 动态 sticker 发送

固定 sticker catalog 与最近上下文候选 MUST 标出 `static`、`animated` 或 `video`：

- `is_animated = true` → `animated` / `application/x-tgsticker`
- `is_video = true` → `video` / `video/webm`
- 其余 → `static` / `image/webp`

发送仍只接受已入库、且当前 bot 拥有 `media_file_ids` mapping 的 short id。运行时 MUST 把原始 Telegram `file_id` 交给同一个 bot 的 `sendSticker`；不得下载后重新上传，也不得把 A bot 的 `file_id` 交给 B bot。

Animated TGS 在本需求中保证可发送，不做视觉渲染。Video WEBM sticker 同时属于可抽帧视频，可以得到视觉描述。Telegram 普通 static sticker 保持现有图片视觉链路。

### 视频识别

以下输入进入视频视觉准备：

- Telegram `video`
- Telegram `animation`
- Telegram `video_note`
- MIME 以 `video/` 开头的 `document`
- `is_video = true` 的 sticker

原始文件下载仍使用 Telegram 的 bot-specific mapping，并受 20 MiB 下载上限约束。每个媒体 identity 最多取三帧；极短视频 MAY 减少帧数。位置算法 MUST：

1. 用 `file_unique_id` 派生固定伪随机序列；同一媒体在重试、重启和不同 bot 中得到相同位置。
2. 从截断到 `[0.05, 0.95]` 的正态分布采样，均值为 `0.5`，因此中间附近概率最高，首尾仍有较小机会。
3. 去除过近位置并升序提交，使模型看到稳定的时间方向。

`ffprobe` 与 `ffmpeg` 通过无 shell 的 argv 调用；frame 写入 0600 临时目录并在请求结束后删除。所有帧在**一次** Pi vision call 中发送，结果继续按 `file_unique_id` 持久化并跨 bot singleflight。日志和 telemetry 只记录 kind、帧数、字节 bucket、耗时、usage、cost 与固定 outcome，不记录 identity、路径、命令 stderr、prompt 或描述正文。

主机缺少任一工具时，daemon 仍可启动，图片 vision 仍可用；视频结果返回确定性 fallback，startup log 与 `bun run debug` MUST 给出固定的 `video_transcoder_unavailable` finding。这个准备失败不得写成永久 terminal vision cache，安装工具后可重试。

### Compaction 后媒体回收

每次成功 compaction 替换 visibility 后，daemon 运行一次有界回收。一个本地媒体文件只要满足以下任一条件就仍被引用：

- 它所属消息在任一**当前配置 bot** 的当前 epoch `bot_visible_messages` 中；
- 消息的初始 event 尚未被任一当前配置 bot cursor 消费；
- 未完成的 direct-reply obligation 引用该消息。

其余 `local_path` 可删除。回收 MUST 先验证 basename 解析后仍位于当前 `data/media`，再删除文件，最后把 `media.local_path` 置空；文件不存在时清理 stale DB path；其他 unlink 失败则保留 DB path，供下次重试。每次最多处理固定批量，observer 失败不得改变 compaction 成功结果。

回收只删除 cache file，不删除：

- `messages` / `message_events` / revisions
- `media` identity、short id、format metadata 或已有 `vision`
- `media_file_ids`
- Pi session 与 compaction summary

因此未来 edit、reply 或重新进入上下文时仍可按 mapping 下载，已有视觉描述也无需再次付费。

## Cache 与成本

Sticker format 会进入固定 catalog block、最近候选 block 和 `send` tool description，是有意的 provider-visible 改动：实现 MUST bump `CACHE_SCHEMA_VERSION`，更新 cache golden 与 `docs/cache.md`。部署后每个 bot 会开启一次新 epoch；旧 session 文件保留。

视频视觉复用既有 append-only `media_update` grammar，不改写已存在 prefix。每个新视频最多新增一次 vision provider call，最多三张经过尺寸限制的 JPEG 共用该调用；persistent cache hit、跨 bot concurrent hit 与 TUI 展示均不增加 provider 调用。TGS 发送与媒体回收新增 provider 调用为 0。

## Debug impact

- 成功：`vision` telemetry 能区分视频并记录 `frames`；compaction 后 `media_cache` 聚合日志只记录 scanned/deleted/stale/failed 数量。
- 合法 no-op：没有可回收 path、所有媒体仍被引用、vision cache hit、非视频 document、TGS 无视觉渲染。
- 降级：工具缺失是 `video_transcoder_unavailable`；probe、抽帧、下载与预算失败继续使用固定 category/outcome，不泄露 stderr 或 path。
- Compaction authority 仍是 structured retained details 与 `bot_visible_messages`；媒体回收是其后的可再生 cache observer，不得回滚或污染业务 cursor。

## 验收标准

1. catalog 同时包含 static、animated、video sticker 时，prompt 标注格式；三者都能解析为当前 bot 的原始 `file_id` 并调用一次 `sendSticker`。
2. 视频位置采样可重复、在 `[5%, 95%]` 内、升序且统计上中间区间多于边缘；一次 executor 输入包含最多三帧而不是三次 provider call。
3. A/B bot 并发识别同一视频只下载/抽帧/调用 provider 一次，后续命中 persistent `media.vision`。
4. 成功 compaction 后，仅当前 bot 已不可见但仍被另一当前 bot 看见的媒体不删除；未消费和待回复媒体不删除；真正无引用文件删除且 DB path 清空。
5. `ffmpeg` / `ffprobe` 缺失时 daemon 与 static image vision 正常，debug 明确报告视频能力不可用。
6. 目标测试和完整 `bun test`、`bun run check`、`bun run lint`、`bun run docs:check` 全部通过后才推送和部署。

## 开发与提交顺序

1. Sticker format metadata、catalog/tool contract、cache schema migration与发送回归测试。
2. 视频 normalization、source cache、正态抽帧、multi-image vision与 transcoder diagnostic。
3. Compaction 后引用判定、cache unlink observer与回归测试。
4. 完整验证、推送、生产安装 `ffmpeg`、拉取、重启和只读健康检查。
