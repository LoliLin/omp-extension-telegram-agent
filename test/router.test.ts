// Deterministic router property tests.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeMessage, routingValue, nameKeywordTrigger, type BotIdentity } from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";

const CHAT = -1004402809405;
const SECRET = "test-secret";
const CFG = { secret: SECRET, pA: 0.1, pB: 0.1 };

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

const bots: [BotIdentity, BotIdentity] = [
	{ id: "A", userId: 7776264871, username: "hastuyuki_bot", name: "小雪" },
	{ id: "B", userId: 8734564920, username: "kosamerobot", name: "小雨" },
];

function row(overrides: Partial<MessageRow>): MessageRow {
	return {
		chat_id: CHAT, message_id: 1, date: 1754600000, thread_id: null,
		sender_id: 111, display_name: "Alice", username: "alice", sender_tag: null,
		is_bot: 0, text: "hello", caption: null, entities: null,
		reply_to_message_id: null, quote: null, edit_date: null, media: null,
		...overrides,
	} as MessageRow;
}

describe("routingValue", () => {
	test("deterministic and in [0,1)", () => {
		for (let id = 1; id < 500; id++) {
			const a = routingValue(SECRET, CHAT, id);
			const b = routingValue(SECRET, CHAT, id);
			expect(a).toBe(b);
			expect(a).toBeGreaterThanOrEqual(0);
			expect(a).toBeLessThan(1);
		}
	});

	test("different messages get different values (sanity)", () => {
		const values = new Set<number>();
		for (let id = 1; id <= 100; id++) values.add(routingValue(SECRET, CHAT, id));
		expect(values.size).toBe(100);
	});
});

describe("routeMessage", () => {
	test("result is always exactly one of A/B/nobody and stable on re-run", () => {
		for (let id = 1; id < 300; id++) {
			const r1 = routeMessage(db, row({ message_id: id }), bots, CFG);
			const r2 = routeMessage(db, row({ message_id: id }), bots, CFG);
			expect(r1).toBe(r2);
			expect(["A", "B", "nobody"]).toContain(r1);
		}
	});

	test("distribution roughly matches configured probabilities", () => {
		let a = 0, b = 0;
		const N = 5000;
		for (let id = 1; id <= N; id++) {
			const r = routeMessage(db, row({ message_id: id }), bots, { secret: SECRET, pA: 0.2, pB: 0.2 });
			if (r === "A") a++;
			if (r === "B") b++;
		}
		// p=0.2 each: expect ~1000 each, allow generous tolerance
		expect(a).toBeGreaterThan(850);
		expect(a).toBeLessThan(1150);
		expect(b).toBeGreaterThan(850);
		expect(b).toBeLessThan(1150);
	});

	test("explicit mention beats probability", () => {
		// find a message id that would route to nobody probabilistically
		let nobodyId = -1;
		for (let id = 1; id < 1000; id++) {
			if (routeMessage(db, row({ message_id: id }), bots, CFG) === "nobody") { nobodyId = id; break; }
		}
		const mentioned = row({
			message_id: nobodyId,
			text: "@hastuyuki_bot hi",
			entities: JSON.stringify([{ type: "mention", offset: 0, length: 14 }]),
		});
		expect(routeMessage(db, mentioned, bots, CFG)).toBe("A");
	});

	test("name keyword beats probability", () => {
		let nobodyId = -1;
		for (let id = 1; id < 1000; id++) {
			if (routeMessage(db, row({ message_id: id }), bots, CFG) === "nobody") { nobodyId = id; break; }
		}
		expect(routeMessage(db, row({ message_id: nobodyId, text: "小雨你怎么看" }), bots, CFG)).toBe("B");
		expect(nameKeywordTrigger(row({ text: "小雨你怎么看" }), bots[1])).toBe(true);
	});

	test("explicit mention has priority over name keyword of the other bot", () => {
		const rowBoth = row({
			message_id: 42,
			text: "@hastuyuki_bot 小雨说的对吗",
			entities: JSON.stringify([{ type: "mention", offset: 0, length: 14 }]),
		});
		expect(routeMessage(db, rowBoth, bots, CFG)).toBe("A");
	});

	test("p=0 means never triggered by probability", () => {
		for (let id = 1; id < 200; id++) {
			expect(routeMessage(db, row({ message_id: id }), bots, { secret: SECRET, pA: 0, pB: 0 })).toBe("nobody");
		}
	});
});
