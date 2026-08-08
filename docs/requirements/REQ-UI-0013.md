# REQ-UI-0013: Pi 原生 sticker 卡片使用紧凑尺寸

- **Status:** Done（2026-08-08；implementation `533c9ec`，多宽度fixture与真实Pi原生媒体卡片已验收）
- **Priority:** P2
- **Source:** 用户在 `REQ-LIST` 新增：「sticker渲染有点太大」
- **依赖:** REQ-UI-0001、REQ-UI-0011、REQ-UI-0012

## 问题

当前 `itemComponent()` 给所有媒体同一组 Pi `Image` 上限：`maxWidthCells: 56`、`maxHeightCells: 16`。生产缓存里绝大多数 sticker 是接近方形的 512×512；按 Pi 常见 9×18 cell 比例，height 16 会得到约32列×16行的贴纸。它在80列聊天流中占据约40%宽度和16行高度，视觉权重接近照片，连续贴纸会明显挤压消息阅读。

照片需要保留细节，不能为了修贴纸一起缩小。Pi 已公开 `ImageOptions.maxWidthCells/maxHeightCells` 并保持宽度 invariant、等比缩放、Kitty/Ghostty scroll crop与fallback；项目只需按media kind选择上限，无需自写缩放或布局。

## 目标

sticker 在原生聊天卡片中使用紧凑的24列×12行上限；photo等现有静态图片继续使用56列×16行。两者仍由同一个 Pi `Image` 组件处理比例、终端宽度、placement、resize与fallback。

## 非目标

- 不改变下载文件、图片分辨率、PNG转换cache或vision输入。
- 不裁剪、拉伸、重编码sticker，不实现用户可调大小。
- 不缩小photo，不调整header、正文、media label或vision文案。
- 不增加容器、边框、动画、自绘escape或第三方图像依赖。

## 需求

- **R1 — 按媒体语义分层：** `mediaKind === "sticker"`使用`maxWidthCells: 24`与`maxHeightCells: 12`；其他可内联图片保留`56×16`。
- **R2 — Pi 单一布局权威：** 只通过`Tui.Image`公开options表达上限；实际比例、窄终端clamp、cell尺寸、Kitty/Ghostty crop与iTerm/fallback继续由Pi负责。
- **R3 — 全路径一致：** PNG直通和Kitty异步转PNG得到同一sticker bounds；首次转换fallback、完成原位刷新、vision update、history prepend与restart cache reuse不能恢复旧尺寸。
- **R4 — 内容稳定：** sticker emoji/kind label和vision说明保持可见，message/header/scroll/filter/footer/session entry不变；photo现有尺寸不回归。
- **R5 — 零数据/成本影响：** 不改SQLite、IPC、provider serialization、cache schema、vision/LLM调用或每turn token。

## 验收标准

- **AC1:** forced Kitty下方形PNG sticker的Pi wire placement为`c=24,r=12`，同一fixture作为photo仍为现有`c=32,r=16`（受16行上限与cell aspect ratio约束）。
- **AC2:** Kitty WebP首帧仍只有label，转换完成后的同一卡片使用sticker bounds；converter调用数与UI-0012去重不变。
- **AC3:** 40/80/120列render均不超过宿主宽度，sticker label/emoji与vision文字仍存在；没有production terminal escape或自定义尺寸计算。
- **AC4:** `bun test test/tg-extension.test.ts test/tg-engine.test.ts`、`bun run check`、cache golden与diff check通过；真实Pi Kitty/Ghostty smoke并入T14。

## 约束

- Cache impact: **NONE**。纯TUI `ImageOptions`差异，provider-visible bytes与context epoch不变。
- 视觉密度: sticker是聊天中的辅助表达，24×12使方形资源比当前32×16线性缩小25%，仍足以辨认；photo保留现状。
- 响应式: 上限不是固定占位，Pi仍按实际terminal/component width向下收缩。

## 待决问题

无。若以后需要用户可调尺寸，另立需求；本次采用一个稳定、可回归的sticker语义上限。

## 追溯

- Plans: `PLAN-20260808-complete-new-reqs#T10ab/T10ac/T10ad`
- Commits: implementation `533c9ec`；其余从`Requirement: REQ-UI-0013` git trailer查
