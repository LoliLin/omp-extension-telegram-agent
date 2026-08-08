import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	analyzeRouting,
	formatRoutingAudit,
	openRoutingAuditDatabase,
	readRoutingAuditLog,
	resolveRoutingAuditInput,
	type RoutingAuditBotInput,
} from "../src/agent/routing-audit.ts";
import { routingValue } from "../src/agent/router.ts";
import type { BotConfig } from "../src/config.ts";
import { openDb, setBotState, setDaemonState } from "../src/db/db.ts";
import { CONTROL_ROUTING_KEY } from "../src/telegram/control-state.ts";

const CHAT = -1001234567890;
const SECRET = "fixture-router-secret-never-print";

function memoryDb(): Database {
	const db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	return db;
}

function auditBots(): RoutingAuditBotInput[] {
	return [
		{ id: "internal-alpha", name: "HiddenAlpha", routingP: 0.66, userId: 7001, username: "ultra_private_alpha_bot" },
		{ id: "internal-beta", name: "HiddenBeta", routingP: 0.34, userId: 7002, username: "ultra_private_beta_bot" },
	];
}

function insertMessage(
	db: Database,
	values: {
		messageId: number;
		isBot?: number;
		senderId?: number;
		text?: string | null;
		caption?: string | null;
		entities?: string | null;
		replyToMessageId?: number | null;
		replyToSenderId?: number | null;
	},
): void {
	db.query(`INSERT OR IGNORE INTO messages (
		chat_id, message_id, date, sender_id, display_name, username, is_bot,
		text, caption, entities, reply_to_message_id, reply_to_sender_id, first_seen_by
	) VALUES (?, ?, 1, ?, 'Private Sender', 'private_sender', ?, ?, ?, ?, ?, ?, 'source-bot')`).run(
		CHAT,
		values.messageId,
		values.senderId ?? 42,
		values.isBot ?? 0,
		values.text ?? null,
		values.caption ?? null,
		values.entities ?? null,
		values.replyToMessageId ?? null,
		values.replyToSenderId ?? null,
	);
}

function findBucketIds(): [number, number] {
	let alpha = 0;
	let beta = 0;
	for (let id = 1; id < 10_000 && (!alpha || !beta); id++) {
		const value = routingValue(SECRET, CHAT, id);
		if (!alpha && value < 0.66) alpha = id;
		if (!beta && value >= 0.66) beta = id;
	}
	return [alpha, beta];
}

function fixture(): { db: Database; input: Parameters<typeof analyzeRouting>[1] } {
	const db = memoryDb();
	const [alphaId, betaId] = findBucketIds();
	insertMessage(db, { messageId: alphaId, text: "ordinary fixture alpha" });
	insertMessage(db, { messageId: betaId, text: "ordinary fixture beta" });
	// Canonical PK makes a duplicate poller copy one audit sample, not a second draw.
	insertMessage(db, { messageId: alphaId, text: "duplicate must not replace" });
	insertMessage(db, {
		messageId: 20_001,
		text: "🙂 @ultra_private_alpha_bot HiddenBeta",
		entities: JSON.stringify([{ type: "mention", offset: 3, length: 24 }]),
	});
	insertMessage(db, { messageId: 20_002, text: "reply", replyToMessageId: 9_999, replyToSenderId: 7002 });
	insertMessage(db, { messageId: 20_003, text: "HiddenBeta please answer" });
	insertMessage(db, { messageId: 20_004, isBot: 1, senderId: 7001, text: "bot alpha output" });
	insertMessage(db, { messageId: 20_005, isBot: 1, senderId: 7002, text: "bot beta output" });
	db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch) VALUES (?, 1, 'private-model', 1)").run("internal-alpha");
	db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch) VALUES (?, 2, 'private-model', 1)").run("internal-alpha");
	db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch) VALUES (?, 3, 'private-model', 1)").run("internal-beta");
	const logText = [
		"[route] route_probability_triggered bot=internal-alpha msg=#900001 count=1",
		"[route] route_probability_triggered bot=internal-beta msg=#900002 count=2",
		"[route] route_probability_skipped_busy bot=internal-alpha msg=#900003 count=1",
		"[route] route_probability_skipped_cooldown bot=internal-beta msg=#900004 count=1",
		"[route] msg #900005 -> bot internal-alpha reason=explicit outcome=started",
		"[route] msg #900006 -> bot internal-beta reason=reply outcome=coalesced",
		"[route] route_probability_triggered bot=unknown-private-bot msg=#900007 count=3",
		"[route] route_probability_skipped_busy truncated-private-line",
	].join("\n");
	return {
		db,
		input: { chatId: CHAT, secret: SECRET, bots: auditBots(), logText, logTruncated: true },
	};
}

