import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
	FooterComponent,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import type { BotStats, EvtItem, TimelineItem } from "../../src/ipc.ts";
import { sanitize } from "../../src/sanitize.ts";
import {
	readMediaImage,
	TimelineClient,
	type TimelineEvent,
	type TimelineHooks,
	type TimelinePort,
} from "../../src/plugin/timeline.ts";

const ENTRY_TYPE = "telegram-chat";
const MIN_PI_VERSION = "0.84.1";

type TimelineFactory = (filter: string | null, hooks: TimelineHooks) => TimelinePort;
type ProcessRunner = typeof spawnSync;
type FeedEntry = { instanceId: string; filter: string | null };

export interface TelegramExtensionOptions {
	rootDir?: string;
	hostVersion?: string;
	timelineFactory?: TimelineFactory;
	processRunner?: ProcessRunner;
	idFactory?: () => string;
	requestIdFactory?: () => string;
}

export function supportsPiVersion(value: string): boolean {
	return value.localeCompare(MIN_PI_VERSION, "en", { numeric: true }) >= 0;
}

function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function fmtDay(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function fmtNum(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 10_000) return `${(value / 1000).toFixed(1)}K`;
	if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
	return String(Math.round(value));
}

function statsText(botId: string, stats: BotStats): string {
	const denominator = stats.cacheRead + stats.cacheMiss;
	const hit = denominator > 0 ? (stats.cacheRead / denominator) * 100 : 0;
	const last = stats.last
		? `last ${fmtNum(stats.last.contextTokens)} (read ${fmtNum(stats.last.cacheRead)} / miss ${fmtNum(stats.last.cacheMiss)})`
		: "no runs yet";
	return `${botId} · ep${stats.epoch} · ${last} · total ${fmtNum(stats.contextTokens)} in / ${fmtNum(stats.outputTokens)} out · $${stats.cost.toFixed(stats.cost >= 1 ? 2 : 4)} · hit ${hit.toFixed(1)}%`;
}

function eventBody(event: EvtItem): string {
	try {
		const payload = JSON.parse(event.payload) as Record<string, unknown>;
		if (event.evtKind === "thinking") return `thinking · ${sanitize(String(payload.text ?? "")).slice(0, 400)}`;
		if (event.evtKind === "assistant_text") return sanitize(String(payload.text ?? "")).slice(0, 400);
		if (event.evtKind === "tool_call") return `${sanitize(String(payload.tool ?? "tool"))} · ${sanitize(JSON.stringify(payload.args ?? {})).slice(0, 180)}`;
		if (event.evtKind === "tool_result") return `${sanitize(String(payload.tool ?? "tool"))} · ${payload.isError ? "error" : "done"}`;
		return `${sanitize(event.evtKind)} · ${sanitize(event.payload).slice(0, 240)}`;
	} catch {
		return sanitize(event.evtKind);
	}
}

export function itemComponent(item: TimelineItem, theme: Theme): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg(item.kind === "msg" && !item.isBot ? "userMessageBg" : "customMessageBg", text));
	if (item.kind === "evt") {
		box.addChild(new Tui.Text(theme.bold(theme.fg("warning", `${sanitize(item.botName)} · LOCAL`)) + theme.fg("dim", `  ${fmtClock(item.ts)}`), 0, 0));
		box.addChild(new Tui.Text(theme.fg("customMessageText", eventBody(item)), 0, 0));
		return box;
	}

	const sender = item.username ? `${sanitize(item.senderName)} · @${sanitize(item.username)}` : sanitize(item.senderName);
	const meta = `#${item.messageId} · ${fmtClock(item.ts)}${item.edited ? " · edited" : ""}`;
	box.addChild(new Tui.Text(theme.bold(theme.fg(item.isBot ? "accent" : "userMessageText", sender)) + theme.fg("dim", `  ${meta}`), 0, 0));
	if (item.replyTo != null) box.addChild(new Tui.Text(theme.fg("muted", `↪ reply to #${item.replyTo}`), 0, 0));
	if (item.text) box.addChild(new Tui.Text(theme.fg(item.isBot ? "customMessageText" : "userMessageText", sanitize(item.text)), 0, 0));
	if (item.mediaKind) {
		const label = `[${sanitize(item.mediaKind)}${item.stickerEmoji ? ` ${sanitize(item.stickerEmoji)}` : ""}]`;
		box.addChild(new Tui.Text(theme.fg("muted", label), 0, 0));
		const image = readMediaImage(item);
		if (image) box.addChild(new Tui.Image(image.base64, image.mime, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 56, maxHeightCells: 16, filename: basename(image.filename) }));
		if (item.mediaDesc?.trim()) box.addChild(new Tui.Text(theme.fg("muted", `视觉理解 · ${sanitize(item.mediaDesc.trim())}`), 0, 0));
	}
	return box;
}

