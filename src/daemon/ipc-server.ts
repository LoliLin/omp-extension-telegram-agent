// IPC server inside the daemon: serves snapshots/history from SQLite and broadcasts live items.

import type { Database } from "bun:sqlite";
import { rmSync, existsSync } from "node:fs";
import type { TimelineItem, MsgItem, EvtItem, ClientRequest, ServerMessage } from "../ipc.ts";
import { encodeFrame, FrameDecoder } from "../ipc.ts";
import type { MessageRow } from "../agent/serialize.ts";

const SNAPSHOT_LIMIT = 100;
const HISTORY_LIMIT = 100;

export class IpcServer {
	private db: Database;
	private sockPath: string;
	private botNames: Map<string, string>;
	private botUserIds: Map<string, number>;
	private listeners = new Set<{ write: (d: string | Uint8Array, byteOffset?: number) => number }>();
	private decoders = new WeakMap<object, FrameDecoder>();
	private outQueues = new WeakMap<object, Uint8Array[]>();
	private encoder = new TextEncoder();

	/** Bun socket.write is unbuffered, byte-oriented, and may accept only part of a frame; queue the rest for drain. */
	private writeFrame(socket: { write: (d: string | Uint8Array, byteOffset?: number) => number }, frame: string): void {
		const bytes = this.encoder.encode(frame);
		const queue = this.outQueues.get(socket) ?? [];
		if (queue.length > 0) {
			queue.push(bytes);
			return;
		}
		const n = socket.write(bytes);
		if (n < bytes.length) queue.push(bytes.subarray(n));
		this.outQueues.set(socket, queue);
	}

	private flushQueue(socket: { write: (d: string | Uint8Array, byteOffset?: number) => number }): void {
		const queue = this.outQueues.get(socket);
		if (!queue) return;
		while (queue.length > 0) {
			const head = queue[0];
			const n = socket.write(head);
			if (n < head.length) {
				queue[0] = head.subarray(n);
				return;
			}
			queue.shift();
		}
	}
	private server: ReturnType<typeof Bun.listen> | null = null;

	constructor(db: Database, sockPath: string, botNames: Map<string, string>, botUserIds: Map<string, number>) {
		this.db = db;
		this.sockPath = sockPath;
		this.botNames = botNames;
		this.botUserIds = botUserIds;
	}

	start(): void {
		if (existsSync(this.sockPath)) rmSync(this.sockPath);
		this.server = Bun.listen({
			unix: this.sockPath,
			socket: {
				open: (socket) => {
					console.log("[ipc] client connected");
					this.listeners.add(socket);
					this.decoders.set(socket, new FrameDecoder());
					this.outQueues.set(socket, []);
				},
				data: (socket, chunk) => {
					try {
						const decoder = this.decoders.get(socket);
						if (!decoder) return;
						for (const frame of decoder.push(chunk)) {
							this.handleRequest(socket, frame as ClientRequest);
						}
					} catch (err) {
						console.error(`[ipc] request handling error: ${err}`);
					}
				},
				drain: (socket) => {
					this.flushQueue(socket);
				},
				close: (socket) => {
					this.listeners.delete(socket);
				},
				error: (_socket, err) => {
					console.error(`[ipc] socket error: ${err}`);
				},
			},
		});
		console.log(`[ipc] listening on ${this.sockPath}`);
	}

	stop(): void {
		this.server?.stop(true);
		if (existsSync(this.sockPath)) rmSync(this.sockPath);
	}

	/** Push a live item to all attached TUIs. */
	broadcast(item: TimelineItem): void {
		if (this.listeners.size === 0) return;
		const frame = encodeFrame({ type: "append", item } satisfies ServerMessage);
		for (const socket of this.listeners) this.writeFrame(socket, frame);
	}

	private handleRequest(socket: { write: (d: string | Uint8Array, byteOffset?: number) => number }, req: ClientRequest): void {
		if (req.type === "hello") {
			const frame = encodeFrame({ type: "snapshot", items: this.loadTimeline(Number.MAX_SAFE_INTEGER, SNAPSHOT_LIMIT) } satisfies ServerMessage);
			this.writeFrame(socket, frame);
		} else if (req.type === "history") {
			const items = this.loadTimeline(req.beforeTs, req.limit ?? HISTORY_LIMIT);
			this.writeFrame(socket, encodeFrame({ type: "history", items, hasMore: items.length >= (req.limit ?? HISTORY_LIMIT) } satisfies ServerMessage));
		}
	}

	/** Merged timeline (messages + agent events) older than beforeTs, ascending. */
	private loadTimeline(beforeTs: number, limit: number): TimelineItem[] {
		const msgs = this.db
			.query("SELECT * FROM messages WHERE date * 1000 < ? ORDER BY date DESC, message_id DESC LIMIT ?")
			.all(Math.ceil(beforeTs), limit) as MessageRow[];
		const evts = this.db
			.query("SELECT * FROM agent_events WHERE ts < ? ORDER BY ts DESC LIMIT ?")
			.all(beforeTs, limit) as { bot_id: string; ts: number; kind: string; payload: string }[];

		const items: TimelineItem[] = [
			...msgs.map((m) => this.msgToItem(m)),
			...evts.map((e) => this.evtToItem(e)),
		];
		items.sort((a, b) => a.ts - b.ts);
		return items.slice(-limit);
	}

	msgToItem(m: MessageRow): MsgItem {
		let botId: string | null = null;
		if (m.is_bot) {
			for (const [id, userId] of this.botUserIds) {
				if (m.sender_id === userId) botId = id;
			}
		}
		let mediaKind: string | null = null;
		let stickerEmoji: string | null = null;
		if (m.media) {
			const media = JSON.parse(m.media) as { kind: string; sticker_emoji?: string };
			mediaKind = media.kind;
			stickerEmoji = media.sticker_emoji ?? null;
		}
		return {
			kind: "msg",
			ts: m.date * 1000,
			chatId: m.chat_id,
			messageId: m.message_id,
			senderName: m.display_name ?? "?",
			username: m.username,
			isBot: Boolean(m.is_bot),
			botId,
			text: m.text ?? m.caption,
			mediaKind,
			stickerEmoji,
			replyTo: m.reply_to_message_id,
			edited: m.edit_date != null,
		};
	}

	evtToItem(e: { bot_id: string; ts: number; kind: string; payload: string }): EvtItem {
		return { kind: "evt", ts: e.ts, botId: e.bot_id, botName: this.botNames.get(e.bot_id) ?? e.bot_id, evtKind: e.kind, payload: e.payload };
	}
}
