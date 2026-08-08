// BotRuntime integration contracts for the structured context protocol.

process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

afterEach(() => db.close());

function appConfig(): AppConfig {
	return {
		dataDir: "/tmp/context-refactor-test",
		dbPath: ":memory:",
		groupPeerId: GROUP,
		bots: [],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "openai-codex/gpt-5.6-luna:low",
		routerSecret: null,
		telegramAdmins: [],
	};
}

function botConfig(): BotConfig {
	return {
		id: "A",
		name: "A",
		token: "test-token",
		personaPath: "",
		routingP: 0,
		samplingCooldownMs: 2_000,
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		reasoningEffort: "off",
		compactionThreshold: 128_000,
		compactionKeepRecent: 20_000,
		tools: { send: true, search: false, runJs: false },
		stickerSets: [],
	};
}

describe("BotRuntime context integration", () => {
	test("compaction visibility is a structured replacement", () => {
		const runtime = new BotRuntime(db, botConfig(), appConfig(), null as never, { chatActionSender: async () => true });
		const state = (runtime as any).contextStateFromEntries([
			{
				type: "custom_message",
				details: {
					version: 2,
					consumedSeq: 10,
					providerText: "old",
					visibleMessageIds: [1],
					events: [],
				},
			},
			{
				type: "compaction",
				details: { consumedSeq: 10, visibleMessageIds: [2], unresolvedReplyMessageIds: [3] },
			},
		], 0) as { consumedSeq: number; visible: Set<number> };

		expect(state.consumedSeq).toBe(10);
		expect([...state.visible]).toEqual([2]);
	});

	test("reply_to accepts only a genuinely visible reference", async () => {
		const runtime = new BotRuntime(db, botConfig(), appConfig(), null as never, { chatActionSender: async () => true });
		let telegramCalls = 0;
		(runtime as any).api = {
			sendMessageWithEntities: async (_chatId: number, text: string) => {
				telegramCalls++;
				return {
					chat: { id: CHAT }, message_id: 100, date: 1_754_600_100,
					from: { id: 999, is_bot: true, first_name: "A" }, text,
				};
			},
			sendMessage: async () => { throw new Error("fallback must not run"); },
		};

		await expect((runtime as any).executeSend({ message: "reply", reply_to: 42 })).rejects.toThrow("reply_not_visible");
		expect(telegramCalls).toBe(0);
		(runtime as any).visibleMessageIds.add(42);
		const result = await (runtime as any).executeSend({ message: "reply", reply_to: 42 });
		expect(result.details.sent).toEqual([100]);
		expect(telegramCalls).toBe(1);
	});
});
