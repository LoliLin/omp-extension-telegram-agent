// TUI client: attaches to the running daemon over local IPC. Read-only observer.
// Exit (q / Ctrl+C) never affects the daemon. Re-attach restores full history.
// Usage: bun run src/main.ts attach [bot-id]   (bot-id = per-bot view, REQ-UI-0002)
// Bottom panel shows live/cumulative provider telemetry (REQ-UI-0003).
// Media with a local cache render via pi-tui's Image (kitty protocol, auto-fallback, REQ-UI-0001).

import { ProcessTerminal, TuiAltScreen, ScrollView, Text, Container, VStack, Image } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

const sockPath = join(process.cwd(), "data", "daemon.sock");
if (!existsSync(sockPath)) {
	console.error("daemon not running (no data/daemon.sock). Start with: bun run src/main.ts start");
	process.exit(1);
}

// per-bot filter (REQ-UI-0002); validated by main.ts against the configured bot list
const ATTACH_BOT = process.env.TG_ATTACH_BOT ?? "";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const BOT_COLORS = [MAGENTA, CYAN, GREEN, YELLOW, BLUE];

function botColor(botId: string | null): string {
	if (!botId) return GREEN;
	let h = 0;
	for (const c of botId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return BOT_COLORS[h % BOT_COLORS.length]!;
}

function fmtClock(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDay(ts: number): string {
	const d = new Date(ts);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- media rendering (REQ-UI-0001 R3/R5) ---
const MEDIA_MAX_BYTES = 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
};

interface MediaImage {
	base64: string;
	mime: string;
	filename: string;
}

function mediaImage(m: MsgItem): MediaImage | null {
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

function renderItem(item: TimelineItem): string {
	if (item.kind === "msg") return renderMsg(item);
	return renderEvt(item);
}

function renderMsg(m: MsgItem): string {
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

function renderEvt(e: EvtItem): string {
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

// --- observability panel (REQ-UI-0003) ---

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`;
	if (n >= 1000) return `${(n / 1000).toFixed(2)}K`;
	return String(Math.round(n));
}

function fmtCost(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

function statsLine(botId: string, s: BotStats): string {
	const hit = s.cacheRead + s.cacheMiss > 0 ? (s.cacheRead / (s.cacheRead + s.cacheMiss)) * 100 : 0;
	const last = s.last
		? `last ${fmtNum(s.last.contextTokens)} (r ${fmtNum(s.last.cacheRead)}/m ${fmtNum(s.last.cacheMiss)})`
		: "last -";
	return `${botColor(botId)}${BOLD}${botId}${RESET}${DIM} · ep${s.epoch} · ${last} · cum in ${fmtNum(s.contextTokens)}/out ${fmtNum(s.outputTokens)} · ${fmtCost(s.cost)} · hit ${hit.toFixed(1)}%${RESET}`;
}

// --- connect ---

const transcript = new Container();
const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "contain" });
const panel = new Text(`${DIM}no telemetry yet${RESET}`);
const status = new Text(`${DIM}connecting...${RESET}`);
const root = new VStack();
root.addChild(scroll as unknown as Parameters<VStack["addChild"]>[0], { grow: 1 });
root.addChild(panel as unknown as Parameters<VStack["addChild"]>[0]);
root.addChild(status as unknown as Parameters<VStack["addChild"]>[0]);

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
tui.setLayoutRoot(root);
tui.start();

let lastDay = "";
let topDayVal: string | null = null; // day of the oldest rendered item (for prepend separators)
let oldestTs = Number.MAX_SAFE_INTEGER;
let oldestCursor: TimelineCursor | null = null;
let hasMore = true;
let loadingOlder = false;
let connected = false;
// Snapshot/broadcast race dedupe (REQ-IPC-0001 R7): same item may arrive twice when a
// broadcast lands while the snapshot is in flight (or across snapshot refreshes).
const seenKeys = new Set<string>();

// stats state (REQ-UI-0003): baseline from snapshot + live pushes deduped by llm_runs.id
let baselineStats: Record<string, BotStats> = {};
let baselineLastId = 0;
const pendingUsage = new Map<number, UsageRun>();

function itemKey(item: TimelineItem): string {
	if (item.kind === "msg") return `m:${item.chatId}:${item.messageId}`;
	return item.evtId != null ? `e:${item.evtId}` : `e?:${item.botId}:${item.ts}:${item.evtKind}:${item.payload}`;
}

function cursorOf(item: TimelineItem): TimelineCursor | null {
	if (item.kind === "msg") return { ts: item.ts, id: item.messageId, rank: 1 };
	return item.evtId != null ? { ts: item.ts, id: item.evtId, rank: 0 } : null;
}

function setStatus(text: string): void {
	status.setText(`${DIM}${text}${RESET}`);
	tui.requestRender();
}

function renderPanel(): void {
	const lines: string[] = [];
	for (const [botId, s] of Object.entries(baselineStats)) {
		const live = [...pendingUsage.values()].filter((u) => u.botId === botId && u.id > baselineLastId);
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
		lines.push(statsLine(botId, merged));
	}
	panel.setText(lines.length > 0 ? lines.join("\n") : `${DIM}no telemetry yet${RESET}`);
	tui.requestRender();
}

function appendItem(item: TimelineItem): void {
	const key = itemKey(item);
	if (seenKeys.has(key)) return;
	seenKeys.add(key);
	const day = fmtDay(item.ts);
	if (day !== lastDay) {
		transcript.addChild(new Text(`${DIM}--- ${day} ---${RESET}`, 1, 0));
		lastDay = day;
	}
	transcript.addChild(new Text(renderItem(item), 1, 0));
	if (item.kind === "msg") {
		const img = mediaImage(item);
		if (img) {
			transcript.addChild(
				new Image(img.base64, img.mime, { fallbackColor: (s) => `${DIM}${s}${RESET}` }, { maxWidthCells: 36, filename: img.filename }),
			);
		}
	}
	transcript.addChild(new Text("", 0, 0));
	if (topDayVal == null) topDayVal = day;
	if (item.ts < oldestTs) {
		oldestTs = item.ts;
		oldestCursor = cursorOf(item);
	}
	tui.requestRender();
}

/** Children (display order) for one timeline item: text + optional image. */
function itemChildren(item: TimelineItem): unknown[] {
	const out: unknown[] = [new Text(renderItem(item), 1, 0)];
	if (item.kind === "msg") {
		const img = mediaImage(item);
		if (img) {
			out.push(new Image(img.base64, img.mime, { fallbackColor: (s) => `${DIM}${s}${RESET}` }, { maxWidthCells: 36, filename: img.filename }));
		}
	}
	return out;
}

/** Build the new leading children (ascending) with day separators (REQ-IPC-0001 R7). */
function prependItems(items: TimelineItem[]): number {
	if (items.length === 0) return 0;
	const children = (transcript as unknown as { children: unknown[] }).children;
	const lead: (TimelineItem | { sep: string })[] = [];
	for (let i = 0; i < items.length; i++) {
		lead.push(items[i]!);
		const next = i + 1 < items.length ? items[i + 1] : null;
		const nextDay = next ? fmtDay(next.ts) : topDayVal;
		if (nextDay != null && fmtDay(items[i]!.ts) !== nextDay) lead.push({ sep: fmtDay(items[i]!.ts) });
	}
	let added = 0;
	const width = terminal.columns ?? 80;
	// unshift in reverse so display order (oldest first) is preserved
	for (let i = lead.length - 1; i >= 0; i--) {
		const entry = lead[i]!;
		const comps = "sep" in entry ? [new Text(`${DIM}--- ${entry.sep} ---${RESET}`, 1, 0)] : itemChildren(entry);
		for (const c of comps) {
			children.unshift(c);
			added += (c as { render: (w: number) => string[] }).render(width).length + 1;
		}
	}
	const oldestItem = items[0]!;
	if (oldestItem.ts < oldestTs) {
		oldestTs = oldestItem.ts;
		oldestCursor = cursorOf(oldestItem);
	}
	topDayVal = fmtDay(oldestItem.ts);
	return added;
}

function requestOlder(): void {
	if (loadingOlder || !hasMore || !connected) return;
	loadingOlder = true;
	setStatus("loading older...");
	// Send both the composite cursor and the legacy beforeTs so an old daemon (strict ts<
	// semantics) still pages correctly; a new daemon uses the cursor (same-second safe).
	const cursor = oldestCursor ?? { ts: oldestTs, id: Number.MAX_SAFE_INTEGER, rank: 1 };
	socket?.write(encodeFrame({ type: "history", beforeTs: oldestTs, before: cursor, limit: 100 }));
}

let socket: { write: (d: string) => void; end: () => void } | null = null;
const decoder = new FrameDecoder();

await Bun.connect({
	unix: sockPath,
	socket: {
		open(s) {
			connected = true;
			socket = s;
			setStatus(ATTACH_BOT ? `connected · 仅 ${ATTACH_BOT} · q 退出 · 滚到顶部加载更早消息` : "connected · q 退出 · 滚到顶部加载更早消息");
			s.write(encodeFrame({ type: "hello", ...(ATTACH_BOT ? { filter: ATTACH_BOT } : {}) }));
		},
		data(_s, chunk) {
			const frames = decoder.push(chunk);
			for (const f of frames) {
				const msg = f as ServerMessage;
				if (msg.type === "snapshot") {
					for (const item of msg.items) appendItem(item);
					if (msg.stats) {
						baselineStats = msg.stats.bots;
						baselineLastId = msg.stats.lastId;
						// pushes that raced ahead of the snapshot are inside the baseline
						for (const [id, u] of pendingUsage) {
							if (u.id <= baselineLastId) pendingUsage.delete(id);
						}
						renderPanel();
					}
					setStatus(
						`connected · ${msg.items.length} items${ATTACH_BOT ? ` · 仅 ${ATTACH_BOT}` : ""} · q 退出 · 滚到顶部加载更早消息`,
					);
				} else if (msg.type === "history") {
					const fresh = msg.items.filter((it) => !seenKeys.has(itemKey(it)));
					for (const it of fresh) seenKeys.add(itemKey(it));
					const oldTop = scroll.scrollTop;
					const added = prependItems(fresh);
					hasMore = msg.hasMore;
					loadingOlder = false;
					scroll.scrollTo(oldTop + added);
					setStatus(hasMore ? "connected · q 退出 · 滚到顶部加载更早消息" : "connected · 已到最早记录");
					tui.requestRender(true);
				} else if (msg.type === "append") {
					appendItem(msg.item);
				} else if (msg.type === "usage") {
					pendingUsage.set(msg.run.id, msg.run);
					renderPanel();
				}
			}
		},
		close() {
			connected = false;
			setStatus("disconnected from daemon");
		},
		error(_s, err) {
			setStatus(`ipc error: ${err}`);
		},
	},
});

// scroll-to-top detection for lazy older loading
setInterval(() => {
	if (scroll.scrollTop === 0 && hasMore && !loadingOlder && transcript.children.length > 0) {
		requestOlder();
	}
}, 400);

tui.addInputListener((data) => {
	if (data === "q" || data === "\x03") {
		tui.stop();
		process.exit(0);
	}
	return undefined;
});
