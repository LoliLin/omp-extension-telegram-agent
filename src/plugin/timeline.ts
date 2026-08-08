import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import {
	encodeFrame,
	FrameDecoder,
	type BotStats,
	type MsgItem,
	type ServerMessage,
	type TimelineCursor,
	type TimelineItem,
	type UsageRun,
} from "../ipc.ts";

const MEDIA_MAX_BYTES = 1024 * 1024;
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
	dispose(): void;
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
	private oldestTs = Number.MAX_SAFE_INTEGER;
	private oldestCursor: TimelineCursor | null = null;
	private socket: Socket | null = null;
	private connected = false;
	private more = true;
	private loadingOlder = false;
	private disposed = false;

	constructor(private readonly sockPath: string, readonly filter: string | null, private readonly hooks: TimelineHooks) {}

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
					this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${String(error)}` });
				}
			});
			socket.once("error", (error) => {
				this.connected = false;
				if (!this.disposed) this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${error.message}` });
				finish(false);
			});
			socket.once("close", () => {
				this.connected = false;
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.connected = false;
		this.socket?.destroy();
		this.socket = null;
	}

	private handleFrame(message: ServerMessage): void {
		if (this.disposed) return;
		if (message.type === "snapshot") {
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
		}
	}

	private emitFresh(type: "append" | "prepend", items: TimelineItem[]): void {
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
			const live = [...this.pendingUsage.values()].filter((run) => run.botId === botId && run.id > this.baselineLastId);
			stats[botId] = {
				...baseline,
				runs: baseline.runs + live.length,
				contextTokens: baseline.contextTokens + live.reduce((sum, run) => sum + run.contextTokens, 0),
				cacheRead: baseline.cacheRead + live.reduce((sum, run) => sum + run.cacheRead, 0),
				cacheMiss: baseline.cacheMiss + live.reduce((sum, run) => sum + run.cacheMiss, 0),
				outputTokens: baseline.outputTokens + live.reduce((sum, run) => sum + run.outputTokens, 0),
				cost: baseline.cost + live.reduce((sum, run) => sum + run.cost, 0),
				last: live.at(-1) ?? baseline.last,
			};
		}
		this.hooks.onEvent({ type: "stats", stats });
	}
}
