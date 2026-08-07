// Telegram timeline engine for the pi extension (REQ-UI-0004).
// Pure data/protocol layer: IPC client + dedupe + composite-cursor pagination + stats
// aggregation + render-text functions. NO terminal code — the pi extension turns the
// emitted units into pi-tui components. Daemon protocol is unchanged (src/ipc.ts).

import { existsSync, readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import {
	encodeFrame,
	FrameDecoder,
	type ServerMessage,
	type TimelineItem,
	type MsgItem,
	type EvtItem,
	type TimelineCursor,
	type UsageRun,
	type BotStats,
} from "../ipc.ts";
import { sanitize } from "../sanitize.ts";

export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const BOT_COLORS = [MAGENTA, CYAN, GREEN, YELLOW, BLUE];

export function botColor(botId: string | null): string {
	if (!botId) return GREEN;
	let h = 0;
	for (const c of botId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return BOT_COLORS[h % BOT_COLORS.length]!;
}

export function fmtClock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDay(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- media (REQ-UI-0001 R3/R5): local cache path -> base64 for pi-tui Image ---
const MEDIA_MAX_BYTES = 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

export interface MediaImage {
	base64: string;
	mime: string;
	filename: string;
}

export function mediaImage(m: MsgItem): MediaImage | null {
	if (!m.mediaPath || !existsSync(m.mediaPath)) return null;
	const ext = (m.mediaPath.split(".").pop() ?? "").toLowerCase();
	const mime = IMAGE_MIME[ext];
	if (!mime) return null; // tgs/webm/other: placeholder + description only
	try {
		const size = statSync(m.mediaPath).size;
		if (size <= 0 || size > MEDIA_MAX_BYTES) return null; // 大图降级，不阻塞渲染
		return { base64: readFileSync(m.mediaPath).toString("base64"), mime, filename: m.mediaPath };
	} catch {
		return null;
	}
}

export function renderMsg(m: MsgItem): string {
	const who = m.username ? `${sanitize(m.senderName)} · @${sanitize(m.username)}` : sanitize(m.senderName);
	const head = `${botColor(m.botId)}${BOLD}${who}${RESET}${DIM}  #${m.messageId}  ${fmtClock(m.ts)}${m.edited ? " (edited)" : ""}${RESET}`;
	const lines: string[] = [head];
	if (m.replyTo != null) lines.push(`${DIM}  ↪ #${m.replyTo}${RESET}`);
	if (m.text) {
		for (const l of sanitize(m.text).split("\n")) lines.push(`  ${l}`);
	}
	if (m.mediaKind) {
		const extra = m.mediaDesc ? ` · ${sanitize(m.mediaDesc)}` : "";
		lines.push(`${DIM}  [${sanitize(m.mediaKind)}${m.stickerEmoji ? " " + sanitize(m.stickerEmoji) : ""}]${sanitize(extra)}${RESET}`);
	}
	return lines.join("\n");
}

export function renderEvt(e: EvtItem): string {
	const head = `${YELLOW}${sanitize(e.botName)} · LOCAL${RESET}${DIM}  ${fmtClock(e.ts)}${RESET}`;
	let body = "";
	try {
		const p = JSON.parse(e.payload) as Record<string, unknown>;
		switch (e.evtKind) {
			case "thinking":
				body = `${DIM}  thinking: ${sanitize(String(p.text ?? "")).slice(0, 400)}${RESET}`;
				break;
			case "assistant_text":
				body = `${DIM}  ${sanitize(String(p.text ?? "")).slice(0, 400)}${RESET}`;
				break;
			case "tool_call": {
				const args = p.args as Record<string, unknown> | undefined;
				const brief =
					p.tool === "send"
						? `${args?.reply_to ? `reply #${args.reply_to} ` : ""}${args?.message ? `"${sanitize(String(args.message)).slice(0, 60)}"` : ""}${args?.sticker ? `sticker:${args.sticker}` : ""}`.trim()
						: sanitize(JSON.stringify(args ?? {})).slice(0, 80);
				body = `  ${BOLD}${sanitize(String(p.tool))}${RESET}  ${brief}`;
				break;
			}
			case "tool_result":
				body = `${DIM}  ${sanitize(String(p.tool))} ${p.isError ? "✗ error" : "✓"}${RESET}`;
				break;
			case "send":
				body = `  ${BOLD}send${RESET} ${DIM}${sanitize(e.payload).slice(0, 100)}${RESET}`;
				break;
			default:
				body = `${DIM}  ${e.evtKind}: ${sanitize(e.payload).slice(0, 120)}${RESET}`;
		}
	} catch {
		body = `${DIM}  ${e.evtKind}${RESET}`;
	}
	return `${head}\n${body}`;
}

export function renderItem(item: TimelineItem): string {
	if (item.kind === "msg") return renderMsg(item);
	return renderEvt(item);
}

// --- stats (REQ-UI-0003) ---

export function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
	if (n >= 1000) return `${(n / 1000).toFixed(2)}K`;
	return String(Math.round(n));
}

export function fmtCost(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

export function statsLine(botId: string, s: BotStats): string {
	const hit = s.cacheRead + s.cacheMiss > 0 ? (s.cacheRead / (s.cacheRead + s.cacheMiss)) * 100 : 0;
	const last = s.last
		? `last ${fmtNum(s.last.contextTokens)} (r ${fmtNum(s.last.cacheRead)}/m ${fmtNum(s.last.cacheMiss)})`
		: "last -";
	return `${botColor(botId)}${BOLD}${botId}${RESET}${DIM} · ep${s.epoch} · ${last} · cum in ${fmtNum(s.contextTokens)}/out ${fmtNum(s.outputTokens)} · ${fmtCost(s.cost)} · hit ${hit.toFixed(1)}%${RESET}`;
}

// --- engine ---

/** A display unit for the UI layer: a date separator or a rendered item (+ optional image). */
export type RenderUnit = { kind: "sep"; day: string } | { kind: "item"; text: string; image: MediaImage | null };

export type TgEvent =
	| { type: "append"; units: RenderUnit[] } // append to the bottom (live / snapshot)
	| { type: "prepend"; units: RenderUnit[] } // ascending page, prepend to the top (older)
	| { type: "stats"; lines: string[] }
	| { type: "status"; text: string }
	| { type: "disconnected"; reason: string };

export interface TgHooks {
	onEvent(e: TgEvent): void;
}

function itemKey(item: TimelineItem): string {
	if (item.kind === "msg") return `m:${item.chatId}:${item.messageId}`;
	return item.evtId != null ? `e:${item.evtId}` : `e?:${item.botId}:${item.ts}:${item.evtKind}:${item.payload}`;
}

function cursorOf(item: TimelineItem): TimelineCursor | null {
	if (item.kind === "msg") return { ts: item.ts, id: item.messageId, rank: 1 };
	return item.evtId != null ? { ts: item.ts, id: item.evtId, rank: 0 } : null;
}

function itemUnit(item: TimelineItem): RenderUnit {
	const text = renderItem(item);
	const image = item.kind === "msg" ? mediaImage(item) : null;
	return { kind: "item", text, image };
}

export class TgTimeline {
	filter: string | null;
	private hooks: TgHooks;
	private sockPath: string;
	private seenKeys = new Set<string>();
	private oldestTs = Number.MAX_SAFE_INTEGER;
	private oldestCursor: TimelineCursor | null = null;
	private hasMore = true;
	private loadingOlder = false;
	private connected = false;
	private lastDay = "";
	private topDayVal: string | null = null;
	private baselineStats: Record<string, BotStats> = {};
	private baselineLastId = 0;
	private pendingUsage = new Map<number, UsageRun>();
	private decoder = new FrameDecoder();
	private socket: Socket | null = null;

	constructor(sockPath: string, filter: string | null, hooks: TgHooks) {
		this.sockPath = sockPath;
		this.filter = filter;
		this.hooks = hooks;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	get isHasMore(): boolean {
		return this.hasMore;
	}

	get isLoadingOlder(): boolean {
		return this.loadingOlder;
	}

	async connect(): Promise<void> {
		if (!existsSync(this.sockPath)) {
			this.hooks.onEvent({ type: "disconnected", reason: "daemon not running (no data/daemon.sock). Start with: bun run src/main.ts start" });
			return;
		}
		// node:net on purpose: the pi extension runtime (jiti) has no Bun global
		await new Promise<void>((resolve, reject) => {
			const sock = createConnection(this.sockPath);
			sock.on("connect", () => {
				this.connected = true;
				this.socket = sock;
				this.status(undefined);
				sock.write(encodeFrame({ type: "hello", ...(this.filter ? { filter: this.filter } : {}) }));
				resolve();
			});
			sock.on("data", (chunk) => {
				try {
					for (const f of this.decoder.push(chunk)) {
						this.handleFrame(f as ServerMessage);
					}
				} catch (err) {
					this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${err}` });
				}
			});
			sock.on("close", () => {
				this.connected = false;
				this.hooks.onEvent({ type: "disconnected", reason: "daemon disconnected" });
			});
			sock.on("error", (err) => {
				this.connected = false;
				this.hooks.onEvent({ type: "disconnected", reason: `ipc error: ${err.message}` });
				reject(err);
			});
		});
	}

	dispose(): void {
		try {
			this.socket?.end();
		} catch {
			// already closed
		}
		this.socket = null;
	}

	/** UI calls this when the scroll view hits the top. */
	requestOlder(): void {
		if (this.loadingOlder || !this.hasMore || !this.connected) return;
		this.loadingOlder = true;
		this.status("loading older...");
		const cursor = this.oldestCursor ?? { ts: this.oldestTs, id: Number.MAX_SAFE_INTEGER, rank: 1 };
		this.socket?.write(encodeFrame({ type: "history", beforeTs: this.oldestTs, before: cursor, limit: 100 }));
	}

	private status(text: string | undefined): void {
		this.hooks.onEvent({
			type: "status",
			text:
				text ??
				(this.filter
					? `connected · 仅 ${this.filter} · q/esc 返回`
					: "connected · q/esc 返回 · 滚到顶部加载更早消息"),
		});
	}

	private handleFrame(msg: ServerMessage): void {
		if (msg.type === "snapshot") {
			for (const item of msg.items) this.append(item);
			if (msg.stats) {
				this.baselineStats = msg.stats.bots;
				this.baselineLastId = msg.stats.lastId;
				for (const [id, u] of this.pendingUsage) {
					if (u.id <= this.baselineLastId) this.pendingUsage.delete(id);
				}
				this.emitStats();
			}
			this.status(undefined);
		} else if (msg.type === "history") {
			const fresh = msg.items.filter((it) => !this.seenKeys.has(itemKey(it)));
			for (const it of fresh) this.seenKeys.add(itemKey(it));
			this.hasMore = msg.hasMore;
			this.loadingOlder = false;
			if (fresh.length > 0) this.emitPrepend(fresh);
			this.status(this.hasMore ? undefined : "已到最早记录 · q/esc 返回");
		} else if (msg.type === "append") {
			this.append(msg.item);
		} else if (msg.type === "usage") {
			this.pendingUsage.set(msg.run.id, msg.run);
			this.emitStats();
		}
	}

	private append(item: TimelineItem): void {
		const key = itemKey(item);
		if (this.seenKeys.has(key)) return;
		this.seenKeys.add(key);
		const units: RenderUnit[] = [];
		const day = fmtDay(item.ts);
		if (day !== this.lastDay) {
			units.push({ kind: "sep", day });
			this.lastDay = day;
		}
		units.push(itemUnit(item));
		if (this.topDayVal == null) this.topDayVal = day;
		if (item.ts < this.oldestTs) {
			this.oldestTs = item.ts;
			this.oldestCursor = cursorOf(item);
		}
		this.hooks.onEvent({ type: "append", units });
	}

	private emitPrepend(items: TimelineItem[]): void {
		const units: RenderUnit[] = [];
		for (let i = 0; i < items.length; i++) {
			units.push(itemUnit(items[i]!));
			const next = i + 1 < items.length ? items[i + 1] : null;
			const nextDay = next ? fmtDay(next.ts) : this.topDayVal;
			if (nextDay != null && fmtDay(items[i]!.ts) !== nextDay) units.push({ kind: "sep", day: fmtDay(items[i]!.ts) });
		}
		const oldestItem = items[0]!;
		if (oldestItem.ts < this.oldestTs) {
			this.oldestTs = oldestItem.ts;
			this.oldestCursor = cursorOf(oldestItem);
		}
		this.topDayVal = fmtDay(oldestItem.ts);
		this.hooks.onEvent({ type: "prepend", units });
	}

	private mergedStats(): { botId: string; line: string }[] {
		const lines: { botId: string; line: string }[] = [];
		for (const [botId, s] of Object.entries(this.baselineStats)) {
			const live = [...this.pendingUsage.values()].filter((u) => u.botId === botId && u.id > this.baselineLastId);
			const merged: BotStats = {
				...s,
				runs: s.runs + live.length,
				contextTokens: s.contextTokens + live.reduce((a, u) => a + u.contextTokens, 0),
				cacheRead: s.cacheRead + live.reduce((a, u) => a + u.cacheRead, 0),
				cacheMiss: s.cacheMiss + live.reduce((a, u) => a + u.cacheMiss, 0),
				outputTokens: s.outputTokens + live.reduce((a, u) => a + u.outputTokens, 0),
				cost: s.cost + live.reduce((a, u) => a + u.cost, 0),
				last: live.at(-1) ?? s.last,
			};
			lines.push({ botId, line: statsLine(botId, merged) });
		}
		return lines;
	}

	private emitStats(): void {
		this.hooks.onEvent({ type: "stats", lines: this.mergedStats().map((l) => l.line) });
	}
}
