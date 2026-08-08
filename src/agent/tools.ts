// Tool definitions for the agent. Cache-visible protocol (docs/cache.md):
// name/description/parameters AND the array order are part of the stable provider prefix.
// Any change here must bump CACHE_SCHEMA_VERSION and start a new context epoch;
// test/cache.test.ts locks the schema hash.

import { Type } from "typebox";
import { sha256Short } from "./prompt.ts";

export interface SendParams {
	message?: string;
	sticker?: string;
	reply_to?: number;
}

export interface SearchParams {
	query: string;
}

export interface RunJsParams {
	code: string;
}

export const SEND_SUCCESS_ACK = "ok";

/** Fixed tool order — never reorder (cache-visible). */
export const TOOL_DEFS = [
	{
		name: "send",
		label: "Send",
		description:
			"Telegram 群唯一的公开输出通道。人类 @你、回复你或用配置名称点名时必须公开回应；其他场景可按人设沉默。先完成搜索或计算，再把文字、贴纸和引用合并成唯一一次最终 send 调用，不能拆开发送。message 或 sticker 至少填一个；成功会立即结束本轮，不要再输出或调用工具。普通 Assistant 文本只在本地可见。",
		parameters: Type.Object({
			message: Type.Optional(Type.String({ description: "发到群里的文字；可与 sticker 和 reply_to 合并。仅发贴纸时省略。" })),
			sticker: Type.Optional(
				Type.String({ description: "可选贴纸；只能填 Sticker 目录或 Available stickers 中真实出现的 id，不得编造。" }),
			),
			reply_to: Type.Optional(
				Type.Number({
					description:
						"直接回应某条消息时填当前可见消息行 # 后的数字 id；不得猜测或使用引用片段中的旧 id。主动发言时省略。",
				}),
			),
		}),
	},
	{
		name: "search",
		label: "Search",
		description:
			"Search the web (TinyFish). Returns up to 5 results with title, url and a short snippet. Use when you need external facts or current information.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
		}),
	},
	{
		name: "run_js",
		label: "Run JS",
		description:
			"Run small pure-computation JavaScript (calculation, JSON, regex, transforms). Sandboxed: no filesystem, network, process or environment access. console.log output and the final expression value are returned. 3s limit.",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript source; the value of the last expression is returned" }),
		}),
	},
] as const;

interface ProviderToolProtocol {
	name: string;
	description: string;
	parameters: unknown;
}

/** Hash every provider-visible field in registration order; labels stay local-only. */
export function toolProtocolHash(definitions: readonly ProviderToolProtocol[]): string {
	return sha256Short(
		JSON.stringify(definitions.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))),
	);
}

/** Stable hash over the complete provider-visible tool protocol. */
export function toolsHash(): string {
	return toolProtocolHash(TOOL_DEFS);
}

/** Pi requires a structural tool result; a constant one-token ACK is cheaper than dynamic ids. */
export function successfulSendResult(sent: number[]) {
	return {
		content: [{ type: "text" as const, text: SEND_SUCCESS_ACK }],
		details: { sent },
		terminate: true as const,
	};
}
