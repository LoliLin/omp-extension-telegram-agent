// Telegram group observer as a pi extension (REQ-UI-0004).
// Run: `pi` (project dir) → `/tg attach [bot-id]` | `/tg panel [bot-id]` | `/tg status [bot-id]`
//
// All rendering/input/terminal machinery is pi's: this extension only wires the daemon IPC
// (src/tui/engine.ts) into pi-tui components (ScrollView/Text/Image) via ctx.ui.custom /
// ctx.ui.setWidget. The daemon stays a background process; closing the view never affects it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, Text, Image, VStack, matchesKey, Key } from "@earendil-works/pi-tui";
import { TgTimeline, type RenderUnit, type MediaImage, DIM, RESET } from "../../src/tui/engine.ts";
import { loadConfig } from "../../src/config.ts";
import { join } from "node:path";

const SOCK_PATH = join(process.cwd(), "data", "daemon.sock");

/** Resolve [bot-id] argument against the configured bots; returns error text when invalid. */
function resolveBotArg(arg: string | undefined): { filter: string | null; error: string | null } {
	if (!arg) return { filter: null, error: null };
	try {
		const ids = loadConfig(process.cwd()).bots.map((b) => b.id);
		if (ids.includes(arg)) return { filter: arg, error: null };
		return { filter: null, error: `unknown bot id "${arg}"; configured bots: ${ids.join(", ") || "(none)"}` };
	} catch (err) {
		return { filter: null, error: `config error: ${(err as Error).message}` };
	}
}

function itemComponent(unit: RenderUnit): { render: (w: number) => string[] } {
	if (unit.kind === "sep") return new Text(`${DIM}--- ${unit.day} ---${RESET}`, 1, 0);
	const item = unit;
	const text = new Text(item.text, 1, 0);
	if (!item.image) return text;
	const img = new Image(
		item.image.base64,
		item.image.mime,
		{ fallbackColor: (s) => `${DIM}${s}${RESET}` },
		{ maxWidthCells: 36, filename: item.image.filename },
	);
	// text + image + spacer must render as one unit for scroll accounting
	const wrap = new Container();
	wrap.addChild(text);
	wrap.addChild(img);
	return wrap;
}

function scrollDelta(comp: { render: (w: number) => string[] }, width: number): number {
	try {
		return comp.render(width).length;
	} catch {
		return 1;
	}
}

// ---------------------------------------------------------------------------
// /tg attach [bot-id] — full-screen group history inside pi
// ---------------------------------------------------------------------------

class TgAttachView {
	private tui: { requestRender: () => void };
	private done: (v?: unknown) => void;
	private filter: string | null;
	private transcript = new Container();
	private scroll: ScrollView;
	private statsText = new Text(`${DIM}no telemetry yet${RESET}`);
	private statusText = new Text(`${DIM}connecting...${RESET}`);
	private root = new VStack();
	private engine: TgTimeline;
	private poll: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(tui: { requestRender: () => void }, done: (v?: unknown) => void, filter: string | null) {
		this.tui = tui;
		this.done = done;
		this.filter = filter;
		this.scroll = new ScrollView(this.transcript, { follow: "end", primary: true, overscroll: "contain" });
		this.root.addChild(this.scroll as unknown as Parameters<VStack["addChild"]>[0], { grow: 1 });
		this.root.addChild(this.statsText as unknown as Parameters<VStack["addChild"]>[0]);
		this.root.addChild(this.statusText as unknown as Parameters<VStack["addChild"]>[0]);

		this.engine = new TgTimeline(SOCK_PATH, filter, { onEvent: (e) => this.onEngineEvent(e) });
		void this.engine.connect().catch((err) => this.onEngineEvent({ type: "disconnected", reason: `connect failed: ${err}` }));

		// scroll-to-top detection for lazy older loading
		this.poll = setInterval(() => {
			if (this.closed) return;
			if (this.scroll.scrollTop === 0 && this.engine.isHasMore && !this.engine.isLoadingOlder) {
				this.engine.requestOlder();
			}
		}, 400);
	}

