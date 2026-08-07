// Local IPC between daemon (server) and TUI (client). Unix socket, JSONL frames.
// Protocol:
//   C->S {type:"hello"}                       S->C {type:"snapshot", items: TimelineItem[]}
//   C->S {type:"history", before, limit}      S->C {type:"history", items, hasMore}
//   (push)                                    S->C {type:"append", item: TimelineItem}
//
// Pagination uses a composite cursor (ts, rank, id): rank 0 = agent event (id = agent_events.id),
// rank 1 = chat message (id = message_id). Merged timeline order is by (ts, rank, id), so
// same-second messages/events are never dropped or duplicated across pages (REQ-IPC-0001 R3).
// Legacy clients sending only `beforeTs` keep the old strict `ts < beforeTs` semantics.

export interface MsgItem {
	kind: "msg";
	ts: number; // unix ms
	chatId: number;
	messageId: number;
	senderName: string;
	username: string | null;
	isBot: boolean;
	botId: string | null; // which of our bots sent it, if any
	text: string | null;
	mediaKind: string | null;
	stickerEmoji: string | null;
	replyTo: number | null;
	edited: boolean;
}

export interface EvtItem {
	kind: "evt";
	ts: number;
	/** agent_events.id; absent on old daemons (dedupe falls back to key+payload). */
	evtId?: number;
	botId: string;
	botName: string;
	evtKind: string; // assistant_text|thinking|tool_call|tool_result|send|usage|...
	payload: string; // JSON
}

export type TimelineItem = MsgItem | EvtItem;

/** Unified merged-timeline sort key: (ts, rank, id). */
export interface TimelineCursor {
	ts: number;
	id: number;
	rank: 0 | 1;
}

export type ClientRequest =
	| { type: "hello" }
	| { type: "history"; beforeTs?: number; before?: TimelineCursor; limit: number };

export type ServerMessage =
	| { type: "snapshot"; items: TimelineItem[] }
	| { type: "history"; items: TimelineItem[]; hasMore: boolean }
	| { type: "append"; item: TimelineItem };

export function encodeFrame(msg: unknown): string {
	return `${JSON.stringify(msg)}\n`;
}

/** Thrown when a client's receive buffer exceeds the bound; caller must disconnect. */
export class FrameOverflowError extends Error {
	constructor() {
		super("ipc frame buffer overflow");
	}
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024; // REQ-IPC-0001 R6

/**
 * Incremental JSONL decoder for a socket data stream. Holds ONE streaming TextDecoder:
 * multi-byte characters split across chunk boundaries decode correctly instead of
 * becoming U+FFFD (REQ-IPC-0001 R1). Buffered (complete) bytes are bounded; the decoder
 * itself only ever retains an incomplete multi-byte tail (≤3 bytes).
 */
export class FrameDecoder {
	private decoder = new TextDecoder();
	private buf = "";

	constructor(private maxBufferBytes: number = DEFAULT_MAX_BUFFER) {}

	push(chunk: Uint8Array | string): unknown[] {
		this.buf += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		if (this.buf.length > this.maxBufferBytes) throw new FrameOverflowError();
		const out: unknown[] = [];
		let idx: number;
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (line) out.push(JSON.parse(line));
		}
		return out;
	}
}
