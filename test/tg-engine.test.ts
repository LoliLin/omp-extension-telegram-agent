// REQ-UI-0004: pi-extension engine tests — real IpcServer + TgTimeline over a real unix
// socket (no terminal, no pi process needed). Covers connect/hello(filter)/snapshot,
// live append, pagination with the composite cursor, stats aggregation with lastId dedupe.

process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { TgTimeline, type TgEvent, type RenderUnit } from "../src/tui/engine.ts";

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

afterEach(() => {
	server.stop();
});

function insertMsg(chatId: number, messageId: number, dateSec: number, text: string, isBot = 0): void {
	db.query(
		`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, 111, 'Alice', 'alice', ?, ?, 'A')`,
	).run(chatId, messageId, dateSec, isBot, text);
}

function insertEvt(botId: string, ts: number, kind: string, payload = "{}"): void {
	db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(botId, ts, kind, payload);
}

function insertRun(botId: string, id: number, ctx: number, read: number, miss: number, cost: number): void {
	db.query(
		"INSERT INTO llm_runs (id, bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES (?, ?, ?, 'm', 1, ?, ?, ?, 10, ?)",
	).run(id, botId, id, ctx, read, miss, cost);
}

interface EventLog {
	events: TgEvent[];
	waitFor(pred: (e: TgEvent) => boolean, timeoutMs?: number): Promise<TgEvent>;
}

function connectTimeline(filter: string | null): Promise<{ engine: TgTimeline; log: EventLog }> {
	return new Promise((resolve, reject) => {
		const log: EventLog = {
			events: [],
			waitFor(pred, timeoutMs = 5000) {
				const existing = this.events.find(pred);
				if (existing) return Promise.resolve(existing);
				return new Promise((res, rej) => {
					const t0 = Date.now();
					const iv = setInterval(() => {
						const hit = log.events.find(pred);
						if (hit) {
							clearInterval(iv);
							res(hit);
						} else if (Date.now() - t0 > timeoutMs) {
							clearInterval(iv);
							rej(new Error(`event not seen in ${timeoutMs}ms; got: ${log.events.map((e) => e.type).join(",")}`));
						}
					}, 20);
				});
			},
		};
		const engine = new TgTimeline(sockPath, filter, { onEvent: (e) => log.events.push(e) });
		engine.connect().then(() => resolve({ engine, log })).catch(reject);
	});
}

function unitTexts(units: RenderUnit[]): string[] {
	return units.map((u) => (u.kind === "sep" ? `--- ${u.day} ---` : u.text));
}

