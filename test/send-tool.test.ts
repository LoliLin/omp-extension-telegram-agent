import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	agentLoop,
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
	EventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import {
	degradedSendResult,
	SEND_NO_RETRY_ACK,
	SEND_SUCCESS_ACK,
	successfulSendResult,
	TOOL_DEFS,
	toolProtocolHash,
	toolsHash,
	type SendDegradedDetails,
} from "../src/agent/tools.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected stream event");
			},
		);
	}
}

function usage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "send-1", name: "send", arguments: { message: "你好" } }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: usage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function userMessage(): UserMessage {
	return { role: "user", content: "小雨你好", timestamp: Date.now() };
}

describe("send tool contract (REQ-SEND-0001)", () => {
	test("one provider-visible tool owns message, sticker, and reply_to usage", () => {
		expect(TOOL_DEFS.map((tool) => tool.name)).toEqual(["send", "search", "run_js"]);
		expect(Object.keys(TOOL_DEFS[0].parameters.properties)).toEqual(["message", "sticker", "reply_to"]);
		expect(TOOL_DEFS[0].description).toContain("唯一的公开输出通道");
		expect(TOOL_DEFS[0].description).toContain("唯一一次最终 send 调用");
		expect(TOOL_DEFS[0].description).toContain("Markdown");
		const messageSchema = TOOL_DEFS[0].parameters.properties.message as { description?: string; maxLength?: number };
		expect(messageSchema.description).toContain("标题、列表、表格和引用");
		expect(messageSchema.description).toContain("不要使用 HTML 或图片");
		expect(messageSchema.description).toContain("不要为了样式包裹整段粗体");
		expect(messageSchema.maxLength).toBe(4096);
		expect((TOOL_DEFS[0].parameters.properties.reply_to as { description?: string }).description).toContain("当前可见消息行");
		expect((TOOL_DEFS[0].parameters.properties.sticker as { description?: string }).description).toContain("Sticker 目录");
	});

	test("personas and shared protocol do not duplicate send invocation syntax", () => {
		for (const path of ["personas/template.zh.md", "personas/template.en.md"]) {
			const persona = readFileSync(path, "utf8");
			expect(persona).not.toMatch(/send\s*\(/);
			expect(persona).not.toContain("reply_to");
			expect(persona).not.toContain("messaging.reply_not_visible");
			expect(persona).not.toContain("Telegram 的 `send`");
			expect(persona).not.toContain("sendRichMessage");
			expect(persona).not.toContain("Rich Markdown");
		}
		const protocol = buildSystemPrompt("test persona");
		expect(protocol).not.toMatch(/send\s*\(/);
		expect(protocol).not.toContain("reply_to");
		expect(protocol).not.toContain("sendRichMessage");
		expect(protocol).not.toContain("Rich Markdown");
	});

	test("tool protocol hash includes description-only changes", () => {
		const changed = TOOL_DEFS.map((tool, index) => ({
			name: tool.name,
			description: index === 0 ? `${tool.description} changed` : tool.description,
			parameters: tool.parameters,
		}));
		expect(toolProtocolHash(changed)).not.toBe(toolsHash());
	});

	test("terminating minimal ACK stops the agent after one provider call", async () => {
		const definition = TOOL_DEFS[0];
		const tool: AgentTool<typeof definition.parameters, { sent: number[] }> = {
			...definition,
			execute: async () => successfulSendResult([9001]),
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role)) as Message[],
		};
		let providerCalls = 0;
		const stream = agentLoop([userMessage()], context, config, undefined, () => {
			providerCalls++;
			const response = new MockAssistantStream();
			queueMicrotask(() => response.push({ type: "done", reason: "toolUse", message: assistantToolCall() }));
			return response;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();
		const result = messages.find((message) => message.role === "toolResult");

		expect(providerCalls).toBe(1);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
		expect(result?.role === "toolResult" ? result.content : null).toEqual([{ type: "text", text: SEND_SUCCESS_ACK }]);
		expect(result?.role === "toolResult" ? result.details : null).toEqual({ sent: [9001] });
		expect(JSON.stringify(result?.role === "toolResult" ? result.content : null)).not.toContain("9001");
	});

	test("a degraded no-retry result also stops after one provider call", async () => {
		const definition = TOOL_DEFS[0];
		const tool: AgentTool<typeof definition.parameters, SendDegradedDetails> = {
			...definition,
			execute: async () => degradedSendResult({
				sent: [],
				outcome: "unknown",
				failed_component: "message",
				failed_outcome: "unknown",
				stage: "telegram_create",
				category: "timeout",
			}),
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages: AgentMessage[]) =>
				messages.filter((message) => ["user", "assistant", "toolResult"].includes(message.role)) as Message[],
		};
		let providerCalls = 0;
		const stream = agentLoop([userMessage()], context, config, undefined, () => {
			providerCalls++;
			const response = new MockAssistantStream();
			queueMicrotask(() => response.push({ type: "done", reason: "toolUse", message: assistantToolCall() }));
			return response;
		});

		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);
		const messages = await stream.result();
		const result = messages.find((message) => message.role === "toolResult");

		expect(providerCalls).toBe(1);
		expect(events.filter((event) => event.type === "turn_end")).toHaveLength(1);
		expect(result?.role === "toolResult" ? result.content : null).toEqual([{ type: "text", text: SEND_NO_RETRY_ACK }]);
		expect(result?.role === "toolResult" ? result.details : null).toMatchObject({ outcome: "unknown", category: "timeout" });
	});
});
