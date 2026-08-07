// Trigger routing: decide which bot (if any) gets a response opportunity.
// Phase 3: explicit mention / reply only. Phase 5 adds name keywords + deterministic probability.

import type { Database } from "bun:sqlite";
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
