// Durable direct-reply delivery obligations. The provider sees only the normal
// canonical message suffix; this table is deterministic scheduling state.

import type { Database } from "bun:sqlite";

export interface ReplyObligation {
	chatId: number;
	messageId: number;
}

export function createReplyObligation(db: Database, botId: string, chatId: number, messageId: number): boolean {
	const result = db
		.query("INSERT OR IGNORE INTO reply_obligations (bot_id, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)")
		.run(botId, chatId, messageId, Date.now());
	return result.changes > 0;
}

/** Pending rows in Telegram chronology; an obligation without a message cannot enter context. */
export function listReplyObligations(db: Database, botId: string, chatId: number, limit = 64): ReplyObligation[] {
	return db
		.query(
			`SELECT o.chat_id AS chatId, o.message_id AS messageId
			   FROM reply_obligations o
			   JOIN messages m ON m.chat_id = o.chat_id AND m.message_id = o.message_id
			  WHERE o.bot_id = ? AND o.chat_id = ?
			  ORDER BY m.date, m.message_id
			  LIMIT ?`,
		)
		.all(botId, chatId, Math.max(1, Math.floor(limit))) as ReplyObligation[];
}

export function removeReplyObligations(db: Database, botId: string, obligations: readonly ReplyObligation[]): void {
	if (obligations.length === 0) return;
	const remove = db.query("DELETE FROM reply_obligations WHERE bot_id = ? AND chat_id = ? AND message_id = ?");
	const transaction = db.transaction(() => {
		for (const obligation of obligations) remove.run(botId, obligation.chatId, obligation.messageId);
	});
	transaction();
}

export function replyObligationCount(db: Database, botId: string, chatId: number): number {
	const row = db
		.query("SELECT COUNT(*) AS count FROM reply_obligations WHERE bot_id = ? AND chat_id = ?")
		.get(botId, chatId) as { count: number };
	return row.count;
}
