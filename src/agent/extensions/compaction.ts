import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import { convertToLlm, type ExtensionFactory, type SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const content of message.content) {
		if (content.type !== "text") continue;
		parts.push(content.text);
	}
	return parts.join("");
}

/**
 * omp's serializeConversation drops developer-role messages (custom context),
 * which would starve the summarizer of the Telegram conversation. Render
 * custom context explicitly and let the standard serializer handle the rest.
 */
export function serializeCompactionMessages(messages: AgentMessage[]): string {
	const llm = convertToLlm(messages);
	const contextParts: string[] = [];
	const ordinary = llm.filter((message) => {
		if (message.role !== "developer") return true;
		const text = messageText(message);
		if (text) contextParts.push(`[Context]: ${text}`);
		return false;
	});
	const serialized = serializeConversation(ordinary);
	return [serialized, ...contextParts].filter(Boolean).join("\n\n");
}

export function makeTelegramCompactionExtension(
	handle: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>,
): ExtensionFactory {
	return (pi) => {
		pi.on("session_before_compact", handle);
	};
}