type FooterBot = Pick<BotConfig, "id" | "model" | "reasoningEffort">;
type FooterHost = Pick<ExtensionContext, "sessionManager" | "modelRegistry" | "model" | "thinkingLevel">;

/** Read-only IPC telemetry view consumed by Pi's own FooterComponent. */
export class TelegramFooterTelemetry {
	private stats: Record<string, BotStats> = {};
	private requestRender: (() => void) | null = null;

	constructor(
		private readonly bots: FooterBot[],
		readonly filter: string | null,
		private readonly host: FooterHost,
	) {}

	update(stats: Record<string, BotStats>): void {
		this.stats = stats;
		this.requestRender?.();
	}

	mount(tui: Tui.TUI, footerData: ReadonlyFooterDataProvider): FooterComponent {
		this.requestRender = () => tui.requestRender();
		const telemetry = this;
		const sessionView = {
			get state() {
				const { bot } = telemetry.scope();
				return {
					model: telemetry.modelFor(bot),
					thinkingLevel: bot?.reasoningEffort ?? telemetry.host.thinkingLevel,
				};
			},
			sessionManager: {
				getEntries: () => telemetry.entries(),
				getCwd: () => telemetry.host.sessionManager.getCwd(),
				getSessionName: () => telemetry.host.sessionManager.getSessionName(),
			},
			getContextUsage: () => telemetry.contextUsage(),
			modelRuntime: { isUsingSubscription: () => false },
		};
		return new FooterComponent(sessionView as never, footerData);
	}

	private scope(): {
		bot: FooterBot | undefined;
		latest: NonNullable<BotStats["last"]> | null;
		totals: Pick<BotStats, "runs" | "cacheMiss" | "cacheRead" | "outputTokens" | "cost">;
	} {
		const selectedBots = this.filter ? this.bots.filter((bot) => bot.id === this.filter) : this.bots;
		let latest: NonNullable<BotStats["last"]> | null = null;
		const totals = { runs: 0, cacheMiss: 0, cacheRead: 0, outputTokens: 0, cost: 0 };
		for (const bot of selectedBots) {
			const stats = this.stats[bot.id];
			if (!stats) continue;
			totals.runs += stats.runs;
			totals.cacheMiss += stats.cacheMiss;
			totals.cacheRead += stats.cacheRead;
			totals.outputTokens += stats.outputTokens;
			totals.cost += stats.cost;
			if (stats.last && (!latest || stats.last.ts > latest.ts || (stats.last.ts === latest.ts && stats.last.id > latest.id))) latest = stats.last;
		}
		const bot = this.filter
			? selectedBots[0]
			: this.bots.find((candidate) => candidate.id === latest?.botId) ?? selectedBots[0];
		return { bot, latest, totals };
	}

	private modelFor(bot: FooterBot | undefined): NonNullable<ExtensionContext["model"]> | undefined {
		if (!bot) return this.host.model;
		const configured = this.host.modelRegistry.getAvailable().find((model) => model.id === bot.model);
		if (configured) return configured;
		if (this.host.model?.id === bot.model) return this.host.model;
		return {
			...(this.host.model ?? {}),
			id: bot.model,
			provider: this.host.model?.provider ?? "telegram",
			api: this.host.model?.api ?? "openai-completions",
			contextWindow: this.host.model?.contextWindow ?? 0,
			reasoning: bot.reasoningEffort !== "off",
		} as NonNullable<ExtensionContext["model"]>;
	}

