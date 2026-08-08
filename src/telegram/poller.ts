// Long-polling loop for one bot token. Offset persisted in bot_state.
// Reconnects with backoff on network/API errors; honors retry_after.

import type { Database } from "bun:sqlite";
import { BotApi, TelegramApiError } from "./api.ts";
import { ingestUpdate, type IngestResult } from "./ingest.ts";
import { getBotState, setBotState } from "../db/db.ts";

const POLL_TIMEOUT_SEC = 25;
const OFFSET_KEY = "update_offset";
const INGEST_FAILURE_WARN_THRESHOLD = 5;

export type MessageHandler = (result: IngestResult, update: unknown, botId: string) => void | Promise<void>;

export class Poller {
	private api: BotApi;
	private botId: string;
	private db: Database;
	private groupPeerId: number;
	private onMessage: MessageHandler | null;
	private replyBotTargets: ReadonlyMap<number, string> | undefined;
	private stopped = false;
	running = false;

	constructor(
		db: Database,
		botId: string,
		token: string,
		groupPeerId: number,
		onMessage: MessageHandler | null = null,
		replyBotTargets?: ReadonlyMap<number, string>,
	) {
		this.db = db;
		this.botId = botId;
		this.api = new BotApi(token);
		this.groupPeerId = groupPeerId;
		this.onMessage = onMessage;
		this.replyBotTargets = replyBotTargets;
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
		let ingestFailures = 0;
		while (!this.stopped) {
			let updates: unknown[];
			try {
				updates = await this.api.getUpdates(this.offset(), POLL_TIMEOUT_SEC);
				backoffMs = 1000;
			} catch (err) {
				if (this.stopped) break;
				if (err instanceof TelegramApiError && (err.code === 401 || err.code === 404)) {
					// auth-level failure: token invalid/revoked. Retry would never succeed — fail loudly.
					console.error(`[poller ${this.botId}] fatal: telegram auth error ${err.code}: ${err.description}`);
					this.running = false;
					throw err;
				}
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
			// shutdown may have happened while the long poll was in flight
			if (this.stopped) break;
			let batchFailed = false;
			for (const update of updates) {
				if (this.stopped) break;
				const updateId = (update as { update_id: number }).update_id;
				try {
					const result = ingestUpdate(this.db, this.botId, update, this.groupPeerId, this.replyBotTargets);
					// advance the offset only after the update is durably ingested; on failure the
					// next getUpdates re-pulls it and raw_updates dedupe keeps the replay idempotent
					setBotState(this.db, this.botId, OFFSET_KEY, String(updateId + 1));
					ingestFailures = 0;
					if (result.kind === "inserted" || result.kind === "edited" || result.kind === "enriched") {
						try {
							await this.onMessage?.(result, update, this.botId);
						} catch {
							// The update and offset are already durable. A side-channel handler failure
							// must not replay or halt polling.
							console.error(`[poller ${this.botId}] message handler failed for update ${updateId}`);
						}
					}
				} catch (err) {
					ingestFailures++;
					console.error(`[poller ${this.botId}] ingest error on update ${updateId} (consecutive ${ingestFailures}): ${err}`);
					if (ingestFailures >= INGEST_FAILURE_WARN_THRESHOLD) {
						console.warn(`[poller ${this.botId}] ${ingestFailures} consecutive ingest failures; offset held at ${this.offset()}, updates will replay`);
					}
					// do not advance the offset past a failed update; stop this batch so later
					// updates don't skip over it. The whole remainder replays on the next poll.
					batchFailed = true;
					break;
				}
			}
			if (batchFailed) {
				await sleep(backoffMs);
				backoffMs = Math.min(backoffMs * 2, 60_000);
			}
		}
		this.running = false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
