// Ingestion: raw update -> raw_updates -> canonical messages. Idempotent.
// See docs/data-model.md for dedupe rules.

import type { Database } from "bun:sqlite";
import { extractUpdateMessage, isTargetChat, normalizeMessage, type CanonicalMessage } from "../telegram/normalize.ts";

export interface IngestResult {
	kind: "inserted" | "edited" | "duplicate" | "ignored";
	chatId?: number;
	messageId?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ingestUpdate(db: Database, botId: string, update: any, groupPeerId: number): IngestResult {
	const updateId = update.update_id as number;

	// 1. store raw update (bot_id + update_id dedupe)
	const raw = db
		.query("INSERT OR IGNORE INTO raw_updates (bot_id, update_id, received_at, json) VALUES (?, ?, ?, ?)")
		.run(botId, updateId, Math.floor(Date.now() / 1000), JSON.stringify(update));
	if (raw.changes === 0) return { kind: "duplicate" };

	// 2. extract message; ignore non-message updates
	const payload = extractUpdateMessage(update);
	if (!payload) return { kind: "ignored" };
	const msg = payload.message;
	if (!isTargetChat(msg.chat.id, groupPeerId)) return { kind: "ignored" };

	const canonical = normalizeMessage(msg, payload.edited ? (msg.edit_date ?? Math.floor(Date.now() / 1000)) : null);

	if (payload.edited) {
		return editMessage(db, canonical);
	}
	return insertMessage(db, botId, canonical);
}

function insertMessage(db: Database, botId: string, m: CanonicalMessage): IngestResult {
	const res = db
		.query(
			`INSERT OR IGNORE INTO messages (
				chat_id, message_id, date, thread_id, sender_id, display_name, username,
				sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id,
				quote, forward_origin, edit_date, media, first_seen_by
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			m.chat_id,
			m.message_id,
			m.date,
			m.thread_id,
			m.sender_id,
			m.display_name,
			m.username,
			m.sender_tag,
			m.sender_chat,
			m.is_bot ? 1 : 0,
			m.text,
			m.caption,
			m.entities ? JSON.stringify(m.entities) : null,
			m.reply_to_message_id,
			m.quote ? JSON.stringify(m.quote) : null,
			m.forward_origin ? JSON.stringify(m.forward_origin) : null,
			m.edit_date,
			m.media ? JSON.stringify(m.media) : null,
			botId,
		);
	if (res.changes === 0) return { kind: "duplicate", chatId: m.chat_id, messageId: m.message_id };
	return { kind: "inserted", chatId: m.chat_id, messageId: m.message_id };
}

function editMessage(db: Database, m: CanonicalMessage): IngestResult {
	const existing = db
		.query("SELECT text, caption, entities, edit_date FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(m.chat_id, m.message_id) as { text: string | null; caption: string | null; entities: string | null; edit_date: number | null } | null;
	if (!existing) {
		// edit arrived for a message we never saw (started mid-history): store as new
		return insertMessage(db, "edit-unknown", m);
	}
	// revision history: keep the previous version
	db.query(
		"INSERT OR IGNORE INTO message_revisions (chat_id, message_id, edit_date, text, caption, entities) VALUES (?, ?, ?, ?, ?, ?)",
	).run(m.chat_id, m.message_id, existing.edit_date ?? m.edit_date ?? 0, existing.text, existing.caption, existing.entities);
	db.query("UPDATE messages SET text = ?, caption = ?, entities = ?, edit_date = ? WHERE chat_id = ? AND message_id = ?").run(
		m.text,
		m.caption,
		m.entities ? JSON.stringify(m.entities) : null,
		m.edit_date,
		m.chat_id,
		m.message_id,
	);
	return { kind: "edited", chatId: m.chat_id, messageId: m.message_id };
}

/** Insert a message we just sent via Bot API (send tool). Dedupes against the later poller echo. */
export function insertSentMessage(db: Database, botId: string, rawMsg: unknown): CanonicalMessage {
	const canonical = normalizeMessage(rawMsg);
	insertMessage(db, botId, canonical);
	return canonical;
}
