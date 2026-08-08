// REQ-STICKER-0001 regression tests: catalog loading (media identity + short_ids + per-bot
// file_id), the identity-only catalog block pinned into the stable system prompt, and send
// resolution from the catalog.

process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { SEND_SUCCESS_ACK } from "../src/agent/tools.ts";
import {
	ensureStickerCatalog,
	stickerCatalogPromptBlock,
	STICKER_CATALOG_MAX,
} from "../src/media/sticker-catalog.ts";
import { TelegramApiError } from "../src/telegram/api.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
	return {
		id: "A",
		name: "小雪",
		token: "t",
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
		...overrides,
	};
}

function makeConfig(): AppConfig {
	return {
		dataDir: "/tmp/sticker-test",
		dbPath: ":memory:",
		groupPeerId: GROUP,
		bots: [],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "openai-codex/gpt-5.6-luna:low",
		routerSecret: null,
		telegramAdmins: [],
	};
}

/** Fake BotApi: getStickerSet works; getFile throws (vision downloads unavailable in tests). */
function fakeApi(stickers: Record<string, unknown[]>): {
	call: (method: string, params: Record<string, unknown>) => Promise<unknown>;
	getFile: () => never;
} {
	return {
		call: async (method: string, params: Record<string, unknown>) => {
			if (method === "getStickerSet") {
				const name = params.name as string;
				return { name, title: name, stickers: stickers[name] ?? [] };
			}
			throw new Error(`unexpected call: ${method}`);
		},
		getFile: () => {
			throw new Error("no downloads in tests");
		},
	};
}

function sticker(id: string, emoji: string): { file_id: string; file_unique_id: string; emoji: string } {
	return { file_id: `fid-${id}`, file_unique_id: `uq-${id}`, emoji };
}

function mapSticker(botId: string, fileUniqueId: string, fileId = `fid-${botId}-${fileUniqueId}`): void {
	db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)").run(botId, fileId, fileUniqueId);
}

describe("ensureStickerCatalog (R1)", () => {
	test("persists media identity, per-bot file_id and rowid-based short_ids; block is deterministic", async () => {
		const api = fakeApi({ cats: [sticker("c1", "😺"), sticker("c2", "🐱")] });
		const res = await ensureStickerCatalog(db, api as never, "A", ["cats"]);
		expect(res.total).toBe(2);
		expect(res.sendable).toBe(2);
		expect(res.missingMapping).toBe(0);
		expect(res.truncated).toBe(false);

		const rows = db.query("SELECT file_unique_id, sticker_set, sticker_emoji, short_id FROM media WHERE kind='sticker' ORDER BY rowid").all();
		expect(rows).toEqual([
			{ file_unique_id: "uq-c1", sticker_set: "cats", sticker_emoji: "😺", short_id: "s1" },
			{ file_unique_id: "uq-c2", sticker_set: "cats", sticker_emoji: "🐱", short_id: "s2" },
		]);
		const fileIds = db.query("SELECT bot_id, file_id FROM media_file_ids ORDER BY file_id").all();
		expect(fileIds).toEqual([
			{ bot_id: "A", file_id: "fid-c1" },
			{ bot_id: "A", file_id: "fid-c2" },
		]);

		// idempotent reload: same ids, no duplicates
		await ensureStickerCatalog(db, api as never, "A", ["cats"]);
		expect(db.query("SELECT COUNT(*) c FROM media WHERE kind='sticker'").get()).toEqual({ c: 2 });
	});

	test("existing vision rows are reused (no re-download)", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision) VALUES ('uq-c1', 'sticker', 'cats', '😺', ?)").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "得意的赞同", at: 1 }),
		);
		const api = fakeApi({ cats: [sticker("c1", "😺"), sticker("c2", "🐱")] });
		await ensureStickerCatalog(db, api as never, "A", ["cats"]);
		const rows = db.query("SELECT file_unique_id, vision FROM media WHERE kind='sticker' ORDER BY rowid").all() as { file_unique_id: string; vision: string | null }[];
		expect(rows[0]!.vision).toContain("得意的赞同");
		expect(rows[1]!.vision).toBeNull();
	});

	test("R5: catalog is capped at STICKER_CATALOG_MAX with truncation flag", async () => {
		const many = Array.from({ length: STICKER_CATALOG_MAX + 5 }, (_, i) => sticker(`x${i}`, "😶"));
		const api = fakeApi({ big: many });
		const res = await ensureStickerCatalog(db, api as never, "A", ["big"]);
		expect(res.total).toBe(STICKER_CATALOG_MAX);
		expect(res.truncated).toBe(true);
		expect(db.query("SELECT COUNT(*) c FROM media WHERE kind='sticker'").get()).toEqual({ c: STICKER_CATALOG_MAX });
	});

	test("a failed set name logs and does not block the catalog", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-stale', 'sticker', 'missing-set', '😿', 's99')").run();
		const api = fakeApi({ good: [sticker("g1", "😺")] });
		const originalError = console.error;
		const originalWarn = console.warn;
		console.error = () => {};
		console.warn = () => {};
		try {
			const res = await ensureStickerCatalog(db, api as never, "A", ["missing-set", "good"]);
			expect(res.total).toBe(1);
			expect(res.sendable).toBe(1);
			expect(res.missingMapping).toBe(1);
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
		}
	});
});

