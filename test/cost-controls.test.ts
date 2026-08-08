// Bounded-cost contracts from review-260808. All tests are local and deterministic.

process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packMessageEvents } from "../src/agent/token-packer.ts";
import {
	commitConsumedContext,
	getConsumedSeq,
	listRecentMessageEvents,
	listVisibleMessageIds,
	messageEventHighWater,
} from "../src/db/message-events.ts";
import { applyRetention } from "../src/db/retention.ts";
import { listReplyObligations } from "../src/db/reply-obligations.ts";
import { stickerCandidatesForTurn } from "../src/media/sticker-catalog.ts";
import { VisionBudgetExceededError, VisionScheduler } from "../src/media/vision-scheduler.ts";

const CHAT = -1004402809405;

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

describe("bounded provider inputs", () => {
	test("ordinary overflow is consumed without becoming visible", () => {
		for (let id = 1; id <= 8; id++) insertMessage(id, `${id}:${"x".repeat(2_000)}`);
		const highWater = messageEventHighWater(db, CHAT);
		const events = listRecentMessageEvents(db, CHAT, 0, highWater, 256);
		const packed = packMessageEvents(db, [], events, 512, { visibleIds: new Set() }, 128);

		expect(packed.droppedNormal).toBeGreaterThan(0);
		expect(packed.visibleMessageIds.length).toBeLessThan(8);
		commitConsumedContext(db, {
			botId: "A",
			chatId: CHAT,
			consumedSeq: highWater,
			epoch: 1,
			visibleMessageIds: packed.visibleMessageIds,
			deliveredObligationIds: [],
		});

		expect(getConsumedSeq(db, "A", CHAT)).toBe(highWater);
		expect(listVisibleMessageIds(db, "A", CHAT, 1)).toEqual([...packed.visibleMessageIds].sort((a, b) => a - b));
		expect(listVisibleMessageIds(db, "A", CHAT, 1)).not.toContain(1);
	});

	test("vision budgets apply across one deployment", async () => {
		let now = Date.UTC(2026, 7, 9, 12);
		const scheduler = new VisionScheduler({
			concurrency: 2,
			perChatHourlyLimit: 2,
			dailyLimit: 3,
			now: () => now,
		});

		await Promise.all([
			scheduler.schedule(CHAT, true, async () => "one"),
			scheduler.schedule(CHAT, false, async () => "two"),
		]);
		await expect(scheduler.schedule(CHAT, true, async () => "blocked-chat")).rejects.toBeInstanceOf(VisionBudgetExceededError);
		await expect(scheduler.schedule(CHAT - 1, true, async () => "three")).resolves.toBe("three");
		await expect(scheduler.schedule(CHAT - 2, true, async () => "blocked-day")).rejects.toBeInstanceOf(VisionBudgetExceededError);
		expect(scheduler.snapshot().dayCount).toBe(3);

		now += 86_400_000;
		await expect(scheduler.schedule(CHAT, true, async () => "next-day")).resolves.toBe("next-day");
	});

	test("reply scans and sticker retrieval stay bounded", () => {
		for (let id = 1; id <= 70; id++) {
			insertMessage(id);
			db.query(`
				INSERT INTO reply_obligations (bot_id, chat_id, message_id, created_at)
				VALUES ('A', ?, ?, ?)
			`).run(CHAT, id, id);
		}
		expect(listReplyObligations(db, "A", CHAT)).toHaveLength(64);

		db.query(`
			INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id)
			VALUES ('sticker-one', 'sticker', '😺', ?, 's1'),
			       ('sticker-two', 'sticker', '🤝', ?, 's2')
		`).run(
			JSON.stringify({ text: "开心猫猫" }),
			JSON.stringify({ text: "握手合作" }),
		);
		db.query(`
			INSERT INTO media_file_ids (bot_id, file_id, file_unique_id)
			VALUES ('A', 'file-one', 'sticker-one'), ('A', 'file-two', 'sticker-two')
		`).run();
		const candidates = stickerCandidatesForTurn(db, "A", "今天很开心 😺", 1);
		expect(candidates).toContain("s1 = 😺 开心猫猫");
		expect(candidates).not.toContain("s2");
	});

	test("retention preserves unconsumed and obligated message events", () => {
		insertMessage(20, "safe to prune");
		insertMessage(21, "obligation keeps me");
		const highWater = messageEventHighWater(db, CHAT);
		db.query(`
			INSERT INTO bot_cursors (bot_id, chat_id, consumed_seq, updated_at)
			VALUES ('A', ?, ?, 1)
		`).run(CHAT, highWater);
		db.query("INSERT INTO reply_obligations (bot_id, chat_id, message_id, created_at) VALUES ('A', ?, 21, 1)").run(CHAT);
		db.query("UPDATE message_events SET event_date = 1 WHERE chat_id = ?").run(CHAT);
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'usage', '{}')").run();
		db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch) VALUES ('A', 1, 'm', 1)").run();
		db.query("INSERT INTO raw_updates (bot_id, update_id, received_at, json) VALUES ('A', 1, 1, '{}')").run();

		const result = applyRetention(db, { telemetryDays: 1, rawUpdateDays: 1, messageEventDays: 1 }, Date.UTC(2026, 7, 9));
		expect(result).toEqual({ agentEvents: 1, llmRuns: 1, rawUpdates: 1, messageEvents: 1 });
		expect(db.query("SELECT message_id FROM message_events").all()).toEqual([{ message_id: 21 }]);
	});
});
