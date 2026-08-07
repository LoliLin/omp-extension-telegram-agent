// Serializer + router unit tests. No network.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serializeMessages, getOrCreateAlias, type MessageRow } from "../src/agent/serialize.ts";
import { explicitTrigger, type BotIdentity } from "../src/agent/router.ts";
import { ingestUpdate, insertSentMessage } from "../src/telegram/ingest.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function insertMsg(overrides: Partial<MessageRow>): void {
	const m = {
		chat_id: CHAT, message_id: 1, date: 1754600000, thread_id: null,
		sender_id: 111, display_name: "Alice", username: "alice", sender_tag: null,
		sender_chat: null, is_bot: 0, text: "hi", caption: null, entities: null,
		reply_to_message_id: null, quote: null, forward_origin: null, edit_date: null, media: null,
		...overrides,
	};
	db.query(
		`INSERT INTO messages (chat_id, message_id, date, thread_id, sender_id, display_name, username, sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id, quote, forward_origin, edit_date, media, first_seen_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A')`,
	).run(m.chat_id, m.message_id, m.date, m.thread_id, m.sender_id, m.display_name, m.username, m.sender_tag, m.sender_chat, m.is_bot, m.text, m.caption, m.entities, m.reply_to_message_id, m.quote, m.forward_origin, m.edit_date, m.media);
}

function row(messageId: number): MessageRow {
	return db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(CHAT, messageId) as MessageRow;
}

const botA: BotIdentity = { id: "A", userId: 7776264871, username: "hastuyuki_bot", name: "小雪" };

describe("serializeMessages", () => {
	test("basic line format with date separator", () => {
		insertMsg({ message_id: 100, date: 1754612345 });
		const out = serializeMessages(db, [row(100)], { visibleIds: new Set() });
		const d = new Date(1754612345 * 1000);
		const p = (n: number) => String(n).padStart(2, "0");
		expect(out).toBe(
			`--- ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ---\n[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] #100 Alice (@alice): hi`,
		);
	});

	test("user without username gets stable alias", () => {
		insertMsg({ message_id: 101, sender_id: 555, username: null, display_name: "Bob" });
		const alias = getOrCreateAlias(db, CHAT, 555);
		expect(alias).toBe("u1");
		expect(getOrCreateAlias(db, CHAT, 555)).toBe("u1"); // stable
		const out = serializeMessages(db, [row(101)], { visibleIds: new Set() });
		expect(out).toContain("Bob (u1)");
	});

	test("bot sender shows bot tag", () => {
		insertMsg({ message_id: 102, is_bot: 1, display_name: "小雪", username: "hastuyuki_bot" });
		const out = serializeMessages(db, [row(102)], { visibleIds: new Set() });
		expect(out).toContain("小雪 (@hastuyuki_bot · bot)");
	});

	test("reply to visible parent is bare reference; invisible parent gets snippet", () => {
		insertMsg({ message_id: 100, text: "parent text here" });
		insertMsg({ message_id: 103, reply_to_message_id: 100, text: "child" });
		const visible = serializeMessages(db, [row(103)], { visibleIds: new Set([100]) });
		expect(visible).toContain("↪ #100: child");
		expect(visible).not.toContain('"');
		const invisible = serializeMessages(db, [row(103)], { visibleIds: new Set() });
		expect(invisible).toContain('↪ #100 @alice "parent text here"');
	});

	test("quote is serialized", () => {
		insertMsg({ message_id: 104, quote: JSON.stringify({ text: "append-only" }), text: "yes" });
		const out = serializeMessages(db, [row(104)], { visibleIds: new Set() });
		expect(out).toContain('quote="append-only"');
	});

	test("sticker and photo placeholders", () => {
		insertMsg({ message_id: 105, text: null, media: JSON.stringify({ kind: "sticker", sticker_emoji: "😺", sticker_set: "cats" }) });
		insertMsg({ message_id: 106, text: null, media: JSON.stringify({ kind: "photo" }) });
		const out = serializeMessages(db, [row(105), row(106)], { visibleIds: new Set() });
		expect(out).toContain("[sticker 😺 set:cats]");
		expect(out).toContain("[图片]");
	});

	test("serialization is deterministic (cache invariant)", () => {
		insertMsg({ message_id: 107, text: "same input" });
		const a = serializeMessages(db, [row(107)], { visibleIds: new Set() });
		const b = serializeMessages(db, [row(107)], { visibleIds: new Set() });
		expect(a).toBe(b);
	});
});

describe("explicitTrigger", () => {
	test("mention entity matching bot username", () => {
		insertMsg({ message_id: 200, text: "@hastuyuki_bot 在吗", entities: JSON.stringify([{ type: "mention", offset: 0, length: 14 }]) });
		expect(explicitTrigger(db, row(200), botA)).toBe(true);
	});

	test("text_mention with user id", () => {
		insertMsg({ message_id: 201, entities: JSON.stringify([{ type: "text_mention", offset: 0, length: 2, user: { id: 7776264871 } }]) });
		expect(explicitTrigger(db, row(201), botA)).toBe(true);
	});

	test("reply to bot message", () => {
		insertMsg({ message_id: 100, sender_id: 7776264871, is_bot: 1 });
		insertMsg({ message_id: 202, reply_to_message_id: 100 });
		expect(explicitTrigger(db, row(202), botA)).toBe(true);
	});

	test("plain message does not trigger", () => {
		insertMsg({ message_id: 203, text: "hello world" });
		expect(explicitTrigger(db, row(203), botA)).toBe(false);
	});

	test("mention of a different user does not trigger", () => {
		insertMsg({ message_id: 204, text: "@someone_else hi", entities: JSON.stringify([{ type: "mention", offset: 0, length: 12 }]) });
		expect(explicitTrigger(db, row(204), botA)).toBe(false);
	});
});

describe("sent message dedupe (send -> poller echo)", () => {
	test("insertSentMessage then poller echo of same message stays single", () => {
		const sent = {
			message_id: 300, from: { id: 7776264871, is_bot: true, first_name: "小雪", username: "hastuyuki_bot" },
			chat: { id: CHAT, type: "supergroup" }, date: 1754600000, text: "bot reply",
		};
		insertSentMessage(db, "A", sent);
		// poller echo arrives later as a normal update
		const r = ingestUpdate(db, "A", { update_id: 900, message: sent }, GROUP);
		expect(r.kind).toBe("duplicate");
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
	});
});
