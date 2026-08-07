// Minimal Telegram Bot API client over fetch. No third-party SDK.
// Docs: https://core.telegram.org/bots/api

const API_BASE = "https://api.telegram.org";
const CALL_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
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

	async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
		const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params),
			signal: AbortSignal.timeout(timeoutMs),
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

	getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_path?: string }> {
		return this.call("getFile", { file_id: fileId });
	}

	async downloadFile(filePath: string): Promise<Uint8Array> {
		const res = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`, {
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
		});
		if (!res.ok) throw new TelegramApiError(res.status, `file download failed: ${filePath}`);
		return new Uint8Array(await res.arrayBuffer());
	}
}
