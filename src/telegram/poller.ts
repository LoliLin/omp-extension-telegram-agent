// Long-polling loop for one bot token. Offset persisted in bot_state.
// Reconnects with backoff on network/API errors; honors retry_after.

import type { Database } from "bun:sqlite";
import { BotApi, TelegramApiError } from "./api.ts";
import { ingestUpdate, type IngestResult } from "./ingest.ts";
import { getBotState, setBotState } from "../db/db.ts";

const POLL_TIMEOUT_SEC = 25;
const OFFSET_KEY = "update_offset";

export type MessageHandler = (result: IngestResult, update: unknown, botId: string) => void;

export class Poller {
	private api: BotApi;
	private botId: string;
	private db: Database;
	private groupPeerId: number;
	private onMessage: MessageHandler | null;
	private stopped = false;
	running = false;

	constructor(db: Database, botId: string, token: string, groupPeerId: number, onMessage: MessageHandler | null = null) {
		this.db = db;
		this.botId = botId;
		this.api = new BotApi(token);
		this.groupPeerId = groupPeerId;
		this.onMessage = onMessage;
	}

	private offset(): number {
		return Number(getBotState(this.db, this.botId, OFFSET_KEY) ?? "0");
	}

	stop(): void {
		this.stopped = true;
	}

	async run(): Promise<void> {
		this.running = true;
		let backoffMs = 1000;
		while (!this.stopped) {
			let updates: unknown[];
			try {
				updates = await this.api.getUpdates(this.offset(), POLL_TIMEOUT_SEC);
				backoffMs = 1000;
			} catch (err) {
				if (this.stopped) break;
				if (err instanceof TelegramApiError && err.retryAfter) {
					await sleep(err.retryAfter * 1000);
					continue;
				}
				if (err instanceof TelegramApiError && err.code === 409) {
					console.error(`[poller ${this.botId}] 409 conflict: another poller holds this token. retrying in 30s`);
					await sleep(30_000);
					continue;
				}
				console.error(`[poller ${this.botId}] poll error: ${err}. retry in ${backoffMs}ms`);
				await sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 60_000);
				continue;
			}
			for (const update of updates) {
				try {
					const result = ingestUpdate(this.db, this.botId, update, this.groupPeerId);
					if (result.kind === "inserted" || result.kind === "edited") {
						this.onMessage?.(result, update, this.botId);
					}
				} catch (err) {
					console.error(`[poller ${this.botId}] ingest error: ${err}`);
				}
				setBotState(this.db, this.botId, OFFSET_KEY, String((update as { update_id: number }).update_id + 1));
			}
		}
		this.running = false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
