// Shared Telegram send -> canonical DB transaction used by agent tools and operator IPC.

import type { Database } from "bun:sqlite";
import { TelegramApiError } from "./api.ts";
import { insertSentMessage } from "./ingest.ts";
import type { CanonicalMessage } from "./normalize.ts";

export interface TextSendApi {
	sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<Record<string, unknown>>;
}

export interface RichTextSendApi extends TextSendApi {
	sendRichMessage(chatId: number, markdown: string, replyToMessageId?: number): Promise<Record<string, unknown>>;
}

export class SentMessagePersistenceError extends Error {
	constructor(public readonly cause: unknown) {
		super("Telegram accepted the message but canonical persistence failed");
		this.name = "SentMessagePersistenceError";
	}
}

export async function sendTextAndPersist(
	db: Database,
	api: TextSendApi,
	botId: string,
	chatId: number,
	text: string,
	replyToMessageId?: number,
): Promise<{ raw: Record<string, unknown>; canonical: CanonicalMessage }> {
	const raw = await api.sendMessage(chatId, text, replyToMessageId);
	try {
		return { raw, canonical: insertSentMessage(db, botId, raw) };
	} catch (error) {
		throw new SentMessagePersistenceError(error);
	}
}

/**
 * True only when Telegram has deterministically rejected the rich request before
 * creating a message. Unknown outcomes must never be retried as plain text.
 */
export function isDeterministicRichRejection(error: unknown): error is TelegramApiError {
	if (!(error instanceof TelegramApiError)) return false;
	const description = error.description.toLowerCase();
	if (description.includes("non-json")) return false;
	if (error.code === 404) {
		return description === "not found"
			|| description.includes("method not found")
			|| description.includes("sendrichmessage");
	}
	if (error.code !== 400) return false;
	return description.includes("can't parse")
		|| description.includes("cannot parse")
		|| description.includes("failed to parse")
		|| description.includes("parse error")
		|| description.includes("unsupported start tag")
		|| description.includes("rich message is not supported")
		|| description.includes("rich messages are not supported");
}

/** Agent rich send with one safe literal fallback and exactly-once persistence. */
export async function sendRichTextAndPersist(
	db: Database,
	api: RichTextSendApi,
	botId: string,
	chatId: number,
	markdown: string,
	replyToMessageId?: number,
): Promise<{
	raw: Record<string, unknown>;
	canonical: CanonicalMessage;
	transport: "rich" | "plain_fallback";
}> {
	let raw: Record<string, unknown>;
	let transport: "rich" | "plain_fallback" = "rich";
	try {
		raw = await api.sendRichMessage(chatId, markdown, replyToMessageId);
	} catch (error) {
		if (!isDeterministicRichRejection(error)) throw error;
		transport = "plain_fallback";
		raw = await api.sendMessage(chatId, markdown, replyToMessageId);
	}
	try {
		return { raw, canonical: insertSentMessage(db, botId, raw), transport };
	} catch (error) {
		throw new SentMessagePersistenceError(error);
	}
}
