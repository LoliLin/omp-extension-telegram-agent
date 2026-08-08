import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import {
	convertToPng,
	FooterComponent,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import type { AgentStreamFrame, BotStats, EvtItem, MsgItem, TimelineItem } from "../../src/ipc.ts";
import { sanitize } from "../../src/sanitize.ts";
import {
	mediaFileRevision,
	readMediaImage,
	TimelineClient,
	type MediaImage,
	type TimelineEvent,
	type TimelineHooks,
	type TimelinePort,
} from "../../src/plugin/timeline.ts";

const ENTRY_TYPE = "telegram-chat";
const MIN_PI_VERSION = "0.84.1";
const MAX_ACTIVE_STREAMS = 32;
const MAX_ENDED_STREAMS = 64;
const PROCESS_OUTPUT_MAX_BYTES = 64 * 1024;
export const MEDIA_CACHE_MAX_ENTRIES = 32;
export const MEDIA_CACHE_MAX_BASE64_BYTES = 32 * 1024 * 1024;
export const MEDIA_CACHE_MAX_ITEM_BASE64_BYTES = 8 * 1024 * 1024;
export const MEDIA_CONVERSION_MAX_PENDING = 32;

type TimelineFactory = (filter: string | null, hooks: TimelineHooks) => TimelinePort;
export interface ProcessRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}
type ProcessRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<ProcessRunResult>;
type FeedEntry = { instanceId: string; filter: string | null };

export type MediaConverter = (
	base64Data: string,
	mimeType: string,
) => Promise<{ data: string; mimeType: string } | null>;

type MediaReadyListener = (filename: string) => void;
type MediaCacheState =
	| { kind: "ready"; image: MediaImage; base64Bytes: number }
	| { kind: "failed"; base64Bytes: 0 };

interface PendingMediaConversion {
	listeners: Set<MediaReadyListener>;
	promise: Promise<void>;
}

export interface NativeMediaCacheLimits {
	maxEntries?: number;
	maxTotalBase64Bytes?: number;
	maxItemBase64Bytes?: number;
	maxPending?: number;
}

/** Pi-owned image rendering with Kitty-only async PNG preparation and bounded local state. */
export class NativeMediaCache {
	private readonly states = new Map<string, MediaCacheState>();
	private readonly pending = new Map<string, PendingMediaConversion>();
	private totalBytesValue = 0;
	readonly limits: Required<NativeMediaCacheLimits>;

	constructor(
		private readonly converter: MediaConverter = convertToPng,
		private readonly capabilities: () => Tui.TerminalCapabilities = () => Tui.getCapabilities(),
		limits: NativeMediaCacheLimits = {},
	) {
		const positive = (value: number | undefined, fallback: number) => {
			const candidate = value ?? fallback;
			return Number.isFinite(candidate) ? Math.max(1, Math.floor(candidate)) : fallback;
		};
		this.limits = {
			maxEntries: positive(limits.maxEntries, MEDIA_CACHE_MAX_ENTRIES),
			maxTotalBase64Bytes: positive(limits.maxTotalBase64Bytes, MEDIA_CACHE_MAX_BASE64_BYTES),
			maxItemBase64Bytes: positive(limits.maxItemBase64Bytes, MEDIA_CACHE_MAX_ITEM_BASE64_BYTES),
			maxPending: positive(limits.maxPending, MEDIA_CONVERSION_MAX_PENDING),
		};
	}

	get size(): number { return this.states.size; }
	get totalBase64Bytes(): number { return this.totalBytesValue; }
	get pendingCount(): number { return this.pending.size; }

