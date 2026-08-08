// REQ-STICKER-0001 regression tests: catalog loading (media identity + short_ids + per-bot
// file_id), deterministic serialization, send resolution from the catalog, dynamic candidate
// exclusion of catalog stickers, and the R6 position invariant (candidates AFTER all messages).

process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { ensureStickerCatalog, stickerCatalogBlock, STICKER_CATALOG_MAX } from "../src/media/sticker-catalog.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { MessageRow } from "../src/agent/serialize.ts";

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
		deepseekApiKey: "",
		tinyfishApiKey: "",
		auxiliaryVisualModel: "gpt-5.6-luna-low",
		routerSecret: null,
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

		const block = stickerCatalogBlock(db, "A", ["cats"]);
		expect(block).toContain("s1 = 😺 [未识别]");
		expect(block).toContain("s2 = 🐱 [未识别]");
		expect(stickerCatalogBlock(db, "A", ["cats"])).toBe(block); // deterministic

		// idempotent reload: same ids, no duplicates
		await ensureStickerCatalog(db, api as never, "A", ["cats"]);
		expect(db.query("SELECT COUNT(*) c FROM media WHERE kind='sticker'").get()).toEqual({ c: 2 });
	});

	test("existing vision rows are reused (no re-download) and serialized with their text", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision) VALUES ('uq-c1', 'sticker', 'cats', '😺', ?)").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "得意的赞同", at: 1 }),
		);
		const api = fakeApi({ cats: [sticker("c1", "😺"), sticker("c2", "🐱")] });
		await ensureStickerCatalog(db, api as never, "A", ["cats"]);
		const block = stickerCatalogBlock(db, "A", ["cats"]);
		expect(block).toContain("s1 = 😺 得意的赞同");
		expect(block).toContain("s2 = 🐱 [未识别]");
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
			expect(stickerCatalogBlock(db, "A", ["missing-set", "good"])).not.toContain("s99");
		} finally {
			console.error = originalError;
			console.warn = originalWarn;
		}
	});
});

describe("catalog serialization (R2)", () => {
	test("order follows configured set order, then rowid; empty for no sets", () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-a1', 'sticker', 'setA', '😺', 's1')").run();
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-b1', 'sticker', 'setB', '🐱', 's2')").run();
		mapSticker("A", "uq-a1");
		mapSticker("A", "uq-b1");
		const block = stickerCatalogBlock(db, "A", ["setB", "setA"]);
		expect(block.indexOf("s2")).toBeLessThan(block.indexOf("s1")); // setB before setA
		expect(stickerCatalogBlock(db, "A", [])).toBe("");
	});
});

describe("send from catalog (R3)", () => {
	test("executeSend resolves a catalog short_id with the bot's file_id", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-c1', 'sticker', 'cats', '😺', 's7')").run();
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', 'fid-c1', 'uq-c1')").run();
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never);
		let sentSticker: string | null = null;
		(rt as any).api = {
			sendMessage: async () => { throw new Error("no text"); },
			sendSticker: async (_chatId: number, fileId: string) => {
				sentSticker = fileId;
				return { chat: { id: CHAT }, message_id: 900, from: { id: 1, is_bot: true }, date: 1754600000 };
			},
		};
		(rt as any).exposed = new Set();
		const result = await (rt as any).executeSend({ sticker: "s7" });
		expect(sentSticker as string | null).toBe("fid-c1");
		expect(result.terminate).toBe(true);
	});

	test("unknown id still errors before any network call", async () => {
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never);
		let networkCalls = 0;
		(rt as any).api = { sendSticker: async () => { networkCalls++; } };
		await expect((rt as any).executeSend({ sticker: "s999" })).rejects.toThrow(/unknown sticker/);
		expect(networkCalls).toBe(0);
	});

	test("a known id without this bot's mapping is diagnosed as a candidate invariant violation", async () => {
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, short_id) VALUES ('uq-b-only', 'sticker', '🅱️', 's241')").run();
		mapSticker("B", "uq-b-only");
		const rt = new BotRuntime(db, makeBot({ id: "A" }), makeConfig(), null as never);
		let networkCalls = 0;
		(rt as any).api = {
			sendMessage: async () => { networkCalls++; },
			sendSticker: async () => { networkCalls++; },
		};
		await expect((rt as any).executeSend({ message: "hi", sticker: "s241" })).rejects.toThrow(/candidate invariant violated/);
		expect(networkCalls).toBe(0);
		const event = db.query("SELECT payload FROM agent_events WHERE kind = 'error'").get() as { payload: string };
		expect(JSON.parse(event.payload)).toMatchObject({ stage: "send", code: "candidate_invariant", sticker: "s241" });
	});
});

