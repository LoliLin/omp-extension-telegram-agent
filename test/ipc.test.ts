// REQ-IPC-0001 regression tests: streaming FrameDecoder, composite-cursor pagination,
// outbound queue bounds, socket permissions, sanitization. No network.

process.env.TZ = "Asia/Singapore";

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FrameDecoder, FrameOverflowError, encodeFrame } from "../src/ipc.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { sanitizeText } from "../src/sanitize.ts";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function insertMsg(chatId: number, messageId: number, dateSec: number, text: string): void {
	db.query(
		`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
		 VALUES (?, ?, ?, 111, 'Alice', 'alice', 0, ?, 'A')`,
	).run(chatId, messageId, dateSec, text);
}

function insertEvt(botId: string, ts: number, kind: string, payload: string): void {
	db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(botId, ts, kind, payload);
}

function makeServer(): IpcServer {
	return new IpcServer(db, "/tmp/nonexistent-ipc-test.sock", new Map([["A", "小雪"]]), new Map([["A", 777]]));
}

/** Fake socket capturing frames; write returns `written` bytes per call (0 = stalled). */
function fakeSocket(written: () => number, onFrame?: (f: unknown) => void) {
	let ended = false;
	let writtenBytes = 0;
	const sink = {
		write: (d: Uint8Array) => {
			const n = written();
			if (n < 0) return -1;
			const take = Math.min(n, d.length);
			if (take > 0) {
				const text = new TextDecoder().decode(d.subarray(0, take));
				for (const line of text.split("\n")) {
					if (line.trim()) onFrame?.(JSON.parse(line));
				}
				writtenBytes += take;
			}
			return take;
		},
		end: () => { ended = true; },
		get ended() { return ended; },
		get writtenBytes() { return writtenBytes; },
	};
	return sink;
}

function attach(server: IpcServer, socket: ReturnType<typeof fakeSocket>): void {
	(server as any).listeners.add(socket);
	(server as any).decoders.set(socket, new FrameDecoder());
	(server as any).outQueues.set(socket, { chunks: [], total: 0 });
}

describe("FrameDecoder (R1)", () => {
	test("AC1: multibyte chars split at every possible chunk boundary decode byte-identically", () => {
		const text = "小雪: 这是一条包含多字节字符的消息 🎉👾 えもじも混ざる";
		const frame = encodeFrame({ type: "append", item: { kind: "msg", text } });
		const bytes = new TextEncoder().encode(frame);
		for (const size of [1, 2, 3, 5, 7, 13]) {
			const decoder = new FrameDecoder();
			const out: unknown[] = [];
			for (let off = 0; off < bytes.length; off += size) {
				out.push(...decoder.push(bytes.subarray(off, Math.min(off + size, bytes.length))));
			}
			expect(out.length).toBe(1);
			expect((out[0] as { item: { text: string } }).item.text).toBe(text);
		}
	});

	test("R1: JSON field values spanning chunks are not corrupted (no U+FFFD)", () => {
		const decoder = new FrameDecoder();
		const bytes = new TextEncoder().encode(`${JSON.stringify({ a: "中文" })}\n${JSON.stringify({ b: "雪" })}\n`);
		// split exactly inside the multibyte sequence of 中 (3 bytes)
		const cut = bytes.indexOf(0xe4); // first byte of 中
		const first = decoder.push(bytes.subarray(0, cut + 1));
		expect(first.length).toBe(0); // partial char held in decoder
		const rest = decoder.push(bytes.subarray(cut + 1));
		expect((rest[0] as { a: string }).a).toBe("中文");
		expect((rest[1] as { b: string }).b).toBe("雪");
	});

	test("R6: receive buffer overflow throws and caller can disconnect", () => {
		const decoder = new FrameDecoder(64);
		expect(() => decoder.push(new TextEncoder().encode("x".repeat(65)))).toThrow(FrameOverflowError);
	});
});

