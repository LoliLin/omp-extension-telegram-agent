import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig } from "../src/config.ts";
import type { ManualCompactResult, RuntimeControlSnapshot } from "../src/agent/runtime.ts";
import { BotApi, TelegramApiError } from "../src/telegram/api.ts";
import { TelegramControlCommandService, parseTelegramControlCommand, type TelegramControlRuntime } from "../src/telegram/control-command.ts";
import { TelegramControlState } from "../src/telegram/control-state.ts";
import { publishTelegramControlMenus, TELEGRAM_CONTROL_MENU, TelegramControlCoordinator } from "../src/telegram/control-integration.ts";
import { Poller } from "../src/telegram/poller.ts";
import { getBotState } from "../src/db/db.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);
const IDENTITIES = [
	{ id: "A", username: "alpha_bot" },
	{ id: "B", username: "beta_bot" },
] as const;

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function bot(id: string): BotConfig {
	return {
		id,
		name: id === "A" ? "小雪" : "小雨",
		token: `${id}:secret-token`,
		personaPath: `/private/${id}.md`,
		routingP: id === "A" ? 0.2 : 0.3,
		samplingCooldownMs: 2_000,
		model: `model-${id}`,
		reasoningEffort: "medium",
		compactionThreshold: 128_000,
		compactionKeepRecent: 20_000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
}

function commandUpdate(updateId = 1): Record<string, unknown> {
	const command = "/tg@beta_bot set A cooldown_ms 0";
	return {
		update_id: updateId,
		message: {
			message_id: 100,
			from: { id: 42, is_bot: false, first_name: "Admin", username: "aac6fef" },
			chat: { id: CHAT, type: "supergroup" },
			date: 1_754_600_000,
			text: command,
			entities: [{ type: "bot_command", offset: 0, length: "/tg@beta_bot".length }],
		},
	};
}

function replyMessage(messageId: number, text: string): Record<string, unknown> {
	return {
		message_id: messageId,
		from: { id: 222, is_bot: true, first_name: "小雨", username: "beta_bot" },
		chat: { id: CHAT, type: "supergroup" },
		date: 1_754_600_001,
		text,
		reply_to_message: { message_id: 100 },
	};
}

class FakeRuntime implements TelegramControlRuntime {
	consumed: number[] = [];
	controlSnapshot(): RuntimeControlSnapshot {
		return { state: "idle", epoch: 1, model: "model", lastCompact: null };
	}
	compactForControl(): Promise<ManualCompactResult> {
		return Promise.resolve({ ok: true, epoch: 2, tokensBefore: 100 });
	}
	consumeControlMessage(messageId: number): void {
		this.consumed.push(messageId);
	}
}

function injectPollApi(poller: Poller, api: { getUpdates(offset: number, timeoutSec: number): Promise<unknown[]> }): void {
	(poller as unknown as { api: typeof api }).api = api;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("Telegram control daemon integration (REQ-CMD-0001)", () => {
	test("BotApi and best-effort startup menu use the exact BotCommand payload", async () => {
		const api = new BotApi("test-token");
		const calls: unknown[] = [];
		(api as any).call = async (method: string, params: unknown) => {
			calls.push({ method, params });
			return true;
		};
		expect(await api.setMyCommands(TELEGRAM_CONTROL_MENU)).toBe(true);
		expect(calls).toEqual([{ method: "setMyCommands", params: { commands: TELEGRAM_CONTROL_MENU } }]);

		const warnings: string[] = [];
		let goodCalls = 0;
		await publishTelegramControlMenus(new Map([
			["A", { setMyCommands: async (commands) => { goodCalls++; expect(commands).toEqual(TELEGRAM_CONTROL_MENU); return true as const; } }],
			["B", { setMyCommands: async () => { throw new Error("https://api.telegram.org/botsecret-token/private"); } }],
		]), (message) => warnings.push(message));
		expect(goodCalls).toBe(1);
		expect(warnings).toEqual(["[telegram-control] menu publish failed bot=B category=request_failed"]);
		expect(warnings[0]).not.toContain("secret-token");
	});

	test("fake Poller → command → target BotApi → canonical DB/broadcast executes once and never exposes command/reply", async () => {
		const bots = [bot("A"), bot("B")];
		const state = new TelegramControlState(db, bots);
		const runtimeA = new FakeRuntime();
		const runtimeB = new FakeRuntime();
		const commands = new TelegramControlCommandService(
			db,
			bots,
			state,
			new Map([["A", runtimeA], ["B", runtimeB]]),
			["@aac6fef"],
		);
		const replyCalls: unknown[] = [];
		const broadcasts: Array<{ chatId: number; messageId: number }> = [];
		const coordinator = new TelegramControlCoordinator(
			db,
			commands,
			new Map([
				["A", { sendMessage: async () => { throw new Error("wrong reply bot"); } }],
				["B", { sendMessage: async (chatId: number, text: string, replyTo?: number) => {
					replyCalls.push({ chatId, text, replyTo });
					return replyMessage(900, text);
				} }],
			]),
			(message) => broadcasts.push({ chatId: message.chatId, messageId: message.messageId }),
		);

		const poller = new Poller(db, "A", "token", GROUP, async (result, raw, botId) => {
			if (result.chatId != null && result.messageId != null) broadcasts.push({ chatId: result.chatId, messageId: result.messageId });
			const parsed = parseTelegramControlCommand(raw, botId, IDENTITIES);
			expect(parsed).not.toBeNull();
			await coordinator.handle(parsed!);
		});
		let polls = 0;
		injectPollApi(poller, {
			getUpdates: async () => {
				polls++;
				if (polls === 1) return [commandUpdate(1), commandUpdate(2)];
				await new Promise((resolve) => setTimeout(resolve, 10));
				return [];
			},
		});
		const running = poller.run();
		await waitFor(() => (db.query("SELECT COUNT(*) n FROM messages").get() as { n: number }).n === 2);
		poller.stop();
		await running;

		expect(getBotState(db, "A", "update_offset")).toBe("3");
		expect(replyCalls).toHaveLength(1);
		expect(replyCalls[0]).toMatchObject({ chatId: CHAT, replyTo: 100 });
		expect(state.get("A")?.cooldownMs).toBe(0);
		expect(db.query("SELECT message_id, first_seen_by FROM messages ORDER BY message_id").all()).toEqual([
			{ message_id: 100, first_seen_by: "A" },
			{ message_id: 900, first_seen_by: "B" },
		]);
		expect(db.query("SELECT kind, COUNT(*) n FROM agent_events WHERE kind LIKE 'telegram_control%' GROUP BY kind ORDER BY kind").all()).toEqual([
			{ kind: "telegram_control", n: 1 },
			{ kind: "telegram_control_claim", n: 1 },
			{ kind: "telegram_control_reply", n: 1 },
		]);
		expect(broadcasts).toEqual([{ chatId: CHAT, messageId: 100 }, { chatId: CHAT, messageId: 900 }]);
		expect(runtimeA.consumed).toEqual([100, 900]);
		expect(runtimeB.consumed).toEqual([100, 900]);
	});

	test("reply failures are one-shot, bounded, and redacted", async () => {
		let calls = 0;
		const warnings: string[] = [];
		const port = {
			handle: async () => ({ chatId: CHAT, replyToMessageId: 100, replyBotId: "A", text: "safe reply", duplicate: false }),
			consumeReply: () => {},
		};
		const coordinator = new TelegramControlCoordinator(
			db,
			port,
			new Map([["A", { sendMessage: async () => {
				calls++;
				throw new TelegramApiError(500, "https://api.telegram.org/botsecret-token/private");
			} }]]),
			undefined,
			(message) => warnings.push(message),
		);
		const result = await coordinator.handle(parseTelegramControlCommand(commandUpdate(), "A", IDENTITIES)!);
		expect(result).toEqual({ outcome: "failed", category: "server_error" });
		expect(calls).toBe(1);
		expect(warnings).toEqual(["[telegram-control] reply failed bot=A msg=#100 category=server_error"]);
		expect(warnings[0]).not.toContain("secret-token");
		expect(db.query("SELECT COUNT(*) n FROM messages").get()).toEqual({ n: 0 });
	});
});