	private entries(): unknown[] {
		const { bot, totals } = this.scope();
		if (totals.runs === 0) return [];
		const model = this.modelFor(bot);
		const totalTokens = totals.cacheMiss + totals.cacheRead + totals.outputTokens;
		return [{
			type: "message",
			id: "telegram-telemetry",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "assistant",
				content: [],
				api: model?.api ?? "openai-completions",
				provider: model?.provider ?? "telegram",
				model: model?.id ?? bot?.model ?? "telegram",
				usage: {
					input: totals.cacheMiss,
					output: totals.outputTokens,
					cacheRead: totals.cacheRead,
					cacheWrite: 0,
					totalTokens,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totals.cost },
				},
				stopReason: "stop",
				timestamp: 0,
			},
		}];
	}

	private contextUsage(): { tokens: number; contextWindow: number; percent: number } {
		const { bot, latest } = this.scope();
		const contextWindow = this.modelFor(bot)?.contextWindow ?? 0;
		const tokens = latest?.contextTokens ?? 0;
		return { tokens, contextWindow, percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : 0 };
	}
}

export class TelegramFeed extends Tui.Container {
	readonly client: TimelinePort;
	private readonly content = new Tui.Container();
	private readonly items: TimelineItem[] = [];
	private statsValue: Record<string, BotStats> = {};
	private statusValue = "connecting...";
	private closed = false;

	constructor(
		readonly filter: string | null,
		private readonly theme: Theme,
		factory: TimelineFactory,
		private readonly changed: (event: TimelineEvent, feed: TelegramFeed) => void,
	) {
		super();
		const header = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
		header.addChild(new Tui.Text(theme.bold(theme.fg("accent", filter ? `Telegram · bot ${filter}` : "Telegram · all bots")), 0, 0));
		header.addChild(new Tui.Text(theme.fg("dim", "Pi transcript owns scrolling, resize, selection and images · /tg more · /tg detach"), 0, 0));
		this.addChild(header);
		this.addChild(new Tui.Spacer(1));
		this.addChild(this.content);
		this.client = factory(filter, { onEvent: (event) => this.onEvent(event) });
	}

	get stats(): Record<string, BotStats> { return this.statsValue; }
	get status(): string { return this.statusValue; }
	start(): void { void this.client.connect(); }
	more(): boolean { return this.client.requestOlder(); }

	detach(reason = "detached"): void {
		if (this.closed) return;
		this.closed = true;
		this.client.dispose();
		this.setStatus(reason);
	}

	dispose(): void { this.detach(); }

	private onEvent(event: TimelineEvent): void {
		if (event.type === "append") {
			this.items.push(...event.items);
			this.appendItems(event.items);
		} else if (event.type === "prepend") {
			this.items.unshift(...event.items);
			this.rebuildItems();
		} else if (event.type === "stats") {
			this.statsValue = event.stats;
		} else if (event.type === "vision") {
			let updated = false;
			for (let index = 0; index < this.items.length; index++) {
				const item = this.items[index]!;
				if (item.kind !== "msg" || item.fileUniqueId !== event.fileUniqueId || item.mediaDesc === event.text) continue;
				this.items[index] = { ...item, mediaDesc: event.text };
				updated = true;
			}
			if (updated) this.rebuildItems();
		} else if (event.type === "status") {
			this.setStatus(event.text);
		} else {
			this.setStatus(event.reason);
		}
		this.changed(event, this);
	}

	private appendItems(items: TimelineItem[]): void {
		let previousDay = this.items.length > items.length ? fmtDay(this.items[this.items.length - items.length - 1]!.ts) : "";
		for (const item of items) {
			const day = fmtDay(item.ts);
			if (day !== previousDay) this.content.addChild(new Tui.Text(this.theme.fg("dim", `──────── ${day} ────────`), 1, 0));
			this.content.addChild(itemComponent(item, this.theme));
			this.content.addChild(new Tui.Spacer(1));
			previousDay = day;
		}
	}

	private rebuildItems(): void {
		this.content.clear();
		this.appendItems(this.items);
	}

	private setStatus(value: string): void {
		this.statusValue = value;
	}
}

function detachedEntry(data: FeedEntry, theme: Theme, supported: boolean): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	const scope = data.filter ? `bot ${data.filter}` : "all bots";
	box.addChild(new Tui.Text(theme.bold(theme.fg("accent", `Telegram · ${scope}`)), 0, 0));
	box.addChild(new Tui.Text(theme.fg("dim", supported ? "detached · run /tg attach to reconnect" : `requires Pi >= ${MIN_PI_VERSION} · run bun run pi`), 0, 0));
	return box;
}

