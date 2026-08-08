// REQ-AGENT-0001 regression tests: flush state machine, exposure lifecycle,
// compaction success/failure handling. No network (fake session/api).
//
// Test seam: BotRuntime's session/api/modelRuntime are private; tests inject fakes
// via `as any` — this asserts observable behavior (sent suffixes, bot_state, agent_events),
// not prompt strings.

// bun test forces UTC; pin the deployment TZ so serialization matches production.
process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotRuntime } from "../src/agent/runtime.ts";
import { getBotState } from "../src/db/db.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import type { AgentStreamFrame } from "../src/ipc.ts";
import type { ActivityScheduler } from "../src/telegram/activity.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function makeRuntime(options: {
	samplingCooldownMs?: number;
	monotonicNow?: () => number;
	activityScheduler?: ActivityScheduler;
	chatActionSender?: () => Promise<unknown>;
	useBotApiForActivity?: boolean;
} = {}): BotRuntime {
	const config: AppConfig = {
		dataDir: "/tmp/req-agent-0001-test",
		dbPath: ":memory:",
		groupPeerId: GROUP,
		bots: [],
		deepseekApiKey: "",
		tinyfishApiKey: "",
		auxiliaryVisualModel: "",
		routerSecret: null,
	};
	const bot: BotConfig = {
		id: "A",
		name: "小雪",
		token: "test-token",
		personaPath: "",
		routingP: 0,
		samplingCooldownMs: options.samplingCooldownMs ?? 2000,
		model: "test-model",
		reasoningEffort: "medium",
		compactionThreshold: 128000,
		compactionKeepRecent: 20000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
	return new BotRuntime(db, bot, config, null as never, {
		monotonicNow: options.monotonicNow,
		activityScheduler: options.activityScheduler,
		...(options.useBotApiForActivity
			? {}
			: { chatActionSender: options.chatActionSender ?? (async () => true) }),
	});
}

class FakeActivityScheduler implements ActivityScheduler {
	now = 0;
	private nextId = 0;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): number {
		const id = ++this.nextId;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	async advance(ms: number): Promise<void> {
		for (let index = 0; index < 5; index++) await Promise.resolve();
		const target = this.now + ms;
		while (true) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			this.now = due[1].at;
			this.tasks.delete(due[0]);
			due[1].callback();
			for (let index = 0; index < 5; index++) await Promise.resolve();
		}
		this.now = target;
	}
}

interface FakeSession {
	sent: string[];
	listener: ((e: unknown) => void) | null;
	sendUserMessage: (text: string) => Promise<void>;
}

/** Attach a fake AgentSession and wire the event subscription. */
function attachFakeSession(
	rt: BotRuntime,
	opts: {
		send?: (text: string) => Promise<void>;
		contextEntries?: () => unknown[];
	} = {},
): FakeSession {
	const fake: FakeSession = {
		sent: [],
		listener: null,
		sendUserMessage: opts.send ?? (async (t: string) => { fake.sent.push(t); }),
	};
	(rt as any).session = {
		subscribe: (l: (e: unknown) => void) => { fake.listener = l; },
		sendUserMessage: (t: string) => fake.sendUserMessage(t),
		sessionManager: { buildContextEntries: () => opts.contextEntries?.() ?? [] },
		dispose: async () => {},
	};
	(rt as any).subscribeEvents();
	return fake;
}

function insertMsg(overrides: Partial<MessageRow>): void {
	const m = {
		chat_id: CHAT, message_id: 1, date: 1754600000, thread_id: null,
		sender_id: 111, display_name: "Alice", username: "alice", sender_tag: null,
		sender_chat: null, is_bot: 0, text: "hi", caption: null, entities: null,
		reply_to_message_id: null, quote: null, forward_origin: null, edit_date: null, media: null,
		...overrides,
	};
	db.query(
		`INSERT INTO messages (chat_id, message_id, date, thread_id, sender_id, display_name, username, sender_tag, sender_chat, is_bot, text, caption, entities, reply_to_message_id, quote, forward_origin, edit_date, media, first_seen_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A')`,
	).run(m.chat_id, m.message_id, m.date, m.thread_id, m.sender_id, m.display_name, m.username, m.sender_tag, m.sender_chat, m.is_bot, m.text, m.caption, m.entities, m.reply_to_message_id, m.quote, m.forward_origin, m.edit_date, m.media);
}

