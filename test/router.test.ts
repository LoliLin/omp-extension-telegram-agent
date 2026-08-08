// Deterministic router property tests.

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	dispatchRoutingDecision,
	routeMessageDecision,
	routingValue,
	nameKeywordTrigger,
	type BotIdentity,
	type RoutingConfig,
	type RoutingDecision,
	type RoutingRuntime,
	type RoutingTrigger,
	type TriggerResult,
	type TriggerSource,
	type TriggerTarget,
} from "../src/agent/router.ts";
import type { MessageRow } from "../src/agent/serialize.ts";

const CHAT = -1004402809405;
const SECRET = "test-secret";
const CFG = { secret: SECRET, probs: [0.1, 0.1] };

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

const bots: BotIdentity[] = [
	{ id: "A", userId: 7776264871, username: "hastuyuki_bot", name: "小雪" },
	{ id: "B", userId: 8734564920, username: "kosamerobot", name: "小雨" },
];

function row(overrides: Partial<MessageRow>): MessageRow {
	return {
		chat_id: CHAT, message_id: 1, date: 1754600000, thread_id: null,
		sender_id: 111, display_name: "Alice", username: "alice", sender_tag: null,
		is_bot: 0, text: "hello", caption: null, entities: null,
		reply_to_message_id: null, reply_to_sender_id: null, quote: null, edit_date: null, media: null,
		...overrides,
	} as MessageRow;
}

function decision(target: string | "nobody", reason: RoutingDecision["reason"], messageId = 1): RoutingDecision {
	return { target, reason, chatId: CHAT, messageId };
}

/** Target-only view for the probability-property tests; production uses routeMessageDecision. */
function routeMessage(db: Database, row: MessageRow, bots: BotIdentity[], config: RoutingConfig): TriggerTarget {
	return routeMessageDecision(db, row, bots, config).target;
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
			const r = routeMessage(db, row({ message_id: id }), bots, { secret: SECRET, probs: [0.2, 0.2] });
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
		expect(routeMessageDecision(db, mentioned, bots, CFG)).toEqual(decision("A", "explicit", nobodyId));
	});

	test("decision reason distinguishes reply, name, probability, and nobody", () => {
		db.query(
			`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, text, first_seen_by)
			 VALUES (?, 900, 1754600000, ?, '小雪', 1, 'parent', 'A')`,
		).run(CHAT, bots[0]!.userId);
		expect(routeMessageDecision(db, row({ message_id: 901, reply_to_message_id: 900 }), bots, CFG)).toEqual(
			decision("A", "reply", 901),
		);
		expect(routeMessageDecision(db, row({ message_id: 902, text: "小雨你怎么看" }), bots, CFG)).toEqual(
			decision("B", "name", 902),
		);
		let probabilityId = -1;
		let nobodyId = -1;
		for (let id = 1; id < 10_000 && (probabilityId < 0 || nobodyId < 0); id++) {
			const decision = routeMessageDecision(db, row({ message_id: id }), bots, CFG);
			if (decision.reason === "probability") probabilityId = id;
			if (decision.reason === "nobody") nobodyId = id;
		}
		expect(routeMessageDecision(db, row({ message_id: probabilityId }), bots, CFG).reason).toBe("probability");
		expect(routeMessageDecision(db, row({ message_id: nobodyId }), bots, CFG)).toEqual(decision("nobody", "nobody", nobodyId));
	});

	test("embedded reply sender routes without a canonical parent and bot senders remain inert", () => {
		const direct = row({
			message_id: 903,
			reply_to_message_id: 12,
			reply_to_sender_id: bots[1]!.userId,
		});
		expect(routeMessageDecision(db, direct, bots, { secret: SECRET, probs: [0, 0] })).toEqual(
			decision("B", "reply", 903),
		);
		expect(routeMessageDecision(db, { ...direct, is_bot: 1 }, bots, { secret: SECRET, probs: [1, 0] })).toEqual(
			decision("nobody", "nobody", 903),
		);
		expect(routeMessageDecision(db, { ...direct, reply_to_sender_id: 111 }, bots, { secret: SECRET, probs: [0, 0] })).toEqual(
			decision("nobody", "nobody", 903),
		);
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
			expect(routeMessage(db, row({ message_id: id }), bots, { secret: SECRET, probs: [0, 0] })).toBe("nobody");
		}
	});

	test("REQ-TEST-0001 AC3: bot messages never trigger, even with mention and p=1", () => {
		const botMsg = row({
			message_id: 500,
			is_bot: 1,
			text: "@hastuyuki_bot 你好吗",
			entities: JSON.stringify([{ type: "mention", offset: 0, length: 14 }]),
		});
		expect(routeMessage(db, botMsg, bots, { secret: SECRET, probs: [1, 0] })).toBe("nobody");
		// reply-to-bot path also dead for bot senders
		const botReply = row({ message_id: 501, is_bot: 1, reply_to_message_id: 100 });
		expect(routeMessage(db, botReply, bots, { secret: SECRET, probs: [1, 0] })).toBe("nobody");
	});
});

