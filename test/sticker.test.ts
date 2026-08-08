// REQ-STICKER-0001 regression tests: catalog loading (media identity + short_ids + per-bot
// file_id), deterministic local retrieval, send resolution from the catalog, and the R6
// position invariant (turn candidates AFTER all messages, never in the stable prefix).

process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { buildSystemPrompt, sha256Short } from "../src/agent/prompt.ts";
import { SEND_SUCCESS_ACK } from "../src/agent/tools.ts";
import {
	ensureStickerCatalog,
	preRecognizeCatalogVision,
	stickerCandidatesForTurn,
	stickerCatalogBlock,
	STICKER_CATALOG_MAX,
} from "../src/media/sticker-catalog.ts";
import { TelegramApiError } from "../src/telegram/api.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import type { VisionExecutor } from "../src/media/vision.ts";

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

	test("VISION AC4/AC8: background catalog vision is two-wide and never mutates the stable prompt", async () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "catalog-vision-test-"));
		try {
			const api = fakeApi({ cats: [sticker("c1", "😺"), sticker("c2", "🐱"), sticker("c3", "😸")] });
			await ensureStickerCatalog(db, api as never, "A", ["cats"]);
			const promptSnapshot = buildSystemPrompt("fixture persona", stickerCatalogBlock(db, "A", ["cats"]));
			const hashSnapshot = sha256Short(promptSnapshot);
			let active = 0;
			let peak = 0;
			const started: number[] = [];
			const releases = new Map<number, () => void>();
			const executor: VisionExecutor = {
				modelRef: "openai-codex/gpt-5.6-luna:low",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				readinessFailure: null,
				describe: async (input) => {
					const id = input.bytes[0]!;
					started.push(id);
					active++;
					peak = Math.max(peak, active);
					return await new Promise((resolve) => {
						releases.set(id, () => {
							active--;
							resolve({
								text: `catalog-${id}`,
								telemetry: {
									kind: "sticker",
									sourceBytesBucket: "lt_32_kib",
									convertedBytesBucket: "unavailable",
									latencyMs: 1,
									inputTokens: 1,
									outputTokens: 1,
									reasoningTokens: 0,
									cost: 0,
									outcome: "ok",
								},
							});
						});
					});
				},
			};
			const background = preRecognizeCatalogVision(
				db,
				{
					getFile: async (fileId: string) => ({ file_path: `stickers/${fileId}.png` }),
					downloadFile: async (filePath: string) => new Uint8Array([Number(filePath.match(/c(\d)/)?.[1])]),
				} as never,
				"A",
				["cats"],
				executor,
				undefined,
				undefined,
				{ cacheDir },
			);
			let completed = false;
			void background.then(() => { completed = true; });
			for (let attempt = 0; attempt < 100 && started.length < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));

			expect(started).toEqual([1, 2]);
			expect(peak).toBe(2);
			expect(completed).toBe(false);
			expect(sha256Short(promptSnapshot)).toBe(hashSnapshot);
			expect(promptSnapshot).not.toContain("[未识别]");
			expect(promptSnapshot).not.toContain("Sticker 目录");
			releases.get(1)!();
			releases.get(2)!();
			for (let attempt = 0; attempt < 100 && started.length < 3; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));
			expect(started).toEqual([1, 2, 3]);
			expect(completed).toBe(false);
			releases.get(3)!();
			await background;

			const nextPrompt = buildSystemPrompt("fixture persona", stickerCatalogBlock(db, "A", ["cats"]));
			expect(nextPrompt).not.toContain("catalog-1");
			expect(sha256Short(nextPrompt)).toBe(hashSnapshot);
			expect(sha256Short(promptSnapshot)).toBe(hashSnapshot);
		} finally {
			rmSync(cacheDir, { recursive: true, force: true });
		}
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
		const rt = new BotRuntime(db, makeBot(), makeConfig(), null as never, { chatActionSender: async () => true });
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

	test("regression: catalog short_ids assigned before vision completes do not crash turn retrieval", () => {
		// catalog pre-recognition is background: short_id exists, vision is NULL
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, short_id) VALUES ('uq-cat0', 'sticker', 'cats', '😺', 's9')").run();
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext0', 'sticker', '😺', ?, 's10')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "上下文语义", at: 1 }),
		);
		mapSticker("A", "uq-ext0");
		const block = stickerCandidatesForTurn(db, "A", "上下文语义");
		expect(block).toContain("s10");
		expect(block).not.toContain("s9"); // no vision -> not a candidate, and no crash
	});

	test("R4: relevant catalog and observed stickers share the bounded turn candidate block", async () => {
		// catalog sticker (from set) + set-external sticker, both with vision
		db.query("INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, vision, short_id) VALUES ('uq-cat', 'sticker', 'cats', '😺', ?, 's1')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "目录语义", at: 1 }),
		);
		db.query("INSERT INTO media (file_unique_id, kind, sticker_emoji, vision, short_id) VALUES ('uq-ext', 'sticker', '😺', ?, 's2')").run(
			JSON.stringify({ model: "m", kind: "sticker", text: "上下文语义", at: 1 }),
		);
		mapSticker("A", "uq-cat");
		mapSticker("A", "uq-ext");
		const block = stickerCandidatesForTurn(db, "A", "目录语义 上下文语义");
		expect(block).toContain("s2 = 😺 上下文语义");
		expect(block).toContain("s1 = 😺 目录语义");
		expect(stickerCandidatesForTurn(db, "A", "完全无关")).toBe("");
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

		const turn = "A 目录 B 目录 双方可用 仅 A 可用 🐱 🤝 🅰️";
		const aCandidates = stickerCandidatesForTurn(db, "A", turn);
		const bCandidates = stickerCandidatesForTurn(db, "B", turn);
		expect(aCandidates).toContain("s300");
		expect(aCandidates).toContain("s301");
		for (const id of [241, 242, 243, 244]) expect(aCandidates).not.toContain(`s${id}`);
		expect(bCandidates).toContain("s300");
		expect(bCandidates).not.toContain("s144");
		expect(bCandidates).not.toContain("s301");
	});
});
