process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { openDb } from "../src/db/db.ts";
import type { SendMessageRequest } from "../src/ipc.ts";
import { TimelineClient, type TimelineEvent } from "../src/plugin/timeline.ts";

let db: Database;
let server: IpcServer;
let sockPath: string;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	sockPath = join(tmpdir(), `tg-engine-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
	server = new IpcServer(db, sockPath, new Map([["A", "小雪"], ["B", "小雨"]]), new Map([["A", 777], ["B", 888]]));
	server.start();
});

afterEach(() => server.stop());

function insertMsg(id: number, dateSec: number, text = `m${id}`): void {
	db.query(`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		VALUES (-1001, ?, ?, 111, 'Alice', 'alice', 0, ?, 'A')`).run(id, dateSec, text);
}

function insertEvt(botId: string, ts: number): void {
	db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, 'thinking', '{}')").run(botId, ts);
}

function insertRun(botId: string, id: number, context: number, read: number, miss: number, cost: number): void {
	db.query("INSERT INTO llm_runs (id, bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES (?, ?, ?, 'm', 1, ?, ?, ?, 10, ?)")
		.run(id, botId, id, context, read, miss, cost);
}

class EventLog {
	readonly events: TimelineEvent[] = [];

	async waitFor(predicate: (event: TimelineEvent) => boolean, timeoutMs = 5000): Promise<TimelineEvent> {
		const started = Date.now();
		while (Date.now() - started <= timeoutMs) {
			const found = this.events.find(predicate);
			if (found) return found;
			await Bun.sleep(10);
		}
		throw new Error(`event not seen; got: ${this.events.map((event) => event.type).join(",")}`);
	}
}

async function connect(filter: string | null): Promise<{ client: TimelineClient; log: EventLog }> {
	const log = new EventLog();
	const client = new TimelineClient(sockPath, filter, { onEvent: (event) => log.events.push(event) });
	await client.connect();
	return { client, log };
}

function allItems(log: EventLog) {
	return log.events.flatMap((event) => event.type === "append" || event.type === "prepend" ? event.items : []);
}

describe("Pi plugin timeline client", () => {
	test("manual send resolves the matching daemon acknowledgement", async () => {
		server.stop();
		const requests: SendMessageRequest[] = [];
		server = new IpcServer(
			db,
			sockPath,
			new Map([["A", "小雪"]]),
			new Map([["A", 777]]),
			async (request) => {
				requests.push(request);
				return { requestId: request.requestId, botId: request.botId, ok: true, chatId: -1001, messageId: 73 };
			},
		);
		server.start();
		const { client } = await connect("A");

		const result = await client.sendText("A", "hello", "request-1");
		client.dispose();

		expect(requests).toEqual([{ type: "send_message", requestId: "request-1", botId: "A", text: "hello" }]);
		expect(result).toEqual({ requestId: "request-1", botId: "A", ok: true, chatId: -1001, messageId: 73 });
	});

	test("missing send acknowledgement becomes unknown without retrying", async () => {
		server.stop();
		let calls = 0;
		server = new IpcServer(
			db,
			sockPath,
			new Map([["A", "小雪"]]),
			new Map([["A", 777]]),
			async () => {
				calls++;
				return await new Promise(() => {});
			},
		);
		server.start();
		const log = new EventLog();
		const client = new TimelineClient(sockPath, "A", { onEvent: (event) => log.events.push(event) }, 20);
		await client.connect();

		const result = await client.sendText("A", "only once", "request-timeout");
		client.dispose();

		expect(calls).toBe(1);
		expect(result).toMatchObject({ requestId: "request-timeout", botId: "A", ok: false, code: "unknown_outcome" });
	});

	test("vision update received before a live message is merged by media identity", async () => {
		const { client, log } = await connect(null);
		await log.waitFor((event) => event.type === "stats");
		server.broadcastVision({ fileUniqueId: "photo-live", text: "一只猫在窗边" });
		server.broadcastVision({ fileUniqueId: "photo-live", text: "一只猫在窗边" });
		server.broadcast({
			kind: "msg",
			ts: Date.now(),
			chatId: -1001,
			messageId: 909,
			senderName: "Alice",
			username: "alice",
			isBot: false,
			botId: null,
			text: null,
			mediaKind: "photo",
			stickerEmoji: null,
			fileUniqueId: "photo-live",
			replyTo: null,
			edited: false,
		});

		await log.waitFor((event) => event.type === "append" && event.items.some((item) => item.kind === "msg" && item.messageId === 909));
		await Bun.sleep(10);
		client.dispose();

		const item = allItems(log).find((candidate) => candidate.kind === "msg" && candidate.messageId === 909);
		expect(item?.kind === "msg" ? item.mediaDesc : null).toBe("一只猫在窗边");
		expect(log.events.filter((event) => event.type === "vision" && event.fileUniqueId === "photo-live")).toHaveLength(1);
	});

	test("vision cache is bounded and applies to later history pages", async () => {
		const log = new EventLog();
		const client = new TimelineClient(sockPath, null, { onEvent: (event) => log.events.push(event) });
		for (let index = 0; index < 300; index++) {
			(client as any).handleFrame({ type: "vision_update", fileUniqueId: `media-${index}`, text: `desc-${index}` });
		}
		(client as any).handleFrame({
			type: "history",
			items: [{
				kind: "msg",
				ts: 1,
				chatId: -1001,
				messageId: 1,
				senderName: "Alice",
				username: null,
				isBot: false,
				botId: null,
				text: null,
				mediaKind: "sticker",
				stickerEmoji: "👋",
				fileUniqueId: "media-299",
				replyTo: null,
				edited: false,
			}],
			hasMore: false,
		});

		expect((client as any).visionUpdates.size).toBe(256);
		const older = log.events.find((event) => event.type === "prepend") as Extract<TimelineEvent, { type: "prepend" }>;
		expect(older.items[0]?.kind === "msg" ? older.items[0].mediaDesc : null).toBe("desc-299");
		client.dispose();
	});

	test("snapshot emits raw items and merged DB stats", async () => {
		insertMsg(100, 1754600000, "hello");
		insertEvt("A", 1754600001 * 1000);
		insertRun("A", 1, 1000, 800, 200, 0.01);
		insertRun("B", 2, 2000, 0, 2000, 0.02);
		const { client, log } = await connect(null);
		await log.waitFor((event) => event.type === "stats");
		client.dispose();

		expect(allItems(log).some((item) => item.kind === "msg" && item.messageId === 100)).toBe(true);
		expect(allItems(log).some((item) => item.kind === "evt" && item.botId === "A")).toBe(true);
		const event = log.events.find((item) => item.type === "stats") as Extract<TimelineEvent, { type: "stats" }>;
		expect(event.stats.A?.cacheRead).toBe(800);
		expect(event.stats.B?.contextTokens).toBe(2000);
	});

	test("hello filter keeps all messages but only the selected bot events", async () => {
		insertMsg(100, 1754600000);
		insertEvt("A", 1754600001 * 1000);
		insertEvt("B", 1754600002 * 1000);
		const { client, log } = await connect("A");
		await log.waitFor((event) => event.type === "stats");
		client.dispose();

		const items = allItems(log);
		expect(items.some((item) => item.kind === "msg")).toBe(true);
		expect(items.some((item) => item.kind === "evt" && item.botId === "A")).toBe(true);
		expect(items.some((item) => item.kind === "evt" && item.botId === "B")).toBe(false);
	});

	test("explicit more uses the composite cursor without loss or duplication", async () => {
		for (let index = 1; index <= 120; index++) insertMsg(1000 + index, index <= 3 ? 1754580000 : 1754580000 + index);
		const { client, log } = await connect(null);
		await log.waitFor((event) => event.type === "append" && event.items.some((item) => item.kind === "msg" && item.messageId === 1120));
		expect(client.requestOlder()).toBe(true);
		await log.waitFor((event) => event.type === "prepend");
		client.dispose();

		const ids = allItems(log).filter((item) => item.kind === "msg").map((item) => item.messageId);
		expect(ids).toHaveLength(120);
		expect(new Set(ids).size).toBe(120);
		for (let index = 1; index <= 120; index++) expect(ids).toContain(1000 + index);
	});

	test("live usage merges once with the snapshot baseline", async () => {
		insertRun("A", 1, 1000, 800, 200, 0.01);
		const { client, log } = await connect("A");
		await log.waitFor((event) => event.type === "stats");
		const before = log.events.filter((event) => event.type === "stats").length;
		server.broadcastUsage({ id: 99, botId: "A", ts: 99, model: "m", epoch: 1, contextTokens: 5000, cacheRead: 4000, cacheMiss: 1000, outputTokens: 50, cost: 0.03 });
		await log.waitFor((event) => event.type === "stats" && log.events.filter((item) => item.type === "stats").indexOf(event) >= before);
		client.dispose();

		const latest = log.events.filter((event): event is Extract<TimelineEvent, { type: "stats" }> => event.type === "stats").at(-1)!;
		expect(latest.stats.A?.contextTokens).toBe(6000);
		expect(latest.stats.A?.cacheRead).toBe(4800);
	});

	test("lifetime telemetry survives daemon restart, merges live detail once, and excludes removed bots", async () => {
		server.stop();
		db.close();
		const dbPath = join(tmpdir(), `tg-lifetime-${process.pid}-${Date.now()}.db`);
		sockPath = join(tmpdir(), `tg-lifetime-${process.pid}-${Date.now()}.sock`);
		let client: TimelineClient | null = null;
		try {
			db = openDb(dbPath);
			db.query("INSERT INTO llm_runs (id, bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost) VALUES (1, 'A', 1000, 'm', 1, 1000, 700, 100, 200, 10, 5, 200, 0.01)").run();
			db.query("INSERT INTO llm_runs (id, bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost) VALUES (2, 'removed', 1500, 'm', 1, 9999, 0, 0, 9999, 99, 99, 999, 9.99)").run();
			server = new IpcServer(db, sockPath, new Map([["A", "小雪"], ["B", "小雨"]]), new Map([["A", 777], ["B", 888]]));
			server.start();
			const first = await connect(null);
			client = first.client;
			const beforeRestart = await first.log.waitFor((event) => event.type === "stats") as Extract<TimelineEvent, { type: "stats" }>;
			expect(beforeRestart.stats.A?.runs).toBe(1);
			client.dispose();
			client = null;
			server.stop();
			db.close();

			db = openDb(dbPath);
			server = new IpcServer(db, sockPath, new Map([["A", "小雪"], ["B", "小雨"]]), new Map([["A", 777], ["B", 888]]));
			server.start();
			const second = await connect(null);
			client = second.client;
			const baseline = await second.log.waitFor((event) => event.type === "stats") as Extract<TimelineEvent, { type: "stats" }>;
			expect(baseline.stats.A).toMatchObject({ runs: 1, cacheWrite: 100, reasoningTokens: 5, totalLatencyMs: 200, latencySamples: 1, firstRunTs: 1000 });
			expect(baseline.stats.removed).toBeUndefined();

			db.query("INSERT INTO llm_runs (id, bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost) VALUES (3, 'A', 2000, 'm', 2, 2000, 1500, 200, 300, 20, 7, 400, 0.02)").run();
			server.broadcastUsage({
				id: 3, botId: "A", ts: 2000, model: "m", epoch: 2, contextTokens: 2000,
				cacheRead: 1500, cacheWrite: 200, cacheMiss: 300, outputTokens: 20,
				reasoningTokens: 7, latencyMs: 400, cost: 0.02,
			});
			const merged = await second.log.waitFor((event) => event.type === "stats" && event.stats.A?.runs === 2) as Extract<TimelineEvent, { type: "stats" }>;

			expect(merged.stats.A).toMatchObject({
				runs: 2,
				contextTokens: 3000,
				cacheRead: 2200,
				cacheWrite: 300,
				cacheMiss: 500,
				outputTokens: 30,
				reasoningTokens: 12,
				totalLatencyMs: 600,
				latencySamples: 2,
				firstRunTs: 1000,
				epoch: 2,
				cost: 0.03,
			});
			expect(merged.stats.A?.last).toMatchObject({ id: 3, cacheWrite: 200, reasoningTokens: 7, latencyMs: 400 });
		} finally {
			client?.dispose();
			server.stop();
			db.close();
			for (const suffix of ["", "-wal", "-shm"]) {
				try { unlinkSync(`${dbPath}${suffix}`); } catch {}
			}
		}
	});

	test("missing daemon returns false with an actionable event", async () => {
		server.stop();
		const log = new EventLog();
		const client = new TimelineClient(sockPath, null, { onEvent: (event) => log.events.push(event) });
		expect(await client.connect()).toBe(false);
		const event = await log.waitFor((item) => item.type === "disconnected") as Extract<TimelineEvent, { type: "disconnected" }>;
		expect(event.reason).toContain("bun run src/main.ts start");
		client.dispose();
	});
});