describe("pagination (R3)", () => {
	function pageAll(): { items: { ts: number; kind: string; messageId?: number; evtId?: number }[]; hasMore: boolean }[] {
		const server = makeServer();
		const pages: { items: { ts: number; kind: string; messageId?: number; evtId?: number }[]; hasMore: boolean }[] = [];
		let cursor: { ts: number; id: number; rank: 0 | 1 } | null = null;
		for (let round = 0; round < 50; round++) {
			const frames: unknown[] = [];
			const socket = fakeSocket(() => 1 << 20, (f) => frames.push(f));
			attach(server, socket);
			(server as any).handleRequest(
				socket,
				cursor
					? { type: "history", before: cursor, beforeTs: cursor.ts, limit: 3 }
					: { type: "history", before: { ts: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER, rank: 1 }, beforeTs: Number.MAX_SAFE_INTEGER, limit: 3 },
			);
			const resp = frames[0] as { type: string; items: { ts: number; kind: string; messageId?: number; evtId?: number }[]; hasMore: boolean };
			expect(resp.type).toBe("history");
			pages.push({ items: resp.items, hasMore: resp.hasMore });
			if (!resp.hasMore || resp.items.length === 0) break;
			const oldest = resp.items[0]!;
			cursor = oldest.kind === "msg" ? { ts: oldest.ts, id: oldest.messageId!, rank: 1 } : { ts: oldest.ts, id: oldest.evtId!, rank: 0 };
		}
		return pages;
	}

	test("AC2: same-second messages + events page without loss or duplication", () => {
		const chatId = -1004402809405;
		// three messages in the same second, plus events interleaved at the same timestamps
		insertMsg(chatId, 100, 1754600000, "same-second-1");
		insertMsg(chatId, 101, 1754600000, "same-second-2");
		insertMsg(chatId, 102, 1754600000, "same-second-3");
		insertMsg(chatId, 103, 1754590000, "older");
		insertMsg(chatId, 104, 1754580000, "oldest");
		insertEvt("A", 1754600000 * 1000, "thinking", "{}"); // event at the same second
		insertEvt("A", 1754590000 * 1000, "thinking", "{}");
		insertEvt("A", 1754580000 * 1000, "thinking", "{}");

		const pages = pageAll();
		const seen = new Set<string>();
		for (const p of pages) {
			for (const it of p.items) {
				const key = it.kind === "msg" ? `m:${it.messageId}` : `e:${it.evtId}`;
				expect(seen.has(key)).toBe(false); // no duplicates across pages
				seen.add(key);
			}
		}
		const dbMsgs = db.query("SELECT message_id FROM messages ORDER BY message_id").all() as { message_id: number }[];
		const dbEvts = db.query("SELECT id FROM agent_events ORDER BY id").all() as { id: number }[];
		expect(seen.size).toBe(dbMsgs.length + dbEvts.length); // nothing lost
		expect(pages.every((p) => p.items.length <= 3)).toBe(true);
	});

	test("legacy beforeTs request keeps strict ts< semantics (old client compat)", () => {
		const chatId = -1004402809405;
		insertMsg(chatId, 100, 1754600000, "a");
		insertMsg(chatId, 101, 1754600000, "b"); // same second as 100
		insertMsg(chatId, 102, 1754590000, "older");
		const server = makeServer();
		const frames: unknown[] = [];
		const socket = fakeSocket(() => 1 << 20, (f) => frames.push(f));
		attach(server, socket);
		(server as any).handleRequest(socket, { type: "history", beforeTs: 1754600000 * 1000, limit: 10 });
		const resp = frames[0] as { items: { messageId?: number }[] };
		// strict <: neither same-second message is returned
		expect(resp.items.map((i) => i.messageId)).toEqual([102]);
	});
});

describe("outbound queue bounds (R2)", () => {
	test("AC3: stalled listener (write returns 0) is disconnected after queue overflow", () => {
		const server = makeServer();
		const socket = fakeSocket(() => 0);
		attach(server, socket);
		const payload = { kind: "evt", ts: 1, botId: "A", botName: "x", evtKind: "thinking", payload: JSON.stringify({ text: "y".repeat(4000) }) };
		let kicked = false;
		for (let i = 0; i < 400 && !kicked; i++) {
			server.broadcast(payload as never);
			kicked = (server as any).listeners.size === 0;
		}
		expect(kicked).toBe(true);
		expect(socket.ended).toBe(true);
		// memory bounded: the queue was dropped
		expect((server as any).outQueues.has(socket)).toBe(false);
	});

	test("AC3: write returning -1 kicks the listener and stops accumulation", () => {
		const server = makeServer();
		const socket = fakeSocket(() => -1);
		attach(server, socket);
		server.broadcast({ kind: "msg", ts: 1, chatId: 1, messageId: 2 } as never);
		expect((server as any).listeners.size).toBe(0);
		expect(socket.ended).toBe(true);
		// further broadcasts must not accumulate anything for it
		server.broadcast({ kind: "msg", ts: 2, chatId: 1, messageId: 3 } as never);
		expect((server as any).outQueues.has(socket)).toBe(false);
	});

	test("kick is logged via console.warn (observability)", () => {
		const server = makeServer();
		const socket = fakeSocket(() => -1);
		attach(server, socket);
		const warn = console.warn;
		const lines: string[] = [];
		console.warn = (...a: unknown[]) => lines.push(a.join(" "));
		try {
			server.broadcast({ kind: "msg", ts: 1, chatId: 1, messageId: 2 } as never);
		} finally {
			console.warn = warn;
		}
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("disconnecting");
	});
});

