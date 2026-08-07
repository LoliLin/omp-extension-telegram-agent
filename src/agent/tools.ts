// Tool definitions for the agent. Cache-visible protocol (docs/cache.md):
// name/description/parameters AND the array order are part of the stable provider prefix.
// Any change here must bump CACHE_SCHEMA_VERSION and start a new context epoch;
// test/cache.test.ts locks the schema hash.

import { Type } from "typebox";
import { sha256Short } from "./prompt.ts";

export interface SendParams {
	reply_to?: number;
	sticker?: string;
	message?: string;
}

export interface SearchParams {
	query: string;
}

export interface RunJsParams {
	code: string;
}

/** Fixed tool order — never reorder (cache-visible). */
export const TOOL_DEFS = [
	{
		name: "send",
		label: "Send",
		description:
			"Send a message and/or sticker to the Telegram group. This ends your turn: after send succeeds, no further output is needed. Omit message for a pure sticker, omit sticker when no suitable candidate exists.",
		parameters: Type.Object({
			reply_to: Type.Optional(Type.Number({ description: "Telegram message id (# number) to reply to" })),
			sticker: Type.Optional(Type.String({ description: "Sticker id from the available sticker list" })),
			message: Type.Optional(Type.String({ description: "Text message to send" })),
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

/** Stable hash over tool names + parameter schemas, in registration order (cache-visible). */
export function toolsHash(): string {
	return sha256Short(JSON.stringify(TOOL_DEFS.map((t) => ({ name: t.name, params: t.parameters }))));
}