	resolve(message: MsgItem, listener?: MediaReadyListener): MediaImage | null {
		const source = readMediaImage(message);
		if (!source) return null;
		if (source.mime === "image/png") return source;
		let protocol: Tui.ImageProtocol;
		try {
			protocol = this.capabilities().images;
		} catch {
			return null;
		}
		if (protocol !== "kitty") return source;

		const cached = this.touch(source.revision);
		if (cached) return cached.kind === "ready" ? cached.image : null;
		const inFlight = this.pending.get(source.revision);
		if (inFlight) {
			if (listener) inFlight.listeners.add(listener);
			return null;
		}
		if (this.pending.size >= this.limits.maxPending) {
			this.remember(source.revision, { kind: "failed", base64Bytes: 0 });
			return null;
		}

		const listeners = new Set<MediaReadyListener>();
		if (listener) listeners.add(listener);
		const entry: PendingMediaConversion = { listeners, promise: Promise.resolve() };
		this.pending.set(source.revision, entry);
		entry.promise = this.prepare(source, entry);
		return null;
	}

	unsubscribe(listener: MediaReadyListener): void {
		for (const conversion of this.pending.values()) conversion.listeners.delete(listener);
	}

	private async prepare(source: MediaImage, entry: PendingMediaConversion): Promise<void> {
		let shouldNotify = false;
		try {
			const converted = await this.converter(source.base64, source.mime);
			if (mediaFileRevision(source.filename) !== source.revision) {
				shouldNotify = true;
				return;
			}
			if (!this.isValidPng(converted)) {
				this.remember(source.revision, { kind: "failed", base64Bytes: 0 });
				return;
			}
			const image = { ...source, base64: converted.data, mime: "image/png" };
			this.remember(source.revision, { kind: "ready", image, base64Bytes: converted.data.length });
			shouldNotify = true;
		} catch {
			if (mediaFileRevision(source.filename) === source.revision) {
				this.remember(source.revision, { kind: "failed", base64Bytes: 0 });
			} else shouldNotify = true;
		} finally {
			if (this.pending.get(source.revision) === entry) this.pending.delete(source.revision);
			if (shouldNotify) {
				for (const listener of entry.listeners) {
					try {
						listener(source.filename);
					} catch {
						// Host lifecycle callbacks are isolated from the shared conversion promise.
					}
				}
			}
			entry.listeners.clear();
		}
	}

	private isValidPng(value: { data: string; mimeType: string } | null): value is { data: string; mimeType: "image/png" } {
		if (!value || value.mimeType !== "image/png" || !value.data || value.data.length > this.limits.maxItemBase64Bytes) {
			return false;
		}
		const bytes = Buffer.from(value.data, "base64");
		const hasSignature = bytes.length >= 8
			&& bytes[0] === 0x89
			&& bytes[1] === 0x50
			&& bytes[2] === 0x4e
			&& bytes[3] === 0x47
			&& bytes[4] === 0x0d
			&& bytes[5] === 0x0a
			&& bytes[6] === 0x1a
			&& bytes[7] === 0x0a;
		if (!hasSignature) return false;
		const dimensions = Tui.getPngDimensions(value.data);
		return dimensions != null && dimensions.widthPx > 0 && dimensions.heightPx > 0;
	}

	private touch(key: string): MediaCacheState | undefined {
		const state = this.states.get(key);
		if (!state) return undefined;
		this.states.delete(key);
		this.states.set(key, state);
		return state;
	}

	private remember(key: string, state: MediaCacheState): void {
		const previous = this.states.get(key);
		if (previous) this.totalBytesValue -= previous.base64Bytes;
		this.states.delete(key);
		this.states.set(key, state);
		this.totalBytesValue += state.base64Bytes;
		while (this.states.size > this.limits.maxEntries || this.totalBytesValue > this.limits.maxTotalBase64Bytes) {
			const oldest = this.states.keys().next().value as string | undefined;
			if (!oldest) break;
			const evicted = this.states.get(oldest);
			this.states.delete(oldest);
			this.totalBytesValue -= evicted?.base64Bytes ?? 0;
		}
	}
}

export type TgCommandDispatch =
	| "attach"
	| "compose"
	| "more"
	| "detach"
	| "panel"
	| "status"
	| "start"
	| "restart"
	| "stop"
	| "status-daemon";

export interface TgBotChoice {
	id: string;
	name: string;
}

export interface TgCommandChildren {
	hint: string;
	optional: boolean;
	acceptUnknown?: boolean;
	resolve: (bots: readonly TgBotChoice[]) => readonly TgCommandNode[];
}

