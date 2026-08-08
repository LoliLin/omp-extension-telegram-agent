// Durable context-state contracts from review-260808. All tests are local and deterministic.

process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getConsumedSeq,
	listRecentMessageEvents,
	listVisibleMessageIds,
	messageEventHighWater,
	replaceVisibleMessageIds,
	setConsumedSeq,
} from "../src/db/message-events.ts";
import { claimRoutingDecision, finishRoutingClaim } from "../src/db/routing-claims.ts";
import { insertSentMessage } from "../src/telegram/ingest.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

afterEach(() => db.close());

function insertMessage(messageId: number, text = `message-${messageId}`): void {
	db.query(`
		INSERT INTO messages (
			chat_id, message_id, date, sender_id, display_name, username, is_bot, text,
			reply_to_message_id, quote, first_seen_by
		) VALUES (?, ?, ?, 111, 'Alice', 'alice', 0, ?, NULL, NULL, 'A')
	`).run(CHAT, messageId, 1_754_600_000 + messageId, text);
}

describe("durable Telegram context state", () => {
	test("compaction never rewinds the consumed event cursor", () => {
		for (let id = 1; id <= 3; id++) insertMessage(id);
		const highWater = messageEventHighWater(db, CHAT);
		setConsumedSeq(db, "A", CHAT, highWater);
		replaceVisibleMessageIds(db, "A", CHAT, 1, [1, 2, 3]);

		// A new context generation may retain one reference; business consumption is unchanged.
		replaceVisibleMessageIds(db, "A", CHAT, 2, [3]);

		expect(getConsumedSeq(db, "A", CHAT)).toBe(highWater);
		expect(listVisibleMessageIds(db, "A", CHAT, 2)).toEqual([3]);
		expect(listRecentMessageEvents(db, CHAT, getConsumedSeq(db, "A", CHAT), highWater, 256)).toEqual([]);
	});

	test("edits append immutable deltas", () => {
		insertMessage(7, "original text");
		db.query("UPDATE messages SET text = 'edited text', edit_date = 1754600100 WHERE chat_id = ? AND message_id = 7").run(CHAT);
		const events = db.query(`
			SELECT kind, payload_json AS payload
			  FROM message_events
			 WHERE chat_id = ? AND message_id = 7
			 ORDER BY ingest_seq
		`).all(CHAT) as { kind: string; payload: string }[];

		expect(events.map((event) => event.kind)).toEqual(["message", "edit"]);
		expect(JSON.parse(events[0]!.payload).text).toBe("original text");
		expect(JSON.parse(events[1]!.payload).text).toBe("edited text");
		expect(db.query("SELECT text FROM messages WHERE message_id = 7").get()).toEqual({ text: "edited text" });
	});

	test("event snapshots retain channel sender and forward identity", () => {
		const senderChat = JSON.stringify({ id: -100123, title: "News" });
		const forwardOrigin = JSON.stringify({ type: "channel", chat: { id: -100456, title: "Source" } });
		db.query(`
			INSERT INTO messages (
				chat_id, message_id, date, sender_chat, is_bot, text, forward_origin, first_seen_by
			) VALUES (?, 30, 1754600030, ?, 0, 'forwarded', ?, 'A')
		`).run(CHAT, senderChat, forwardOrigin);
		const event = db.query("SELECT payload_json AS payload FROM message_events WHERE message_id = 30").get() as { payload: string };

		expect(JSON.parse(event.payload)).toMatchObject({ sender_chat: senderChat, forward_origin: forwardOrigin });
	});

	test("cached vision follows the immutable base message", () => {
		db.query("INSERT INTO media (file_unique_id, kind, vision) VALUES ('cached-photo', 'photo', ?)").run(
			JSON.stringify({ model: "fixture", kind: "photo", text: "already described", at: 1 }),
		);
		insertSentMessage(db, "A", {
			chat: { id: CHAT },
			message_id: 31,
			date: 1_754_600_031,
			from: { id: 999, is_bot: true, first_name: "A" },
			photo: [{ file_id: "file-31", file_unique_id: "cached-photo", width: 32, height: 32 }],
		});

		expect(db.query("SELECT kind FROM message_events WHERE message_id = 31 ORDER BY ingest_seq").all()).toEqual([
			{ kind: "message" },
			{ kind: "media_update" },
		]);
	});

	test("routing claims suppress a later enrichment after accepted dispatch", () => {
		const decision = { chatId: CHAT, messageId: 8, target: "A", reason: "probability" as const };
		expect(claimRoutingDecision(db, decision, 1)).toBe(true);
		finishRoutingClaim(db, decision, 1, "started");
		expect(claimRoutingDecision(db, { ...decision, reason: "reply" }, 2)).toBe(false);
	});
});

test("million-event history uses a bounded indexed query", () => {
	const historyDb = new Database(":memory:");
	try {
		historyDb.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
		historyDb.exec(`
			WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
			numbers(n) AS (
				SELECT a.d + 10*b.d + 100*c.d + 1000*d.d + 10000*e.d + 100000*f.d + 1
				  FROM digits a CROSS JOIN digits b CROSS JOIN digits c
				  CROSS JOIN digits d CROSS JOIN digits e CROSS JOIN digits f
			)
			INSERT INTO message_events
				(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			SELECT 'bulk:' || n, ${CHAT}, n, 0, 'message', 1, '{}'
			  FROM numbers;
		`);
		const insert = historyDb.query(`
			INSERT INTO message_events
				(event_key, chat_id, message_id, revision, kind, event_date, payload_json)
			VALUES (?, ?, ?, 0, 'message', 2, '{}')
		`);
		for (let id = 1_000_001; id <= 1_000_010; id++) insert.run(`tail:${id}`, CHAT, id);
		const highWater = messageEventHighWater(historyDb, CHAT);
		const rows = listRecentMessageEvents(historyDb, CHAT, 1_000_000, highWater, 256);
		const plan = historyDb.query(`
			EXPLAIN QUERY PLAN
			SELECT * FROM message_events
			 WHERE chat_id = ? AND ingest_seq > ? AND ingest_seq <= ?
			 ORDER BY ingest_seq DESC LIMIT ?
		`).all(CHAT, 1_000_000, highWater, 256) as { detail: string }[];

		expect(rows.map((event) => event.messageId)).toEqual([
			1_000_001, 1_000_002, 1_000_003, 1_000_004, 1_000_005,
			1_000_006, 1_000_007, 1_000_008, 1_000_009, 1_000_010,
		]);
		expect(plan.some((row) => row.detail.includes("idx_message_events_chat_seq"))).toBe(true);
	} finally {
		historyDb.close();
	}
}, 20_000);
