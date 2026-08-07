// Ingestion + normalization tests over deterministic fixtures. No network.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ingestUpdate } from "../src/telegram/ingest.ts";
import { normalizeMessage, isTargetChat } from "../src/telegram/normalize.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GROUP = 4402809405;
const SUPERGROUP = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function makeUpdate(updateId: number, message: object): object {
	return { update_id: updateId, message };
}

function makeMessage(overrides: object = {}): object {
	return {
		message_id: 100,
		from: { id: 111, is_bot: false, first_name: "Alice", username: "alice" },
		chat: { id: SUPERGROUP, type: "supergroup", title: "test group" },
		date: 1754600000,
		text: "hello",
		...overrides,
	};
}

describe("isTargetChat", () => {
	test("accepts raw, negative, and -100 forms", () => {
		expect(isTargetChat(GROUP, GROUP)).toBe(true);
		expect(isTargetChat(-GROUP, GROUP)).toBe(true);
		expect(isTargetChat(SUPERGROUP, GROUP)).toBe(true);
		expect(isTargetChat(12345, GROUP)).toBe(false);
	});
});

describe("ingestUpdate", () => {
	test("inserts a normal text message", () => {
		const r = ingestUpdate(db, "A", makeUpdate(1, makeMessage()), GROUP);
		expect(r.kind).toBe("inserted");
		const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(SUPERGROUP, 100) as Record<string, unknown>;
		expect(row.text).toBe("hello");
		expect(row.username).toBe("alice");
		expect(row.first_seen_by).toBe("A");
	});

	test("raw update is stored", () => {
		ingestUpdate(db, "A", makeUpdate(2, makeMessage()), GROUP);
		const row = db.query("SELECT bot_id, update_id FROM raw_updates WHERE update_id = 2").get() as Record<string, unknown>;
		expect(row.bot_id).toBe("A");
	});

	test("duplicate update (same bot, same update_id) is skipped", () => {
		ingestUpdate(db, "A", makeUpdate(3, makeMessage()), GROUP);
		const r = ingestUpdate(db, "A", makeUpdate(3, makeMessage()), GROUP);
		expect(r.kind).toBe("duplicate");
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
	});

	test("same group message via both bots yields one canonical message", () => {
		ingestUpdate(db, "A", makeUpdate(10, makeMessage()), GROUP);
		const r = ingestUpdate(db, "B", makeUpdate(11, makeMessage()), GROUP);
		expect(r.kind).toBe("duplicate");
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
		// but both raw updates are kept
		expect(db.query("SELECT COUNT(*) c FROM raw_updates").get()).toEqual({ c: 2 });
	});

	test("message from another chat is ignored", () => {
		const r = ingestUpdate(db, "A", makeUpdate(20, makeMessage({ chat: { id: 999, type: "private" } })), GROUP);
		expect(r.kind).toBe("ignored");
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 0 });
	});

	test("non-message update is ignored", () => {
		const r = ingestUpdate(db, "A", { update_id: 30, my_chat_member: {} }, GROUP);
		expect(r.kind).toBe("ignored");
	});

	test("edit stores revision and updates latest", () => {
		ingestUpdate(db, "A", makeUpdate(40, makeMessage()), GROUP);
		const edited = { update_id: 41, edited_message: makeMessage({ text: "hello v2", edit_date: 1754600100 }) };
		const r = ingestUpdate(db, "A", edited, GROUP);
		expect(r.kind).toBe("edited");
		const row = db.query("SELECT text, edit_date FROM messages WHERE message_id = 100").get() as Record<string, unknown>;
		expect(row.text).toBe("hello v2");
		expect(row.edit_date).toBe(1754600100);
		const rev = db.query("SELECT text FROM message_revisions WHERE message_id = 100").get() as Record<string, unknown>;
		expect(rev.text).toBe("hello");
	});

	test("two consecutive edits keep the full revision chain (REQ-TG-0001 AC1)", () => {
		ingestUpdate(db, "A", makeUpdate(42, makeMessage()), GROUP); // v1, date=1754600000
		ingestUpdate(db, "A", { update_id: 43, edited_message: makeMessage({ text: "hello v2", edit_date: 1754600100 }) }, GROUP);
		const r = ingestUpdate(db, "A", { update_id: 44, edited_message: makeMessage({ text: "hello v3", edit_date: 1754600200 }) }, GROUP);
		expect(r.kind).toBe("edited");
		// v1 keyed by the original send time, v2 keyed by the first edit time — no collision
		const revs = db
			.query("SELECT edit_date, text FROM message_revisions WHERE message_id = 100 ORDER BY edit_date")
			.all() as { edit_date: number; text: string }[];
		expect(revs).toEqual([
			{ edit_date: 1754600000, text: "hello" },
			{ edit_date: 1754600100, text: "hello v2" },
		]);
		const row = db.query("SELECT text, edit_date FROM messages WHERE message_id = 100").get() as Record<string, unknown>;
		expect(row.text).toBe("hello v3");
		expect(row.edit_date).toBe(1754600200);
	});

	test("edit arriving before the original still dedupes revisions (REQ-TG-0001)", () => {
		// edit-unknown path: stored as a fresh row, later edits revision it normally
		ingestUpdate(db, "A", { update_id: 45, edited_message: makeMessage({ text: "mid v1", edit_date: 1754600300 }) }, GROUP);
		ingestUpdate(db, "A", { update_id: 46, edited_message: makeMessage({ text: "mid v2", edit_date: 1754600400 }) }, GROUP);
		const revs = db
			.query("SELECT edit_date, text FROM message_revisions WHERE message_id = 100")
			.all() as { edit_date: number; text: string }[];
		expect(revs).toEqual([{ edit_date: 1754600300, text: "mid v1" }]);
		const row = db.query("SELECT text, first_seen_by FROM messages WHERE message_id = 100").get() as Record<string, unknown>;
		expect(row.text).toBe("mid v2");
		expect(row.first_seen_by).toBe("edit-unknown");
	});

	test("reply relation and quote are captured", () => {
		const m = makeMessage({
			message_id: 101,
			text: "@alice agree",
			reply_to_message: makeMessage({ message_id: 100 }),
			quote: { text: "hello", position: 0 },
			entities: [{ type: "mention", offset: 0, length: 6 }],
		});
		ingestUpdate(db, "A", makeUpdate(50, m), GROUP);
		const row = db.query("SELECT reply_to_message_id, quote, entities FROM messages WHERE message_id = 101").get() as Record<string, unknown>;
		expect(row.reply_to_message_id).toBe(100);
		expect(JSON.parse(row.quote as string).text).toBe("hello");
		expect(JSON.parse(row.entities as string)[0].type).toBe("mention");
	});

	test("photo normalizes to media with largest size", () => {
		const m = makeMessage({
			message_id: 102,
			text: undefined,
			caption: "look",
			photo: [
				{ file_id: "small", file_unique_id: "u-small", width: 90, height: 90 },
				{ file_id: "big", file_unique_id: "u-big", width: 800, height: 600 },
			],
		});
		ingestUpdate(db, "A", makeUpdate(60, m), GROUP);
		const row = db.query("SELECT media, caption FROM messages WHERE message_id = 102").get() as Record<string, unknown>;
		const media = JSON.parse(row.media as string);
		expect(media.kind).toBe("photo");
		expect(media.file_unique_id).toBe("u-big");
		expect(row.caption).toBe("look");
	});

	test("sticker normalizes with set and emoji", () => {
		const m = makeMessage({
			message_id: 103,
			text: undefined,
			sticker: { file_id: "f1", file_unique_id: "u1", width: 512, height: 512, set_name: "cats", emoji: "😺" },
		});
		ingestUpdate(db, "A", makeUpdate(70, m), GROUP);
		const row = db.query("SELECT media FROM messages WHERE message_id = 103").get() as Record<string, unknown>;
		const media = JSON.parse(row.media as string);
		expect(media.kind).toBe("sticker");
		expect(media.sticker_set).toBe("cats");
	});
});

describe("normalizeMessage", () => {
	test("bot sender flag", () => {
		const m = normalizeMessage(makeMessage({ from: { id: 222, is_bot: true, first_name: "BotA", username: "bot_a" } }));
		expect(m.is_bot).toBe(true);
	});
});