describe("socket hardening (R4)", () => {
	test("AC4: unix socket file is chmod 600 after listen", () => {
		const sockPath = join(tmpdir(), `ipc-test-${process.pid}-${Date.now()}.sock`);
		const server = new IpcServer(db, sockPath, new Map(), new Map());
		server.start();
		try {
			const mode = statSync(sockPath).mode & 0o777;
			expect(mode).toBe(0o600);
		} finally {
			server.stop();
		}
	});

	test("AC4: history limit is clamped to [1, 500]", () => {
		const chatId = -1004402809405;
		for (let i = 0; i < 50; i++) insertMsg(chatId, 1000 + i, 1754600000 + i, `m${i}`);
		const server = makeServer();
		const frames: unknown[] = [];
		const socket = fakeSocket(() => 1 << 20, (f) => frames.push(f));
		attach(server, socket);
		(server as any).handleRequest(socket, { type: "history", beforeTs: Number.MAX_SAFE_INTEGER, limit: 1e9 });
		const resp = frames[0] as { items: unknown[]; hasMore: boolean };
		expect(resp.items.length).toBeLessThanOrEqual(500);
		expect(resp.items.length).toBe(50);
	});
});

describe("per-bot filter + stats (REQ-UI-0002/0003)", () => {
	test("hello filter: events filtered daemon-side; broadcast/usage filtered; stats aggregates match DB", () => {
		const server = makeServer();
		const chatId = -1004402809405;
		insertMsg(chatId, 100, 1754600000, "a");
		insertEvt("A", 1754600000 * 1000 + 1, "thinking", "{}");
		insertEvt("B", 1754600000 * 1000 + 2, "thinking", "{}");
		db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('A', 1, 'm', 1, 1000, 800, 200, 50, 0.01)").run();
		db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('A', 2, 'm', 1, 2000, 1800, 200, 60, 0.02)").run();
		db.query("INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('B', 3, 'm', 2, 5000, 0, 5000, 100, 0.05)").run();

		const frames: unknown[] = [];
		const socket = fakeSocket(() => 1 << 20, (f) => frames.push(f));
		attach(server, socket);
		(server as any).handleRequest(socket, { type: "hello", filter: "A" });
		const snap = frames[0] as {
			type: string;
			items: { kind: string; botId?: string }[];
			stats: { lastId: number; bots: Record<string, { runs: number; cost: number; epoch: number; last: { botId: string } | null }> };
		};
		expect(snap.type).toBe("snapshot");
		// events filtered to bot A only; messages always present
		expect(snap.items.filter((i) => i.kind === "evt").map((i) => i.botId)).toEqual(["A"]);
		// stats: full history for A; B excluded entirely in per-bot view
		expect(snap.stats.lastId).toBe(3);
		expect(snap.stats.bots.A.runs).toBe(2);
		expect(snap.stats.bots.A.cost).toBeCloseTo(0.03);
		expect(snap.stats.bots.A.epoch).toBe(1);
		expect(snap.stats.bots.A.last?.botId).toBe("A");
		expect(snap.stats.bots.B).toBeUndefined();

		// broadcast is filtered too
		(server as any).broadcast({ kind: "evt", ts: 1, botId: "B", botName: "B", evtKind: "x", payload: "{}" });
		(server as any).broadcast({ kind: "evt", ts: 2, botId: "A", botName: "A", evtKind: "x", payload: "{}" });
		(server as any).broadcast({ kind: "msg", ts: 3, chatId: 1, messageId: 9 });
		const appendFrames = frames.filter((f) => (f as { type: string }).type === "append") as { item: { kind: string; botId?: string } }[];
		expect(appendFrames.map((f) => (f.item.kind === "evt" ? f.item.botId : "msg"))).toEqual(["A", "msg"]);

		// usage push is filtered per bot
		(server as any).broadcastUsage({ id: 4, botId: "B", ts: 4, model: "m", epoch: 1, contextTokens: 1, cacheRead: 0, cacheMiss: 1, outputTokens: 0, cost: 0 });
		(server as any).broadcastUsage({ id: 5, botId: "A", ts: 5, model: "m", epoch: 1, contextTokens: 1, cacheRead: 0, cacheMiss: 1, outputTokens: 0, cost: 0 });
		const usageFrames = frames.filter((f) => (f as { type: string }).type === "usage") as { run: { botId: string } }[];
		expect(usageFrames.map((f) => f.run.botId)).toEqual(["A"]);
	});
});

describe("sanitization (R5)", () => {
	test("AC5: ANSI clear-screen and colors are removed, text survives", () => {
		const dirty = "hello \x1b[2J\x1b[31mred\x1b[0m world";
		expect(sanitizeText(dirty)).toBe("hello red world");
	});

	test("AC5: OSC 52 clipboard write is stripped", () => {
		const dirty = "hi \x1b]52;c;bWFsaWNpb3Vz\x07 there";
		expect(sanitizeText(dirty)).toBe("hi  there");
	});

	test("AC5: newline and tab survive; other C0 controls do not", () => {
		expect(sanitizeText("a\nb\tc\x07d\x1b[?25l")).toBe("a\nb\tcd");
	});
});
