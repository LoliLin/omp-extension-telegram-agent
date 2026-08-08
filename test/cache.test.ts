// Cache regression test: golden hashes lock the cache-visible protocol (docs/cache.md).
// If any of these fail, a change altered the provider-visible prefix:
// - system prompt (persona + protocol block)          => bump CACHE_SCHEMA_VERSION, new epoch
// - tool name/description/parameter schema + order    => same
// - message serialization grammar                     => same
// UI-only changes must NOT affect these hashes.

import { describe, expect, test } from "bun:test";

// bun test forces UTC; the daemon serializes in local time. Pin the deployment TZ
// before anything calls Date so the golden hash matches production behavior.
process.env.TZ = "Asia/Singapore";

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { serializeMessageEvents, serializeMessages, type MessageRow } from "../src/agent/serialize.ts";
import { buildSystemPrompt, sha256Short, CACHE_SCHEMA_VERSION, COMPACTION_SUMMARY_PROMPT } from "../src/agent/prompt.ts";
import { toolsHash } from "../src/agent/tools.ts";
import { stickerCandidatesForTurn } from "../src/media/sticker-catalog.ts";
import {
	NO_SEND_MARKER,
	TELEGRAM_CONTEXT_TYPE,
	TELEGRAM_CONTEXT_VERSION,
	TELEGRAM_EXTENSION_ORDER,
} from "../src/agent/extensions/index.ts";

const GOLDEN = {
	schemaVersion: 8,
	systemZhTemplate: "71aa33e82b4d",
	systemEnTemplate: "57e3746bcf4d",
	serialize: "68a17d6e5c05",
	eventSerialize: "4a57de738bf9",
	tools: "280868a5b3a9",
	compactionPrompt: "045a5241fdd7",
	extensionOrder: "e04f7032d531",
	contextProtocol: "a9ca6974ac5f",
};

test("CACHE_SCHEMA_VERSION unchanged", () => {
	expect(CACHE_SCHEMA_VERSION).toBe(GOLDEN.schemaVersion);
});

test("system prompts stable (persona + protocol)", () => {
	const a = buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"));
	const b = buildSystemPrompt(readFileSync("personas/template.en.md", "utf8"));
	expect(sha256Short(a)).toBe(GOLDEN.systemZhTemplate);
	expect(sha256Short(b)).toBe(GOLDEN.systemEnTemplate);
});

test("message serialization grammar stable", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const ins = db.prepare(
		`INSERT INTO messages (chat_id, message_id, date, thread_id, sender_id, display_name, username, sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id, quote, forward_origin, edit_date, media, first_seen_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	);
	ins.run(-1004402809405, 100, 1754612345, null, 111, "Alice", "alice", null, null, 0, "这个实现是不是有问题？", null, null, null, null, null, null, null, "A");
	ins.run(-1004402809405, 101, 1754612360, null, 222, "Bob", null, null, null, 0, "感觉是 API 抽风", null, null, 100, null, null, null, null, "A");
	ins.run(-1004402809405, 102, 1754612380, null, 7776264871, "小雪", "hastuyuki_bot", null, null, 1, "应该保持 append-only", null, null, null, null, null, null, null, "A");
	const rows = db.query("SELECT * FROM messages ORDER BY date").all() as MessageRow[];
	const out = serializeMessages(db, rows, { visibleIds: new Set([100]) });
	expect(sha256Short(out)).toBe(GOLDEN.serialize);
});

test("immutable event and extension protocol grammar stable", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const row: MessageRow = {
		chat_id: -1004402809405, message_id: 200, date: 1754612345, thread_id: null,
		sender_id: 111, display_name: "Alice", username: "alice", sender_tag: null,
		sender_chat: null, is_bot: 0, text: "original", caption: null, entities: null,
		rich_message: null, reply_to_message_id: null, reply_to_sender_id: null, quote: null,
		forward_origin: null, edit_date: null, media: null,
	};
	const out = serializeMessageEvents(db, [
		{ ingestSeq: 1, chatId: row.chat_id, messageId: 200, revision: 0, kind: "message", eventDate: row.date, payload: row },
		{ ingestSeq: 2, chatId: row.chat_id, messageId: 200, revision: 1754612400, kind: "edit", eventDate: 1754612400, payload: { ...row, text: "edited", edit_date: 1754612400 } },
		{ ingestSeq: 3, chatId: row.chat_id, messageId: 200, revision: 1, kind: "metadata", eventDate: 1754612401, payload: { ...row, reply_to_message_id: 199, reply_to_sender_id: 222 } },
		{ ingestSeq: 4, chatId: row.chat_id, messageId: 200, revision: 2, kind: "media_update", eventDate: 1754612402, payload: { file_unique_id: "u", media_kind: "photo", text: "a cat" } },
	], { visibleIds: new Set() });
	expect(sha256Short(out)).toBe(GOLDEN.eventSerialize);
	expect(sha256Short(JSON.stringify(TELEGRAM_EXTENSION_ORDER))).toBe(GOLDEN.extensionOrder);
	expect(sha256Short(JSON.stringify({
		type: TELEGRAM_CONTEXT_TYPE,
		version: TELEGRAM_CONTEXT_VERSION,
		noSend: NO_SEND_MARKER,
	}))).toBe(GOLDEN.contextProtocol);
});

test("complete provider tool protocol + order stable (REQ-TEST-0001 R2)", () => {
	expect(toolsHash()).toBe(GOLDEN.tools);
});

test("compaction summary prompt grammar stable (REQ-TEST-0001 R2)", () => {
	expect(sha256Short(COMPACTION_SUMMARY_PROMPT)).toBe(GOLDEN.compactionPrompt);
});

test("sticker inventory is retrieved per turn and never enters the stable prefix", () => {
	const db = new Database(":memory:");
	db.exec(readFileSync("src/db/schema.sql", "utf8"));
	const ins = db.prepare(
		`INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES (?, 'sticker', ?, ?, ?, ?)`,
	);
	ins.run("uq-cat-1", "Mikufufu", "😺", JSON.stringify({ model: "m", kind: "sticker", text: "得意的赞同，smug/amused", at: 1 }), "s1");
	ins.run("uq-cat-2", "Mikufufu", "🐱", null, "s2"); // no vision yet -> [未识别]
	ins.run("uq-cat-b-only", "Mikufufu", "🅱️", JSON.stringify({ model: "m", kind: "sticker", text: "另一个 bot 的映射", at: 1 }), "s3");
	db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'fid-1', 'uq-cat-1'), ('A', 'fid-2', 'uq-cat-2')").run();
	db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('B', 'fid-3', 'uq-cat-b-only')").run();
	expect(stickerCandidatesForTurn(db, "A", "得意 smug 😺")).toContain("s1 = 😺 得意的赞同，smug/amused");
});