describe("TgTimeline engine (REQ-UI-0004)", () => {
	test("connect + snapshot: messages and events arrive as append units; stats lines match llm_runs", async () => {
		const chatId = -1004402809405;
		insertMsg(chatId, 100, 1754600000, "hello");
		insertEvt("A", 1754600001 * 1000, "thinking");
		insertRun("A", 1, 1000, 800, 200, 0.01);
		insertRun("B", 2, 2000, 0, 2000, 0.02);

		const { engine, log } = await connectTimeline(null);
		const snap = await log.waitFor((e) => e.type === "snapshot" as never || (e.type === "append" && e.units!.some((u) => u.kind === "item")));
		void snap;
		await log.waitFor((e) => e.type === "stats");
		engine.dispose();

		const appended = log.events.filter((e) => e.type === "append").flatMap((e) => (e as { units: RenderUnit[] }).units);
		const texts = unitTexts(appended).join("\n");
		expect(texts).toContain("#100 ");
		expect(texts).toContain("小雪 · LOCAL");
		const stats = log.events.find((e) => e.type === "stats") as { lines: string[] };
		expect(stats.lines.length).toBe(2);
		expect(stats.lines[0]).toContain("A");
		expect(stats.lines[0]).toContain("hit 80.0%");
		expect(stats.lines[1]).toContain("B");
	});

	test("hello filter: only the filtered bot's LOCAL events arrive; messages always arrive", async () => {
		const chatId = -1004402809405;
		insertMsg(chatId, 100, 1754600000, "hi");
		insertEvt("A", 1754600001 * 1000, "thinking");
		insertEvt("B", 1754600002 * 1000, "thinking");

		const { engine, log } = await connectTimeline("A");
		await log.waitFor((e) => e.type === "stats" || (e.type === "append" && (e as { units: RenderUnit[] }).units.length > 0));
		engine.dispose();

		const appended = log.events.filter((e) => e.type === "append").flatMap((e) => (e as { units: RenderUnit[] }).units);
		const texts = unitTexts(appended).join("\n");
		expect(texts).toContain("#100 ");
		expect(texts).toContain("小雪 · LOCAL");
		expect(texts).not.toContain("小雨 · LOCAL");
	});

	test("pagination: snapshot + requestOlder page through same-second messages without loss or duplication", async () => {
		const chatId = -1004402809405;
		// 120 messages: snapshot returns the newest 100; the oldest 20 (incl. 3 same-second
		// messages) must arrive via the composite-cursor history page — no loss, no duplication.
		for (let i = 1; i <= 120; i++) {
			// ids 1..3 share the same second (the composite-cursor case)
			const dateSec = i <= 3 ? 1754580000 : 1754580000 + i;
			insertMsg(chatId, 1000 + i, dateSec, `m${i}`);
		}

		const { engine, log } = await connectTimeline(null);
		// wait until the snapshot page (100 items, id 1021..1120) has arrived
		await log.waitFor((e) => e.type === "append" && (e as { units: RenderUnit[] }).units.some((u) => u.kind === "item" && u.text.includes("#1120")));
		// page back: the remaining 20 older messages
		engine.requestOlder();
		const hist = (await log.waitFor((e) => e.type === "prepend")) as { units: RenderUnit[] };
		engine.dispose();

		const all = unitTexts(
			log.events
				.filter((e) => e.type === "append")
				.flatMap((e) => (e as { units: RenderUnit[] }).units)
				.concat(hist.units),
		).join("\n");
		// every message id appears exactly once
		for (let i = 1; i <= 120; i++) {
			const id = `#${1000 + i} `;
			expect(all.split(id).length - 1).toBe(1);
		}
	});

	test("live append + usage push update the stats lines (lastId dedupe)", async () => {
		const { engine, log } = await connectTimeline("A");
		await log.waitFor((e) => e.type === "stats");
		const before = log.events.filter((e) => e.type === "stats").length;

		// a live run completes while attached: the daemon pushes it as a usage frame
		server.broadcastUsage({ id: 99, botId: "A", ts: 99, model: "m", epoch: 1, contextTokens: 5000, cacheRead: 4000, cacheMiss: 1000, outputTokens: 50, cost: 0.03 });
		// wait for a NEW stats event (the (before)-th index in the stats-only list)
		await log.waitFor((e) => e.type === "stats" && log.events.filter((x) => x.type === "stats").indexOf(e as { type: "stats"; lines: string[] }) >= before);

		engine.dispose();
		const stats = log.events.filter((e) => e.type === "stats") as { lines: string[] }[];
		const last = stats.at(-1)!;
		expect(last.lines[0]).toContain("cum in 5.00K");
		expect(last.lines[0]).toContain("hit 80.0%");
	});

	test("daemon not running: disconnected event with a helpful reason", async () => {
		server.stop();
		const { engine, log } = await connectTimeline(null);
		const ev = await log.waitFor((e) => e.type === "disconnected");
		expect((ev as { reason: string }).reason).toContain("daemon not running");
		engine.dispose();
	});

	test("render functions produce stable text for messages/events (smoke)", () => {
		const { renderMsg, renderEvt } = require("../src/tui/engine.ts") as typeof import("../src/tui/engine.ts");
		const m = renderMsg({ kind: "msg", ts: 1754600000 * 1000, chatId: 1, messageId: 5, senderName: "Alice", username: "alice", isBot: false, botId: null, text: "hello\nworld", mediaKind: null, stickerEmoji: null, replyTo: 3, edited: true });
		expect(m).toContain("#5");
		expect(m).toContain("↪ #3");
		expect(m).toContain("(edited)");
		expect(m).toContain("hello\n  world");
		const e = renderEvt({ kind: "evt", ts: 1, evtId: 2, botId: "A", botName: "小雪", evtKind: "thinking", payload: JSON.stringify({ text: "想" }) });
		expect(e).toContain("小雪 · LOCAL");
		expect(e).toContain("thinking");
	});
});
