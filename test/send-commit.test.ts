process.env.TZ = "Asia/Singapore";

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { SEND_NO_RETRY_ACK, SEND_SUCCESS_ACK } from "../src/agent/tools.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import { insertSentMessage } from "../src/telegram/ingest.ts";
import { TelegramApiError } from "../src/telegram/api.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);
const SCHEMA = readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8");

function makeDb(path = ":memory:"): Database {
	const db = new Database(path);
	db.exec(SCHEMA);
	db.exec("PRAGMA busy_timeout = 0");
	return db;
}

function makeBot(): BotConfig {
	return {
		id: "A",
		name: "小雪",
		token: "test-token-must-not-leak",
		personaPath: "",
		routingP: 0,
		samplingCooldownMs: 2000,
		provider: "deepseek",
		model: "m",
		reasoningEffort: "medium",
		compactionThreshold: 128000,
		compactionKeepRecent: 20000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
}

function makeConfig(dbPath = ":memory:"): AppConfig {
	return {
		dataDir: "/tmp/send-commit-test",
		dbPath,
		groupPeerId: GROUP,
		bots: [],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "gpt-5.6-luna-low",
		routerSecret: null,
		telegramAdmins: [],
	};
}

function makeRuntime(db: Database, dbPath = ":memory:"): BotRuntime {
	return new BotRuntime(db, makeBot(), makeConfig(dbPath), null as never, { chatActionSender: async () => true });
}

function textMessage(messageId: number, text = "secret-text-must-not-leak"): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "小雪" },
		date: 1754600000 + messageId,
		text,
	};
}

function stickerMessage(messageId: number): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "小雪" },
		date: 1754600000 + messageId,
		sticker: {
			file_id: "sent-sticker-file-id",
			file_unique_id: "sent-sticker-unique-id",
			width: 128,
			height: 128,
			is_animated: false,
			is_video: false,
		},
	};
}

function mapSticker(db: Database, shortId = "s7"): void {
	db.query(
		"INSERT INTO media (file_unique_id, kind, sticker_emoji, short_id) VALUES ('catalog-unique-id', 'sticker', '😺', ?)",
	).run(shortId);
	db.query(
		"INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'catalog-file-id', 'catalog-unique-id')",
	).run();
}

interface TestSendResult {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown>;
	terminate: boolean;
}

async function captureWarnings(operation: () => Promise<TestSendResult>): Promise<{ result: TestSendResult; warnings: string[] }> {
	const original = console.warn;
	const warnings: string[] = [];
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		return { result: await operation(), warnings };
	} finally {
		console.warn = original;
	}
}