describe("routing audit", () => {
	test("100,000 deterministic messages land in exactly one 0.66/0.34 bucket", () => {
		const sample = (): string => {
			let alpha = 0;
			let beta = 0;
			let nobody = 0;
			let invalid = 0;
			for (let messageId = 1; messageId <= 100_000; messageId++) {
				const value = routingValue(SECRET, CHAT, messageId);
				const matches = Number(value < 0.66) + Number(value >= 0.66 && value < 1);
				if (matches !== 1) invalid++;
				if (value < 0.66) alpha++;
				else if (value < 1) beta++;
				else nobody++;
			}
			return JSON.stringify({ alpha, beta, nobody, invalid });
		};
		const first = sample();
		expect(sample()).toBe(first);
		const counts = JSON.parse(first) as { alpha: number; beta: number; nobody: number; invalid: number };
		expect(counts.alpha + counts.beta).toBe(100_000);
		expect(counts.nobody).toBe(0);
		expect(counts.invalid).toBe(0);
		expect(counts.alpha / 100_000).toBeGreaterThan(0.65);
		expect(counts.alpha / 100_000).toBeLessThan(0.67);
	});

	test("separates assignment, explicit reasons, lifecycle, runs, and public messages", () => {
		const { db, input } = fixture();
		try {
			const report = analyzeRouting(db, input);
			expect(report.humanMessages).toBe(5);
			expect(report.botMessagesIgnored).toBe(2);
			expect(report.probabilitySample).toBe(2);
			expect(report.probabilityNobody).toBe(0);
			expect(report.classificationStatus).toBe("complete");
			expect(report.bots.map((bot) => bot.assignments)).toEqual([1, 1]);
			expect(report.bots.map((bot) => bot.reasons)).toEqual([
				{ explicit: 1, reply: 0, name: 0 },
				{ explicit: 0, reply: 1, name: 1 },
			]);
			expect(report.bots[0]!.probabilityOutcomes).toEqual({
				started: 1, busy: 1, cooldown: 0, coalesced: 0, stopping: 0, missingRuntime: 0,
			});
			expect(report.bots[1]!.probabilityOutcomes).toEqual({
				started: 1, busy: 0, cooldown: 1, coalesced: 0, stopping: 0, missingRuntime: 0,
			});
			expect(report.bots[0]!.explicitOutcomes.started).toBe(1);
			expect(report.bots[1]!.explicitOutcomes.coalesced).toBe(1);
			expect(report.bots.map((bot) => bot.llmRuns)).toEqual([2, 1]);
			expect(report.bots.map((bot) => bot.publicMessages)).toEqual([1, 1]);
			expect(report.log).toEqual({
				status: "partial", truncated: true, recognizedRecords: 6, unknownBotRecords: 1, malformedRecords: 1,
			});
			const first = formatRoutingAudit(report);
			expect(formatRoutingAudit(analyzeRouting(db, input))).toBe(first);
		} finally {
			db.close();
		}
	});

	test("an underfull probability sum reports the unassigned interval as nobody", () => {
		const db = memoryDb();
		try {
			let messageId = 1;
			while (routingValue(SECRET, CHAT, messageId) < 0.5) messageId++;
			insertMessage(db, { messageId, text: "ordinary unassigned fixture" });
			const report = analyzeRouting(db, {
				chatId: CHAT,
				secret: SECRET,
				bots: [
					{ id: "one", name: "One", routingP: 0.2, userId: 71, username: "one_bot" },
					{ id: "two", name: "Two", routingP: 0.3, userId: 72, username: "two_bot" },
				],
				logText: null,
			});
			expect(report.probabilitySample).toBe(1);
			expect(report.probabilityNobody).toBe(1);
			expect(report.bots.map((bot) => bot.assignments)).toEqual([0, 0]);
		} finally {
			db.close();
		}
	});

	test("empty, single-bot, N-bot, invalid entities, and missing log remain honest", () => {
		const db = memoryDb();
		try {
			insertMessage(db, { messageId: 91_919, text: "invalid entity fixture", entities: "{" });
			const report = analyzeRouting(db, {
				chatId: CHAT,
				secret: SECRET,
				bots: [
					{ id: "one", name: "One", routingP: 0.2, userId: null, username: null },
					{ id: "two", name: "Two", routingP: 0.3, userId: 72, username: "two_bot" },
					{ id: "three", name: "Three", routingP: 0.5, userId: 73, username: "three_bot" },
				],
				logText: null,
			});
			expect(report.bots).toHaveLength(3);
			expect(report.classificationStatus).toBe("partial");
			expect(report.invalidEntityRows).toBe(1);
			expect(report.log.status).toBe("unavailable");
			expect(report.bots[0]!.publicMessages).toBeNull();
			const output = formatRoutingAudit(report);
			expect(output).toContain("public");
			expect(output).toContain("unavailable");
			expect(output).not.toContain("NaN");
			expect(output).not.toContain("Infinity");

			const empty = analyzeRouting(db, {
				chatId: -1009999999999,
				secret: SECRET,
				bots: [{ id: "solo", name: "Solo", routingP: 1, userId: 99, username: "solo_bot" }],
				logText: "",
			});
			expect(empty.humanMessages).toBe(0);
			expect(empty.probabilityNobody).toBe(0);
			expect(formatRoutingAudit(empty)).toContain("0/0 (n/a)");
			expect(formatRoutingAudit(empty)).toContain("daemon-log: partial");
		} finally {
			db.close();
		}
	});

	test("uses persisted routing overrides and daemon router secret without mutating state", () => {
		const db = memoryDb();
		try {
			setBotState(db, "one", CONTROL_ROUTING_KEY, "0.66");
			setBotState(db, "two", CONTROL_ROUTING_KEY, "0.34");
			setBotState(db, "one", "bot_user_id", "8101");
			setBotState(db, "one", "bot_username", "one_bot");
			setBotState(db, "two", "bot_user_id", "8102");
			setBotState(db, "two", "bot_username", "two_bot");
			setDaemonState(db, "router_secret", SECRET);
			const bot = (id: string): BotConfig => ({
				id, name: id, token: "unused", personaPath: "/private/persona", routingP: 0.5,
				samplingCooldownMs: 2000, provider: "unused", model: "unused",
				reasoningEffort: "low", compactionThreshold: 1,
				compactionKeepRecent: 1, tools: { send: true, search: false, runJs: false }, stickerSets: [],
			});
			const input = resolveRoutingAuditInput(db, {
				groupPeerId: 1234567890,
				routerSecret: null,
				bots: [bot("one"), bot("two")],
			}, null);
			expect(input.bots.map((item) => item.routingP)).toEqual([0.66, 0.34]);
			expect(input.secret).toBe(SECRET);
			expect(input.bots.map((item) => item.userId)).toEqual([8101, 8102]);
			expect(db.query("SELECT COUNT(*) AS count FROM bot_state").get()).toEqual({ count: 6 });
		} finally {
			db.close();
		}
	});

	test("formatter omits bot identity, message content/id, secrets, and paths", () => {
		const { db, input } = fixture();
		try {
			const output = formatRoutingAudit(analyzeRouting(db, input));
			for (const forbidden of [
				"internal-alpha",
				"internal-beta",
				"HiddenAlpha",
				"HiddenBeta",
				"ultra_private_alpha_bot",
				"fixture-router-secret-never-print",
				"ordinary fixture alpha",
				"900001",
				"1234567890",
				"7001",
				"private-model",
				"/private/persona",
			]) {
				expect(output).not.toContain(forbidden);
			}
			expect(output).toContain("bot-1");
			expect(output).toContain("bot-2");
		} finally {
			db.close();
		}
	});

	test("opens file databases read-only and bounds a truncated log", () => {
		const root = mkdtempSync(join(tmpdir(), "routing-audit-"));
		const dbPath = join(root, "agent.db");
		const writable = openDb(dbPath);
		writable.close();
		const readonly = openRoutingAuditDatabase(dbPath);
		try {
			expect(() => readonly.query("INSERT INTO daemon_state (key, value) VALUES ('x', 'y')").run()).toThrow();
		} finally {
			readonly.close();
		}
		const logPath = join(root, "daemon.log");
		writeFileSync(logPath, "discard-this-line\nkeep-this-line\nlast-line\n");
		const log = readRoutingAuditLog(logPath, 25);
		expect(log?.truncated).toBe(true);
		expect(log?.text).not.toContain("discard-this-line");
		expect(log?.text).toContain("last-line");
		rmSync(root, { recursive: true, force: true });
	});
});
