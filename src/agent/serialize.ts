// Serialize canonical messages into the fixed LLM grammar (docs/cache.md, CACHE_SCHEMA_VERSION=1).
// Grammar stability is a cache invariant: never change existing output shape.

import type { Database } from "bun:sqlite";

export interface MessageRow {
	chat_id: number;
	message_id: number;
	date: number;
	thread_id: number | null;
	sender_id: number | null;
	display_name: string | null;
	username: string | null;
	sender_tag: string | null;
	is_bot: number;
	text: string | null;
	caption: string | null;
	entities: string | null;
	rich_message?: string | null;
	reply_to_message_id: number | null;
	quote: string | null;
	edit_date: number | null;
	media: string | null;
}

/** Stable short alias (u<N>) for users without username. */
export function getOrCreateAlias(db: Database, chatId: number, userId: number): string {
	const existing = db.query("SELECT alias FROM aliases WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
		| { alias: string }
		| null;
	if (existing) return existing.alias;
	const max = db
		.query("SELECT COUNT(*) c FROM aliases WHERE chat_id = ?")
		.get(chatId) as { c: number };
	const alias = `u${max.c + 1}`;
	db.query("INSERT INTO aliases (chat_id, user_id, alias) VALUES (?, ?, ?)").run(chatId, userId, alias);
	return alias;
}

function senderLabel(db: Database, m: MessageRow): string {
	const name = m.display_name ?? (m.sender_id != null ? String(m.sender_id) : "?");
	const parts: string[] = [];
	if (m.username) parts.push(`@${m.username}`);
	else if (m.sender_id != null) parts.push(getOrCreateAlias(db, m.chat_id, m.sender_id));
	if (m.is_bot) parts.push("bot");
	if (m.sender_tag) parts.push(`tag:${m.sender_tag}`);
	return parts.length > 0 ? `${name} (${parts.join(" · ")})` : name;
}

function mediaPlaceholder(db: Database, mediaJson: string): string {
	const media = JSON.parse(mediaJson) as { kind: string; sticker_emoji?: string; sticker_set?: string; file_unique_id?: string };
	let vision: string | null = null;
	if (media.file_unique_id) {
		const row = db.query("SELECT vision FROM media WHERE file_unique_id = ?").get(media.file_unique_id) as
			| { vision: string | null }
			| null;
		if (row?.vision) vision = (JSON.parse(row.vision) as { text: string }).text;
	}
	if (media.kind === "sticker") {
		const emoji = media.sticker_emoji ?? "";
		if (vision) return `[sticker${emoji ? " " + emoji : ""}: ${vision}]`;
		const set = media.sticker_set ? ` set:${media.sticker_set}` : "";
		return `[sticker${emoji ? " " + emoji : ""}${set}]`;
	}
	if (media.kind === "photo") return vision ? `[图片: ${vision}]` : "[图片]";
	return `[${media.kind}]`;
}

function fmtTime(dateSec: number): string {
	const d = new Date(dateSec * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(dateSec: number): string {
	const d = new Date(dateSec * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shortQuote(db: Database, chatId: number, messageId: number): string | null {
	const parent = db
		.query("SELECT text, caption, display_name, username, sender_id FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(chatId, messageId) as MessageRow | null;
	if (!parent) return null;
	const body = (parent.text ?? parent.caption ?? "").replace(/\s+/g, " ").trim();
	const snippet = body.length > 40 ? `${body.slice(0, 40)}…` : body;
	const who = parent.username ? `@${parent.username}` : (parent.display_name ?? "?");
	return snippet ? `${who} "${snippet}"` : who;
}

export interface SerializeOptions {
	/** message ids already visible in the model's current context (exposed ∪ current batch) */
	visibleIds: Set<number>;
}

/**
 * Serialize a batch of messages (must be same chat, ascending date order).
 * Inserts date separators when the local date changes between messages.
 */
export function serializeMessages(db: Database, rows: MessageRow[], opts: SerializeOptions): string {
	const lines: string[] = [];
	let lastDate: string | null = null;
	for (const m of rows) {
		const day = fmtDate(m.date);
		if (day !== lastDate) {
			lines.push(`--- ${day} ---`);
			lastDate = day;
		}
		let line = `[${fmtTime(m.date)}] #${m.message_id} ${senderLabel(db, m)}`;
		if (m.reply_to_message_id != null) {
			line += ` ↪ #${m.reply_to_message_id}`;
			if (!opts.visibleIds.has(m.reply_to_message_id)) {
				const ref = shortQuote(db, m.chat_id, m.reply_to_message_id);
				if (ref) line += ` ${ref}`;
			}
		}
		if (m.quote) {
			const q = JSON.parse(m.quote) as { text?: string };
			if (q.text) line += ` quote="${q.text.replace(/\s+/g, " ").slice(0, 60)}"`;
		}
		line += ":";
		const body = m.text ?? m.caption ?? (m.media ? mediaPlaceholder(db, m.media) : "");
		if (body) line += ` ${body}`;
		if (m.media && (m.text || m.caption)) line += ` ${mediaPlaceholder(db, m.media)}`;
		if (m.edit_date) line += " (edited)";
		lines.push(line);
		opts.visibleIds.add(m.message_id);
	}
	return lines.join("\n");
}
