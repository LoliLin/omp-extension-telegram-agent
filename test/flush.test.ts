// REQ-AGENT-0001 regression tests: flush state machine, visibility lifecycle,
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
import {
	appendMediaUpdateEvents,
	listVisibleMessageIds,
	messageEventHighWater,
	setConsumedSeq,
} from "../src/db/message-events.ts";
import type { AppConfig, BotConfig } from "../src/config.ts";
import type { MessageRow } from "../src/agent/serialize.ts";
import type { AgentStreamFrame } from "../src/ipc.ts";
import type { ActivityScheduler } from "../src/telegram/activity.ts";
import { setLogSink } from "../src/observability/log.ts";
import type {
	VisionExecutor,
	VisionKind,
	VisionOutcome,
	VisionTelemetry,
} from "../src/media/vision.ts";

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
	visionExecutor?: VisionExecutor;
} = {}): BotRuntime {
	const config: AppConfig = {
		dataDir: "/tmp/req-agent-0001-test",
		dbPath: ":memory:",
		groupPeerId: GROUP,
		bots: [],
		tinyfishApiKey: "",
		auxiliaryVisualModel: "",
		routerSecret: null,
		telegramAdmins: [],
	};
	const bot: BotConfig = {
		id: "A",
		name: "小雪",
		token: "test-token",
		personaPath: "",
		routingP: 0,
		samplingCooldownMs: options.samplingCooldownMs ?? 2000,
		provider: "deepseek",
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
		visionExecutor: options.visionExecutor,
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
	compact: (...args: unknown[]) => Promise<{ tokensBefore: number }>;
}

/** Attach a fake AgentSession and wire the event subscription. */
function attachFakeSession(
	rt: BotRuntime,
	opts: {
		send?: (text: string) => Promise<void>;
		customSend?: (message: { content: string; details: { visibleMessageIds: number[] } }) => Promise<void>;
		contextEntries?: () => unknown[];
		compact?: (...args: unknown[]) => Promise<{ tokensBefore: number }>;
		isStreaming?: boolean;
	} = {},
): FakeSession {
	const fake: FakeSession = {
		sent: [],
		listener: null,
		sendUserMessage: opts.send ?? (async (t: string) => { fake.sent.push(t); }),
		compact: opts.compact ?? (async () => ({ tokensBefore: 100 })),
	};
	(rt as any).session = {
		subscribe: (l: (e: unknown) => void) => { fake.listener = l; },
		sendUserMessage: (t: string) => fake.sendUserMessage(t),
		...(opts.customSend ? { sendCustomMessage: opts.customSend } : {}),
		compact: (...args: unknown[]) => fake.compact(...args),
		isStreaming: opts.isStreaming ?? false,
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

function insertVisionMsg(messageId: number, fileUniqueId: string, kind: VisionKind = "photo"): void {
	db.query("INSERT OR IGNORE INTO media (file_unique_id, kind) VALUES (?, ?)").run(fileUniqueId, kind);
	db.query("INSERT OR IGNORE INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', ?, ?)").run(
		`file-${messageId}`,
		fileUniqueId,
	);
	insertMsg({
		message_id: messageId,
		date: 1754600000 + messageId,
		text: null,
		media: JSON.stringify({
			kind,
			file_unique_id: fileUniqueId,
			...(kind === "sticker" ? { sticker_emoji: "😿", sticker_set: "fixture" } : {}),
		}),
	});
}

function visionTelemetry(kind: VisionKind, outcome: VisionOutcome = "ok"): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: "lt_32_kib",
		convertedBytesBucket: "unavailable",
		latencyMs: 10,
		inputTokens: 10,
		outputTokens: 5,
		reasoningTokens: 0,
		cost: 0.001,
		outcome,
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("condition did not settle");
}

function visibleIds(): number[] {
	return listVisibleMessageIds(db, "A", CHAT, Number(getBotState(db, "A", "context_epoch") ?? "1"));
}

function errorEvents(): { stage: string; error?: string; category?: string; reason?: string; aborted?: boolean }[] {
	const rows = db.query("SELECT payload FROM agent_events WHERE bot_id = 'A' AND kind = 'error'").all() as { payload: string }[];
	return rows.map((r) => JSON.parse(r.payload) as { stage: string });
}

describe("flush state machine (REQ-AGENT-0001)", () => {
	for (const mediaCount of [1, 2, 3]) {
		test(`VISION AC1/AC8: ${mediaCount} uncached media settle in two-wide waves before one provider submit`, async () => {
			let active = 0;
			let peak = 0;
			const started: number[] = [];
			const calls = new Map<number, number>();
			const releases = new Map<number, () => void>();
			const executor: VisionExecutor = {
				modelRef: "openai-codex/gpt-5.6-luna:low",
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				readinessFailure: null,
				describe: async (input) => {
					const id = input.bytes[0]!;
					calls.set(id, (calls.get(id) ?? 0) + 1);
					started.push(id);
					active++;
					peak = Math.max(peak, active);
					return await new Promise((resolve) => {
						releases.set(id, () => {
							active--;
							resolve({ text: `vision-${id}`, telemetry: visionTelemetry(input.kind) });
						});
					});
				},
			};
			const rt = makeRuntime({ visionExecutor: executor });
			const fake = attachFakeSession(rt);
			(rt as any).api = {
				getFile: async (fileId: string) => ({ file_path: `photos/${fileId}.png` }),
				downloadFile: async (filePath: string) => {
					const id = Number(filePath.match(/file-(\d+)/)?.[1]);
					return new Uint8Array([id]);
				},
			};
			for (let id = 1; id <= mediaCount; id++) insertVisionMsg(id, `media-${id}`);

			rt.trigger();
			const flush = (rt as any).flushPromise as Promise<void>;
			const recognizedIds = Array.from({ length: mediaCount }, (_, index) => mediaCount - index).slice(0, 2);
			await waitUntil(() => started.length === recognizedIds.length);
			expect(fake.sent).toHaveLength(0);
			const firstWave = [...started];
			for (const id of firstWave) releases.get(id)!();
			await flush;

			expect(peak).toBe(recognizedIds.length);
			expect(started).toEqual(recognizedIds);
			expect([...calls.values()]).toEqual(Array.from({ length: recognizedIds.length }, () => 1));
			expect(fake.sent).toHaveLength(1);
			for (const id of recognizedIds) {
				expect(fake.sent[0]).toContain(`[图片: vision-${id}]`);
			}
			for (let id = 1; id <= mediaCount; id++) {
				if (!recognizedIds.includes(id)) expect(fake.sent[0]).toContain(`#${id} Alice (@alice): [图片]`);
			}
			expect(visibleIds()).toEqual(Array.from({ length: mediaCount }, (_, index) => index + 1));

			const payloadRows = db.query("SELECT payload FROM agent_events WHERE bot_id = 'A' AND kind = 'vision' ORDER BY id").all() as { payload: string }[];
			expect(payloadRows).toHaveLength(recognizedIds.length);
			const serializedTelemetry = payloadRows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
			for (const payload of serializedTelemetry) {
				expect(Object.keys(payload).sort()).toEqual([
					"convertedBytesBucket", "cost", "inputTokens", "kind", "latencyMs", "outcome",
					"outputTokens", "reasoningTokens", "sourceBytesBucket",
				].sort());
			}
			expect(JSON.stringify(serializedTelemetry)).not.toMatch(/media-|file-|photos|vision-\d/);
		});
	}

	test("VISION AC2: provider failure and unsupported media submit one fallback and never rewrite it", async () => {
		let describeCalls = 0;
		const executor: VisionExecutor = {
			modelRef: "openai-codex/gpt-5.6-luna:low",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			readinessFailure: null,
			describe: async (input) => {
				describeCalls++;
				return { text: null, telemetry: visionTelemetry(input.kind, "provider_request_failed") };
			},
		};
		const rt = makeRuntime({ visionExecutor: executor });
		const fake = attachFakeSession(rt);
		(rt as any).api = {
			getFile: async (fileId: string) => ({
				file_path: fileId === "file-1" ? "photos/failure.png" : "stickers/animated.tgs",
			}),
			downloadFile: async () => new Uint8Array([1]),
		};
		insertVisionMsg(1, "failed-photo");
		insertVisionMsg(2, "unsupported-sticker", "sticker");

		rt.trigger();
		await ((rt as any).flushPromise as Promise<void>);
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("#1 Alice (@alice): [图片]");
		expect(fake.sent[0]).toContain("#2 Alice (@alice): [sticker 😿 set:fixture]");
		expect(describeCalls).toBe(1);
		expect(visibleIds()).toEqual([1, 2]);

		rt.trigger();
		await ((rt as any).flushPromise as Promise<void>);
		expect(fake.sent).toHaveLength(1);
		expect(describeCalls).toBe(1);
		expect(db.query("SELECT json_extract(vision, '$.outcome') outcome FROM media WHERE file_unique_id = 'failed-photo'").get()).toEqual({ outcome: "provider_request_failed" });
		expect(db.query("SELECT json_extract(vision, '$.outcome') outcome FROM media WHERE file_unique_id = 'unsupported-sticker'").get()).toEqual({ outcome: "unsupported_format" });
	});

	test("VISION AC3: a persistent cache hit reaches provider without download or another description", async () => {
		const executor: VisionExecutor = {
			modelRef: "openai-codex/gpt-5.6-luna:low",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			readinessFailure: null,
			describe: async () => { throw new Error("cached media must not describe"); },
		};
		const rt = makeRuntime({ visionExecutor: executor });
		const fake = attachFakeSession(rt);
		(rt as any).api = {
			getFile: async () => { throw new Error("cached media must not call Telegram"); },
			downloadFile: async () => { throw new Error("cached media must not download"); },
		};
		insertVisionMsg(1, "cached-photo");
		db.query("UPDATE media SET vision = ? WHERE file_unique_id = 'cached-photo'").run(
			JSON.stringify({ model: "fixture", kind: "photo", text: "cached-description", outcome: "ok", at: 1 }),
		);
		appendMediaUpdateEvents(db, "cached-photo", "cached-description");

		rt.trigger();
		await ((rt as any).flushPromise as Promise<void>);
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("[图片: cached-description]");
		expect(db.query("SELECT COUNT(*) n FROM agent_events WHERE kind = 'vision'").get()).toEqual({ n: 0 });
	});

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

			expect(fake.sent.length).toBe(1);
			expect(fake.sent[0]).toContain("#1 ");
			expect(fake.sent[0]).toContain("#2 ");
			expect(visibleIds()).toEqual([1, 2]);
		expect(errorEvents()).toEqual([]);
	});

	test("AC2: provider submission failure keeps events uncommitted and retries later", async () => {
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
		expect(getBotState(db, "A", "exposed_ids")).toBeNull(); // legacy state is never recreated
		const errors = errorEvents();
		expect(errors.length).toBe(1);
		expect(errors[0].stage).toBe("flush");
		expect(errors[0]).toEqual({ stage: "flush", category: "provider_request_failed" });

		fail = false;
		rt.trigger();
		await (rt as any).flushPromise;

		expect(fake.sent.length).toBe(1);
		expect(fake.sent[0]).toContain("#1 ");
		expect(visibleIds()).toEqual([1]);
	});

	test("REQ-SEND-0003: a message packed for this provider turn is immediately replyable", async () => {
		const rt = makeRuntime();
		let replyTo: number | undefined;
		let telegramCalls = 0;
		(rt as any).api = {
			sendMessageWithEntities: async (_chatId: number, text: string, _entities: unknown, reply?: number) => {
				telegramCalls++;
				replyTo = reply;
				return {
					chat: { id: CHAT }, message_id: 100, date: 1_754_600_100,
					from: { id: 999, is_bot: true, first_name: "A" }, text,
				};
			},
			sendMessage: async () => { throw new Error("plain fallback must not run"); },
		};
		attachFakeSession(rt, {
			customSend: async (message) => {
				expect(message.details.visibleMessageIds).toEqual([42]);
				const result = await (rt as any).executeSend({ message: "精确回复", reply_to: 42 });
				expect(result.terminate).toBe(true);
			},
		});
		insertMsg({ message_id: 42, text: "reply to this turn" });

		rt.trigger();
		await (rt as any).flushPromise;

		expect(telegramCalls).toBe(1);
		expect(replyTo).toBe(42);
		expect(visibleIds()).toEqual([42, 100]);
		expect(errorEvents()).toEqual([]);
	});

	test("REQ-SEND-0003: failed provider submission rolls back turn-local reply visibility", async () => {
		const rt = makeRuntime();
		attachFakeSession(rt, {
			customSend: async (message) => {
				expect((rt as any).visibleMessageIds.has(message.details.visibleMessageIds[0])).toBe(true);
				throw new Error("provider unavailable before session persistence");
			},
			contextEntries: () => [],
		});
		insertMsg({ message_id: 43, text: "must remain retryable" });

		rt.trigger();
		await (rt as any).flushPromise;

		expect((rt as any).visibleMessageIds.has(43)).toBe(false);
		expect(visibleIds()).toEqual([]);
		expect(errorEvents()).toEqual([{ stage: "flush", category: "provider_request_failed" }]);
	});

	test("AC3: failed/aborted compaction does not bump epoch or replace visibility", () => {
		const rt = makeRuntime();
		const fake = attachFakeSession(rt);
		(rt as any).markVisible([1, 2, 3]);

		fake.listener!({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "Auto-compaction failed: boom" });
		expect((rt as any).epoch).toBe(1);
		expect(visibleIds()).toEqual([1, 2, 3]);

		fake.listener!({ type: "compaction_end", reason: "overflow", result: undefined, aborted: true, willRetry: false });
		expect((rt as any).epoch).toBe(1);
		expect(visibleIds()).toEqual([1, 2, 3]);

		const errors = errorEvents();
		expect(errors.length).toBe(2);
		expect(errors.every((e) => e.stage === "compaction")).toBe(true);
		expect(errors.every((e) => e.category === "provider_request_failed")).toBe(true);
		expect(JSON.stringify(errors)).not.toContain("boom");
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

	test("AC4: compaction replaces structured visibility without replaying the consumed cursor", async () => {
		const rt = makeRuntime();
		for (let i = 1; i <= 60; i++) insertMsg({ message_id: i, date: 1754600000 + i, text: `m${i}` });
		const consumed = messageEventHighWater(db, CHAT);
		setConsumedSeq(db, "A", CHAT, consumed);
		(rt as any).markVisible(Array.from({ length: 60 }, (_, i) => i + 1));
		const fake = attachFakeSession(rt);
		const kept = [45, 46, 47, 48, 49, 50, 51, 52];

		fake.listener!({
			type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
			result: {
				summary: "摘要",
				firstKeptEntryId: "u1",
				tokensBefore: 99999,
				details: { consumedSeq: consumed, visibleMessageIds: kept },
			},
		});

		expect((rt as any).epoch).toBe(2);
		expect(getBotState(db, "A", "context_epoch")).toBe("2");
		expect(visibleIds()).toEqual(kept);
		expect(messageEventHighWater(db, CHAT)).toBe(consumed);
		expect(db.query("SELECT consumed_seq AS consumed FROM bot_cursors WHERE bot_id = 'A'").get()).toEqual({ consumed });

		rt.trigger();
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(0);

		insertMsg({ message_id: 61, date: 1754600061, text: "new only" });
		rt.trigger();
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("#61 ");
		expect(fake.sent[0]).not.toContain("#1 ");
	});

	test("REQ-CMD-0001 manual compact calls Pi once only while idle and preserves the unified epoch handler", async () => {
		const rt = makeRuntime();
		let calls = 0;
		const fake = attachFakeSession(rt, {
			compact: async (...args) => {
				calls++;
				expect(args).toEqual([]);
				fake.listener!({
					type: "compaction_end",
					reason: "manual",
					aborted: false,
					willRetry: false,
					result: { summary: "bounded", firstKeptEntryId: "x", tokensBefore: 321 },
				});
				return { tokensBefore: 321 };
			},
		});
		expect(await rt.compactForControl()).toEqual({ ok: true, epoch: 2, tokensBefore: 321 });
		expect(calls).toBe(1);
		expect(rt.controlSnapshot()).toMatchObject({ state: "idle", epoch: 2, model: "test-model", lastCompact: { outcome: "ok" } });

		(rt as any).flushing = true;
		expect(await rt.compactForControl()).toEqual({ ok: false, code: "busy" });
		(rt as any).flushing = false;
		(rt as any).stopping = true;
		expect(await rt.compactForControl()).toEqual({ ok: false, code: "stopping" });
		expect(calls).toBe(1);
	});

	test("REQ-CMD-0001 compact coalesces explicit traffic, skips probability, and drains after completion", async () => {
		const rt = makeRuntime();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const fake = attachFakeSession(rt, {
			compact: async () => {
				await gate;
				fake.listener!({
					type: "compaction_end",
					reason: "manual",
					aborted: false,
					willRetry: false,
					result: { summary: "bounded", firstKeptEntryId: "x", tokensBefore: 100 },
				});
				return { tokensBefore: 100 };
			},
		});
		const compact = rt.compactForControl();
		expect(rt.controlSnapshot().state).toBe("compacting");
		insertMsg({ message_id: 71, text: "arrived during compact" });
		expect(rt.trigger("explicit")).toBe("coalesced");
		expect(rt.trigger("probability")).toBe("skipped_busy");
		release();
		expect(await compact).toMatchObject({ ok: true });
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("#71 ");
	});

	test("REQ-CMD-0001 durable claim stays excluded after compaction replaces visibility", async () => {
		const rt = makeRuntime();
		const fake = attachFakeSession(rt);
		insertMsg({ message_id: 81, text: "/tg status" });
		insertMsg({ message_id: 82, date: 1754600001, sender_id: 777, display_name: "小雪", username: "alpha_bot", is_bot: 1, text: "status reply" });
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 1, 'telegram_control_claim', ?)").run(
			JSON.stringify({ chat_id: CHAT, message_id: 81, command: "status" }),
		);
		db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES ('A', 2, 'telegram_control_reply', ?)").run(
			JSON.stringify({ chat_id: CHAT, message_id: 82 }),
		);
		rt.consumeControlMessage(81);
		rt.consumeControlMessage(82);
		fake.listener!({
			type: "compaction_end",
			reason: "manual",
			aborted: false,
			willRetry: false,
			result: { summary: "bounded", firstKeptEntryId: "x", tokensBefore: 100 },
		});
		insertMsg({ message_id: 83, date: 1754600002, text: "ordinary" });
		expect(rt.trigger()).toBe("started");
		await (rt as any).flushPromise;
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).not.toContain("#81 ");
		expect(fake.sent[0]).not.toContain("#82 ");
		expect(fake.sent[0]).toContain("#83 ");
	});

	test("R7: executeSend validates the sticker before any network send", async () => {
		const rt = makeRuntime();
		attachFakeSession(rt);
		let networkCalls = 0;
		(rt as any).api = {
			sendMessageWithEntities: async () => { networkCalls++; throw new Error("must not reach network"); },
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
			sendMessageWithEntities: async (chatId: number, text: string) => ({
				chat: { id: chatId }, message_id: sentMessageId++, from: { id: 777, is_bot: true, first_name: "小雪" },
				date: 1754600100, text,
			}),
			sendMessage: async () => { throw new Error("plain fallback must not run"); },
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
		expect(db.query("SELECT kind FROM agent_events ORDER BY id").all()).toEqual([{ kind: "markdown_sent" }, { kind: "send" }]);
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
		const restore = setLogSink((line) => warnings.push(line));
		try {
			expect(rt.trigger("explicit")).toBe("started");
			await scheduler.advance(8000);
			expect(actionCalls).toBe(3);
			const activityWarnings = warnings
				.map((line) => JSON.parse(line) as { component: string; event: string })
				.filter((record) => record.component === "telegram_activity" && record.event === "typing_failed");
			expect(activityWarnings).toHaveLength(1);
			expect(activityWarnings[0]).toMatchObject({
				component: "telegram_activity",
				event: "typing_failed",
				fields: { bot_id: "A", category: "request_failed", retry: true },
			});
			expect(warnings.join("\n")).not.toContain("test-token");
			expect(warnings.join("\n")).not.toContain("https://");
			release();
			await (rt as any).flushPromise;
		} finally {
			restore();
		}
		expect(fake.sent).toHaveLength(1);
		expect(visibleIds()).toEqual([1]);
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
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]).toContain("#1 ");
		expect(fake.sent[0]).toContain("#2 ");
		expect(rt.samplingState()).toBe("cooldown");

		insertMsg({ message_id: 3, date: 1754600003, text: "explicit during cooldown" });
		expect(rt.trigger("explicit")).toBe("started");
		await (rt as any).flushPromise;
		expect(fake.sent[1]).toContain("#3 ");
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
		expect(errorEvents()).toEqual([{ stage: "flush", category: "provider_request_failed" }]);
	});
});
