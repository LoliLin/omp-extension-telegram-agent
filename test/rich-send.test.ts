process.env.TZ = "Asia/Singapore";

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BotApi, TelegramApiError } from "../src/telegram/api.ts";
import { formatTelegramMarkdown, TelegramMarkdownError } from "../src/telegram/markdown.ts";
import {
	classifyTelegramCreateFailure,
	isDeterministicEntityRejection,
	sendMarkdownTextAndPersist,
	SentMessagePersistenceError,
} from "../src/telegram/send.ts";

const CHAT = -1004402809405;
const MARKDOWN = "# 标题\n\n普通正文与 **重点**、`code`。";
const FORMATTED = formatTelegramMarkdown(MARKDOWN);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function textMessage(messageId = 900, text = FORMATTED.text): Record<string, unknown> {
	return {
		chat: { id: CHAT, type: "supergroup", title: "test" },
		message_id: messageId,
		from: { id: 777, is_bot: true, first_name: "小雪" },
		date: 1754600000,
		text,
		entities: FORMATTED.entities,
	};
}

describe("Telegram Markdown entity outbound contract (REQ-TG-0004)", () => {
	test("BotApi sends exact classic sendMessage entities and reply parameters", async () => {
		const api = new BotApi("test-token");
		const calls: unknown[] = [];
		(api as any).call = async (method: string, params: unknown) => {
			calls.push({ method, params });
			return textMessage();
		};

		await api.sendMessageWithEntities(CHAT, FORMATTED.text, FORMATTED.entities, 42);
		await api.sendMessageWithEntities(CHAT, "普通文本", []);

		expect(calls).toEqual([
			{
				method: "sendMessage",
				params: {
					chat_id: CHAT,
					text: FORMATTED.text,
					entities: FORMATTED.entities,
					reply_parameters: { message_id: 42 },
				},
			},
			{ method: "sendMessage", params: { chat_id: CHAT, text: "普通文本" } },
		]);
	});

	test("formatted Markdown sends once, persists canonical text, and never calls fallback", async () => {
		const calls: unknown[] = [];
		const api = {
			sendMessageWithEntities: async (
				chatId: number,
				text: string,
				entities: unknown,
				replyTo?: number,
			) => {
				calls.push({ kind: "formatted", chatId, text, entities, replyTo });
				return textMessage();
			},
			sendMessage: async () => {
				calls.push({ kind: "plain" });
				return textMessage();
			},
		};

		const result = await sendMarkdownTextAndPersist(db, api, "A", CHAT, MARKDOWN, 42);

		expect(result.transport).toBe("formatted");
		expect(calls).toEqual([{
			kind: "formatted",
			chatId: CHAT,
			text: FORMATTED.text,
			entities: FORMATTED.entities,
			replyTo: 42,
		}]);
		expect(result.canonical.text).toBe(FORMATTED.text);
		expect(db.query("SELECT text, rich_message FROM messages WHERE message_id = 900").get()).toEqual({
			text: FORMATTED.text,
			rich_message: null,
		});
	});

	test("confirmed entity rejection falls back once to generated plain text and persists once", async () => {
		const calls: unknown[] = [];
		const api = {
			sendMessageWithEntities: async () => {
				calls.push("formatted");
				throw new TelegramApiError(400, "Bad Request: can't parse entities");
			},
			sendMessage: async (chatId: number, text: string, replyTo?: number) => {
				calls.push({ kind: "plain", chatId, text, replyTo });
				return textMessage(901, text);
			},
		};

		const result = await sendMarkdownTextAndPersist(db, api, "A", CHAT, MARKDOWN, 42);

		expect(result.transport).toBe("plain_fallback");
		expect(calls).toEqual(["formatted", { kind: "plain", chatId: CHAT, text: FORMATTED.text, replyTo: 42 }]);
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 1 });
		expect(result.canonical.text).toBe(FORMATTED.text);
	});

	test("only confirmed entity-format 400 errors are eligible for fallback", () => {
		for (const description of [
			"Bad Request: can't parse entities",
			"Bad Request: message entity offset is invalid",
			"Bad Request: entity length is invalid",
		]) {
			expect(isDeterministicEntityRejection(new TelegramApiError(400, description))).toBe(true);
		}
		for (const error of [
			new TelegramApiError(400, "non-JSON response (HTTP 400)"),
			new TelegramApiError(400, "Bad Request: message to be replied not found"),
			new TelegramApiError(404, "Not Found"),
			new TelegramApiError(429, "Too Many Requests"),
			new TelegramApiError(500, "Internal Server Error"),
			new DOMException("timed out", "TimeoutError"),
			new Error("network reset"),
		]) {
			expect(isDeterministicEntityRejection(error)).toBe(false);
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
				sendMessageWithEntities: async () => { throw error; },
				sendMessage: async () => { plainCalls++; return textMessage(); },
			};
			await expect(sendMarkdownTextAndPersist(db, api, "A", CHAT, MARKDOWN)).rejects.toBe(error);
			expect(plainCalls).toBe(0);
		}
		expect(db.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
	});

	test("local Markdown rejection happens before network and is classified as rejected", async () => {
		let networkCalls = 0;
		const api = {
			sendMessageWithEntities: async () => { networkCalls++; return textMessage(); },
			sendMessage: async () => { networkCalls++; return textMessage(); },
		};
		let caught: unknown;
		try {
			await sendMarkdownTextAndPersist(db, api, "A", CHAT, "**x** ".repeat(101));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(TelegramMarkdownError);
		expect(classifyTelegramCreateFailure(caught)).toEqual({ outcome: "rejected", category: "invalid_request" });
		expect(networkCalls).toBe(0);
	});

	test("post-send persistence failures never retry either transport", async () => {
		for (const fallback of [false, true]) {
			const fileDb = new Database(":memory:");
			fileDb.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
			let formattedCalls = 0;
			let plainCalls = 0;
			const api = {
				sendMessageWithEntities: async () => {
					formattedCalls++;
					if (fallback) throw new TelegramApiError(400, "Bad Request: can't parse entities");
					return textMessage(910);
				},
				sendMessage: async () => { plainCalls++; return textMessage(911); },
			};
			fileDb.close();

			await expect(sendMarkdownTextAndPersist(fileDb, api, "A", CHAT, MARKDOWN)).rejects.toBeInstanceOf(
				SentMessagePersistenceError,
			);
			expect(formattedCalls).toBe(1);
			expect(plainCalls).toBe(fallback ? 1 : 0);
		}
	});
});
