// Telegram group observer as a pi extension (REQ-UI-0004).
// Run: `pi` (project dir) → `/tg attach [bot-id]` | `/tg panel [bot-id]` | `/tg status [bot-id]`
//                               | `/tg start` | `/tg stop` | `/tg status-daemon` | `/tg panel off`
//
// All rendering/input/terminal machinery is pi's; this extension only wires the daemon IPC
// (src/tui/engine.ts) into renderable lines via ctx.ui.custom / ctx.ui.setWidget.
//
// NOTE on the bundled pi-tui: inside pi's jiti extension runtime, the bundled
// @earendil-works/pi-tui exposes Text/Container/Image/Markdown/Spacer but NOT
// ScrollView/VStack/HStack ("X is not a constructor" — verified with a probe extension).
// The attach view therefore keeps its own small line buffer + viewport slice (height from
// process.stdout.rows); pi still owns the render loop, input dispatch, themes and the
// kitty image protocol. Real inline images inside the scrolling view are degraded to
// placeholders (kitty placements don't follow a custom viewport); /tg panel and status
// are unaffected.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import { TgTimeline, type RenderUnit, DIM, RESET } from "../../src/tui/engine.ts";
import { loadConfig } from "../../src/config.ts";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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

/** unit -> plain display lines (media stays a placeholder line; images are degraded, see header). */
function unitLines(unit: RenderUnit): string[] {
	if (unit.kind === "sep") return [`${DIM}--- ${unit.day} ---${RESET}`];
	return unit.text.split("\n");
}

// ---------------------------------------------------------------------------
// /tg attach [bot-id] — full-screen group history inside pi
// ---------------------------------------------------------------------------

interface TgTui {
	requestRender(): void;
	terminal?: { columns: number; rows: number };
}

class TgAttachView {
	private tui: TgTui;
	private done: (v?: unknown) => void;
	private filter: string | null;
	private lines: string[] = []; // all timeline display lines, oldest first
	private scrollTop = 0;
	private statsLine = `${DIM}no telemetry yet${RESET}`;
	private statusLine = `${DIM}connecting...${RESET}`;
	private engine: TgTimeline;
	private poll: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private hidden = false; // status mode: timeline hidden, stats/status only

	constructor(tui: TgTui, done: (v?: unknown) => void, filter: string | null) {
		this.tui = tui;
		this.done = done;
		this.filter = filter;
		this.engine = new TgTimeline(SOCK_PATH, filter, { onEvent: (e) => this.onEngineEvent(e) });
		void this.engine.connect().catch((err) => this.onEngineEvent({ type: "disconnected", reason: `connect failed: ${err}` }));

		// scroll-to-top detection for lazy older loading
		this.poll = setInterval(() => {
			if (this.closed || this.hidden) return;
			if (this.scrollTop === 0 && this.engine.isHasMore && !this.engine.isLoadingOlder) {
				this.engine.requestOlder();
			}
		}, 400);
	}

	/** status mode: drop the timeline from the view. */
	hideTimeline(): void {
		this.hidden = true;
	}

	private onEngineEvent(e: { type: string; units?: RenderUnit[]; lines?: string[]; text?: string; reason?: string }): void {
		if (this.closed) return;
		if (e.type === "append" && e.units) {
			for (const unit of e.units) this.lines.push(...unitLines(unit));
			this.followEnd();
			this.tui.requestRender();
		} else if (e.type === "prepend" && e.units) {
			const newLines: string[] = [];
			for (const unit of e.units) newLines.push(...unitLines(unit));
			this.lines.unshift(...newLines);
			this.scrollTop += newLines.length; // keep the viewport anchored
			this.tui.requestRender();
		} else if (e.type === "stats" && e.lines) {
			this.statsLine = e.lines.length > 0 ? e.lines.map((l) => l.slice(0, 100)).join("\n") : `${DIM}no telemetry yet${RESET}`;
			this.tui.requestRender();
		} else if (e.type === "status" && e.text != null) {
			this.statusLine = `${DIM}${e.text}${RESET}`;
			this.tui.requestRender();
		} else if (e.type === "disconnected") {
			this.statusLine = `${DIM}${e.reason ?? "disconnected"} · esc 返回${RESET}`;
			this.tui.requestRender();
		}
	}