function exposedIds(): number[] {
	return JSON.parse(getBotState(db, "A", "exposed_ids") ?? "[]") as number[];
}

function errorEvents(): { stage: string; error?: string }[] {
	const rows = db.query("SELECT payload FROM agent_events WHERE bot_id = 'A' AND kind = 'error'").all() as { payload: string }[];
	return rows.map((r) => JSON.parse(r.payload) as { stage: string });
}

describe("flush state machine (REQ-AGENT-0001)", () => {
	test("REQ-UI-0010 streams bounded assistant snapshots without persisting partial rows", async () => {
		const rt = makeRuntime();
		const fake = attachFakeSession(rt);
		const frames: AgentStreamFrame[] = [];
		rt.streamSink = (frame) => frames.push(frame);
		const base = {
			role: "assistant",
			api: "openai-completions",
			provider: "test",
			model: "test-model",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: 1,
		};

		fake.listener?.({ type: "message_start", message: { ...base, content: [] } });
		fake.listener?.({
			type: "message_update",
			message: { ...base, content: [{ type: "thinking", thinking: `思考${"x".repeat(5000)}` }] },
			assistantMessageEvent: { type: "thinking_delta" },
		});
		fake.listener?.({
			type: "message_update",
			message: {
				...base,
				content: [
					{ type: "thinking", thinking: "先检查" },
					{ type: "toolCall", id: "tc-1", name: "send", arguments: { message: `你好${"y".repeat(3000)}` } },
				],
			},
			assistantMessageEvent: { type: "toolcall_delta" },
		});
		fake.listener?.({
			type: "message_end",
			message: { ...base, stopReason: "toolUse", content: [{ type: "toolCall", id: "tc-1", name: "send", arguments: { message: "你好" } }] },
		});

		expect(frames.map((frame) => frame.phase)).toEqual(["start", "update", "update", "end"]);
		expect(new Set(frames.map((frame) => frame.streamId)).size).toBe(1);
		const updates = frames.filter((frame): frame is Extract<AgentStreamFrame, { phase: "update" }> => frame.phase === "update");
		expect(updates[0]!.thinking.length).toBeLessThanOrEqual(4096);
		expect(updates[1]!.text).toBe("");
		expect(updates[1]!.toolCalls).toHaveLength(1);
		expect(updates[1]!.toolCalls[0]!.arguments.length).toBeLessThanOrEqual(2048);
		expect(db.query("SELECT COUNT(*) n FROM agent_events").get()).toEqual({ n: 0 });

		rt.streamDemand = () => false;
		fake.listener?.({ type: "message_start", message: { ...base, content: [] } });
		fake.listener?.({ type: "message_update", message: { ...base, content: [{ type: "toolCall", id: "hidden", name: "send", arguments: { message: "not serialized for IPC" } }] }, assistantMessageEvent: { type: "toolcall_delta" } });
		expect(frames.at(-1)?.phase).toBe("end");
		rt.streamDemand = () => true;
		fake.listener?.({ type: "message_update", message: { ...base, content: [{ type: "text", text: "listener joined mid-stream" }] }, assistantMessageEvent: { type: "text_delta" } });
		fake.listener?.({ type: "agent_end", messages: [], willRetry: false });
		fake.listener?.({ type: "agent_settled" });
		expect(frames.slice(-2).map((frame) => frame.phase)).toEqual(["update", "end"]);
		await rt.stop();
		expect(frames.at(-1)?.phase).toBe("end");
	});

	test("REQ-UI-0009 persists and pushes complete provider usage telemetry", () => {
		const rt = makeRuntime();
		(rt as any).runStartTs = 1000;
		let pushed: unknown;
		rt.usageSink = (run) => { pushed = run; };
		(rt as any).recordUsage({
			input: 200,
			output: 30,
			cacheRead: 700,
			cacheWrite: 100,
			reasoning: 40,
			cost: { total: 0.012 },
		}, 1450);

		expect(db.query("SELECT context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost FROM llm_runs").get()).toEqual({
			context_tokens: 1000,
			cache_read: 700,
			cache_write: 100,
			cache_miss: 200,
			output_tokens: 30,
			reasoning_tokens: 40,
			latency_ms: 450,
			cost: 0.012,
		});
		expect(pushed).toMatchObject({
			contextTokens: 1000,
			cacheRead: 700,
			cacheWrite: 100,
			cacheMiss: 200,
			outputTokens: 30,
			reasoningTokens: 40,
			latencyMs: 450,
			cost: 0.012,
		});
	});

	test("AC1: trigger during slow-vision flush coalesces; each message serialized exactly once, in order", async () => {
		const rt = makeRuntime();
		const fake = attachFakeSession(rt);
		let releaseVision!: () => void;
		const visionGate = new Promise<void>((r) => { releaseVision = r; });
		(rt as any).ensureBatchVision = () => visionGate; // simulate the slow vision await

		insertMsg({ message_id: 1, date: 1754600000, text: "first" });
		rt.trigger(); // parks at the vision gate (flushing=true, synchronously)
		const inFlight = (rt as any).flushPromise as Promise<void>;

		insertMsg({ message_id: 2, date: 1754600010, text: "second" });
		rt.trigger(); // re-entrant during the await: must only set pendingTrigger

		releaseVision();
		await inFlight;

		expect(fake.sent.length).toBe(2);
		expect(fake.sent[0]).toContain("#1 ");
		expect(fake.sent[0]).not.toContain("#2 ");
		expect(fake.sent[1]).toContain("#2 ");
		expect(fake.sent[1]).not.toContain("#1 "); // never re-serialized (cache invariant 3)
		expect(exposedIds()).toEqual([1, 2]);
		expect(errorEvents()).toEqual([]);
	});

	test("AC2: sendUserMessage failure keeps messages unexposed, records error, later trigger retries", async () => {
		const rt = makeRuntime();
		let fail = true;
		const fake = attachFakeSession(rt, {
			send: async (t: string) => {
				if (fail) throw new Error("injected send failure");
				fake.sent.push(t);
			},
		});
		insertMsg({ message_id: 1, text: "hello" });

		rt.trigger();
		await (rt as any).flushPromise; // resolves — no unhandled rejection escapes

		expect(fake.sent.length).toBe(0);
		expect(getBotState(db, "A", "exposed_ids")).toBeNull(); // never marked exposed
		const errors = errorEvents();
		expect(errors.length).toBe(1);
		expect(errors[0].stage).toBe("flush");
		expect(errors[0].error).toContain("injected send failure");

		fail = false;
		rt.trigger();
		await (rt as any).flushPromise;

		expect(fake.sent.length).toBe(1);
		expect(fake.sent[0]).toContain("#1 ");
		expect(exposedIds()).toEqual([1]);
	});

	test("AC3: failed/aborted compaction does not bump epoch or reset exposure", () => {
		const rt = makeRuntime();
		const fake = attachFakeSession(rt);
		(rt as any).markExposed([1, 2, 3]);

		fake.listener!({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "Auto-compaction failed: boom" });
		expect((rt as any).epoch).toBe(1);
		expect(exposedIds()).toEqual([1, 2, 3]);

		fake.listener!({ type: "compaction_end", reason: "overflow", result: undefined, aborted: true, willRetry: false });
		expect((rt as any).epoch).toBe(1);
		expect(exposedIds()).toEqual([1, 2, 3]);

		const errors = errorEvents();
		expect(errors.length).toBe(2);
		expect(errors.every((e) => e.stage === "compaction")).toBe(true);
	});

	test("AC3: empty compaction summary is refused via cancel (never persisted)", async () => {
		const rt = makeRuntime();
		attachFakeSession(rt);
		(rt as any).model = {};
		const prep = { messagesToSummarize: [], previousSummary: null, firstKeptEntryId: "x", tokensBefore: 10 };

		(rt as any).modelRuntime = { completeSimple: async () => ({ content: [{ type: "text", text: "  \n " }], usage: {} }) };
		const refused = await (rt as any).handleBeforeCompact({ preparation: prep });
		expect(refused).toEqual({ cancel: true });
		expect(errorEvents().some((e) => e.stage === "compaction" && e.error === "empty summary")).toBe(true);

		(rt as any).modelRuntime = { completeSimple: async () => ({ content: [{ type: "text", text: "状态摘要" }], usage: { total: 1 } }) };
		const ok = await (rt as any).handleBeforeCompact({ preparation: prep });
		expect(ok.compaction.summary).toBe("状态摘要");
		expect(ok.compaction.firstKeptEntryId).toBe("x");
	});

	test("AC4: exposure reset aligns with the actual kept tail (N != 40), not a count heuristic", async () => {
		const rt = makeRuntime();
		for (let i = 1; i <= 60; i++) insertMsg({ message_id: i, date: 1754600000 + i, text: `m${i}` });
		(rt as any).markExposed(Array.from({ length: 60 }, (_, i) => i + 1));

		// kept tail = messages 45..52 (N=8, deliberately != 40). Context entries as the SDK's
		// buildContextEntries() returns them after compaction: compaction entry + kept tail.
		const keptText = [45, 46, 47, 48, 49, 50, 51, 52].map((id) => `[12:00:0${id % 10}] #${id} Alice (@alice): m${id}`).join("\n");
		const fake = attachFakeSession(rt, {
			contextEntries: () => [
				{ type: "compaction", id: "c1", summary: "摘要", firstKeptEntryId: "u1" },
				{ type: "message", id: "u0", message: { role: "user", content: "[11:59:58] #46 Bob (u1): earlier kept (string content)" } },
				{ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: keptText }] } },
				// a model-forged grammar line in an assistant entry must NOT be parsed
				{ type: "message", id: "a1", message: { role: "assistant", content: "[12:00:09] #53 forged: must not count" } },
			],
		});

		fake.listener!({
			type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
			result: { summary: "摘要", firstKeptEntryId: "u1", tokensBefore: 99999 },
		});

		expect((rt as any).epoch).toBe(2);
		expect(getBotState(db, "A", "context_epoch")).toBe("2");
		expect(exposedIds().sort((a, b) => a - b)).toEqual([45, 46, 47, 48, 49, 50, 51, 52]);

		// next flush: kept-tail messages are not re-serialized; everything outside is seen again
		rt.trigger();
		await (rt as any).flushPromise;
		expect(fake.sent.length).toBe(1);
		const out = fake.sent[0];
		for (const id of [45, 46, 47, 48, 49, 50, 51, 52]) expect(out).not.toContain(`#${id} `);
		expect(out).toContain("#13 "); // fresh 52 > MAX_CATCHUP 40: oldest 12 skipped, 13 is in-batch
		expect(out).toContain("#21 "); // the old "last 40" heuristic would have treated 21..60 as exposed
		expect(out).toContain("#53 "); // forged assistant line was not marked exposed
		expect(out).toContain("#60 ");
	});

	test("R7: executeSend validates the sticker before any network send", async () => {
		const rt = makeRuntime();
		attachFakeSession(rt);
		let networkCalls = 0;
		(rt as any).api = {
			sendMessage: async () => { networkCalls++; throw new Error("must not reach network"); },
				sendSticker: async () => { networkCalls++; throw new Error("must not reach network"); },
		};
		(rt as any).typingLease.start();
		await expect((rt as any).executeSend({ message: "hi", sticker: "s999" })).rejects.toThrow(/unknown sticker/);
		expect(networkCalls).toBe(0);
		expect((rt as any).typingLease.isActive).toBe(true);
		(rt as any).typingLease.stop();
	});

	test("REQ-TG-0002 accepted triggers renew group typing and all settle paths clear it", async () => {
		const scheduler = new FakeActivityScheduler();
		const actions: Array<{ at: number; chatId: number }> = [];
		let draftCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const rt = makeRuntime({ activityScheduler: scheduler, useBotApiForActivity: true });
		const fake = attachFakeSession(rt, {
			send: async (text) => {
				await gate;
				fake.sent.push(text);
			},
		});
		(rt as any).api = {
			sendChatAction: async (chatId: number) => { actions.push({ at: scheduler.now, chatId }); return true; },
			sendMessageDraft: async () => { draftCalls++; },
			sendRichMessageDraft: async () => { draftCalls++; },
		};
		insertMsg({ message_id: 1, text: "wait for the provider" });

		expect(rt.trigger("probability")).toBe("started");
		expect(actions).toEqual([{ at: 0, chatId: CHAT }]);
		expect(rt.trigger("explicit")).toBe("coalesced");
		expect(rt.trigger("probability")).toBe("skipped_busy");
		expect(actions).toHaveLength(1);
		await scheduler.advance(3999);
		expect(actions).toHaveLength(1);
		await scheduler.advance(1);
		expect(actions).toEqual([{ at: 0, chatId: CHAT }, { at: 4000, chatId: CHAT }]);

		release();
		await (rt as any).flushPromise;
		expect((rt as any).typingLease.isActive).toBe(false);
		await scheduler.advance(12_000);
		expect(actions).toHaveLength(2);
		expect(draftCalls).toBe(0);
		await rt.stop();
		expect(rt.trigger("explicit")).toBe("skipped_stopping");
		expect(actions).toHaveLength(2);
	});

	test("REQ-TG-0002 successful send releases typing and pending flush reacquires it", async () => {
		const scheduler = new FakeActivityScheduler();
		const actions: number[] = [];
		let draftCalls = 0;
		let sentMessageId = 900;
		const rt = makeRuntime({ activityScheduler: scheduler, useBotApiForActivity: true });
		(rt as any).api = {
			sendChatAction: async (chatId: number) => { expect(chatId).toBe(CHAT); actions.push(scheduler.now); return true; },
			sendMessage: async (chatId: number, text: string) => ({
				chat: { id: chatId }, message_id: sentMessageId++, from: { id: 777, is_bot: true, first_name: "小雪" },
				date: 1754600100, text,
			}),
			sendMessageDraft: async () => { draftCalls++; },
			sendRichMessageDraft: async () => { draftCalls++; },
		};
		let runs = 0;
		const fake = attachFakeSession(rt, {
			send: async (text) => {
				fake.sent.push(text);
				runs++;
				if (runs !== 1) return;
				await (rt as any).executeSend({ message: "first reply" });
				expect((rt as any).typingLease.isActive).toBe(false);
				insertMsg({ message_id: 2, date: 1754600200, text: "pending explicit" });
				expect(rt.trigger("explicit")).toBe("coalesced");
			},
		});
		insertMsg({ message_id: 1, text: "first trigger" });

		expect(rt.trigger("explicit")).toBe("started");
		await (rt as any).flushPromise;

		expect(runs).toBe(2);
		expect(actions).toEqual([0, 0]);
		expect((rt as any).typingLease.metrics).toMatchObject({ starts: 2, stops: 2 });
		expect((rt as any).typingLease.isActive).toBe(false);
		expect(draftCalls).toBe(0);
		expect(db.query("SELECT kind FROM agent_events ORDER BY id").all()).toEqual([{ kind: "send" }]);
	});

	test("REQ-TG-0002 action failures are deduplicated, redacted, and isolated from flush", async () => {
		const scheduler = new FakeActivityScheduler();
		let actionCalls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const rt = makeRuntime({ activityScheduler: scheduler, useBotApiForActivity: true });
		const fake = attachFakeSession(rt, {
			send: async (text) => {
				await gate;
				fake.sent.push(text);
			},
		});
		(rt as any).api = {
			sendChatAction: async () => {
				actionCalls++;
				throw new Error("https://api.telegram.org/bottest-token/private-detail");
			},
		};
		insertMsg({ message_id: 1, text: "provider still runs" });
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
		try {
			expect(rt.trigger("explicit")).toBe("started");
			await scheduler.advance(8000);
			expect(actionCalls).toBe(3);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain("bot=A typing failed (request_failed)");
			expect(warnings[0]).not.toContain("test-token");
			expect(warnings[0]).not.toContain("https://");
			release();
			await (rt as any).flushPromise;
		} finally {
			console.warn = originalWarn;
		}
		expect(fake.sent).toHaveLength(1);
		expect(exposedIds()).toEqual([1]);
		expect(db.query("SELECT COUNT(*) n FROM agent_events").get()).toEqual({ n: 0 });
		expect((rt as any).typingLease.isActive).toBe(false);
	});
});

