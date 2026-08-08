import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig } from "../src/config.ts";
import type { ManualCompactResult, RuntimeControlSnapshot } from "../src/agent/runtime.ts";
import { TelegramControlState } from "../src/telegram/control-state.ts";
import {
	CONTROL_COMMAND_AUDIT_EVENT,
	CONTROL_COMMAND_CLAIM_EVENT,
	CONTROL_REPLY_EVENT,
	TelegramControlCommandService,
	consumedControlMessageIds,
	parseTelegramControlCommand,
	type ParsedTelegramControlCommand,
	type TelegramControlRuntime,
} from "../src/telegram/control-command.ts";

const CHAT = -1004402809405;
const IDENTITIES = [
	{ id: "A", username: "alpha_bot" },
	{ id: "B", username: "beta_bot" },
] as const;

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function bot(id: string, name = id, routingP = 0.2): BotConfig {
	return {
		id,
		name,
		token: `${id}:secret-token-must-not-appear`,
		personaPath: `/private/personas/${id}-must-not-appear.md`,
		routingP,
		samplingCooldownMs: 2_000,
		provider: "deepseek",
		model: `model-${id}`,
		apiKeyEnv: "test_api_key",
		providerApiKey: "test-key",
		reasoningEffort: "medium",
		compactionThreshold: 128_000,
		compactionKeepRecent: 20_000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
}

function update(
	text: string,
	options: {
		messageId?: number;
		entityOffset?: number;
		entityLength?: number;
		entityType?: string;
		caption?: boolean;
		edited?: boolean;
		from?: Record<string, unknown> | null;
		senderChat?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	const commandLength = options.entityLength ?? text.split(/\s/, 1)[0]!.length;
	const message: Record<string, unknown> = {
		message_id: options.messageId ?? 10,
		from: options.from === undefined
			? { id: 42, is_bot: false, first_name: "Alice", username: "aac6fef" }
			: options.from,
		chat: { id: CHAT, type: "supergroup" },
		date: 1_754_600_000,
		...(options.caption
			? { caption: text, caption_entities: [{ type: options.entityType ?? "bot_command", offset: options.entityOffset ?? 0, length: commandLength }] }
			: { text, entities: [{ type: options.entityType ?? "bot_command", offset: options.entityOffset ?? 0, length: commandLength }] }),
		...(options.senderChat ? { sender_chat: options.senderChat } : {}),
	};
	return { update_id: options.messageId ?? 10, [options.edited ? "edited_message" : "message"]: message };
}

function parsed(text: string, options: Parameters<typeof update>[1] = {}, receivingBotId = "A"): ParsedTelegramControlCommand {
	const result = parseTelegramControlCommand(update(text, options), receivingBotId, IDENTITIES);
	if (!result) throw new Error(`expected parsed command: ${text}`);
	return result;
}

class FakeRuntime implements TelegramControlRuntime {
	consumed: number[] = [];
	compactCalls = 0;
	snapshot: RuntimeControlSnapshot = { state: "idle", epoch: 3, model: "model", lastCompact: null };
	compact: () => Promise<ManualCompactResult> = async () => ({ ok: true, epoch: 4, tokensBefore: 100 });

	controlSnapshot(): RuntimeControlSnapshot {
		return this.snapshot;
	}

	async compactForControl(): Promise<ManualCompactResult> {
		this.compactCalls++;
		return await this.compact();
	}

	consumeControlMessage(messageId: number): void {
		this.consumed.push(messageId);
	}
}

function service(options: {
	bots?: BotConfig[];
	runtimes?: Map<string, FakeRuntime>;
	admins?: Array<number | `@${string}`>;
} = {}) {
	const bots = options.bots ?? [bot("A"), bot("B", "小雨", 0.3)];
	const runtimes = options.runtimes ?? new Map(bots.map((value) => [value.id, new FakeRuntime()]));
	const state = new TelegramControlState(db, bots);
	let now = 1_000;
	const commands = new TelegramControlCommandService(db, bots, state, runtimes, options.admins ?? [42, "@aac6fef"], () => now++);
	return { bots, runtimes, state, commands };
}

describe("Telegram control entity parser (REQ-CMD-0001)", () => {
	test("offset-zero command, suffix, case, caption, and edit use one strict grammar", () => {
		expect(parsed("/tg").action).toEqual({ kind: "help" });
		expect(parsed("/TG@BeTa_BoT StAtUs B")).toMatchObject({
			replyBotId: "B",
			sender: { id: 42, username: "@aac6fef", isBot: false, hasSenderChat: false },
			action: { kind: "status", botId: "B" },
		});
		expect(parsed("/tg set A ROUTING_P 0.25").action).toEqual({ kind: "set", botId: "A", parameter: "routing_p", value: 0.25 });
		expect(parsed("/tg reset B COOLDOWN_MS", { caption: true }).action).toEqual({ kind: "reset", botId: "B", parameter: "cooldown_ms" });
		expect(parsed("/tg compact all", { edited: true })).toMatchObject({ edited: true, action: { kind: "compact", target: "all" } });
	});

	test("non-leading entity, unknown suffix, mention in chat, and other commands are not consumed", () => {
		expect(parseTelegramControlCommand(update("x /tg help", { entityOffset: 2, entityLength: 3 }), "A", IDENTITIES)).toBeNull();
		expect(parseTelegramControlCommand(update("/tg@missing_bot help"), "A", IDENTITIES)).toBeNull();
		expect(parseTelegramControlCommand(update("talk about /tg", { entityType: "mention", entityOffset: 11, entityLength: 3 }), "A", IDENTITIES)).toBeNull();
		expect(parseTelegramControlCommand(update("/other help"), "A", IDENTITIES)).toBeNull();
		expect(parseTelegramControlCommand({ update_id: 1, callback_query: {} }, "A", IDENTITIES)).toBeNull();
	});

	test("missing, extra, adjacent, and ill-typed arguments become bounded usage without guessing", () => {
		for (const text of [
			"/tg help extra",
			"/tg status A extra",
			"/tg compact",
			"/tg set A routing_p NaN",
			"/tg set A routing_p 1e-1",
			"/tg set A cooldown_ms 1.5",
			"/tg reset A model",
			"/tg unknown",
		]) expect(parsed(text).action).toEqual({ kind: "usage" });
		expect(parsed("/tgBAD", { entityLength: 3 }).action).toEqual({ kind: "usage" });
	});
});

describe("deterministic Telegram control service (REQ-CMD-0001)", () => {
	test("public status is available to humans and is bounded without tokens, paths, or message bodies", async () => {
		const longBots = [bot("A", `小雪${"x".repeat(5000)}`)];
		const { commands } = service({ bots: longBots, admins: [] });
		db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, cost) VALUES ('A', 1, 'm', 2, 100, 50, 0, 50, 10, 2, 0.1234)").run();
		const status = await commands.handle(parsed("/tg status A", { from: { id: 999, is_bot: false, first_name: "public" } }));
		expect(status.text).toContain("state=idle epoch=3");
		expect(status.text).toContain("routing_p=0.2 (config)");
		expect(status.text).toContain("runs=1 context=100 output=10 cost=$0.1234");
		expect(status.text!.length).toBeLessThanOrEqual(3500);
		expect(status.text).not.toContain("secret-token");
		expect(status.text).not.toContain("/private/");
		expect(status.text).not.toContain("message body");
	});

	test("numeric and normalized username admins mutate; impostors and untrusted sender shapes do not", async () => {
		const { commands, state } = service();
		expect((await commands.handle(parsed("/tg set A routing_p 0.4", { messageId: 20 }))).text).toContain("set A.routing_p = 0.4");
		expect(state.get("A")?.routingP).toBe(0.4);

		const usernameAdmin = parsed("/tg set B cooldown_ms 0", {
			messageId: 21,
			from: { id: 999, is_bot: false, first_name: "not trusted", username: "AAC6FEF" },
		});
		expect((await commands.handle(usernameAdmin)).text).toContain("set B.cooldown_ms = 0");
		expect(state.get("B")?.cooldownMs).toBe(0);

		for (const [messageId, from, senderChat] of [
			[22, { id: 1000, is_bot: false, first_name: "aac6fef", username: "impostor" }, undefined],
			[23, { id: 42, is_bot: true, first_name: "bot", username: "aac6fef" }, undefined],
			[24, null, undefined],
			[25, { id: 42, is_bot: false, first_name: "Alice", username: "aac6fef" }, { id: -1, title: "anonymous" }],
		] as const) {
			const result = await commands.handle(parsed("/tg set A cooldown_ms 10", { messageId, from, senderChat }));
			if (from && !from.is_bot && !senderChat) expect(result.text).toContain("权限不足");
			else expect(result.text).toBeNull();
		}
		expect(state.get("A")?.cooldownMs).toBe(2_000);
	});

	test("one message id claims and executes once; edits are consumed without mutation", async () => {
		const { commands, state, runtimes } = service();
		const command = parsed("/tg set A cooldown_ms 15", { messageId: 30 });
		const first = await commands.handle(command);
		const duplicate = await commands.handle(command);
		expect(first.duplicate).toBe(false);
		expect(duplicate).toMatchObject({ duplicate: true, text: null });
		expect(state.get("A")?.cooldownMs).toBe(15);
		expect(db.query("SELECT COUNT(*) n FROM agent_events WHERE kind = ?").get(CONTROL_COMMAND_CLAIM_EVENT)).toEqual({ n: 1 });
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([30]));
		for (const runtime of runtimes.values()) expect(runtime.consumed).toEqual([30, 30]);

		const edited = await commands.handle(parsed("/tg reset A cooldown_ms", { messageId: 31, edited: true }));
		expect(edited.text).toBeNull();
		expect(state.get("A")?.cooldownMs).toBe(15);
	});

	test("mutations are globally serialized and compact all runs bots in config order", async () => {
		const runtimeA = new FakeRuntime();
		const runtimeB = new FakeRuntime();
		let releaseA!: () => void;
		const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
		const order: string[] = [];
		runtimeA.compact = async () => {
			order.push("A:start");
			await gateA;
			order.push("A:end");
			return { ok: true, epoch: 4, tokensBefore: 100 };
		};
		runtimeB.compact = async () => {
			order.push("B:start");
			order.push("B:end");
			return { ok: false, code: "busy" };
		};
		const { commands, state } = service({ runtimes: new Map([["A", runtimeA], ["B", runtimeB]]) });
		const compact = commands.handle(parsed("/tg compact all", { messageId: 40 }));
		for (let index = 0; index < 3; index++) await Promise.resolve();
		const set = commands.handle(parsed("/tg set B cooldown_ms 0", { messageId: 41 }));
		for (let index = 0; index < 3; index++) await Promise.resolve();
		expect(order).toEqual(["A:start"]);
		expect(state.get("B")?.cooldownMs).toBe(2_000);
		releaseA();
		const compactResult = await compact;
		expect(compactResult.text).toContain("A: compact 完成");
		expect(compactResult.text).toContain("B: busy");
		expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
		expect((await set).text).toContain("set B.cooldown_ms = 0");
		expect(state.get("B")?.cooldownMs).toBe(0);
	});

	test("reply markers are idempotent and audit payloads remain allowlisted", async () => {
		const { commands, runtimes } = service();
		await commands.handle(parsed("/tg bots", { messageId: 50 }));
		commands.consumeReply("A", CHAT, 500);
		commands.consumeReply("A", CHAT, 500);
		expect(consumedControlMessageIds(db, CHAT)).toEqual(new Set([50, 500]));
		expect(db.query("SELECT COUNT(*) n FROM agent_events WHERE kind = ?").get(CONTROL_REPLY_EVENT)).toEqual({ n: 1 });
		for (const runtime of runtimes.values()) expect(runtime.consumed).toEqual([50, 500, 500]);

		const audits = db.query("SELECT payload FROM agent_events WHERE kind = ?").all(CONTROL_COMMAND_AUDIT_EVENT) as { payload: string }[];
		expect(audits).toHaveLength(1);
		expect(JSON.parse(audits[0]!.payload)).toEqual({
			command: "bots",
			target: null,
			sender_id: 42,
			username: "@aac6fef",
			authorized: true,
			outcome: "ok",
			duration_ms: 1,
		});
		expect(audits[0]!.payload).not.toContain("secret-token");
		expect(audits[0]!.payload).not.toContain("/tg bots");
	});
});
