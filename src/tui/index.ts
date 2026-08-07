// TUI client: attaches to the running daemon over local IPC. Read-only observer.
// Exit (q / Ctrl+C) never affects the daemon. Re-attach restores full history.

import { ProcessTerminal, TuiAltScreen, ScrollView, Text, Container, VStack } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, FrameDecoder, type ServerMessage, type TimelineItem, type MsgItem, type EvtItem } from "../ipc.ts";

const sockPath = join(process.cwd(), "data", "daemon.sock");
if (!existsSync(sockPath)) {
	console.error("daemon not running (no data/daemon.sock). Start with: bun run src/main.ts start");
	process.exit(1);
}

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";

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

function renderItem(item: TimelineItem): string {
	if (item.kind === "msg") return renderMsg(item);
	return renderEvt(item);
}

function renderMsg(m: MsgItem): string {
	const who = m.username ? `${m.senderName} · @${m.username}` : m.senderName;
	const color = m.botId === "A" ? MAGENTA : m.botId === "B" ? CYAN : GREEN;
	const head = `${color}${BOLD}${who}${RESET}${DIM}  #${m.messageId}  ${fmtClock(m.ts)}${m.edited ? " (edited)" : ""}${RESET}`;
	const lines: string[] = [head];
	if (m.replyTo != null) lines.push(`${DIM}  ↪ #${m.replyTo}${RESET}`);
	if (m.text) {
		for (const l of m.text.split("\n")) lines.push(`  ${l}`);
	}
	if (m.mediaKind) {
		lines.push(`${DIM}  [${m.mediaKind}${m.stickerEmoji ? " " + m.stickerEmoji : ""}]${RESET}`);
	}
	return lines.join("\n");
}

function renderEvt(e: EvtItem): string {
	const head = `${YELLOW}${e.botName} · LOCAL${RESET}${DIM}  ${fmtClock(e.ts)}${RESET}`;
	let body = "";
	try {
		const p = JSON.parse(e.payload) as Record<string, unknown>;
		switch (e.evtKind) {
			case "thinking":
				body = `${DIM}  thinking: ${String(p.text ?? "").slice(0, 400)}${RESET}`;
				break;
			case "assistant_text":
				body = `${DIM}  ${String(p.text ?? "").slice(0, 400)}${RESET}`;
				break;
			case "tool_call": {
				const args = p.args as Record<string, unknown> | undefined;
				const brief =
					p.tool === "send"
						? `${args?.reply_to ? `reply #${args.reply_to} ` : ""}${args?.message ? `"${String(args.message).slice(0, 60)}"` : ""}${args?.sticker ? `sticker:${args.sticker}` : ""}`.trim()
						: JSON.stringify(args ?? {}).slice(0, 80);
				body = `  ${BOLD}${String(p.tool)}${RESET}  ${brief}`;
				break;
			}
			case "tool_result":
				body = `${DIM}  ${String(p.tool)} ${p.isError ? "✗ error" : "✓"}${RESET}`;
				break;
			case "send":
				body = `  ${BOLD}send${RESET} ${DIM}${e.payload.slice(0, 100)}${RESET}`;
				break;
			default:
				body = `${DIM}  ${e.evtKind}: ${e.payload.slice(0, 120)}${RESET}`;
		}
	} catch {
		body = `${DIM}  ${e.evtKind}${RESET}`;
	}
	return `${head}\n${body}`;
}

// --- connect ---

const transcript = new Container();
const scroll = new ScrollView(transcript, { follow: "end", primary: true, overscroll: "contain" });
const status = new Text(`${DIM}connecting...${RESET}`);
const root = new VStack();
root.addChild(scroll as unknown as Parameters<VStack["addChild"]>[0], { grow: 1 });
root.addChild(status as unknown as Parameters<VStack["addChild"]>[0]);

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
tui.setLayoutRoot(root);
tui.start();

let lastDay = "";
let oldestTs = Number.MAX_SAFE_INTEGER;
let hasMore = true;
let loadingOlder = false;
let connected = false;

function setStatus(text: string): void {
	status.setText(`${DIM}${text}${RESET}`);
	tui.requestRender();
}

function appendItem(item: TimelineItem): void {
	const day = fmtDay(item.ts);
	if (day !== lastDay) {
		transcript.addChild(new Text(`${DIM}--- ${day} ---${RESET}`, 1, 0));
		lastDay = day;
	}
	transcript.addChild(new Text(renderItem(item), 1, 0));
	transcript.addChild(new Text("", 0, 0));
	if (item.ts < oldestTs) oldestTs = item.ts;
	tui.requestRender();
}

function prependItems(items: TimelineItem[]): number {
	if (items.length === 0) return 0;
	const children = (transcript as unknown as { children: unknown[] }).children;
	let added = 0;
	const width = terminal.columns ?? 80;
	for (const item of items) {
		const comp = new Text(renderItem(item), 1, 0);
		children.unshift(new Text("", 0, 0));
		children.unshift(comp);
		added += comp.render(width).length + 1;
	}
	if (items[0].ts < oldestTs) oldestTs = items[0].ts;
	return added;
}

function requestOlder(): void {
	if (loadingOlder || !hasMore || !connected) return;
	loadingOlder = true;
	setStatus("loading older...");
	socket?.write(encodeFrame({ type: "history", beforeTs: oldestTs, limit: 100 }));
}

let socket: { write: (d: string) => void; end: () => void } | null = null;
const decoder = new FrameDecoder();

await Bun.connect({
	unix: sockPath,
	socket: {
		open(s) {
			connected = true;
			socket = s;
			setStatus("connected · q 退出 · 滚到顶部加载更早消息");
			s.write(encodeFrame({ type: "hello" }));
		},
		data(_s, chunk) {
			const frames = decoder.push(chunk);
			for (const f of frames) {
				const msg = f as ServerMessage;
				if (msg.type === "snapshot") {
					for (const item of msg.items) appendItem(item);
					setStatus(`connected · ${msg.items.length} items · q 退出 · 滚到顶部加载更早消息`);
				} else if (msg.type === "history") {
					const oldTop = scroll.scrollTop;
					const added = prependItems(msg.items);
					hasMore = msg.hasMore;
					loadingOlder = false;
					scroll.scrollTo(oldTop + added);
					setStatus(hasMore ? "connected · q 退出 · 滚到顶部加载更早消息" : "connected · 已到最早记录");
					tui.requestRender(true);
				} else if (msg.type === "append") {
					appendItem(msg.item);
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