	private onEngineEvent(e: { type: string; units?: RenderUnit[]; lines?: string[]; text?: string; reason?: string }): void {
		if (this.closed) return;
		if (e.type === "append" && e.units) {
			for (const unit of e.units) this.transcript.addChild(itemComponent(unit) as never);
			this.tui.requestRender();
		} else if (e.type === "prepend" && e.units) {
			const children = (this.transcript as unknown as { children: unknown[] }).children;
			const width = 100; // scroll accounting uses component render height; close enough per unit
			let added = 0;
			for (let i = e.units.length - 1; i >= 0; i--) {
				const comp = itemComponent(e.units[i]!);
				children.unshift(comp as never);
				added += scrollDelta(comp, width) + 1;
			}
			this.scroll.scrollTo(this.scroll.scrollTop + added);
			this.tui.requestRender();
		} else if (e.type === "stats" && e.lines) {
			this.statsText.setText(e.lines.length > 0 ? e.lines.map((l) => l.slice(0, 100)).join("\n") : `${DIM}no telemetry yet${RESET}`);
			this.tui.requestRender();
		} else if (e.type === "status" && e.text != null) {
			this.statusText.setText(`${DIM}${e.text}${RESET}`);
			this.tui.requestRender();
		} else if (e.type === "disconnected") {
			this.statusText.setText(`${DIM}${e.reason ?? "disconnected"} · esc 返回${RESET}`);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		return this.root.render(width);
	}

	invalidate(): void {
		this.root.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		// keyboard scrolling (pi routes mouse wheel to the primary scroll view itself)
		if (matchesKey(data, Key.up)) this.scroll.scrollTo(Math.max(0, this.scroll.scrollTop - 1));
		else if (matchesKey(data, Key.down)) this.scroll.scrollTo(this.scroll.scrollTop + 1);
		else if (matchesKey(data, Key.pageUp)) this.scroll.scrollTo(Math.max(0, this.scroll.scrollTop - 20));
		else if (matchesKey(data, Key.pageDown)) this.scroll.scrollTo(this.scroll.scrollTop + 20);
		else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
		else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
	}

	/** status mode: keep the stats/status lines, drop the timeline from the view. */
	hideTimeline(): void {
		this.root.removeChild(this.scroll as never);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.poll) clearInterval(this.poll);
		this.poll = null;
		this.engine.dispose();
		this.done();
	}
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("tg", {
		description: "Telegram observer: /tg attach [bot] | /tg panel [bot] | /tg status [bot] | /tg start | /tg stop | /tg status-daemon",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Telegram observer requires interactive mode", "error");
				return;
			}
			const [sub, botArg] = (args ?? "").trim().split(/\s+/);

			if (sub === "attach") {
				const { filter, error } = resolveBotArg(botArg);
				if (error) {
					ctx.ui.notify(error, "error");
					return;
				}
				await ctx.ui.custom((tui, _theme, _kb, done) => new TgAttachView(tui, done, filter));
			} else if (sub === "status") {
				const { filter, error } = resolveBotArg(botArg);
				if (error) {
					ctx.ui.notify(error, "error");
					return;
				}
				// one-shot stats overlay; esc to close
				await ctx.ui.custom(
					(tui, theme, _kb, done) => {
						const view = new TgAttachView(tui, done, filter);
						// status mode: hide the timeline; show stats + status lines only
						view.hideTimeline();
						return view;
					},
					{ overlay: true },
				);
			} else if (sub === "panel") {
				if (botArg === "off") {
					ctx.ui.setWidget("tg-panel", undefined);
					ctx.ui.notify("telegram panel hidden", "info");
					return;
				}
				const { filter, error } = resolveBotArg(botArg);
				if (error) {
					ctx.ui.notify(error, "error");
					return;
				}
				const engine = new TgTimeline(SOCK_PATH, filter, {
					onEvent: (e) => {
						if (e.type === "stats" && e.lines) {
							lastLines = e.lines.map((l) => l.slice(0, 100));
							tuiRef?.requestRender();
						} else if (e.type === "disconnected") {
							lastLines = [e.reason ?? "disconnected"];
							tuiRef?.requestRender();
						}
					},
				});
				// keep references for the widget factory below
				let tuiRef: { requestRender: () => void } | null = null;
				let lastLines: string[] = ["no telemetry yet"];
				ctx.ui.setWidget("tg-panel", (tui) => {
					tuiRef = tui;
					return {
						render: () => lastLines,
						invalidate: () => {},
					};
				});
				void engine.connect().catch((err) => {
					lastLines = [`connect failed: ${err}`];
					tuiRef?.requestRender();
				});
				ctx.ui.notify(`telegram panel ${filter ? `(bot ${filter})` : "(global)"} — 常驻遥测；/tg panel off 关闭`, "info");
			} else if (sub === "start" || sub === "stop" || sub === "status") {
				// daemon lifecycle without leaving pi
				const res = Bun.spawnSync(["bun", "run", "src/main.ts", sub], { cwd: process.cwd() });
				ctx.ui.notify((res.stdout.toString() + res.stderr.toString()).trim() || `daemon ${sub}`, "info");
			} else {
				ctx.ui.notify("usage: /tg attach [bot] | /tg panel [bot] | /tg status [bot] | /tg start | /tg stop | /tg status-daemon | /tg panel off", "info");
			}
		},
	});
}
