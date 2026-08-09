// Local IPC between daemon (server) and TUI (client). Unix socket, JSONL frames.
// Protocol:
//   C->S {type:"hello"}                       S->C {type:"snapshot", items: TimelineItem[]}
//   C->S {type:"history", before, limit}      S->C {type:"history", items, hasMore}
//   C->S {type:"send_message", requestId,...} S->C {type:"send_result", requestId, ok,...}
//   (push)                                    S->C {type:"append", item: TimelineItem}
//   (push)                                    S->C {type:"vision_update", fileUniqueId, text}
//   (push)                                    S->C {type:"media_ready", fileUniqueId, mediaPath}
//   (push)                                    S->C {type:"agent_stream", stream: AgentStreamFrame}
//
// Pagination uses a composite cursor (ts, rank, id): rank 0 = agent event (id = agent_events.id),
// rank 1 = chat message (id = message_id). Merged timeline order is by (ts, rank, id), so
// same-second messages/events are never dropped or duplicated across pages (REQ-IPC-0001 R3).

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
	/** local cache path for the media file (same uid as the TUI); absent when not downloaded (REQ-UI-0001 R5). */
	mediaPath?: string | null;
	/** vision description text for the media, if recognized (REQ-UI-0001 R3). */
	mediaDesc?: string | null;
	/** stable Telegram media identity used to merge live vision updates (REQ-UI-0006 R1). */
	fileUniqueId?: string | null;
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

/** One provider run's telemetry, pushed live and aggregated in snapshots (REQ-UI-0003). */
export interface UsageRun {
	id: number; // llm_runs.id — dedupes snapshot/push races
	botId: string;
	ts: number;
	model: string;
	epoch: number;
	contextTokens: number;
	cacheRead: number;
	/** Additive in REQ-UI-0009; absent from old daemons. */
	cacheWrite?: number;
	cacheMiss: number;
	outputTokens: number;
	/** Additive detail fields; absent from old daemons. */
	reasoningTokens?: number;
	latencyMs?: number | null;
	cost: number;
	/** Auxiliary compaction response: included in totals, never replaces latest conversation context. */
	compaction?: boolean;
}

/** Cumulative stats per bot (full-history aggregation, daemon-side). */
export interface BotStats {
	runs: number;
	contextTokens: number;
	cacheRead: number;
	/** Lifetime cache-write total; absent from old daemons. */
	cacheWrite?: number;
	cacheMiss: number;
	outputTokens: number;
	/** Lifetime detail totals; absent from old daemons. */
	reasoningTokens?: number;
	totalLatencyMs?: number;
	latencySamples?: number;
	firstRunTs?: number | null;
	cost: number;
	epoch: number;
	/** Latest main-conversation response (`compaction = 0`). */
	last: UsageRun | null;
}

/** Snapshot stats: lastId = max llm_runs.id included; pushes with id <= lastId are already inside. */
export interface StatsSnapshot {
	lastId: number;
	bots: Record<string, BotStats>;
}

/** A newly persisted, non-empty vision description (REQ-UI-0006). */
export interface VisionUpdate {
	fileUniqueId: string;
	text: string;
}

/** A newly installed owner-only local media file (REQ-UI-0014). */
export interface MediaReadyUpdate {
	fileUniqueId: string;
	mediaPath: string;
}

export type AgentActivityContent = { type: "text"; text: string } | { type: "thinking"; thinking: string };

export interface AgentActivityAssistantSection {
	type: "assistant";
	content: AgentActivityContent[];
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
}

export interface AgentActivityEventSection {
	type: "event";
	kind: string;
	detail: string;
}

export type AgentActivitySection = AgentActivityAssistantSection | AgentActivityEventSection;

/** Bounded, TUI-only projection of one complete Pi agent run. */
export interface AgentActivity {
	version: 1;
	activityId: string;
	startedAt: number;
	sections: AgentActivitySection[];
	truncated: boolean;
}

interface AgentStreamBase {
	streamId: string;
	botId: string;
	botName: string;
	ts: number;
}

/** Ephemeral assistant display state. It is never persisted or replayed in snapshots. */
export type AgentStreamFrame = AgentStreamBase &
	({ phase: "start" } | { phase: "update"; activity: AgentActivity } | { phase: "end" });

export type SendMessageErrorCode =
	| "invalid_request"
	| "unknown_bot"
	| "too_long"
	| "request_conflict"
	| "busy"
	| "telegram_error"
	| "unknown_outcome"
	| "service_unavailable"
	| "internal_error";

export interface SendMessageSuccess {
	requestId: string;
	botId: string;
	ok: true;
	chatId: number;
	messageId: number;
}

export interface SendMessageFailure {
	requestId: string;
	botId: string;
	ok: false;
	code: SendMessageErrorCode;
	error: string;
}

export type SendMessageResult = SendMessageSuccess | SendMessageFailure;

export interface SendMessageRequest {
	type: "send_message";
	requestId: string;
	botId: string;
	text: string;
}

export type ClientRequest =
	| { type: "hello"; filter?: string } // filter = bot id; absent = global view (REQ-UI-0002)
	| { type: "history"; before?: TimelineCursor; limit: number }
	| SendMessageRequest;

export type ServerMessage =
	| { type: "snapshot"; items: TimelineItem[]; stats?: StatsSnapshot }
	| { type: "history"; items: TimelineItem[]; hasMore: boolean }
	| { type: "append"; item: TimelineItem }
	| { type: "usage"; run: UsageRun }
	| ({ type: "vision_update" } & VisionUpdate)
	| ({ type: "media_ready" } & MediaReadyUpdate)
	| { type: "agent_stream"; stream: AgentStreamFrame }
	| ({ type: "send_result" } & SendMessageResult);

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
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic frame-splitting read loop
		while ((idx = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, idx).trim();
			this.buf = this.buf.slice(idx + 1);
			if (line) out.push(JSON.parse(line));
		}
		return out;
	}
}
