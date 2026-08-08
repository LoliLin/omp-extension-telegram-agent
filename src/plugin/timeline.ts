import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import {
	encodeFrame,
	FrameDecoder,
	type BotStats,
	type MsgItem,
	type SendMessageFailure,
	type SendMessageResult,
	type ServerMessage,
	type TimelineCursor,
	type TimelineItem,
	type UsageRun,
} from "../ipc.ts";

const MEDIA_MAX_BYTES = 1024 * 1024;
const SEND_ACK_TIMEOUT_MS = 15_000;
const MAX_PENDING_SENDS = 32;
const MAX_VISION_UPDATES = 256;
const VISION_UPDATE_TTL_MS = 10 * 60 * 1000;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

export interface MediaImage {
	base64: string;
	mime: string;
	filename: string;
}

/** Read a daemon-provided local image for Pi's Image component. */
export function readMediaImage(message: MsgItem): MediaImage | null {
	if (!message.mediaPath || !existsSync(message.mediaPath)) return null;
	const mime = IMAGE_MIME[(message.mediaPath.split(".").pop() ?? "").toLowerCase()];
	if (!mime) return null;
	try {
		const size = statSync(message.mediaPath).size;
		if (size <= 0 || size > MEDIA_MAX_BYTES) return null;
		return { base64: readFileSync(message.mediaPath).toString("base64"), mime, filename: message.mediaPath };
	} catch {
		return null;
	}
}

export type TimelineEvent =
	| { type: "append"; items: TimelineItem[] }
	| { type: "prepend"; items: TimelineItem[] }
	| { type: "stats"; stats: Record<string, BotStats> }
	| { type: "vision"; fileUniqueId: string; text: string }
	| { type: "status"; text: string }
	| { type: "disconnected"; reason: string };

export interface TimelineHooks {
	onEvent(event: TimelineEvent): void;
}

export interface TimelinePort {
	readonly filter: string | null;
	readonly isConnected: boolean;
	readonly hasMore: boolean;
	readonly isLoadingOlder: boolean;
	connect(): Promise<boolean>;
	requestOlder(): boolean;
	sendText(botId: string, text: string, requestId: string): Promise<SendMessageResult>;
	dispose(): void;
}

interface PendingSend {
	botId: string;
	resolve(result: SendMessageResult): void;
	timer: ReturnType<typeof setTimeout>;
}

interface CachedVisionUpdate {
	text: string;
	expiresAt: number;
}

function itemKey(item: TimelineItem): string {
	if (item.kind === "msg") return `m:${item.chatId}:${item.messageId}`;
	return item.evtId != null ? `e:${item.evtId}` : `e?:${item.botId}:${item.ts}:${item.evtKind}:${item.payload}`;
}

function cursorOf(item: TimelineItem): TimelineCursor | null {
	if (item.kind === "msg") return { ts: item.ts, id: item.messageId, rank: 1 };
	return item.evtId == null ? null : { ts: item.ts, id: item.evtId, rank: 0 };
}

function compareCursor(left: TimelineCursor, right: TimelineCursor): number {
	return left.ts - right.ts || left.rank - right.rank || left.id - right.id;
}

/** IPC-only timeline client. Presentation belongs to the Pi extension. */
export class TimelineClient implements TimelinePort {
	private readonly seen = new Set<string>();
	private readonly decoder = new FrameDecoder();
	private baselineStats: Record<string, BotStats> = {};
	private baselineLastId = 0;
	private pendingUsage = new Map<number, UsageRun>();
	private readonly pendingSends = new Map<string, PendingSend>();
	private readonly visionUpdates = new Map<string, CachedVisionUpdate>();
	private oldestTs = Number.MAX_SAFE_INTEGER;
	private oldestCursor: TimelineCursor | null = null;
	private socket: Socket | null = null;
	private connected = false;
	private more = true;
	private loadingOlder = false;
	private disposed = false;

	constructor(
		private readonly sockPath: string,
		readonly filter: string | null,
		private readonly hooks: TimelineHooks,
		private readonly sendAckTimeoutMs = SEND_ACK_TIMEOUT_MS,
	) {}

	get isConnected(): boolean { return this.connected; }
	get hasMore(): boolean { return this.more; }
	get isLoadingOlder(): boolean { return this.loadingOlder; }