describe("Telegram create commit boundary (REQ-SEND-0002)", () => {
	test("SQLITE_BUSY after Telegram #19614 terminates without a second create and echo recovery dedupes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tg-send-lock-"));
		const path = join(dir, "messages.sqlite");
		const db = makeDb(path);
		const lockDb = new Database(path);
		lockDb.exec("PRAGMA busy_timeout = 0");
		const runtime = makeRuntime(db, path);
		const raw = textMessage(19614);
		let createCalls = 0;
		let broadcasts = 0;
		(runtime as any).api = {
			sendRichMessage: async () => {
				createCalls++;
				return raw;
			},
			sendMessage: async () => {
				throw new Error("plain fallback must not run");
			},
		};
		runtime.sentMessageSink = () => { broadcasts++; };

		let released = false;
		let releaseTimer: ReturnType<typeof setTimeout> | null = null;
		try {
			lockDb.exec("BEGIN IMMEDIATE");
			lockDb.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('lock', 1, 'lock', '{}')").run();
			releaseTimer = setTimeout(() => {
				lockDb.exec("COMMIT");
				released = true;
			}, 600);

			const { result, warnings } = await captureWarnings(() => (runtime as any).executeSend({ message: "secret-text-must-not-leak" }));

			expect(createCalls).toBe(1);
			expect(broadcasts).toBe(1);
			expect(result).toEqual({
				content: [{ type: "text", text: SEND_NO_RETRY_ACK }],
				details: {
					sent: [19614],
					outcome: "committed",
					failed_component: "message",
					failed_outcome: "committed",
					stage: "canonical_persist",
					category: "sqlite_busy",
				},
				terminate: true,
			});
			expect(warnings.join("\n")).not.toContain("secret-text-must-not-leak");
			expect(warnings.join("\n")).not.toContain("test-token-must-not-leak");

			// A later poller/recovery projection is local-only and idempotent by chat/message id.
			insertSentMessage(db, "A", raw);
			insertSentMessage(db, "A", raw);
			expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE message_id = 19614").get()).toEqual({ count: 1 });
			const diagnostic = db.query("SELECT payload FROM agent_events WHERE kind = 'send_degraded'").get() as { payload: string };
			expect(diagnostic.payload).toContain("sqlite_busy");
			expect(diagnostic.payload).not.toContain("secret-text-must-not-leak");
			expect(diagnostic.payload).not.toContain("test-token-must-not-leak");
		} finally {
			if (releaseTimer) clearTimeout(releaseTimer);
			if (!released) {
				try { lockDb.exec("ROLLBACK"); } catch { /* already released */ }
			}
			lockDb.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a transient local lock is retried without repeating Telegram I/O", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tg-send-retry-"));
		const path = join(dir, "messages.sqlite");
		const db = makeDb(path);
		const lockDb = new Database(path);
		lockDb.exec("PRAGMA busy_timeout = 0");
		const runtime = makeRuntime(db, path);
		let createCalls = 0;
		(runtime as any).api = {
			sendRichMessage: async () => {
				createCalls++;
				return textMessage(19615);
			},
			sendMessage: async () => { throw new Error("plain fallback must not run"); },
		};
		let released = false;
		let releaseTimer: ReturnType<typeof setTimeout> | null = null;
		try {
			lockDb.exec("BEGIN IMMEDIATE");
			lockDb.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('lock', 1, 'lock', '{}')").run();
			releaseTimer = setTimeout(() => {
				lockDb.exec("COMMIT");
				released = true;
			}, 60);
			const result = await (runtime as any).executeSend({ message: "one create" });
			expect(createCalls).toBe(1);
			expect(result.content).toEqual([{ type: "text", text: SEND_SUCCESS_ACK }]);
			expect(result.details).toEqual({ sent: [19615] });
			expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE message_id = 19615").get()).toEqual({ count: 1 });
		} finally {
			if (releaseTimer) clearTimeout(releaseTimer);
			if (!released) {
				try { lockDb.exec("ROLLBACK"); } catch { /* already released */ }
			}
			lockDb.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("sticker-only persistence failure is terminal committed and calls create once", async () => {
		const db = makeDb();
		mapSticker(db);
		const runtime = makeRuntime(db);
		let createCalls = 0;
		(runtime as any).api = {
			sendSticker: async () => {
				createCalls++;
				db.close();
				return stickerMessage(19616);
			},
		};
		const { result } = await captureWarnings(() => (runtime as any).executeSend({ sticker: "s7" }));
		expect(createCalls).toBe(1);
		expect(result.terminate).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: SEND_NO_RETRY_ACK }]);
		expect(result.details).toMatchObject({
			sent: [19616],
			outcome: "committed",
			failed_component: "sticker",
			failed_outcome: "committed",
			stage: "canonical_persist",
		});
	});

	test("message commit followed by sticker failure returns partial without replaying text", async () => {
		for (const [error, failedOutcome] of [
			[new DOMException("timed out", "TimeoutError"), "unknown"],
			[new TelegramApiError(400, "Bad Request: wrong sticker"), "rejected"],
		] as const) {
			const db = makeDb();
			mapSticker(db);
			const runtime = makeRuntime(db);
			const calls: string[] = [];
			(runtime as any).api = {
				sendRichMessage: async () => { calls.push("message"); return textMessage(19617); },
				sendMessage: async () => { calls.push("plain"); return textMessage(19618); },
				sendSticker: async () => { calls.push("sticker"); throw error; },
			};
			const { result } = await captureWarnings(() => (runtime as any).executeSend({ message: "one", sticker: "s7" }));
			expect(calls).toEqual(["message", "sticker"]);
			expect(result.terminate).toBe(true);
			expect(result.details).toMatchObject({
				sent: [19617],
				outcome: "partial",
				failed_component: "sticker",
				failed_outcome: failedOutcome,
				stage: "telegram_create",
			});
			expect(db.query("SELECT message_id FROM messages").all()).toEqual([{ message_id: 19617 }]);
			db.close();
		}
	});

	test("a returned Telegram message without a usable id still fences a later component rejection", async () => {
		const db = makeDb();
		mapSticker(db);
		const runtime = makeRuntime(db);
		const calls: string[] = [];
		(runtime as any).api = {
			sendRichMessage: async () => {
				calls.push("message");
				return { chat: { id: CHAT }, from: { id: 777, is_bot: true }, date: 1754600000 };
			},
			sendMessage: async () => { calls.push("plain"); return textMessage(1); },
			sendSticker: async () => {
				calls.push("sticker");
				throw new TelegramApiError(400, "Bad Request: wrong sticker");
			},
		};

		const { result } = await captureWarnings(() => (runtime as any).executeSend({ message: "one", sticker: "s7" }));

		expect(calls).toEqual(["message", "sticker"]);
		expect(result).toMatchObject({
			content: [{ type: "text", text: SEND_NO_RETRY_ACK }],
			details: {
				sent: [],
				outcome: "partial",
				failed_component: "sticker",
				failed_outcome: "rejected",
				stage: "telegram_create",
			},
			terminate: true,
		});
		db.close();
	});

	test("timeout, socket, non-JSON, 429, and 5xx are terminal unknown with no plain fallback", async () => {
		const cases: Array<[unknown, string]> = [
			[new DOMException("timed out", "TimeoutError"), "timeout"],
			[new Error("socket reset with secret-text-must-not-leak"), "network_error"],
			[new TelegramApiError(502, "non-JSON response (HTTP 502)"), "non_json"],
			[new TelegramApiError(429, "Too Many Requests"), "rate_limited"],
			[new TelegramApiError(500, "Internal Server Error"), "server_error"],
		];
		for (const [error, category] of cases) {
			const db = makeDb();
			const runtime = makeRuntime(db);
			let richCalls = 0;
			let plainCalls = 0;
			(runtime as any).api = {
				sendRichMessage: async () => { richCalls++; throw error; },
				sendMessage: async () => { plainCalls++; return textMessage(1); },
			};
			const { result, warnings } = await captureWarnings(() => (runtime as any).executeSend({ message: "secret-text-must-not-leak" }));
			expect(richCalls).toBe(1);
			expect(plainCalls).toBe(0);
			expect(result).toMatchObject({
				content: [{ type: "text", text: SEND_NO_RETRY_ACK }],
				details: {
					sent: [],
					outcome: "unknown",
					failed_component: "message",
					failed_outcome: "unknown",
					stage: "telegram_create",
					category,
				},
				terminate: true,
			});
			expect(warnings.join("\n")).not.toContain("secret-text-must-not-leak");
			const diagnostic = db.query("SELECT payload FROM agent_events WHERE kind = 'send_degraded'").get() as { payload: string };
			expect(diagnostic.payload).not.toContain("secret-text-must-not-leak");
			db.close();
		}
	});

	test("post-commit exposure, broadcast, event, and typing failures cannot overturn the terminal result", async () => {
		const db = makeDb();
		const runtime = makeRuntime(db);
		let createCalls = 0;
		(runtime as any).api = {
			sendRichMessage: async () => { createCalls++; return textMessage(19619); },
			sendMessage: async () => { throw new Error("plain fallback must not run"); },
		};
		(runtime as any).markExposed = () => { throw new Error("exposure secret-text-must-not-leak"); };
		runtime.sentMessageSink = () => { throw new Error("broadcast secret-text-must-not-leak"); };
		runtime.eventSink = () => { throw new Error("event secret-text-must-not-leak"); };
		(runtime as any).typingLease.stop = () => { throw new Error("typing secret-text-must-not-leak"); };

		const { result, warnings } = await captureWarnings(() => (runtime as any).executeSend({ message: "secret-text-must-not-leak" }));

		expect(createCalls).toBe(1);
		expect(result.terminate).toBe(true);
		expect(result.details).toMatchObject({
			sent: [19619],
			outcome: "committed",
			failed_component: "message",
			failed_outcome: "committed",
			stage: "local_effect",
			category: "exposure_failed",
		});
		expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE message_id = 19619").get()).toEqual({ count: 1 });
		expect(db.query("SELECT COUNT(*) AS count FROM agent_events WHERE kind = 'send_degraded'").get()).toEqual({ count: 1 });
		expect(warnings.join("\n")).not.toContain("secret-text-must-not-leak");
		db.close();
	});

	test("all deterministic preflight failures keep Telegram create count at zero", async () => {
		const db = makeDb();
		const runtime = makeRuntime(db);
		let networkCalls = 0;
		(runtime as any).api = {
			sendRichMessage: async () => { networkCalls++; return textMessage(1); },
			sendMessage: async () => { networkCalls++; return textMessage(1); },
			sendSticker: async () => { networkCalls++; return stickerMessage(2); },
		};
		await expect((runtime as any).executeSend({})).rejects.toThrow(/at least one/);
		await expect((runtime as any).executeSend({ message: "reply", reply_to: 42 })).rejects.toThrow(/reply_not_visible/);
		await expect((runtime as any).executeSend({ sticker: "s404" })).rejects.toThrow(/unknown sticker/);
		db.query(
			"INSERT INTO media (file_unique_id, kind, sticker_emoji, short_id) VALUES ('missing-map', 'sticker', '😿', 's8')",
		).run();
		await expect((runtime as any).executeSend({ message: "text", sticker: "s8" })).rejects.toThrow(/candidate invariant/);
		expect(networkCalls).toBe(0);
		db.close();
	});
});
