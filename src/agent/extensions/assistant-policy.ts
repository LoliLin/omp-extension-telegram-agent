import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

export const NO_SEND_MARKER = "[no_send]";

function assistantText(message: Extract<AgentMessage, { role: "assistant" }>): string {
	return message.content
		.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
		.map((content) => content.text)
		.join("")
		.trim();
}

/** Keep protocol-required tool/thinking blocks, but never carry unpublished assistant prose. */
export function applyAssistantPersistencePolicy(message: AgentMessage): AgentMessage {
	if (message.role !== "assistant") return message;
	const text = assistantText(message);
	const toolCalls = message.content.filter((content) => content.type === "toolCall");
	if (toolCalls.length === 0) {
		if (text && text !== NO_SEND_MARKER) return { ...message, content: [{ type: "text", text: NO_SEND_MARKER }] };
		return message;
	}
	const protocolContent = message.content.filter((content) => content.type !== "text");
	return protocolContent.length === message.content.length ? message : { ...message, content: protocolContent };
}

/** True when an assistant message carries prose that must not reach the provider. */
export function hasUnpublishedAssistantText(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	if (message.content.some((content) => content.type === "toolCall")) return false;
	const text = assistantText(message);
	return Boolean(text) && text !== NO_SEND_MARKER;
}

/**
 * omp rewrites provider-bound context through the `context` hook (message_end hooks
 * cannot replace messages). Historical unpublished prose is rewritten on every
 * context assembly, so the provider never sees it after a restart either.
 */
export function makeAssistantPersistencePolicyExtension(): ExtensionFactory {
	return (pi) => {
		pi.on("context", (event) => {
			let messages = event.messages;
			for (let index = 0; index < messages.length; index++) {
				const rewritten = applyAssistantPersistencePolicy(messages[index]!);
				if (rewritten === messages[index]) continue;
				if (messages === event.messages) messages = [...messages];
				messages[index] = rewritten;
			}
			return { messages };
		});
	};
}
