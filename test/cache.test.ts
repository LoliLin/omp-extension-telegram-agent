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
import { serializeMessages, type MessageRow } from "../src/agent/serialize.ts";
import { buildSystemPrompt, sha256Short, CACHE_SCHEMA_VERSION, COMPACTION_SUMMARY_PROMPT } from "../src/agent/prompt.ts";
import { toolsHash } from "../src/agent/tools.ts";
import { stickerCatalogBlock } from "../src/media/sticker-catalog.ts";

const GOLDEN = {
	schemaVersion: 7,
	systemZhTemplate: "d2429abc25aa",
	systemEnTemplate: "8a5eb2679620",
	serialize: "68a17d6e5c05",
	tools: "280868a5b3a9",
	compactionPrompt: "045a5241fdd7",
	systemZhTemplateWithCatalog: "319085c72d6b",
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

test("complete provider tool protocol + order stable (REQ-TEST-0001 R2)", () => {
	expect(toolsHash()).toBe(GOLDEN.tools);
});

test("compaction summary prompt grammar stable (REQ-TEST-0001 R2)", () => {
	expect(sha256Short(COMPACTION_SUMMARY_PROMPT)).toBe(GOLDEN.compactionPrompt);
});

test("sticker catalog block is part of the stable prefix grammar (REQ-STICKER-0001 AC1)", () => {
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
	const block = stickerCatalogBlock(db, "A", ["Mikufufu"]);
	expect(block).toContain("s1 = 😺 得意的赞同，smug/amused");
	expect(block).toContain("s2 = 🐱 [未识别]");
	expect(block).not.toContain("s3");
	const persona = readFileSync("personas/template.zh.md", "utf8");
	expect(sha256Short(buildSystemPrompt(persona, block))).toBe(GOLDEN.systemZhTemplateWithCatalog);
	// determinism: same DB state -> byte-identical block
	expect(stickerCatalogBlock(db, "A", ["Mikufufu"])).toBe(block);
});
