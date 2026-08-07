// Local IPC between daemon (server) and TUI (client). Unix socket, JSONL frames.
// Protocol:
//   C->S {type:"hello"}                       S->C {type:"snapshot", items: TimelineItem[]}
//   C->S {type:"history", beforeTs, limit}    S->C {type:"history", items, hasMore}
//   (push)                                    S->C {type:"append", item: TimelineItem}

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
	botId: string;
	botName: string;
	evtKind: string; // assistant_text|thinking|tool_call|tool_result|send|usage|...
	payload: string; // JSON
}

export type TimelineItem = MsgItem | EvtItem;

export type ClientRequest =
	| { type: "hello" }
	| { type: "history"; beforeTs: number; limit: number };

export type ServerMessage =
	| { type: "snapshot"; items: TimelineItem[] }
	| { type: "history"; items: TimelineItem[]; hasMore: boolean }
	| { type: "append"; item: TimelineItem };

export function encodeFrame(msg: unknown): string {
	return `${JSON.stringify(msg)}\n`;
}

/** Incremental JSONL decoder for a socket data stream. */
export class FrameDecoder {
	private buf = "";
	push(chunk: Uint8Array | string): unknown[] {
		this.buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
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