describe("send from catalog (R3)", () => {
	test("executeSend resolves a catalog short_id with the bot's file_id", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-c1', 'sticker', 'cats', '😺', 's7')").run();
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'fid-c1', 'uq-c1')").run();
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never, { chatActionSender: async () => true });
		let sentSticker: string | null = null;
		(rt as any).api = {
			sendMessage: async () => { throw new Error("no text"); },
			sendSticker: async (_chatId: number, fileId: string) => {
				sentSticker = fileId;
				return { chat: { id: CHAT }, message_id: 900, from: { id: 1, is_bot: true }, date: 1754600000 };
			},
		};
		(rt as any).typingLease.start();
		const result = await (rt as any).executeSend({ sticker: "s7" });
		expect(sentSticker as string | null).toBe("fid-c1");
		expect(result.terminate).toBe(true);
		expect((rt as any).typingLease.isActive).toBe(false);
	});

	test("one send combines message, sticker, and reply with a terminating minimal ACK", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-combined', 'sticker', 'cats', '😺', 's8')").run();
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'fid-combined', 'uq-combined')").run();
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never, { chatActionSender: async () => true });
		const calls: Array<{ kind: string; chatId: number; payload: string; replyTo?: number }> = [];
		(rt as any).api = {
			sendMessageWithEntities: async (chatId: number, text: string, _entities: unknown, replyTo?: number) => {
				calls.push({ kind: "formatted", chatId, payload: text, replyTo });
				return {
					chat: { id: CHAT }, message_id: 901, from: { id: 1, is_bot: true, first_name: "小雪" },
					date: 1754600000, text,
				};
			},
			sendMessage: async () => { throw new Error("plain fallback must not run"); },
			sendSticker: async (chatId: number, fileId: string, replyTo?: number) => {
				calls.push({ kind: "sticker", chatId, payload: fileId, replyTo });
				return {
					chat: { id: CHAT }, message_id: 902, from: { id: 1, is_bot: true, first_name: "小雪" },
					date: 1754600001,
				};
			},
		};
		(rt as any).visibleMessageIds = new Set([42]);
		(rt as any).typingLease.start();

		const result = await (rt as any).executeSend({ message: "收到", sticker: "s8", reply_to: 42 });

		expect(calls).toEqual([
			{ kind: "formatted", chatId: CHAT, payload: "收到", replyTo: 42 },
			{ kind: "sticker", chatId: CHAT, payload: "fid-combined", replyTo: 42 },
		]);
		expect(result).toEqual({
			content: [{ type: "text", text: SEND_SUCCESS_ACK }],
			details: { sent: [901, 902] },
			terminate: true,
		});
		expect(db.query("SELECT message_id FROM messages ORDER BY message_id").all()).toEqual([
			{ message_id: 901 },
			{ message_id: 902 },
		]);
		expect((rt as any).typingLease.isActive).toBe(false);
	});

	test("unknown id still errors before any network call", async () => {
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never);
		let networkCalls = 0;
		(rt as any).api = { sendSticker: async () => { networkCalls++; } };
		await expect((rt as any).executeSend({ sticker: "s999" })).rejects.toThrow(/unknown sticker/);
		expect(networkCalls).toBe(0);
	});

	test("a confirmed entity rejection emits one observable plain fallback", async () => {
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never, { chatActionSender: async () => true });
		const calls: string[] = [];
		const broadcasts: unknown[] = [];
		(rt as any).api = {
			sendMessageWithEntities: async () => {
				calls.push("formatted");
				throw new TelegramApiError(400, "Bad Request: can't parse entities");
			},
			sendMessage: async (_chatId: number, text: string) => {
				calls.push("plain");
				return {
					chat: { id: CHAT }, message_id: 903, from: { id: 1, is_bot: true, first_name: "小雪" },
					date: 1754600002, text,
				};
			},
		};
		rt.sentMessageSink = (message) => broadcasts.push(message);

		await (rt as any).executeSend({ message: "# 未闭合" });

		expect(calls).toEqual(["formatted", "plain"]);
		expect(broadcasts).toHaveLength(1);
		expect(db.query("SELECT kind, payload FROM agent_events ORDER BY id").all()).toEqual([
			{ kind: "plain_fallback", payload: JSON.stringify({ message_id: 903 }) },
			{ kind: "send", payload: JSON.stringify({ reply_to: null, sticker: null, sent: [903] }) },
		]);
	});

	test("a known id without this bot's mapping is diagnosed as a candidate invariant violation", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, short_id) VALUES ('uq-b-only', 'sticker', '🅱️', 's241')").run();
		mapSticker("B", "uq-b-only");
		const rt = new BotRuntime(db, makeBot({ id: "A" }), makeConfig(), null as never);
		let networkCalls = 0;
		(rt as any).api = {
			sendMessageWithEntities: async () => { networkCalls++; },
			sendMessage: async () => { networkCalls++; },
			sendSticker: async () => { networkCalls++; },
		};
		await expect((rt as any).executeSend({ message: "hi", sticker: "s241" })).rejects.toThrow(/candidate invariant violated/);
		expect(networkCalls).toBe(0);
		const event = db.query("SELECT payload FROM agent_events WHERE kind = 'error'").get() as { payload: string };
		expect(JSON.parse(event.payload)).toMatchObject({ stage: "send", code: "candidate_invariant", sticker: "s241" });
	});
});