	async connect(): Promise<boolean> {
		if (this.disposed) return false;
		if (!existsSync(this.sockPath)) {
			this.hooks.onEvent({
				type: "disconnected",
				reason: "daemon not running (no data/daemon.sock). Start with: bun run src/main.ts start",
			});
			return false;
		}

		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			const socket = createConnection(this.sockPath);
			this.socket = socket;
			socket.once("connect", () => {
				if (this.disposed) {
					socket.destroy();
					finish(false);
					return;
				}
				this.connected = true;
				this.emitStatus();
				socket.write(encodeFrame({ type: "hello", ...(this.filter ? { filter: this.filter } : {}) }));
				finish(true);
			});
			socket.on("data", (chunk) => {
				try {
					for (const frame of this.decoder.push(chunk)) this.handleFrame(frame as ServerMessage);
				} catch (error) {
					this.failPendingSends("Telegram daemon IPC failed before acknowledging the send");
					this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${String(error)}` });
					socket.destroy();
				}
			});
			socket.once("error", (error) => {
				this.connected = false;
				this.failPendingSends("Telegram daemon connection failed before acknowledging the send");
				if (!this.disposed) this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${error.message}` });
				finish(false);
			});
			socket.once("close", () => {
				this.connected = false;
				this.failPendingSends("Telegram daemon disconnected before acknowledging the send");
				if (!this.disposed) this.hooks.onEvent({ type: "disconnected", reason: "daemon disconnected" });
				finish(false);
			});
		});
	}

	requestOlder(): boolean {
		if (this.loadingOlder || !this.more || !this.connected || !this.socket) return false;
		this.loadingOlder = true;
		this.hooks.onEvent({ type: "status", text: "loading older Telegram history..." });
		const before = this.oldestCursor ?? { ts: this.oldestTs, id: Number.MAX_SAFE_INTEGER, rank: 1 };
		this.socket.write(encodeFrame({ type: "history", beforeTs: this.oldestTs, before, limit: 100 }));
		return true;
	}

	sendText(botId: string, text: string, requestId: string): Promise<SendMessageResult> {
		if (this.disposed || !this.connected || !this.socket) {
			return Promise.resolve(this.sendFailure(requestId, botId, "service_unavailable", "Telegram daemon is not connected"));
		}
		if (this.pendingSends.has(requestId)) {
			return Promise.resolve(this.sendFailure(requestId, botId, "request_conflict", "request id is already pending"));
		}
		if (this.pendingSends.size >= MAX_PENDING_SENDS) {
			return Promise.resolve(this.sendFailure(requestId, botId, "busy", "too many Telegram sends are pending"));
		}

		return new Promise<SendMessageResult>((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.pendingSends.get(requestId);
				if (!pending) return;
				this.pendingSends.delete(requestId);
				pending.resolve(this.sendFailure(
					requestId,
					botId,
					"unknown_outcome",
					"Telegram send acknowledgement timed out; check the group before retrying",
				));
			}, this.sendAckTimeoutMs);
			this.pendingSends.set(requestId, { botId, resolve, timer });
			try {
				this.socket!.write(encodeFrame({ type: "send_message", requestId, botId, text }));
			} catch (error) {
				this.finishPendingSend(requestId, this.sendFailure(
					requestId,
					botId,
					"unknown_outcome",
					`Telegram send write failed with an unknown outcome: ${String(error)}`,
				));
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		this.failPendingSends("timeline client disposed before Telegram acknowledged the send");
		this.socket?.destroy();
		this.socket = null;
	}

	private handleFrame(message: ServerMessage): void {
		if (this.disposed) return;
		if (message.type === "send_result") {
			const { type: _type, ...result } = message;
			this.finishPendingSend(message.requestId, result);
		} else if (message.type === "snapshot") {
			this.emitFresh("append", message.items);
			if (message.stats) {
				this.baselineStats = message.stats.bots;
				this.baselineLastId = message.stats.lastId;
				for (const id of this.pendingUsage.keys()) if (id <= this.baselineLastId) this.pendingUsage.delete(id);
				this.emitStats();
			}
			this.emitStatus();
		} else if (message.type === "history") {
			this.more = message.hasMore;
			this.loadingOlder = false;
			this.emitFresh("prepend", message.items);
			this.emitStatus(this.more ? undefined : "oldest Telegram record reached");
		} else if (message.type === "append") {
			this.emitFresh("append", [message.item]);
		} else if (message.type === "usage") {
			this.pendingUsage.set(message.run.id, message.run);
			this.emitStats();
		} else if (message.type === "vision_update") {
			this.receiveVisionUpdate(message.fileUniqueId, message.text);
		}
	}

	private receiveVisionUpdate(fileUniqueId: string, value: string): void {
		const text = value.trim();
		if (!fileUniqueId || !text) return;
		this.pruneVisionUpdates();
		const existing = this.visionUpdates.get(fileUniqueId);
		if (existing?.text === text) return;
		if (!existing && this.visionUpdates.size >= MAX_VISION_UPDATES) {
			const oldest = this.visionUpdates.keys().next().value as string | undefined;
			if (oldest) this.visionUpdates.delete(oldest);
		}
		this.visionUpdates.delete(fileUniqueId);
		this.visionUpdates.set(fileUniqueId, { text, expiresAt: Date.now() + VISION_UPDATE_TTL_MS });
		this.hooks.onEvent({ type: "vision", fileUniqueId, text });
	}

	private pruneVisionUpdates(): void {
		const now = Date.now();
		for (const [fileUniqueId, update] of this.visionUpdates) {
			if (update.expiresAt <= now) this.visionUpdates.delete(fileUniqueId);
		}
	}

	private finishPendingSend(requestId: string, result: SendMessageResult): void {
		const pending = this.pendingSends.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingSends.delete(requestId);
		pending.resolve(result);
	}

	private failPendingSends(reason: string): void {
		for (const [requestId, pending] of this.pendingSends) {
			this.finishPendingSend(requestId, this.sendFailure(
				requestId,
				pending.botId,
				"unknown_outcome",
				`${reason}; check the group before retrying`,
			));
		}
	}

	private sendFailure(
		requestId: string,
		botId: string,
		code: SendMessageFailure["code"],
		error: string,
	): SendMessageFailure {
		return { requestId, botId, ok: false, code, error };
	}

	private emitFresh(type: "append" | "prepend", items: TimelineItem[]): void {
		this.pruneVisionUpdates();
		const fresh = items.filter((item) => {
			const key = itemKey(item);
			if (this.seen.has(key)) return false;
			this.seen.add(key);
			const cursor = cursorOf(item);
			if (cursor && (!this.oldestCursor || compareCursor(cursor, this.oldestCursor) < 0)) {
				this.oldestTs = item.ts;
				this.oldestCursor = cursor;
			}
			return true;
		}).map((item) => {
			if (item.kind !== "msg" || !item.fileUniqueId) return item;
			const update = this.visionUpdates.get(item.fileUniqueId);
			return update ? { ...item, mediaDesc: update.text } : item;
		});
		if (fresh.length > 0) this.hooks.onEvent({ type, items: fresh });
	}

	private emitStatus(override?: string): void {
		this.hooks.onEvent({
			type: "status",
			text: override ?? (this.filter ? `connected · bot ${this.filter}` : "connected · all bots"),
		});
	}

	private emitStats(): void {
		const stats: Record<string, BotStats> = {};
		for (const [botId, baseline] of Object.entries(this.baselineStats)) {
			const live = [...this.pendingUsage.values()]
				.filter((run) => run.botId === botId && run.id > this.baselineLastId)
				.sort((left, right) => left.id - right.id);
			const merged: BotStats = {
				...baseline,
				cacheWrite: baseline.cacheWrite ?? 0,
				reasoningTokens: baseline.reasoningTokens ?? 0,
				totalLatencyMs: baseline.totalLatencyMs ?? 0,
				latencySamples: baseline.latencySamples ?? 0,
				firstRunTs: baseline.firstRunTs ?? baseline.last?.ts ?? null,
			};
			for (const run of live) {
				merged.runs++;
				merged.contextTokens += run.contextTokens;
				merged.cacheRead += run.cacheRead;
				merged.cacheWrite! += run.cacheWrite ?? 0;
				merged.cacheMiss += run.cacheMiss;
				merged.outputTokens += run.outputTokens;
				merged.reasoningTokens! += run.reasoningTokens ?? 0;
				if (run.latencyMs != null) {
					merged.totalLatencyMs! += run.latencyMs;
					merged.latencySamples!++;
				}
				merged.cost += run.cost;
				merged.epoch = Math.max(merged.epoch, run.epoch);
				merged.firstRunTs = merged.firstRunTs == null ? run.ts : Math.min(merged.firstRunTs, run.ts);
				merged.last = run;
			}
			stats[botId] = merged;
		}
		this.hooks.onEvent({ type: "stats", stats });
	}
}
