// System prompt assembly. This is cache-visible protocol (docs/cache.md).
// Any change here => bump CACHE_SCHEMA_VERSION and start a new context epoch.

import { createHash } from "node:crypto";

export const CACHE_SCHEMA_VERSION = 1;

// Fixed shared protocol block, appended after the persona. Never reorder.
const PROTOCOL = `
---

# 群聊协议

你在一个 Telegram 群里。群消息按时间顺序以如下格式出现在对话里：

[HH:mm:ss] #<消息id> 名字 (@username 或 u<N> 别名 · bot · tag:<标签>): 内容

- ↪ #<id> 表示该消息回复了某条消息；后面可能带一小段被引用消息的参考文字
- quote="..." 表示发送者明确引用的原文片段
- 日期变化时会插入 --- YYYY-MM-DD --- 分隔行
- [图片]、[sticker ...] 等是媒体占位符

规则：

- 你可以保持沉默：不调用 send，本轮就不会有任何内容进群。你的普通输出只有本地观察者看得到
- 想发言就在本轮调用一次 send({message?, reply_to?, sticker?})。reply_to 只能使用上下文中真实出现过的 # 数字 id
- 群里还有另一个 AI bot（你的姐妹），她的消息你能看到，但不要替她说话，也不要回复她的消息
`;

export function buildSystemPrompt(personaText: string): string {
	return `${personaText.trim()}\n${PROTOCOL}`;
}

/**
 * Chat-oriented compaction summary prompt (state, not replay). Part of the cache-visible
 * protocol: the summary grammar lives at the boundary of a new epoch, so its prompt is
 * hashed by the golden test (REQ-TEST-0001 R2).
 */
export const COMPACTION_SUMMARY_PROMPT = `你在为一个长期住在 Telegram 群里的 AI 群友压缩记忆。把被压缩的群聊历史总结成"状态"而不是逐条复述，供它之后延续人设和上下文。

保留：
- 重要人物关系、称呼和互动模式
- 已知稳定事实和长期话题
- 正在讨论的问题、结论和争议点
- 承诺和未解决事项
- 必要的消息引用（#消息id）
- 这个人设真正会关心的信息

输出中文，分段，直接给摘要正文，控制在 800 字以内。`;

export function sha256Short(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}