describe("probability sampling lifecycle (REQ-ROUTE-0001)", () => {
	test("busy bursts do not create pending runs; cooldown uses an exact non-blocking deadline", async () => {
		let now = 1000;
		const rt = makeRuntime({ monotonicNow: () => now });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fake = attachFakeSession(rt, {
			send: async (text) => {
				await gate;
				fake.sent.push(text);
			},
		});

		insertMsg({ message_id: 1, text: "starts A" });
		expect(rt.trigger("probability")).toBe("started");
		expect(rt.samplingState()).toBe("busy");
		for (let id = 2; id <= 101; id++) {
			insertMsg({ message_id: id, date: 1754600000 + id, text: `busy-${id}` });
			expect(rt.trigger("probability")).toBe("skipped_busy");
		}
		expect((rt as any).pendingTrigger).toBe(false);
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 101 });

		release();
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("#1 ");
		expect(rt.samplingState()).toBe("cooldown");

		now = 2999;
		insertMsg({ message_id: 102, date: 1754600202, text: "one ms early" });
		expect(rt.trigger("probability")).toBe("skipped_cooldown");
		expect(fake.sent).toHaveLength(1); // deadline itself never schedules a run

		now = 3000;
		expect(rt.samplingState()).toBe("idle");
		expect(fake.sent).toHaveLength(1);
		insertMsg({ message_id: 103, date: 1754600203, text: "at deadline" });
		expect(rt.trigger("probability")).toBe("started");
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(2);
		expect(fake.sent[1]).toContain("#102 ");
		expect(fake.sent[1]).toContain("#103 ");
		expect(fake.sent[1]).not.toContain("#1 ");
	});

	test("explicit triggers coalesce while busy and bypass probability cooldown", async () => {
		let now = 5000;
		const rt = makeRuntime({ monotonicNow: () => now });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fake = attachFakeSession(rt, {
			send: async (text) => {
				await gate;
				fake.sent.push(text);
			},
		});

		insertMsg({ message_id: 1, text: "probability" });
		expect(rt.trigger("probability")).toBe("started");
		insertMsg({ message_id: 2, date: 1754600002, text: "@mention" });
		expect(rt.trigger("explicit")).toBe("coalesced");
		expect((rt as any).pendingTrigger).toBe(true);
		release();
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(2);
		expect(fake.sent[1]).toContain("#2 ");
		expect(rt.samplingState()).toBe("cooldown");

		insertMsg({ message_id: 3, date: 1754600003, text: "explicit during cooldown" });
		expect(rt.trigger("explicit")).toBe("started");
		await (rt as any).flushPromise;
		expect(fake.sent[2]).toContain("#3 ");
		expect(rt.trigger("probability")).toBe("skipped_cooldown");
	});

	test("zero cooldown restores probability availability immediately", async () => {
		let now = 10;
		const rt = makeRuntime({ samplingCooldownMs: 0, monotonicNow: () => now });
		attachFakeSession(rt);
		insertMsg({ message_id: 1 });
		expect(rt.trigger("probability")).toBe("started");
		await (rt as any).flushPromise;
		expect(rt.isAvailableForSampling(now)).toBe(true);
	});

	test("a controlled probability flush failure still enters cooldown", async () => {
		let now = 20;
		const rt = makeRuntime({ monotonicNow: () => now });
		attachFakeSession(rt, { send: async () => { throw new Error("provider failed"); } });
		insertMsg({ message_id: 1 });
		expect(rt.trigger("probability")).toBe("started");
		await (rt as any).flushPromise;
		expect(rt.samplingState()).toBe("cooldown");
		expect(errorEvents()).toEqual([{ stage: "flush", error: "provider failed" }]);
	});
});
