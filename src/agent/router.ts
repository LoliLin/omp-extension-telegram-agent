// Trigger routing: decide which bot (if any) gets a response opportunity.
// Priority: explicit @mention > reply to bot > name keyword > deterministic probability.
// Probability routing uses one shared HMAC value per message (restart/replay/duplicate-safe).

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import type { MessageRow } from "./serialize.ts";

export type TriggerTarget = "A" | "B" | "nobody";

export interface BotIdentity {
	id: "A" | "B";
	userId: number;
	username: string;
	name: string;
}

interface TgEntity {
	type: string;
	offset: number;
	length: number;
	user?: { id: number };
}

/** Explicit mention (@username entity, text_mention, or reply to the bot's message). */
export function explicitTrigger(db: Database, row: MessageRow, bot: BotIdentity): boolean {
	if (row.entities) {
		const entities = JSON.parse(row.entities) as TgEntity[];
		for (const e of entities) {
			if (e.type === "mention" && row.text) {
				const mentioned = row.text.slice(e.offset, e.offset + e.length).toLowerCase();
				if (mentioned === `@${bot.username.toLowerCase()}`) return true;
			}
			if (e.type === "text_mention" && e.user?.id === bot.userId) return true;
		}
	}
	if (row.reply_to_message_id != null) {
		const parent = db
			.query("SELECT sender_id FROM messages WHERE chat_id = ? AND message_id = ?")
			.get(row.chat_id, row.reply_to_message_id) as { sender_id: number | null } | null;
		if (parent?.sender_id === bot.userId) return true;
	}
	return false;
}

/** Bot's configured name appears in the message text (e.g. "小雪你怎么看"). */
export function nameKeywordTrigger(row: MessageRow, bot: BotIdentity): boolean {
	const text = row.text ?? row.caption;
	if (!text) return false;
	return text.includes(bot.name);
}

/** Shared deterministic value in [0, 1) for a message. */
export function routingValue(secret: string, chatId: number, messageId: number): number {
	const digest = createHmac("sha256", secret).update(`${chatId}:${messageId}`).digest();
	// first 6 bytes -> [0, 1)
	return digest.readUIntBE(0, 6) / 2 ** 48;
}

export interface RoutingConfig {
	secret: string;
	pA: number; // probability for bot A
	pB: number; // probability for bot B
}

/** Full routing decision for one group message. */
export function routeMessage(db: Database, row: MessageRow, bots: [BotIdentity, BotIdentity], config: RoutingConfig): TriggerTarget {
	// Bot messages are observed history, never triggers — single authority point (REQ-TEST-0001
	// R3): a caller forgetting the is_bot pre-check cannot introduce bot↔bot trigger loops.
	if (row.is_bot) return "nobody";
	for (const bot of bots) {
		if (explicitTrigger(db, row, bot)) return bot.id;
	}
	for (const bot of bots) {
		if (nameKeywordTrigger(row, bot)) return bot.id;
	}
	const u = routingValue(config.secret, row.chat_id, row.message_id);
	if (u < config.pA) return "A";
	if (u < config.pA + config.pB) return "B";
	return "nobody";
}
