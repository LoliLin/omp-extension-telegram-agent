process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcServer } from "../src/daemon/ipc-server.ts";
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