export function registerTelegramExtension(pi: ExtensionAPI, options: TelegramExtensionOptions = {}): void {
	const rootDir = options.rootDir ?? process.cwd();
	const hostVersion = options.hostVersion ?? VERSION;
	const supported = supportsPiVersion(hostVersion);
	const factory = options.timelineFactory ?? ((filter, hooks) => new TimelineClient(join(rootDir, "data", "daemon.sock"), filter, hooks));
	const runProcess = options.processRunner ?? spawnSync;
	const makeId = options.idFactory ?? randomUUID;
	const makeRequestId = options.requestIdFactory ?? randomUUID;
	const feeds = new Map<string, TelegramFeed>();
	let pending: { data: FeedEntry; changed: (event: TimelineEvent, feed: TelegramFeed) => void } | null = null;
	let active: TelegramFeed | null = null;
	let footerTelemetry: TelegramFooterTelemetry | null = null;
	let footerOwner: "feed" | "standalone" | null = null;
	let footerClient: TimelinePort | null = null;
	let compose: Pick<BotConfig, "id" | "name"> | null = null;
	let sending = false;
	let lastUi: ExtensionContext["ui"] | null = null;

	const composeLabel = (bot: Pick<BotConfig, "id" | "name">) => bot.name === bot.id ? bot.id : `${bot.id} (${bot.name})`;
	const showComposeStatus = (ui: ExtensionContext["ui"], busy = false) => {
		if (!compose) {
			ui.setStatus("telegram-compose", undefined);
			return;
		}
		ui.setStatus("telegram-compose", `TELEGRAM · ${busy ? "SENDING" : "SEND"} AS ${composeLabel(compose)}`);
	};
	const closeCompose = (ui: ExtensionContext["ui"] | null = lastUi) => {
		compose = null;
		if (ui) ui.setStatus("telegram-compose", undefined);
	};
	const clearStatsFooter = (ui: ExtensionContext["ui"] | null = lastUi) => {
		footerClient?.dispose();
		footerClient = null;
		footerTelemetry = null;
		footerOwner = null;
		ui?.setFooter(undefined);
	};
	const mountStatsFooter = (filter: string | null, owner: "feed" | "standalone", ctx: ExtensionContext) => {
		const bots = loadConfig(rootDir).bots.map(({ id, model, reasoningEffort }) => ({ id, model, reasoningEffort }));
		const telemetry = new TelegramFooterTelemetry(bots, filter, ctx);
		footerTelemetry = telemetry;
		footerOwner = owner;
		ctx.ui.setFooter((tui, _theme, footerData) => telemetry.mount(tui, footerData));
	};
	const resolveBot = (arg: string | undefined, ui: ExtensionContext["ui"]): BotConfig | undefined => {
		if (!arg) {
			ui.notify("missing bot id; usage: /tg compose <bot-id>", "error");
			return undefined;
		}
		try {
			const bots = loadConfig(rootDir).bots;
			const bot = bots.find((candidate) => candidate.id === arg);
			if (bot) return bot;
			ui.notify(`unknown bot id "${arg}"; configured bots: ${bots.map((candidate) => candidate.id).join(", ") || "(none)"}`, "error");
		} catch (error) {
			ui.notify(`config error: ${(error as Error).message}`, "error");
		}
		return undefined;
	};

	pi.registerEntryRenderer<FeedEntry>(ENTRY_TYPE, (entry, _renderOptions, theme) => {
		const data = entry.data as FeedEntry | undefined;
		if (!data) return new Tui.Text(theme.fg("error", "invalid Telegram feed entry"), 1, 0);
		const existing = feeds.get(data.instanceId);
		if (existing) return existing;
		if (!supported || pending?.data.instanceId !== data.instanceId) return detachedEntry(data, theme, supported);
		const feed = new TelegramFeed(data.filter, theme, factory, pending.changed);
		pending = null;
		feeds.set(data.instanceId, feed);
		active = feed;
		feed.start();
		return feed;
	});

	pi.on("session_shutdown", () => {
		closeCompose();
		clearStatsFooter();
		for (const feed of feeds.values()) feed.dispose();
		active = null;
	});

	pi.on("input", async (event, ctx) => {
		lastUi = ctx.ui;
		if (!compose || event.source !== "interactive") return { action: "continue" };
		const original = event.text;
		if (event.images && event.images.length > 0) {
			ctx.ui.setEditorText(original);
			ctx.ui.notify("Telegram compose does not support attachments; remove them or leave compose mode", "error");
			return { action: "handled" };
		}
		if (!original.trim()) {
			ctx.ui.setEditorText(original);
			ctx.ui.notify("Telegram message cannot be empty", "warning");
			return { action: "handled" };
		}
		if (sending) {
			ctx.ui.setEditorText(original);
			ctx.ui.notify("A Telegram message is already being sent; this submission was not sent", "warning");
			return { action: "handled" };
		}
		if (!active?.client.isConnected) {
			closeCompose(ctx.ui);
			ctx.ui.setEditorText(original);
			ctx.ui.notify("Telegram daemon is disconnected; compose mode was closed and the message was not sent", "error");
			return { action: "handled" };
		}

		const identity = compose;
		sending = true;
		showComposeStatus(ctx.ui, true);
		try {
			const result = await active.client.sendText(identity.id, original, makeRequestId());
			if (result.ok) {
				ctx.ui.notify(`Telegram sent as ${composeLabel(identity)} · #${result.messageId}`, "info");
			} else {
				ctx.ui.setEditorText(original);
				if (result.code === "unknown_outcome") {
					ctx.ui.notify("Telegram send result is unknown. Check the group before retrying to avoid a duplicate.", "warning");
					closeCompose(ctx.ui);
				} else {
					ctx.ui.notify(`Telegram send failed (${result.code}): ${result.error}`, "error");
					if (result.code === "service_unavailable") closeCompose(ctx.ui);
				}
			}
		} catch (error) {
			ctx.ui.setEditorText(original);
			ctx.ui.notify(`Telegram send result is unknown. Check the group before retrying: ${String(error)}`, "warning");
			closeCompose(ctx.ui);
		} finally {
			sending = false;
			if (compose === identity) showComposeStatus(ctx.ui);
		}
		return { action: "handled" };
	});

	pi.registerCommand("tg", {
		description: "Telegram: attach [bot] | compose <bot|off> | more | detach | panel [bot|off] | status [bot] | start | stop | status-daemon",
		handler: async (args, ctx) => {
			lastUi = ctx.ui;
			const [sub = "", botArg] = args.trim().split(/\s+/);
			const daemonSub = sub === "start" || sub === "stop" || sub === "status-daemon";
			if (!supported && !daemonSub) {
				ctx.ui.notify(`Telegram native UI requires Pi >= ${MIN_PI_VERSION}; host is ${hostVersion}. Run: bun run pi`, "error");
				return;
			}
			if (ctx.mode !== "tui" && !daemonSub) {
				ctx.ui.notify("Telegram UI requires interactive mode", "error");
				return;
			}

			const resolveFilter = (arg: string | undefined): string | null | undefined => {
				if (!arg) return null;
				try {
					const ids = loadConfig(rootDir).bots.map((bot) => bot.id);
					if (ids.includes(arg)) return arg;
					ctx.ui.notify(`unknown bot id "${arg}"; configured bots: ${ids.join(", ") || "(none)"}`, "error");
				} catch (error) {
					ctx.ui.notify(`config error: ${(error as Error).message}`, "error");
				}
				return undefined;
			};

			if (sub === "attach") {
				const filter = resolveFilter(botArg);
				if (filter === undefined) return;
				closeCompose(ctx.ui);
				active?.detach("replaced by a new /tg attach");
				clearStatsFooter(ctx.ui);
				mountStatsFooter(filter, "feed", ctx);
				const data = { instanceId: makeId(), filter };
				pending = {
					data,
					changed: (event, feed) => {
						if (footerOwner === "feed" && active === feed && event.type === "stats") footerTelemetry?.update(feed.stats);
						if (event.type === "disconnected" && active === feed) {
							closeCompose(ctx.ui);
							clearStatsFooter(ctx.ui);
							ctx.ui.notify(`Telegram feed disconnected: ${event.reason}`, "error");
						}
					},
				};
				pi.appendEntry<FeedEntry>(ENTRY_TYPE, data);
				if (pending) {
					pending = null;
					clearStatsFooter(ctx.ui);
					ctx.ui.notify("Pi did not mount the Telegram transcript entry", "error");
				}
			} else if (sub === "compose") {
				if (botArg === "off") {
					closeCompose(ctx.ui);
					ctx.ui.notify("Telegram compose mode is off; editor input goes to Pi", "info");
					return;
				}
				if (!active?.client.isConnected) {
					ctx.ui.notify("no connected Telegram feed; run /tg attach first and wait for the daemon connection", "error");
					return;
				}
				const bot = resolveBot(botArg, ctx.ui);
				if (!bot) return;
				compose = { id: bot.id, name: bot.name };
				showComposeStatus(ctx.ui);
				ctx.ui.notify(`Telegram compose enabled: editor sends as ${composeLabel(compose)}. Run /tg compose off to return to Pi.`, "warning");
			} else if (sub === "more") {
				if (!active) ctx.ui.notify("no live Telegram feed; run /tg attach first", "warning");
				else if (!active.more()) ctx.ui.notify(active.client.hasMore ? "Telegram history request already in progress" : "oldest Telegram record reached", "info");
			} else if (sub === "detach") {
				if (!active) ctx.ui.notify("no live Telegram feed", "warning");
				else {
					closeCompose(ctx.ui);
					active.detach();
					active = null;
					clearStatsFooter(ctx.ui);
				}
			} else if (sub === "panel") {
				if (botArg === "off") {
					clearStatsFooter(ctx.ui);
					return;
				}
				const filter = resolveFilter(botArg);
				if (filter === undefined) return;
				clearStatsFooter(ctx.ui);
				if (active?.client.isConnected && active.filter === filter) {
					mountStatsFooter(filter, "feed", ctx);
					footerTelemetry?.update(active.stats);
				} else {
					mountStatsFooter(filter, "standalone", ctx);
					const telemetry = footerTelemetry;
					footerClient = factory(filter, {
						onEvent: (event) => {
							if (footerOwner !== "standalone" || footerTelemetry !== telemetry) return;
							if (event.type === "stats") telemetry?.update(event.stats);
							else if (event.type === "disconnected") {
								clearStatsFooter(ctx.ui);
								ctx.ui.notify(`Telegram stats disconnected: ${event.reason}`, "error");
							}
						},
					});
					void footerClient.connect();
				}
			} else if (sub === "status") {
				const filter = resolveFilter(botArg);
				if (filter === undefined) return;
				if (active && active.filter === filter && Object.keys(active.stats).length > 0) {
					ctx.ui.notify(Object.entries(active.stats).map(([id, stats]) => statsText(id, stats)).join("\n"), "info");
					return;
				}
				await new Promise<void>((resolve) => {
					let client: TimelinePort;
					let done = false;
					const finish = (text: string, type: "info" | "error") => {
						if (done) return;
						done = true;
						clearTimeout(timer);
						client.dispose();
						ctx.ui.notify(text, type);
						resolve();
					};
					const timer = setTimeout(() => finish("timed out waiting for Telegram telemetry", "error"), 3000);
					client = factory(filter, {
						onEvent: (event) => {
							if (event.type === "stats") {
								const text = Object.entries(event.stats).map(([id, stats]) => statsText(id, stats)).join("\n");
								finish(text || "no telemetry yet", "info");
							} else if (event.type === "disconnected") finish(event.reason, "error");
						},
					});
					void client.connect();
				});
			} else if (daemonSub) {
				const command = sub === "status-daemon" ? "status" : sub;
				const result: SpawnSyncReturns<Buffer> = runProcess("bun", ["run", "src/main.ts", command], { cwd: rootDir });
				const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || `daemon ${command}`;
				ctx.ui.notify(output, result.status === 0 ? "info" : "error");
			} else {
				ctx.ui.notify("usage: /tg attach [bot] | compose <bot|off> | more | detach | panel [bot|off] | status [bot] | start | stop | status-daemon", "info");
			}
		},
	});
}

export default function telegramExtension(pi: ExtensionAPI): void {
	registerTelegramExtension(pi);
}