describe("probability dispatch policy (REQ-ROUTE-0001)", () => {
	class FakeRuntime implements RoutingRuntime {
		readonly calls: Array<{ source: TriggerSource; trigger: RoutingTrigger }> = [];
		constructor(private result: TriggerResult) {}
		trigger(source: TriggerSource, trigger: RoutingTrigger): TriggerResult {
			this.calls.push({ source, trigger });
			return this.result;
		}
	}

	test("a busy probability target is skipped without redistribution", () => {
		const a = new FakeRuntime("skipped_busy");
		const b = new FakeRuntime("started");
		const result = dispatchRoutingDecision(
			decision("A", "probability", 800),
			new Map<string, RoutingRuntime>([["A", a], ["B", b]]),
		);
		expect(result.outcome).toBe("skipped_busy");
		expect(a.calls).toEqual([{ source: "probability", trigger: { reason: "probability", chatId: CHAT, messageId: 800 } }]);
		expect(b.calls).toEqual([]);
	});

	test("different probability buckets can start A and B independently", () => {
		const a = new FakeRuntime("started");
		const b = new FakeRuntime("started");
		const runtimes = new Map<string, RoutingRuntime>([["A", a], ["B", b]]);
		expect(dispatchRoutingDecision(decision("A", "probability", 801), runtimes).outcome).toBe("started");
		expect(dispatchRoutingDecision(decision("B", "probability", 802), runtimes).outcome).toBe("started");
		expect(a.calls).toEqual([{ source: "probability", trigger: { reason: "probability", chatId: CHAT, messageId: 801 } }]);
		expect(b.calls).toEqual([{ source: "probability", trigger: { reason: "probability", chatId: CHAT, messageId: 802 } }]);
	});

	test("mention/reply/name dispatch through the explicit coalescing path", () => {
		for (const reason of ["explicit", "reply", "name"] as const) {
			const runtime = new FakeRuntime("coalesced");
			const result = dispatchRoutingDecision(decision("A", reason, 803), new Map([["A", runtime]]));
			expect(result.outcome).toBe("coalesced");
			expect(runtime.calls).toEqual([{ source: "explicit", trigger: { reason, chatId: CHAT, messageId: 803 } }]);
		}
	});

	test("configured name is explicit at p=0 and bypasses busy/cooldown sampling gates", () => {
		const decision = routeMessageDecision(
			db,
			row({ message_id: 777, text: "我叫小雨" }),
			bots,
			{ secret: SECRET, probs: [0, 0] },
		);
		expect(decision).toEqual({ target: "B", reason: "name", chatId: CHAT, messageId: 777 });

		const busy = new FakeRuntime("coalesced");
		expect(dispatchRoutingDecision(decision, new Map([["B", busy]]))).toEqual({
			...decision,
			outcome: "coalesced",
		});
		expect(busy.calls).toEqual([{ source: "explicit", trigger: { reason: "name", chatId: CHAT, messageId: 777 } }]);

		const coolingDown = new FakeRuntime("started");
		expect(dispatchRoutingDecision(decision, new Map([["B", coolingDown]])).outcome).toBe("started");
		expect(coolingDown.calls).toEqual([{ source: "explicit", trigger: { reason: "name", chatId: CHAT, messageId: 777 } }]);
	});
});
