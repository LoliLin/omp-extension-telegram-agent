// Shared Telegram send -> canonical DB transaction used by agent tools and operator IPC.

import type { Database } from "bun:sqlite";
import { insertSentMessage } from "./ingest.ts";
import type { CanonicalMessage } from "./normalize.ts";

export interface TextSendApi {
	sendMessage(chatId: number, text: string, replyToMessageId?: number): Promise<Record<string, unknown>>;
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