export interface TgCommandNode {
	token: string;
	label?: string;
	description: string;
	dispatch?: TgCommandDispatch;
	children?: TgCommandChildren;
}

export interface TgCompletionItem {
	value: string;
	label: string;
	description?: string;
}

function botChildren(dispatch: TgCommandDispatch, optional: boolean, includeOff = false): TgCommandChildren {
	return {
		hint: includeOff ? "bot|off" : "bot",
		optional,
		acceptUnknown: true,
		resolve: (bots) => [
			...bots.map((bot) => ({
				token: bot.id,
				label: bot.name === bot.id ? bot.id : `${bot.id} (${bot.name})`,
				description: `Telegram bot ${bot.name}`,
				dispatch,
			})),
			...(includeOff ? [{ token: "off", description: "Restore Pi behavior", dispatch }] : []),
		],
	};
}

export const TG_COMMAND_TREE: readonly TgCommandNode[] = [
	{ token: "attach", description: "Observe all bots or one bot", dispatch: "attach", children: botChildren("attach", true) },
	{ token: "compose", description: "Send editor text as a bot", dispatch: "compose", children: botChildren("compose", false, true) },
	{ token: "more", description: "Load one older history page", dispatch: "more" },
	{ token: "detach", description: "Disconnect the live feed", dispatch: "detach" },
	{ token: "panel", description: "Select or restore Telegram footer stats", dispatch: "panel", children: botChildren("panel", true, true) },
	{ token: "status", description: "Show detailed usage", dispatch: "status", children: botChildren("status", true) },
	{ token: "start", description: "Start the Telegram daemon", dispatch: "start" },
	{ token: "restart", description: "Gracefully restart every configured bot", dispatch: "restart" },
	{ token: "stop", description: "Stop the Telegram daemon", dispatch: "stop" },
	{ token: "status-daemon", description: "Show daemon process status", dispatch: "status-daemon" },
];

function runChildProcess(command: string, args: readonly string[], options: { cwd: string }): Promise<ProcessRunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
			const combined = Buffer.concat([current, chunk]);
			return combined.length <= PROCESS_OUTPUT_MAX_BYTES ? combined : combined.subarray(combined.length - PROCESS_OUTPUT_MAX_BYTES);
		};
		child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
		child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
		child.once("error", (error) => resolve({ status: null, stdout: stdout.toString(), stderr: `${stderr.toString()}${error.message}` }));
		child.once("close", (status) => resolve({ status, stdout: stdout.toString(), stderr: stderr.toString() }));
	});
}

function normalizedTokens(value: string): string[] {
	const trimmed = value.trim();
	return trimmed ? trimmed.split(/\s+/) : [];
}

export function formatTgHelp(tree: readonly TgCommandNode[] = TG_COMMAND_TREE): string {
	const syntax = tree.map((node) => {
		if (!node.children) return node.token;
		const hint = node.children.optional ? `[${node.children.hint}]` : `<${node.children.hint}>`;
		return `${node.token} ${hint}`;
	});
	return `usage: /tg ${syntax.join(" | ")}`;
}

export function completeTgArguments(
	argumentPrefix: string,
	bots: readonly TgBotChoice[],
	tree: readonly TgCommandNode[] = TG_COMMAND_TREE,
): TgCompletionItem[] | null {
	const tokens = normalizedTokens(argumentPrefix);
	const startsNextToken = /\s$/.test(argumentPrefix);
	const path = startsNextToken ? tokens : tokens.slice(0, -1);
	const partial = startsNextToken ? "" : tokens.at(-1) ?? "";
	let candidates = tree;
	const valuePath: string[] = [];

	for (const token of path) {
		const node = candidates.find((candidate) => candidate.token === token);
		if (!node?.children) return null;
		valuePath.push(node.token);
		candidates = node.children.resolve(bots);
	}

	const needle = partial.toLocaleLowerCase("en");
	const matches = candidates.filter((candidate) => candidate.token.toLocaleLowerCase("en").startsWith(needle));
	if (matches.length === 0) return null;
	return matches.map((candidate) => ({
		value: [...valuePath, candidate.token].join(" "),
		label: candidate.label ?? candidate.token,
		description: candidate.description,
	}));
}