describe("catalog pinned into the system prompt (R4)", () => {
	test("catalog block is identity-only, deterministic, and joins the prompt after the persona", () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES ('uq-cat', 'sticker', 'cats', '😺', ?, 's1')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "目录语义", at: 1 }),
		);
		mapSticker("A", "uq-cat");
		const block = stickerCatalogPromptBlock(db, "A", ["cats"]);
		expect(block).toContain("[cats] 😺 s1");
		expect(block).not.toContain("目录语义"); // vision text never enters the stable prefix
		expect(stickerCatalogPromptBlock(db, "A", ["cats"])).toBe(block); // restart-stable
		const prompt = buildSystemPrompt("fixture persona", block);
		expect(prompt.indexOf("fixture persona")).toBeLessThan(prompt.indexOf("# Sticker 目录"));
		expect(buildSystemPrompt("fixture persona", block)).toBe(prompt);
	});

	test("stickers not sendable by this bot produce no prompt section", () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-b-only', 'sticker', 'cats', '🅱️', 's2')").run();
		mapSticker("B", "uq-b-only");
		expect(stickerCatalogPromptBlock(db, "A", ["cats"])).toBe("");
		expect(buildSystemPrompt("fixture persona", "")).not.toContain("Sticker 目录");
	});

	test("REQ-STICKER-0002: fixed catalogs never leak another bot's mappings", () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-a144', 'sticker', 'setA', '😺', 's144')").run();
		for (const id of [241, 242, 243, 244]) {
			db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES (?, 'sticker', 'setB', '🐱', ?)").run(
				`uq-b${id}`,
				`s${id}`,
			);
		}
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-shared', 'sticker', 'setS', '🤝', 's300')").run();

		mapSticker("A", "uq-a144");
		for (const id of [241, 242, 243, 244]) mapSticker("B", `uq-b${id}`);
		mapSticker("A", "uq-shared");
		mapSticker("B", "uq-shared");

		const aBlock = stickerCatalogPromptBlock(db, "A", ["setA", "setS"]);
		const bBlock = stickerCatalogPromptBlock(db, "B", ["setB", "setS"]);
		expect(aBlock).toContain("s144");
		expect(aBlock).toContain("s300");
		for (const id of [241, 242, 243, 244]) expect(aBlock).not.toContain(`s${id}`);
		expect(bBlock).toContain("s300");
		expect(bBlock).not.toContain("s144");
	});
});
