process.env.TZ = "Asia/Singapore";

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { listVisibleMessageIds } from "../src/db/message-events.ts";
import { createReplyObligation, replyObligationCount } from "../src/db/reply-obligations.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import { openDb } from "../src/db/db.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function config(dbPath = ":memory:"): AppConfig {
	return {
		dataDir: "/tmp/reply-delivery-test",
		dbPath,
		groupPeerId: GROUP,
		bots: [],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "",
		routerSecret: null,
		telegramAdmins: [],
	};
}

function bot(id = "A"): BotConfig {
	return {
		id,
		name: id === "A" ? "小雪" : "小雨",
		token: "test-token",
		personaPath: "",
		routingP: 0,
		samplingCooldownMs: 2000,
		provider: "deepseek",
		model: "test-model",
		reasoningEffort: "medium",
		compactionThreshold: 128000,
		compactionKeepRecent: 20000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
}

function runtime(database: Database, id = "A", dbPath = ":memory:"): BotRuntime {
	return new BotRuntime(database, bot(id), config(dbPath), null as never, { chatActionSender: async () => true });
}

function attach(
	rt: BotRuntime,
	send: (text: string) => Promise<void>,
): void {
	(rt as any).session = {
		subscribe: () => {},
		sendUserMessage: send,
		sessionManager: { buildContextEntries: () => [] },
		dispose: async () => {},
	};
}

function insertMessage(database: Database, messageId: number, text = `message-${messageId}`): void {
	database.query(
		`INSERT INTO messages (
			chat_id, message_id, date, sender_id, display_name, username, is_bot,
			text, reply_to_message_id, reply_to_sender_id, first_seen_by
		 ) VALUES (?, ?, ?, 111, 'Alice', 'alice', 0, ?, 900, 7776264871, 'A')`,
	).run(CHAT, messageId, 1754600000 + messageId, text);
}

function replyTrigger(messageId: number) {
	return { reason: "reply" as const, chatId: CHAT, messageId };
}

function anchors(suffix: string): number[] {
	return [...suffix.matchAll(/\] #(\d+) /g)].map((match) => Number(match[1]));
}

function visibleIds(database: Database, botId = "A"): number[] {
	return listVisibleMessageIds(database, botId, CHAT, 1);
}

describe("durable direct reply delivery (REQ-REPLY-0001)", () => {
	test("an idle reply enters the provider suffix once and clears only after submission", async () => {
		insertMessage(db, 10, "模型必须看到这句");
		const rt = runtime(db);
		const suffixes: string[] = [];
		attach(rt, async (text) => { suffixes.push(text); });
		let telegramSends = 0;
		(rt as any).api = {
			sendMessage: async () => { telegramSends++; },
			sendMessageWithEntities: async () => { telegramSends++; },
		};

		expect(rt.trigger("explicit", replyTrigger(10))).toBe("started");
		await (rt as any).flushPromise;

		expect(suffixes).toHaveLength(1);
		expect(suffixes[0]).toContain("#10 Alice");
		expect(suffixes[0]).toContain("模型必须看到这句");
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
		expect(telegramSends).toBe(0);
		expect(db.query("SELECT kind FROM agent_events ORDER BY id").all()).toEqual([
			{ kind: "reply_obligation_created" },
			{ kind: "reply_obligation_delivered" },
		]);
	});

	test("provider failure retains the exact reply and a later normal flush retries it", async () => {
		insertMessage(db, 11, "失败后仍需交付");
		const rt = runtime(db);
		const attempts: string[] = [];
		attach(rt, async (text) => {
			attempts.push(text);
			if (attempts.length === 1) throw new Error("provider unavailable");
		});

		rt.trigger("explicit", replyTrigger(11));
		await (rt as any).flushPromise;
		expect(replyObligationCount(db, "A", CHAT)).toBe(1);
		expect(visibleIds(db)).not.toContain(11);

		rt.trigger("explicit");
		await (rt as any).flushPromise;
		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toBe(attempts[0]);
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
		expect(visibleIds(db)).toContain(11);
	});

	test("a reply arriving while busy coalesces into the next bounded suffix", async () => {
		insertMessage(db, 12, "first");
		const rt = runtime(db);
		const suffixes: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		attach(rt, async (text) => {
			suffixes.push(text);
			if (suffixes.length === 1) await gate;
		});

		expect(rt.trigger("explicit")).toBe("started");
		await Promise.resolve();
		insertMessage(db, 13, "busy reply");
		expect(rt.trigger("explicit", replyTrigger(13))).toBe("coalesced");
		release();
		await (rt as any).flushPromise;

		expect(suffixes).toHaveLength(2);
		expect(suffixes[0]).toContain("#12 ");
		expect(suffixes[1]).toContain("#13 ");
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
		expect(db.query("SELECT COUNT(*) AS count FROM agent_events WHERE kind = 'reply_obligation_coalesced'").get()).toEqual({ count: 1 });
	});

	test("stopping preserves the obligation without starting a provider request", async () => {
		insertMessage(db, 14, "restart must recover me");
		const rt = runtime(db);
		let providerCalls = 0;
		attach(rt, async () => { providerCalls++; });
		await rt.stop();

		expect(rt.trigger("explicit", replyTrigger(14))).toBe("skipped_stopping");
		expect(replyObligationCount(db, "A", CHAT)).toBe(1);
		expect(providerCalls).toBe(0);
	});

	test("a direct reply bypasses probability cooldown while keeping the obligation", async () => {
		insertMessage(db, 15, "cooldown reply");
		const rt = runtime(db);
		const suffixes: string[] = [];
		attach(rt, async (text) => { suffixes.push(text); });
		(rt as any).cooldownUntil = performance.now() + 60_000;

		expect(rt.trigger("explicit", replyTrigger(15))).toBe("started");
		await (rt as any).flushPromise;
		expect(suffixes).toHaveLength(1);
		expect(suffixes[0]).toContain("#15 ");
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
	});

	test("normal traffic cannot crowd a direct reply out of the token-bounded suffix", async () => {
		for (let id = 1; id <= 45; id++) insertMessage(db, id, `normal-${id}`);
		insertMessage(db, 46, "mandatory reply");
		const rt = runtime(db);
		const suffixes: string[] = [];
		attach(rt, async (text) => { suffixes.push(text); });

		rt.trigger("explicit", replyTrigger(46));
		await (rt as any).flushPromise;

		expect(suffixes).toHaveLength(1);
		expect(anchors(suffixes[0]!)).toHaveLength(46);
		expect(anchors(suffixes[0]!)).toContain(46);
		expect(visibleIds(db)).toHaveLength(46);
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
	});

	test("many replies drain chronologically in token-bounded provider calls", async () => {
		for (let id = 1; id <= 45; id++) {
			insertMessage(db, id, `reply-${id}`);
			createReplyObligation(db, "A", CHAT, id);
		}
		const rt = runtime(db);
		const suffixes: string[] = [];
		attach(rt, async (text) => { suffixes.push(text); });

		expect(rt.recoverReplyObligations()).toBe("started");
		await (rt as any).flushPromise;

		expect(suffixes).toHaveLength(1);
		expect(anchors(suffixes[0]!)).toHaveLength(45);
		expect(suffixes.flatMap(anchors)).toEqual(Array.from({ length: 45 }, (_, index) => index + 1));
		expect(replyObligationCount(db, "A", CHAT)).toBe(0);
		expect(db.query("SELECT COUNT(*) AS count FROM agent_events WHERE kind = 'reply_obligation_delivered'").get()).toEqual({ count: 45 });
	});

	test("file DB recovery is per-bot and idempotent after a committed delivery", async () => {
		const path = join(tmpdir(), `reply-recovery-${process.pid}-${Date.now()}.db`);
		let fileDb: Database | null = null;
		try {
			fileDb = openDb(path);
			insertMessage(fileDb, 100, "reply A");
			insertMessage(fileDb, 101, "reply B");
			createReplyObligation(fileDb, "A", CHAT, 100);
			createReplyObligation(fileDb, "B", CHAT, 101);
			fileDb.close();

			fileDb = openDb(path);
			const a = runtime(fileDb, "A", path);
			const b = runtime(fileDb, "B", path);
			const sentA: string[] = [];
			const sentB: string[] = [];
			attach(a, async (text) => { sentA.push(text); });
			attach(b, async (text) => { sentB.push(text); });
			expect(a.recoverReplyObligations()).toBe("started");
			expect(b.recoverReplyObligations()).toBe("started");
			await Promise.all([(a as any).flushPromise, (b as any).flushPromise]);
			expect(sentA[0]).toContain("#100 ");
			expect(sentB[0]).toContain("#101 ");
			expect(fileDb.query("SELECT bot_id AS botId, payload FROM agent_events WHERE kind = 'reply_obligation_recovered' ORDER BY bot_id").all()).toEqual([
				{ botId: "A", payload: JSON.stringify({ message_id: 100 }) },
				{ botId: "B", payload: JSON.stringify({ message_id: 101 }) },
			]);
			fileDb.close();

			fileDb = openDb(path);
			const aRestarted = runtime(fileDb, "A", path);
			const bRestarted = runtime(fileDb, "B", path);
			attach(aRestarted, async () => { throw new Error("must not repeat"); });
			attach(bRestarted, async () => { throw new Error("must not repeat"); });
			expect(aRestarted.recoverReplyObligations()).toBeNull();
			expect(bRestarted.recoverReplyObligations()).toBeNull();
			expect(replyObligationCount(fileDb, "A", CHAT)).toBe(0);
		} finally {
			fileDb?.close();
			for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
		}
	});

	test("legacy databases add reply identity and obligation storage idempotently", () => {
		const path = join(tmpdir(), `reply-migration-${process.pid}-${Date.now()}.db`);
		let fileDb: Database | null = null;
		try {
			const legacy = new Database(path, { create: true });
			legacy.exec(`
				CREATE TABLE messages (
					chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, date INTEGER NOT NULL,
					thread_id INTEGER, sender_id INTEGER, display_name TEXT, username TEXT,
					sender_tag TEXT, sender_chat TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
					text TEXT, caption TEXT, entities TEXT, rich_message TEXT,
					reply_to_message_id INTEGER, quote TEXT, forward_origin TEXT, edit_date INTEGER,
					media TEXT, first_seen_by TEXT NOT NULL, PRIMARY KEY (chat_id, message_id)
				);
			`);
			legacy.query("INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, text, first_seen_by) VALUES (?, 1, 1, 111, 'Alice', 0, 'legacy', 'A')").run(CHAT);
			legacy.close();

			fileDb = openDb(path);
			fileDb.close();
			fileDb = openDb(path);
			const columns = (fileDb.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((column) => column.name);
			expect(columns).toContain("reply_to_sender_id");
			expect(fileDb.query("SELECT text, reply_to_sender_id FROM messages WHERE message_id = 1").get()).toEqual({
				text: "legacy",
				reply_to_sender_id: null,
			});
			expect(fileDb.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reply_obligations'").get()).toEqual({
				name: "reply_obligations",
			});
		} finally {
			fileDb?.close();
			for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
		}
	});
});