export type ParsedTgCommand =
	| { ok: true; dispatch: TgCommandDispatch; arguments: string[] }
	| { ok: false; reason: "empty" | "unknown" | "extra" };

export function parseTgArguments(
	input: string,
	bots: readonly TgBotChoice[],
	tree: readonly TgCommandNode[] = TG_COMMAND_TREE,
): ParsedTgCommand {
	const tokens = normalizedTokens(input);
	if (tokens.length === 0) return { ok: false, reason: "empty" };
	const rootNode = tree.find((candidate) => candidate.token === tokens[0]);
	if (!rootNode) return { ok: false, reason: "unknown" };
	let node: TgCommandNode = rootNode;

	for (let index = 1; index < tokens.length; index++) {
		const children: TgCommandChildren | undefined = node.children;
		if (!children) return { ok: false, reason: "extra" };
		const child: TgCommandNode | undefined = children.resolve(bots).find((candidate) => candidate.token === tokens[index]);
		if (child) {
			node = child;
			continue;
		}
		if (children.acceptUnknown && index === tokens.length - 1 && node.dispatch) {
			return { ok: true, dispatch: node.dispatch, arguments: tokens.slice(1) };
		}
		return { ok: false, reason: "extra" };
	}

	return node.dispatch
		? { ok: true, dispatch: node.dispatch, arguments: tokens.slice(1) }
		: { ok: false, reason: "extra" };
}

export interface TelegramExtensionOptions {
	rootDir?: string;
	hostVersion?: string;
	timelineFactory?: TimelineFactory;
	processRunner?: ProcessRunner;
	idFactory?: () => string;
	requestIdFactory?: () => string;
	mediaCache?: NativeMediaCache;
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

function fmtDuration(value: number): string {
	if (value < 1000) return `${Math.round(value)}ms`;
	if (value < 10_000) return `${(value / 1000).toFixed(2)}s`;
	return `${(value / 1000).toFixed(1)}s`;
}

function statsText(botId: string, stats: BotStats): string {
	if (stats.runs === 0) return `${botId} · lifetime · no runs yet`;
	const cacheWrite = stats.cacheWrite ?? 0;
	const reasoningTokens = stats.reasoningTokens ?? 0;
	const denominator = stats.cacheRead + cacheWrite + stats.cacheMiss;
	const hit = denominator > 0 ? (stats.cacheRead / denominator) * 100 : 0;
	const since = stats.firstRunTs != null ? `${fmtDay(stats.firstRunTs)} ${fmtClock(stats.firstRunTs)}` : "unknown";
	const averageLatency = (stats.latencySamples ?? 0) > 0
		? fmtDuration((stats.totalLatencyMs ?? 0) / (stats.latencySamples ?? 1))
		: "n/a";
	const last = stats.last;
	const lastLine = last
		? `last · ep${last.epoch} · ctx ${fmtNum(last.contextTokens)} · miss ${fmtNum(last.cacheMiss)} · read ${fmtNum(last.cacheRead)} · write ${fmtNum(last.cacheWrite ?? 0)} · out ${fmtNum(last.outputTokens)} · reasoning ${fmtNum(last.reasoningTokens ?? 0)} · ${last.latencyMs == null ? "latency n/a" : fmtDuration(last.latencyMs)} · $${last.cost.toFixed(last.cost >= 1 ? 2 : 4)}`
		: `last · ep${stats.epoch} · unavailable`;
	const totalLine = `total · prompt ${fmtNum(stats.contextTokens)} · ↑${fmtNum(stats.cacheMiss)} ↓${fmtNum(stats.outputTokens)} R${fmtNum(stats.cacheRead)} W${fmtNum(cacheWrite)} · reasoning ${fmtNum(reasoningTokens)} · $${stats.cost.toFixed(stats.cost >= 1 ? 2 : 4)} · CH${hit.toFixed(1)}% · avg ${averageLatency}`;
	return `${botId} · lifetime · ${stats.runs} runs since ${since}\n${lastLine}\n${totalLine}`;
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

function cardHeader(identity: string, metadata: string, theme: Theme, color: Parameters<Theme["fg"]>[0]): Tui.Component {
	const left = theme.bold(theme.fg(color, sanitize(identity))), right = theme.fg("dim", metadata);
	return new Tui.HStack([
		{ component: new Tui.TruncatedText(left), basis: Tui.visibleWidth(left), grow: 1, minSize: 8 },
		{ component: new Tui.TruncatedText(right), basis: Tui.visibleWidth(right), minSize: 12 },
	], { gap: 2 });
}

export type MediaImageResolver = (item: MsgItem) => MediaImage | null;

export function itemComponent(item: TimelineItem, theme: Theme, resolveMedia: MediaImageResolver = readMediaImage): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg(item.kind === "msg" && !item.isBot ? "userMessageBg" : "customMessageBg", text));
	if (item.kind === "evt") {
		box.addChild(cardHeader(`${item.botName} · bot ${item.botId}`, `LOCAL · ${fmtClock(item.ts)}`, theme, "warning"));
		box.addChild(new Tui.Text(theme.fg("customMessageText", eventBody(item)), 0, 0));
		return box;
	}

