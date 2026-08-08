// REQ-UI-0005 daemon-side write contract: validation, idempotency, persistence, and errors.

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ManualSendService, TELEGRAM_TEXT_MAX_CHARS } from "../src/daemon/manual-send.ts";
import type { SendMessageRequest } from "../src/ipc.ts";
import { TelegramApiError } from "../src/telegram/api.ts";
import { ingestUpdate } from "../src/telegram/ingest.ts";

const GROUP = 1;
const CHAT = -1001;

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function request(requestId: string, text = "hello", botId = "A"): SendMessageRequest {
	return { type: "send_message", requestId, botId, text };
}

function rawMessage(messageId: number, text: string): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		date: 1754600000 + messageId,
		from: { id: 777, is_bot: true, first_name: "小雪", username: "hastuyuki_bot" },
		text,
	};
}

describe("ManualSendService", () => {
	test("concurrent duplicate request ids send once, persist once, notify once, and poller echo dedupes", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const raw = rawMessage(900, "hello");
		const notifications: unknown[] = [];
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async () => { calls++; await gate; return raw; } }]]),
			(message) => notifications.push(message),
		);

		const first = service.send(request("req-1"));
		const duplicate = service.send(request("req-1"));
		expect(duplicate).toBe(first);
		release();
		const [a, b] = await Promise.all([first, duplicate]);
		expect(a).toEqual(b);
		expect(a).toEqual({ requestId: "req-1", botId: "A", ok: true, chatId: CHAT, messageId: 900 });
		expect(calls).toBe(1);
		expect(notifications).toEqual([{ botId: "A", chatId: CHAT, messageId: 900 }]);
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });

		const echo = ingestUpdate(db, "A", { update_id: 1, message: raw }, GROUP);
		expect(echo.kind).toBe("duplicate");
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
	});

	test("same request id with different content is rejected without a second network call", async () => {
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async (_chat: number, text: string) => { calls++; await gate; return rawMessage(901, text); } }]]),
		);
		const first = service.send(request("req-conflict", "one"));
		const conflict = await service.send(request("req-conflict", "two"));
		expect(conflict).toMatchObject({ ok: false, code: "request_conflict" });
		expect(calls).toBe(1);
		release();
		await first;
		expect(calls).toBe(1);
	});

	test("unknown bot, empty text, oversized text, and invalid request id never touch Telegram", async () => {
		let calls = 0;
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async () => { calls++; return rawMessage(902, "x"); } }]]),
		);
		expect(await service.send(request("req-unknown", "x", "B"))).toMatchObject({ ok: false, code: "unknown_bot" });
		expect(await service.send(request("req-empty", " \n\t"))).toMatchObject({ ok: false, code: "invalid_request" });
		expect(await service.send(request("req-long", "x".repeat(TELEGRAM_TEXT_MAX_CHARS + 1)))).toMatchObject({ ok: false, code: "too_long" });
		expect(await service.send(request("bad request id", "x"))).toMatchObject({ ok: false, code: "invalid_request" });
		expect(calls).toBe(0);
	});

	test("the 4096-character boundary counts Unicode code points", async () => {
		let calls = 0;
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async (_chat: number, text: string) => { calls++; return rawMessage(904, text); } }]]),
		);
		expect((await service.send(request("req-max", "😀".repeat(TELEGRAM_TEXT_MAX_CHARS)))).ok).toBe(true);
		expect(await service.send(request("req-over", "😀".repeat(TELEGRAM_TEXT_MAX_CHARS + 1)))).toMatchObject({
			ok: false,
			code: "too_long",
		});
		expect(calls).toBe(1);
	});

	test("Telegram API errors are explicit and cached against automatic retry", async () => {
		let calls = 0;
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async () => { calls++; throw new TelegramApiError(401, "Unauthorized"); } }]]),
		);
		const first = await service.send(request("req-401"));
		const duplicate = await service.send(request("req-401"));
		expect(first).toMatchObject({ ok: false, code: "telegram_error", error: "Telegram send failed (401)" });
		expect(duplicate).toEqual(first);
		expect(calls).toBe(1);
	});

	test("post-Telegram persistence failure reports unknown outcome and is not retried", async () => {
		let calls = 0;
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async () => { calls++; return rawMessage(903, "hello"); } }]]),
		);
		db.close();
		const result = await service.send(request("req-db-fail"));
		expect(result).toMatchObject({ ok: false, code: "unknown_outcome" });
		expect(await service.send(request("req-db-fail"))).toEqual(result);
		expect(calls).toBe(1);
	});

	test("completed request cache stays bounded and observer failure cannot turn a sent message into failure", async () => {
		let nextMessageId = 1000;
		const service = new ManualSendService(
			db,
			CHAT,
			new Map([["A", { sendMessage: async (_chat: number, text: string) => rawMessage(nextMessageId++, text) }]]),
			() => { throw new Error("observer down"); },
		);
		const originalError = console.error;
		const originalLog = console.log;
		console.error = () => {};
		console.log = () => {};
		try {
			for (let index = 0; index < 300; index++) {
				const result = await service.send(request(`req-${index}`, `m${index}`));
				expect(result.ok).toBe(true);
			}
		} finally {
			console.error = originalError;
			console.log = originalLog;
		}
		expect((service as any).requests.size).toBeLessThanOrEqual(256);
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 300 });
	});
});