describe("dynamic candidates coexistence (R4/R6)", () => {
	function insertStickerMsg(messageId: number, fileUniqueId: string): void {
		db.query(
			`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, media, first_seen_by)
			 VALUES (?, ?, ?, 111, 'Alice', 'alice', 0, NULL, ?, 'A')`,
		).run(CHAT, messageId, 1754600000 + messageId, JSON.stringify({ kind: "sticker", file_unique_id: fileUniqueId, sticker_emoji: "😺" }));
	}

	function attachFakeSession(rt: BotRuntime): { sent: string[] } {
		const fake = { sent: [] as string[], listener: null as null };
		(rt as any).session = {
			subscribe: () => {},
			sendUserMessage: async (t: string) => { fake.sent.push(t); },
			sessionManager: { buildContextEntries: () => [] },
			dispose: async () => {},
		};
		return fake;
	}

	test("R6: dynamic candidates serialize AFTER all messages (suffix tail), never before", async () => {
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never);
		const fake = attachFakeSession(rt);
		// set-external stickers seen in context, with vision
		insertStickerMsg(1, "uq-ext-1");
		insertStickerMsg(2, "uq-ext-2");
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext-1', 'sticker', '😺', ?, 's5')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "外部 sticker 语义", at: 1 }),
		);
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext-2', 'sticker', '😺', ?, 's6')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "另一个", at: 1 }),
		);
		mapSticker("A", "uq-ext-1");
		mapSticker("A", "uq-ext-2");
		(rt as any).ensureBatchVision = async () => {};
		rt.trigger();
		await (rt as any).flushPromise;
		expect(fake.sent.length).toBe(1);
		const out = fake.sent[0]!;
		const msgIdx = out.indexOf("#1 ");
		const catIdx = out.indexOf("Available stickers:");
		expect(msgIdx).toBeGreaterThanOrEqual(0);
		expect(catIdx).toBeGreaterThan(msgIdx); // candidates strictly AFTER the message lines
		expect(out.lastIndexOf("Available stickers:")).toBe(catIdx); // exactly one block, at the tail
	});

	test("regression: catalog short_ids assigned before vision completes must not crash the candidates block", () => {
		// catalog pre-recognition is background: short_id exists, vision is NULL
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-cat0', 'sticker', 'cats', '😺', 's9')").run();
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext0', 'sticker', '😺', ?, 's10')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "上下文语义", at: 1 }),
		);
		mapSticker("A", "uq-ext0");
		const rt = new BotRuntime(db, makeBot({ stickerSets: ["cats"] }), makeConfig(), null as never);
		const block = (rt as any).stickerCandidatesBlock() as string;
		expect(block).toContain("s10");
		expect(block).not.toContain("s9"); // no vision -> not a candidate, and no crash
	});

	test("R4: catalog stickers are excluded from the dynamic candidates block", async () => {
		// catalog sticker (from set) + set-external sticker, both with vision
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES ('uq-cat', 'sticker', 'cats', '😺', ?, 's1')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "目录语义", at: 1 }),
		);
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext', 'sticker', '😺', ?, 's2')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "上下文语义", at: 1 }),
		);
		mapSticker("A", "uq-cat");
		mapSticker("A", "uq-ext");
		const rt = new BotRuntime(db, makeBot({ stickerSets: ["cats"] }), makeConfig(), null as never);
		const block = (rt as any).stickerCandidatesBlock() as string;
		expect(block).toContain("s2 = 😺 上下文语义");
		expect(block).not.toContain("s1");
		// without sets, nothing is excluded
		const rt2 = new BotRuntime(db, makeBot(), makeConfig(), null as never);
		const block2 = (rt2 as any).stickerCandidatesBlock() as string;
		expect(block2).toContain("s1");
		expect(block2).toContain("s2");
	});

	test("REQ-STICKER-0002: fixed catalogs and dynamic candidates never leak another bot's mappings", () => {
		const vision = (text: string) => JSON.stringify({ model: "m", kind: "sticker", text, at: 1 });
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES ('uq-a144', 'sticker', 'setA', '😺', ?, 's144')").run(vision("A 目录"));
		for (const id of [241, 242, 243, 244]) {
			db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES (?, 'sticker', 'setB', '🐱', ?, ?)").run(
				`uq-b${id}`,
				vision(`B 目录 ${id}`),
				`s${id}`,
			);
		}
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-shared', 'sticker', '🤝', ?, 's300')").run(vision("双方可用"));
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-a-only', 'sticker', '🅰️', ?, 's301')").run(vision("仅 A 可用"));

		mapSticker("A", "uq-a144");
		for (const id of [241, 242, 243, 244]) mapSticker("B", `uq-b${id}`);
		mapSticker("A", "uq-shared");
		mapSticker("B", "uq-shared");
		mapSticker("A", "uq-a-only");

		expect(stickerCatalogBlock(db, "A", ["setA"])).toContain("s144");
		expect(stickerCatalogBlock(db, "A", ["setB"])).toBe("");
		expect(stickerCatalogBlock(db, "B", ["setB"])).toContain("s241");
		expect(stickerCatalogBlock(db, "B", ["setA"])).toBe("");

		const aCandidates = (new BotRuntime(db, makeBot({ id: "A", stickerSets: ["setA"] }), makeConfig(), null as never) as any).stickerCandidatesBlock() as string;
		const bCandidates = (new BotRuntime(db, makeBot({ id: "B", stickerSets: ["setB"] }), makeConfig(), null as never) as any).stickerCandidatesBlock() as string;
		expect(aCandidates).toContain("s300");
		expect(aCandidates).toContain("s301");
		for (const id of [241, 242, 243, 244]) expect(aCandidates).not.toContain(`s${id}`);
		expect(bCandidates).toContain("s300");
		expect(bCandidates).not.toContain("s144");
		expect(bCandidates).not.toContain("s301");
	});
});