	const sender = `${item.senderName}${item.botId ? ` · bot ${item.botId}` : item.username ? ` · @${item.username}` : ""}`;
	box.addChild(cardHeader(sender, `#${item.messageId} · ${fmtClock(item.ts)}${item.edited ? " · edited" : ""}`, theme, item.isBot ? "accent" : "userMessageText"));
	if (item.replyTo != null) box.addChild(new Tui.Text(theme.fg("muted", `↪ reply to #${item.replyTo}`), 0, 0));
	if (item.text) box.addChild(new Tui.Text(theme.fg(item.isBot ? "customMessageText" : "userMessageText", sanitize(item.text)), 0, 0));
	if (item.mediaKind) {
		box.addChild(new Tui.Text(theme.fg("muted", `[${sanitize(item.mediaKind)}${item.stickerEmoji ? ` ${sanitize(item.stickerEmoji)}` : ""}]`), 0, 0));
		const image = resolveMedia(item);
		if (image) box.addChild(new Tui.Image(image.base64, image.mime, { fallbackColor: (text) => theme.fg("muted", text) }, { maxWidthCells: 56, maxHeightCells: 16, filename: basename(image.filename) }));
		if (item.mediaDesc?.trim()) box.addChild(new Tui.Text(theme.fg("muted", `视觉理解 · ${sanitize(item.mediaDesc.trim())}`), 0, 0));
	}
	return box;
}