	private followEnd(): void {
		this.scrollTop = Math.max(0, this.lines.length - 1);
	}

	/** real terminal height comes from pi's TUI instance (process.stdout.rows is 0 in jiti). */
	private viewportRows(): number {
		return Math.max(8, (this.tui.terminal?.rows ?? 24) - 2); // reserve stats + status lines
	}

	render(width: number): string[] {
		const rows = this.viewportRows();
		const out: string[] = [];
		if (!this.hidden) {
			const maxTop = Math.max(0, this.lines.length - rows);
			this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxTop));
			for (let i = this.scrollTop; i < Math.min(this.lines.length, this.scrollTop + rows); i++) {
				// pi's renderer hard-fails on over-width lines; truncate every line
				out.push(truncateToWidth(this.lines[i]!, width));
			}
		}
		out.push(truncateToWidth(this.statsLine, width));
		out.push(truncateToWidth(this.statusLine, width));
		return out;
	}

	invalidate(): void {
		// nothing cached
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.close();
			return;
		}
		const rows = this.viewportRows();
		if (matchesKey(data, Key.up)) this.scrollTop = Math.max(0, this.scrollTop - 1);
		else if (matchesKey(data, Key.down)) this.scrollTop = Math.min(Math.max(0, this.lines.length - rows), this.scrollTop + 1);
		else if (matchesKey(data, Key.pageUp)) this.scrollTop = Math.max(0, this.scrollTop - 20);
		else if (matchesKey(data, Key.pageDown)) this.scrollTop = Math.min(Math.max(0, this.lines.length - rows), this.scrollTop + 20);
		else if (matchesKey(data, Key.home)) this.scrollTop = 0;
		else if (matchesKey(data, Key.end)) this.scrollTop = Math.max(0, this.lines.length - rows);
		else return;
		this.tui.requestRender();
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
					(tui, _theme, _kb, done) => {
						const view = new TgAttachView(tui, done, filter);
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
				// Simple array form for setWidget: the factory form is unreliable in the bundled
				// pi-tui (verified: array form renders, factory form did not). Every update
				// re-sets the widget with fresh lines.
				// no terminal size available inside widget scope (jiti reports 0); keep lines
				// short so pi's over-width guard can never trip on narrow terminals
				const showWidget = (lines: string[]) =>
					ctx.ui.setWidget("tg-panel", lines.map((l) => truncateToWidth(l, 60)));
				showWidget(["no telemetry yet"]);
				const engine = new TgTimeline(SOCK_PATH, filter, {
					onEvent: (e) => {
						if (e.type === "stats" && e.lines) {
							showWidget(e.lines);
						} else if (e.type === "disconnected") {
							showWidget([e.reason ?? "disconnected"]);
						}
					},
				});
				void engine.connect().catch((err) => showWidget([`connect failed: ${err}`]));
				ctx.ui.notify(`telegram panel ${filter ? `(bot ${filter})` : "(global)"} — 常驻遥测；/tg panel off 关闭`, "info");
			} else if (sub === "start" || sub === "stop" || sub === "status-daemon") {
				// daemon lifecycle without leaving pi (node API: jiti has no Bun global)
				const res = spawnSync("bun", ["run", "src/main.ts", sub === "status-daemon" ? "status" : sub], { cwd: process.cwd() });
				ctx.ui.notify((res.stdout.toString() + res.stderr.toString()).trim() || `daemon ${sub}`, "info");
			} else {
				ctx.ui.notify("usage: /tg attach [bot] | /tg panel [bot] | /tg status [bot] | /tg start | /tg stop | /tg status-daemon | /tg panel off", "info");
			}
		},
	});
}
