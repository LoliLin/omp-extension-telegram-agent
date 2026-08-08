process.env.TZ = "Asia/Singapore";

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotApi, TelegramApiError } from "../src/telegram/api.ts";
import {
	isDeterministicRichRejection,
	sendRichTextAndPersist,
	SentMessagePersistenceError,
} from "../src/telegram/send.ts";

const CHAT = -1004402809405;
const MARKDOWN = "# 标题\n\n- A\n- B\n\n```ts\nconst ok = true;\n```\n\n| 名称 | 值 |\n| --- | --- |\n| hit | 90% |\n\n> 引用";

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function richMessage(messageId = 900): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "小雪" },
		date: 1754600000,
		rich_message: {
			blocks: [
				{ type: "heading", text: "标题" },
				{ type: "list", items: [{ label: "-", blocks: [{ type: "paragraph", text: "A" }] }] },
			],
		},
	};
}

function plainMessage(messageId = 901): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "小雪" },
		date: 1754600001,
		text: MARKDOWN,
	};
}

describe("Telegram rich outbound contract (REQ-TG-0003)", () => {
	test("BotApi sends exactly InputRichMessage markdown and reply parameters", async () => {
		const api = new BotApi("test-token");
		const calls: unknown[] = [];
		(api as any).call = async (method: string, params: unknown) => {
			calls.push({ method, params });
			return richMessage();
		};

		await api.sendRichMessage(CHAT, MARKDOWN, 42);

		expect(calls).toEqual([{
			method: "sendRichMessage",
			params: {
				chat_id: CHAT,
				rich_message: { markdown: MARKDOWN },
				reply_parameters: { message_id: 42 },
			},
		}]);
	});

	test("rich Markdown sends once, persists its projection, and never calls plain send", async () => {
		const calls: unknown[] = [];
		const api = {
			sendRichMessage: async (chatId: number, markdown: string, replyTo?: number) => {
				calls.push({ kind: "rich", chatId, markdown, replyTo });
				return richMessage();
			},
			sendMessage: async () => {
				calls.push({ kind: "plain" });
				return plainMessage();
			},
		};

		const result = await sendRichTextAndPersist(db, api, "A", CHAT, MARKDOWN, 42);

		expect(result.transport).toBe("rich");
		expect(calls).toEqual([{ kind: "rich", chatId: CHAT, markdown: MARKDOWN, replyTo: 42 }]);
		expect(result.canonical.text).toBe("标题\n- A");
		expect(db.query("SELECT text, rich_message FROM messages WHERE message_id = 900").get()).toEqual({
			text: "标题\n- A",
			rich_message: JSON.stringify((richMessage().rich_message)),
		});
	});

	test("confirmed parse rejection falls back once to literal plain text and persists once", async () => {
		const calls: unknown[] = [];
		const api = {
			sendRichMessage: async () => {
				calls.push("rich");
				throw new TelegramApiError(400, "Bad Request: can't parse rich message markdown");
			},
			sendMessage: async (chatId: number, text: string, replyTo?: number) => {
				calls.push({ kind: "plain", chatId, text, replyTo });
				return plainMessage();
			},
		};

		const result = await sendRichTextAndPersist(db, api, "A", CHAT, MARKDOWN, 42);

		expect(result.transport).toBe("plain_fallback");
		expect(calls).toEqual(["rich", { kind: "plain", chatId: CHAT, text: MARKDOWN, replyTo: 42 }]);
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
		expect(result.canonical.text).toBe(MARKDOWN);
	});

	test("only deterministic rich 4xx errors are eligible for fallback", () => {
		expect(isDeterministicRichRejection(new TelegramApiError(404, "Not Found"))).toBe(true);
		expect(isDeterministicRichRejection(new TelegramApiError(400, "Bad Request: unsupported start tag"))).toBe(true);
		for (const error of [
			new TelegramApiError(400, "non-JSON response (HTTP 400)"),
			new TelegramApiError(400, "Bad Request: message to be replied not found"),
			new TelegramApiError(429, "Too Many Requests"),
			new TelegramApiError(500, "Internal Server Error"),
			new TelegramApiError(502, "non-JSON response (HTTP 502)"),
			new DOMException("timed out", "TimeoutError"),
			new Error("network reset"),
		]) {
			expect(isDeterministicRichRejection(error)).toBe(false);
		}
	});

	test("timeout, server, non-JSON, and generic failures never call plain send", async () => {
		for (const error of [
			new DOMException("timed out", "TimeoutError"),
			new TelegramApiError(500, "Internal Server Error"),
			new TelegramApiError(502, "non-JSON response (HTTP 502)"),
			new Error("socket closed"),
		]) {
			let plainCalls = 0;
			const api = {
				sendRichMessage: async () => { throw error; },
				sendMessage: async () => { plainCalls++; return plainMessage(); },
			};
			await expect(sendRichTextAndPersist(db, api, "A", CHAT, MARKDOWN)).rejects.toBe(error);
			expect(plainCalls).toBe(0);
		}
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
	});

	test("post-send persistence failures never retry either transport", async () => {
		for (const fallback of [false, true]) {
			const fileDb = new Database(":memory:");
			fileDb.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
			let richCalls = 0;
			let plainCalls = 0;
			const api = {
				sendRichMessage: async () => {
					richCalls++;
					if (fallback) throw new TelegramApiError(400, "Bad Request: can't parse markdown");
					return richMessage(910);
				},
				sendMessage: async () => { plainCalls++; return plainMessage(911); },
			};
			fileDb.close();

			await expect(sendRichTextAndPersist(fileDb, api, "A", CHAT, MARKDOWN)).rejects.toBeInstanceOf(
				SentMessagePersistenceError,
			);
			expect(richCalls).toBe(1);
			expect(plainCalls).toBe(fallback ? 1 : 0);
		}
	});
});