export function streamComponent(stream: Extract<AgentStreamFrame, { phase: "update" }>, theme: Theme): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(cardHeader(`${stream.botName} · bot ${stream.botId}`, `STREAMING · ${fmtClock(stream.ts)}`, theme, "warning"));
	if (stream.thinking) box.addChild(new Tui.Text(theme.fg("muted", `thinking · ${sanitize(stream.thinking)}`), 0, 0));
	if (stream.text) box.addChild(new Tui.Text(theme.fg("customMessageText", sanitize(stream.text)), 0, 0));
	for (const tool of stream.toolCalls) box.addChild(new Tui.Text(theme.fg("accent", `${sanitize(tool.name)} · ${sanitize(tool.arguments)}`), 0, 0));
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
		totals: { runs: number; cacheMiss: number; cacheRead: number; cacheWrite: number; outputTokens: number; cost: number };
	} {
		const selectedBots = this.filter ? this.bots.filter((bot) => bot.id === this.filter) : this.bots;
		let latest: NonNullable<BotStats["last"]> | null = null;
		const totals = { runs: 0, cacheMiss: 0, cacheRead: 0, cacheWrite: 0, outputTokens: 0, cost: 0 };
		for (const bot of selectedBots) {
			const stats = this.stats[bot.id];
			if (!stats) continue;
			totals.runs += stats.runs;
			totals.cacheMiss += stats.cacheMiss;
			totals.cacheRead += stats.cacheRead;
			totals.cacheWrite += stats.cacheWrite ?? 0;
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
		const totalTokens = totals.cacheMiss + totals.cacheRead + totals.cacheWrite + totals.outputTokens;
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
					cacheWrite: totals.cacheWrite,
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
	private clientValue: TimelinePort;
	private readonly content = new Tui.Container();
	private readonly streamContent = new Tui.Container();
	private readonly items: TimelineItem[] = [];
	private readonly itemKeys = new Set<string>();
	private readonly cardSlots = new Map<string, Tui.Container>();
	private readonly streams = new Map<string, Extract<AgentStreamFrame, { phase: "update" }>>();
	private readonly endedStreams = new Set<string>();
	private statsValue: Record<string, BotStats> = {};
	private statusValue = "connecting...";
	private closed = false;
	private mediaGeneration = 0;
	private mediaListener: MediaReadyListener;
	private readonly mediaResolver: MediaImageResolver;

	constructor(
		readonly filter: string | null,
		private readonly theme: Theme,
		private readonly factory: TimelineFactory,
		private readonly changed: (event: TimelineEvent, feed: TelegramFeed) => void,
		private readonly mediaCache: NativeMediaCache,
		private readonly requestRender: () => void,
	) {
		super();
		this.mediaListener = this.createMediaListener();
		this.mediaResolver = (item) => this.mediaCache.resolve(item, this.mediaListener);
		const header = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
		header.addChild(new Tui.Text(theme.bold(theme.fg("accent", filter ? `Telegram · bot ${filter}` : "Telegram · all bots")), 0, 0));
		header.addChild(new Tui.Text(theme.fg("dim", "Pi transcript owns scrolling, resize, selection and images · /tg more · /tg detach"), 0, 0));
		this.addChild(header);
		this.addChild(new Tui.Spacer(1));
		this.addChild(this.content);
		this.addChild(this.streamContent);
		this.clientValue = factory(filter, { onEvent: (event) => this.onEvent(event) });
	}

	get client(): TimelinePort { return this.clientValue; }
	get stats(): Record<string, BotStats> { return this.statsValue; }
	get status(): string { return this.statusValue; }
	start(): void { void this.clientValue.connect(); }
	more(): boolean { return this.clientValue.requestOlder(); }

	suspendForRestart(): void {
		this.clientValue.dispose();
		this.invalidateMediaListener();
		this.clearStreams();
		this.setStatus("restarting Telegram daemon...");
	}

	async reconnect(): Promise<boolean> {
		this.clientValue.dispose();
		this.closed = false;
		this.setStatus("reconnecting Telegram feed...");
		this.clientValue = this.factory(this.filter, { onEvent: (event) => this.onEvent(event) });
		this.rebuildItems();
		this.requestRender();
		return this.clientValue.connect();
	}

	detach(reason = "detached"): void {
		if (this.closed) return;
		this.closed = true;
		this.clientValue.dispose();
		this.invalidateMediaListener();
		this.clearStreams();
		this.setStatus(reason);
	}

	dispose(): void { this.detach(); }

	private onEvent(event: TimelineEvent): void {
		if (event.type === "append") {
			const fresh = event.items.filter((item) => this.rememberItem(item));
			this.items.push(...fresh);
			this.appendItems(fresh);
		} else if (event.type === "prepend") {
			const fresh = event.items.filter((item) => this.rememberItem(item));
			if (fresh.length > 0) {
				this.items.unshift(...fresh);
				this.rebuildItems();
			}
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
		} else if (event.type === "stream") {
			this.applyStream(event.stream);
		} else if (event.type === "status") {
			this.setStatus(event.text);
		} else {
			this.clearStreams();
			this.setStatus(event.reason);
		}
		this.changed(event, this);
	}

	private rememberItem(item: TimelineItem): boolean {
		const key = this.itemKey(item);
		if (this.itemKeys.has(key)) return false;
		this.itemKeys.add(key);
		return true;
	}

	private appendItems(items: TimelineItem[]): void {
		let previousDay = this.items.length > items.length ? fmtDay(this.items[this.items.length - items.length - 1]!.ts) : "";
		for (const item of items) {
			const day = fmtDay(item.ts);
			if (day !== previousDay) this.content.addChild(new Tui.Text(this.theme.fg("dim", `──────── ${day} ────────`), 1, 0));
			const slot = new Tui.Container();
			slot.addChild(itemComponent(item, this.theme, this.mediaResolver));
			this.cardSlots.set(this.itemKey(item), slot);
			this.content.addChild(slot);
			this.content.addChild(new Tui.Spacer(1));
			previousDay = day;
		}
	}

	private rebuildItems(): void {
		this.content.clear();
		this.cardSlots.clear();
		this.appendItems(this.items);
	}

	private itemKey(item: TimelineItem): string {
		if (item.kind === "msg") return `m:${item.chatId}:${item.messageId}`;
		return item.evtId != null
			? `e:${item.evtId}`
			: `e?:${item.botId}:${item.ts}:${item.evtKind}:${item.payload}`;
	}

	private refreshMedia(filename: string): void {
		let refreshed = false;
		for (const item of this.items) {
			if (item.kind !== "msg" || item.mediaPath !== filename) continue;
			const slot = this.cardSlots.get(this.itemKey(item));
			if (!slot) continue;
			slot.clear();
			slot.addChild(itemComponent(item, this.theme, this.mediaResolver));
			refreshed = true;
		}
		if (refreshed) this.requestRender();
	}

	private applyStream(stream: AgentStreamFrame): void {
		const key = `${stream.botId}:${stream.streamId}`;
		if (stream.phase === "end") {
			this.streams.delete(key);
			this.rememberEnded(key);
			this.rebuildStreams();
			return;
		}
		if (this.endedStreams.has(key)) return;
		if (!this.streams.has(key) && this.streams.size >= MAX_ACTIVE_STREAMS) {
			const oldest = this.streams.keys().next().value as string | undefined;
			if (oldest) this.streams.delete(oldest);
		}
		this.streams.delete(key);
		this.streams.set(key, stream.phase === "start" ? { ...stream, phase: "update", thinking: "", text: "", toolCalls: [] } : stream);
		this.rebuildStreams();
	}

	private rememberEnded(key: string): void {
		this.endedStreams.delete(key);
		this.endedStreams.add(key);
		while (this.endedStreams.size > MAX_ENDED_STREAMS) {
			const oldest = this.endedStreams.keys().next().value as string | undefined;
			if (!oldest) break;
			this.endedStreams.delete(oldest);
		}
	}

	private rebuildStreams(): void {
		this.streamContent.clear();
		for (const stream of this.streams.values()) {
			this.streamContent.addChild(streamComponent(stream, this.theme));
			this.streamContent.addChild(new Tui.Spacer(1));
		}
	}

	private clearStreams(): void {
		if (this.streams.size === 0) return;
		this.streams.clear();
		this.rebuildStreams();
	}

	private setStatus(value: string): void {
		this.statusValue = value;
	}

	private createMediaListener(): MediaReadyListener {
		const generation = this.mediaGeneration;
		return (filename) => {
			if (this.closed || generation !== this.mediaGeneration) return;
			this.refreshMedia(filename);
		};
	}

	private invalidateMediaListener(): void {
		this.mediaCache.unsubscribe(this.mediaListener);
		this.mediaGeneration++;
		this.mediaListener = this.createMediaListener();
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
	const mediaCache = options.mediaCache ?? new NativeMediaCache();
	const runProcess = options.processRunner ?? runChildProcess;
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
	let completionBots: TgBotChoice[] | undefined;
	let requestHostRender: (() => void) | null = null;
	const getCompletionBots = (): TgBotChoice[] => {
		if (completionBots) return completionBots;
		try {
			completionBots = loadConfig(rootDir).bots.map(({ id, name }) => ({ id, name }));
			return completionBots;
		} catch {
			return [];
		}
	};

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
		ctx.ui.setFooter((tui, _theme, footerData) => {
			requestHostRender = () => tui.requestRender();
			return telemetry.mount(tui, footerData);
		});
	};
	const mountStandaloneStats = (filter: string | null, ctx: ExtensionContext) => {
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
		const feed = new TelegramFeed(data.filter, theme, factory, pending.changed, mediaCache, () => requestHostRender?.());
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
		requestHostRender = null;
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
		description: `Telegram: ${formatTgHelp().slice("usage: /tg ".length)}`,
		getArgumentCompletions: (argumentPrefix) => completeTgArguments(argumentPrefix, getCompletionBots()),
		handler: async (args, ctx) => {
			lastUi = ctx.ui;
			const parsed = parseTgArguments(args, getCompletionBots());
			if (!parsed.ok) {
				ctx.ui.notify(formatTgHelp(), parsed.reason === "empty" ? "info" : "error");
				return;
			}
			const sub = parsed.dispatch;
			const botArg = parsed.arguments[0];
			const daemonSub = sub === "start" || sub === "restart" || sub === "stop" || sub === "status-daemon";
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
						requestHostRender?.();
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
					mountStandaloneStats(filter, ctx);
				}
			} else if (sub === "status") {
				const filter = resolveFilter(botArg);
				if (filter === undefined) return;
				if (active && active.filter === filter && Object.keys(active.stats).length > 0) {
					ctx.ui.notify(Object.entries(active.stats).map(([id, stats]) => statsText(id, stats)).join("\n\n"), "info");
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
								const text = Object.entries(event.stats).map(([id, stats]) => statsText(id, stats)).join("\n\n");
								finish(text || "no telemetry yet", "info");
							} else if (event.type === "disconnected") finish(event.reason, "error");
						},
					});
					void client.connect();
				});
			} else if (daemonSub) {
				const command = sub === "status-daemon" ? "status" : sub;
				const restartFeed = sub === "restart" && ctx.mode === "tui" ? active : null;
				const restoreFooter = sub === "restart" && ctx.mode === "tui" && footerOwner && footerTelemetry
					? { owner: footerOwner, filter: footerTelemetry.filter }
					: null;
				if (sub === "restart" && ctx.mode === "tui") {
					closeCompose(ctx.ui);
					restartFeed?.suspendForRestart();
					clearStatsFooter(ctx.ui);
					ctx.ui.setStatus("telegram-daemon", "TELEGRAM · RESTARTING");
					ctx.ui.notify("Restarting every configured Telegram bot...", "info");
				}
				let result: ProcessRunResult;
				try {
					result = await runProcess("bun", ["run", "src/main.ts", command], { cwd: rootDir });
				} catch (error) {
					result = { status: null, stdout: "", stderr: `failed to run daemon command: ${String(error)}` };
				}
				let output = `${result.stdout}${result.stderr}`.trim() || `daemon ${command}`;
				let level: "info" | "error" = result.status === 0 ? "info" : "error";
				if (sub === "restart" && result.status === 0 && output.includes("daemon ready")) {
					if (restartFeed) {
						if (restoreFooter?.owner === "feed") mountStatsFooter(restartFeed.filter, "feed", ctx);
						const connected = await restartFeed.reconnect();
						if (connected) {
							if (restoreFooter?.owner === "feed") footerTelemetry?.update(restartFeed.stats);
							else if (restoreFooter?.owner === "standalone") mountStandaloneStats(restoreFooter.filter, ctx);
						} else {
							clearStatsFooter(ctx.ui);
							output += "\ndaemon is ready, but the previous feed could not reconnect; run /tg attach again";
							level = "error";
						}
					} else if (restoreFooter?.owner === "standalone") {
						mountStandaloneStats(restoreFooter.filter, ctx);
					}
				}
				if (sub === "restart" && ctx.mode === "tui") ctx.ui.setStatus("telegram-daemon", undefined);
				ctx.ui.notify(output, level);
			}
		},
	});
}

export default function telegramExtension(pi: ExtensionAPI): void {
	registerTelegramExtension(pi);
}
