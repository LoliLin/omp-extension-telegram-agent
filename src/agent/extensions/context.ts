import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { MessageEventKind } from "../../db/message-events.ts";

export const TELEGRAM_CONTEXT_TYPE = "telegram_context_v2";
export const TELEGRAM_CONTEXT_VERSION = 3;

export interface TelegramContextEventRef {
	ingestSeq: number;
	kind: MessageEventKind;
	chatId: number;
	messageId: number;
	fullMessageVisible: boolean;
}

export interface TelegramContextDetails {
	version: typeof TELEGRAM_CONTEXT_VERSION;
	consumedSeq: number;
	providerText: string;
	stickerCandidates: string;
	visibleMessageIds: number[];
	events: TelegramContextEventRef[];
}

export function isTelegramContextDetails(value: unknown): value is TelegramContextDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as Partial<TelegramContextDetails>;
	return (
		details.version === TELEGRAM_CONTEXT_VERSION &&
		Number.isSafeInteger(details.consumedSeq) &&
		(details.consumedSeq as number) >= 0 &&
		typeof details.providerText === "string" &&
		typeof details.stickerCandidates === "string" &&
		Array.isArray(details.visibleMessageIds) &&
		details.visibleMessageIds.every((id) => Number.isSafeInteger(id) && id > 0) &&
		Array.isArray(details.events) &&
		details.events.every(
			(event) =>
				event != null &&
				Number.isSafeInteger(event.ingestSeq) &&
				event.ingestSeq > 0 &&
				Number.isSafeInteger(event.chatId) &&
				Number.isSafeInteger(event.messageId) &&
				event.messageId > 0 &&
				typeof event.fullMessageVisible === "boolean",
		)
	);
}

/**
 * Keep the provider projection derived from extension-owned structured details. The same bytes are
 * also persisted as content for compaction/debugging, but restored sessions never need to parse
 * rendered Telegram grammar to recover message identities.
 */
export function projectTelegramContext(messages: AgentMessage[]): AgentMessage[] {
	const lastTelegramContext = messages.findLastIndex(
		(message) => message.role === "custom" && message.customType === TELEGRAM_CONTEXT_TYPE,
	);
	return messages.map((message, index) => {
		if (message.role === "toolResult" && message.toolName === "send") {
			const details = message.details as { sent?: unknown; outcome?: unknown } | undefined;
			const sent = Array.isArray(details?.sent)
				? details.sent.filter((id): id is number => Number.isSafeInteger(id) && (id as number) > 0)
				: [];
			if (sent.length > 0) {
				const ack = details?.outcome ? "no_retry" : "ok";
				return {
					...message,
					content: [{ type: "text", text: `${ack} sent_message_ids=${sent.map((id) => `#${id}`).join(",")}` }],
				};
			}
		}
		if (message.role !== "custom" || message.customType !== TELEGRAM_CONTEXT_TYPE) return message;
		if (!isTelegramContextDetails(message.details)) return message;
		const candidates = index === lastTelegramContext ? message.details.stickerCandidates.trim() : "";
		return {
			...message,
			content: candidates ? `${message.details.providerText}\n\n${candidates}` : message.details.providerText,
		};
	});
}

export function makeTelegramContextExtension(): InlineExtension {
	return {
		name: "tg-context",
		hidden: true,
		factory: (pi) => {
			pi.on("context", (event) => ({ messages: projectTelegramContext(event.messages) }));
		},
	};
}
