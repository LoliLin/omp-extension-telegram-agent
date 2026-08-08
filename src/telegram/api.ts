// Minimal Telegram Bot API client over fetch. No third-party SDK.
// Docs: https://core.telegram.org/bots/api

import type { TelegramMessageEntity } from "./markdown.ts";

const API_BASE = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHAT_ACTION_TIMEOUT_MS = 3500;
// headroom on top of the long-poll window so the server-side timeout fires first
const LONG_POLL_GRACE_MS = 10_000;

export class TelegramApiError extends Error {
	code: number;
	description: string;
	retryAfter: number | null;
	constructor(code: number, description: string, retryAfter: number | null = null) {
		super(`telegram api error ${code}: ${description}`);
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

interface ApiResponse<T> {
	ok: boolean;
	result?: T;
	error_code?: number;
	description?: string;
	parameters?: { retry_after?: number };
}

export class BotApi {
	token: string;
	constructor(token: string) {
		this.token = token;
	}

	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		timeoutMs: number = CALL_TIMEOUT_MS,
		externalSignal?: AbortSignal,
	): Promise<T> {
		const signal = externalSignal
			? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params),
			signal,
		});
		let body: ApiResponse<T>;
		try {
			body = (await res.json()) as ApiResponse<T>;
		} catch {
			// intermediaries can answer with HTML/text (e.g. 502 pages); keep the HTTP status
			throw new TelegramApiError(res.status, `non-JSON response (HTTP ${res.status})`);
		}
		if (!body.ok) {
			throw new TelegramApiError(
				body.error_code ?? res.status,
				body.description ?? "unknown",
				body.parameters?.retry_after ?? null,
			);
		}
		return body.result as T;
	}

	getMe(): Promise<{ id: number; username: string; first_name: string; is_bot: boolean }> {
		return this.call("getMe");
	}

	getUpdates(offset: number, timeoutSec: number): Promise<unknown[]> {
		return this.call(
			"getUpdates",
			{
				offset,
				timeout: timeoutSec,
				allowed_updates: ["message", "edited_message"],
			},
			timeoutSec * 1000 + LONG_POLL_GRACE_MS,
		);
	}

	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true> {
		return this.call<true>("setMyCommands", { commands });
	}

	sendMessage(
		chatId: number,
		text: string,
		replyToMessageId?: number,
	): Promise<Record<string, unknown>> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	sendMessageWithEntities(
		chatId: number,
		text: string,
		entities: readonly TelegramMessageEntity[],
		replyToMessageId?: number,
	): Promise<Record<string, unknown>> {
		return this.call("sendMessage", {
			chat_id: chatId,
			text,
			...(entities.length > 0 ? { entities } : {}),
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	sendSticker(
		chatId: number,
		fileId: string,
		replyToMessageId?: number,
	): Promise<Record<string, unknown>> {
		return this.call("sendSticker", {
			chat_id: chatId,
			sticker: fileId,
			...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
		});
	}

	/** Current deployment's group-capable processing indicator; draft Thinking is private-only. */
	sendChatAction(chatId: number): Promise<true> {
		return this.call<true>(
			"sendChatAction",
			{ chat_id: chatId, action: "typing" },
			CHAT_ACTION_TIMEOUT_MS,
		);
	}

	getFile(fileId: string, signal?: AbortSignal): Promise<{ file_id: string; file_unique_id: string; file_path?: string }> {
		return this.call("getFile", { file_id: fileId }, CALL_TIMEOUT_MS, signal);
	}

	async downloadFile(filePath: string, externalSignal?: AbortSignal): Promise<Uint8Array> {
		const signal = externalSignal
			? AbortSignal.any([externalSignal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
			: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const res = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`, {
			signal,
		});
		if (!res.ok) throw new TelegramApiError(res.status, `file download failed: ${filePath}`);
		return new Uint8Array(await res.arrayBuffer());
	}
}
