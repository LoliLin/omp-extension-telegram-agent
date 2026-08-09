import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	convertToLlm,
	serializeConversation,
	type CompactionResult,
	type InlineExtension,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

type SessionBeforeCompactResult = { cancel?: boolean; compaction?: CompactionResult };

export function serializeCompactionMessages(messages: AgentMessage[]): string {
	return serializeConversation(convertToLlm(messages));
}

export function makeTelegramCompactionExtension(
	handle: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>,
): InlineExtension {
	return {
		name: "tg-compaction",
		hidden: true,
		factory: (pi) => {
			pi.on("session_before_compact", handle);
		},
	};
}
