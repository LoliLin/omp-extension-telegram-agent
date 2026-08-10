import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	convertToPng,
	ToolExecutionComponent,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import { redactDaemonLog } from "../../src/daemon/control.ts";
import type {
	AgentActivity,
	AgentActivityAssistantSection,
	AgentActivityEventSection,
	AgentStreamFrame,
	BotStats,
	EvtItem,
	MsgItem,
	RuntimeControlSnapshot,
	TimelineItem,
} from "../../src/ipc.ts";
import { runNativeConfigWizard, type PiModelPreflight } from "../../src/onboarding/config-wizard.ts";
import { buildBotStatusView, formatUsdCost, renderBotStatusPlain } from "../../src/observability/status.ts";
import { summarizeBotUsage } from "../../src/observability/usage.ts";
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
const FEED_WIDGET_KEY = "telegram-feed";
const MIN_PI_VERSION = "0.84.1";
const MAX_ACTIVE_STREAMS = 32;
const MAX_ENDED_STREAMS = 64;
const PROCESS_OUTPUT_MAX_BYTES = 64 * 1024;
export const MEDIA_CACHE_MAX_ENTRIES = 32;
export const MEDIA_CACHE_MAX_BASE64_BYTES = 32 * 1024 * 1024;
export const MEDIA_CACHE_MAX_ITEM_BASE64_BYTES = 8 * 1024 * 1024;
export const MEDIA_CONVERSION_MAX_PENDING = 32;

const IDENTITY_COLORS = [
	"accent",
	"syntaxFunction",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxKeyword",
	"syntaxVariable",
	"mdLink",
] as const satisfies readonly ThemeColor[];

type TimelineFactory = (filter: string | null, hooks: TimelineHooks) => TimelinePort;
export interface ProcessRunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}
type ProcessRunner = (command: string, args: readonly string[], options: { cwd: string }) => Promise<ProcessRunResult>;
type FeedEntry = { instanceId: string; filter: string | null };
type ComposeIdentity = Pick<BotConfig, "id" | "name">;
type ComposeMode = { kind: "scope" } | { kind: "bot"; identity: ComposeIdentity };
type ToolPresentationHost = { ui: Tui.TUI; cwd: string };
type StatusModel = Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "contextWindow" | "reasoning">;
type StatusBot = Pick<
	BotConfig,
	"id" | "name" | "provider" | "model" | "reasoningEffort" | "routingP" | "samplingCooldownMs"
>;
type StatusHost = {
	modelRegistry: { getAvailable(): readonly StatusModel[] };
	model: StatusModel | undefined;
	thinkingLevel?: ExtensionContext["thinkingLevel"];
};

export type MediaConverter = (
	base64Data: string,
	mimeType: string,
) => Promise<{ data: string; mimeType: string } | null>;

type MediaReadyListener = (filename: string) => void;
type MediaCacheState = { kind: "ready"; image: MediaImage; base64Bytes: number } | { kind: "failed"; base64Bytes: 0 };

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
		this.limits = {
			maxEntries: limits.maxEntries ?? MEDIA_CACHE_MAX_ENTRIES,
			maxTotalBase64Bytes: limits.maxTotalBase64Bytes ?? MEDIA_CACHE_MAX_BASE64_BYTES,
			maxItemBase64Bytes: limits.maxItemBase64Bytes ?? MEDIA_CACHE_MAX_ITEM_BASE64_BYTES,
			maxPending: limits.maxPending ?? MEDIA_CONVERSION_MAX_PENDING,
		};
	}

	get size(): number {
		return this.states.size;
	}
	get totalBase64Bytes(): number {
		return this.totalBytesValue;
	}
	get pendingCount(): number {
		return this.pending.size;
	}

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

	private isValidPng(
		value: { data: string; mimeType: string } | null,
	): value is { data: string; mimeType: "image/png" } {
		if (!value || value.mimeType !== "image/png" || !value.data || value.data.length > this.limits.maxItemBase64Bytes) {
			return false;
		}
		const bytes = Buffer.from(value.data, "base64");
		const hasSignature =
			bytes.length >= 8 &&
			bytes[0] === 0x89 &&
			bytes[1] === 0x50 &&
			bytes[2] === 0x4e &&
			bytes[3] === 0x47 &&
			bytes[4] === 0x0d &&
			bytes[5] === 0x0a &&
			bytes[6] === 0x1a &&
			bytes[7] === 0x0a;
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
	| "config"
	| "attach"
	| "compose"
	| "more"
	| "detach"
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
	{ token: "config", description: "Configure Telegram with Pi dialogs", dispatch: "config" },
	{
		token: "attach",
		description: "Open all bots or one bot for chat",
		dispatch: "attach",
		children: botChildren("attach", true),
	},
	{
		token: "compose",
		description: "Use the feed scope, one bot, or Pi",
		dispatch: "compose",
		children: botChildren("compose", true, true),
	},
	{ token: "more", description: "Load one older history page", dispatch: "more" },
	{ token: "detach", description: "Disconnect the live feed", dispatch: "detach" },
	{ token: "status", description: "Show detailed usage", dispatch: "status", children: botChildren("status", true) },
	{ token: "start", description: "Start the Telegram daemon", dispatch: "start" },
	{ token: "restart", description: "Gracefully restart every configured bot", dispatch: "restart" },
	{ token: "stop", description: "Stop the Telegram daemon", dispatch: "stop" },
	{ token: "status-daemon", description: "Show daemon process status", dispatch: "status-daemon" },
];

function runChildProcess(
	command: string,
	args: readonly string[],
	options: { cwd: string },
): Promise<ProcessRunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => {
			const combined = Buffer.concat([current, chunk]);
			return combined.length <= PROCESS_OUTPUT_MAX_BYTES
				? combined
				: combined.subarray(combined.length - PROCESS_OUTPUT_MAX_BYTES);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.once("error", (error) =>
			resolve({ status: null, stdout: stdout.toString(), stderr: `${stderr.toString()}${error.message}` }),
		);
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
	const partial = startsNextToken ? "" : (tokens.at(-1) ?? "");
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
		const child: TgCommandNode | undefined = children
			.resolve(bots)
			.find((candidate) => candidate.token === tokens[index]);
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
	piModelPreflight?: PiModelPreflight;
}

export interface TelegramComposeIndicator {
	text: string;
	color: Extract<ThemeColor, "accent" | "warning" | "error">;
}

export function supportsPiVersion(value: string): boolean {
	return value.localeCompare(MIN_PI_VERSION, "en", { numeric: true }) >= 0;
}

/** One-line attached-feed chrome with compose guidance kept beside its Telegram scope. */
export function telegramFeedHeaderLine(
	width: number,
	theme: Pick<Theme, "fg" | "bold">,
	scope: string,
	composeIndicator: TelegramComposeIndicator | null,
): string {
	if (width <= 0) return "";
	const indicator = composeIndicator
		? `${theme.fg("dim", " · ")}${theme.bold(theme.fg(composeIndicator.color, sanitize(composeIndicator.text)))}`
		: "";
	const text =
		`${theme.bold(theme.fg("accent", "Telegram"))}${theme.fg("dim", ` · ${sanitize(scope)} · `)}` +
		`${theme.fg("success", "attached")}${indicator}${theme.fg("dim", " · /tg more · /tg detach")}`;
	return Tui.truncateToWidth(` ${text}`, width, theme.fg("dim", "..."));
}

function fmtClock(ts: number): string {
	return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

function fmtDay(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function identityColor(identity: string): ThemeColor {
	let hash = 0x811c9dc5;
	for (let index = 0; index < identity.length; index++) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return IDENTITY_COLORS[(hash >>> 0) % IDENTITY_COLORS.length]!;
}

function resolveStatusModel(
	bot: StatusBot | undefined,
	status: RuntimeControlSnapshot | undefined,
	host: StatusHost,
): StatusModel | undefined {
	if (!bot && !status) return host.model;
	const provider = status?.provider ?? bot?.provider;
	const modelId = status?.model ?? bot?.model;
	const configured = host.modelRegistry
		.getAvailable()
		.find((model) => model.provider === provider && model.id === modelId);
	if (configured) return configured;
	const activeModel = host.model;
	if (activeModel && activeModel.provider === provider && activeModel.id === modelId) return activeModel;
	return {
		id: modelId ?? "unknown",
		provider: provider ?? "unknown",
		contextWindow: status?.contextWindow ?? 0,
		reasoning: (status?.reasoningEffort ?? bot?.reasoningEffort ?? "off") !== "off",
	};
}

export function statsText(
	botId: string,
	stats: BotStats,
	bot: StatusBot | undefined,
	status: RuntimeControlSnapshot | undefined,
	host: StatusHost,
): string {
	const model = resolveStatusModel(bot, status, host);
	const identity: StatusBot = bot ?? {
		id: botId,
		name: botId,
		provider: status?.provider ?? model?.provider ?? "unknown",
		model: status?.model ?? model?.id ?? "unknown",
		reasoningEffort: status?.reasoningEffort ?? host.thinkingLevel ?? "off",
		routingP: status?.routingP ?? 0,
		samplingCooldownMs: status?.samplingCooldownMs ?? 0,
	};
	return renderBotStatusPlain(buildBotStatusView(identity, stats, status, model?.contextWindow ?? 0));
}

function footerTokens(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export interface TelegramFooterUsage {
	inputTokens: number;
	outputTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitPercent: number | null;
	cacheEstimated: boolean;
	cost: number;
	contextPercent: number | null;
	contextWindow: number;
	provider: string;
	model: string;
	reasoning: boolean;
	reasoningEffort: RuntimeControlSnapshot["reasoningEffort"];
}

/** Telegram telemetry projected into the fields shown by Pi's native footer. */
export function telegramFooterUsage(
	filter: string | null,
	statsByBot: Readonly<Record<string, BotStats>>,
	statuses: Readonly<Record<string, RuntimeControlSnapshot>>,
	bots: readonly StatusBot[],
	host: StatusHost,
): TelegramFooterUsage | undefined {
	const configured = new Map(bots.map((bot) => [bot.id, bot]));
	const selected = Object.entries(statsByBot).filter(
		([botId]) => configured.has(botId) && (filter == null || botId === filter),
	);
	if (selected.length === 0) return undefined;

	const totals: BotStats = {
		runs: 0,
		contextTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheMiss: 0,
		estimatedCacheRuns: 0,
		outputTokens: 0,
		cost: 0,
		epoch: 0,
		last: null,
	};
	let currentBotId = filter ?? selected[0]![0];
	for (const [botId, stats] of selected) {
		totals.runs += stats.runs;
		totals.contextTokens += stats.contextTokens;
		totals.cacheRead += stats.cacheRead;
		totals.cacheWrite = (totals.cacheWrite ?? 0) + (stats.cacheWrite ?? 0);
		totals.cacheMiss += stats.cacheMiss;
		totals.estimatedCacheRuns = (totals.estimatedCacheRuns ?? 0) + (stats.estimatedCacheRuns ?? 0);
		totals.outputTokens += stats.outputTokens;
		totals.cost += stats.cost;
		if (
			stats.last &&
			(!totals.last ||
				stats.last.ts > totals.last.ts ||
				(stats.last.ts === totals.last.ts && stats.last.id > totals.last.id))
		) {
			totals.last = stats.last;
			currentBotId = botId;
		}
	}
	totals.epoch = totals.last?.epoch ?? statsByBot[currentBotId]?.epoch ?? 0;

	const status = statuses[currentBotId];
	const bot = configured.get(currentBotId);
	const model = resolveStatusModel(bot, status, host);
	const usage = summarizeBotUsage(totals, model?.contextWindow ?? status?.contextWindow ?? 0);
	return {
		inputTokens: totals.cacheMiss,
		outputTokens: totals.outputTokens,
		cacheRead: totals.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheHitPercent: usage.cacheHitPercent,
		cacheEstimated: usage.cacheEstimated,
		cost: totals.cost,
		contextPercent: usage.context.percent,
		contextWindow: usage.context.contextWindow,
		provider: model?.provider ?? status?.provider ?? bot?.provider ?? "unknown",
		model: model?.id ?? status?.model ?? bot?.model ?? currentBotId,
		reasoning: model?.reasoning ?? false,
		reasoningEffort: status?.reasoningEffort ?? bot?.reasoningEffort ?? "off",
	};
}

export interface TelegramFooterView {
	cwd: string;
	home: string | undefined;
	branch: string | null;
	sessionName: string | undefined;
	usage: TelegramFooterUsage | undefined;
	availableProviderCount: number;
	statuses: ReadonlyMap<string, string>;
}

function footerCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const relativeToHome = relative(resolve(home), resolve(cwd));
	const insideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!insideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function footerStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Pi-native footer layout backed by Telegram rather than operator-session usage. */
export function telegramFooterLines(width: number, theme: Pick<Theme, "fg">, view: TelegramFooterView): string[] {
	let path = footerCwd(view.cwd, view.home);
	if (view.branch) path += ` (${view.branch})`;
	if (view.sessionName) path += ` • ${view.sessionName}`;
	const lines = [Tui.truncateToWidth(theme.fg("dim", path), width, theme.fg("dim", "..."))];

	if (view.usage) {
		const usage = view.usage;
		const parts: string[] = [];
		const cacheApprox = usage.cacheEstimated ? "≈" : "";
		if (usage.inputTokens) parts.push(`↑${cacheApprox}${footerTokens(usage.inputTokens)}`);
		if (usage.outputTokens) parts.push(`↓${footerTokens(usage.outputTokens)}`);
		if (usage.cacheRead) parts.push(`R${cacheApprox}${footerTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) parts.push(`W${footerTokens(usage.cacheWrite)}`);
		if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitPercent != null) {
			parts.push(`CH${cacheApprox}${usage.cacheHitPercent.toFixed(1)}%`);
		}
		if (usage.cost) parts.push(`$${formatUsdCost(usage.cost)}`);

		const context = `${usage.contextPercent == null ? "?" : `${usage.contextPercent.toFixed(1)}%`}/${footerTokens(
			usage.contextWindow,
		)} (auto)`;
		parts.push(
			usage.contextPercent != null && usage.contextPercent > 90
				? theme.fg("error", context)
				: usage.contextPercent != null && usage.contextPercent > 70
					? theme.fg("warning", context)
					: context,
		);

		let statsLeft = parts.join(" ");
		let statsLeftWidth = Tui.visibleWidth(statsLeft);
		if (statsLeftWidth > width) {
			statsLeft = Tui.truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = Tui.visibleWidth(statsLeft);
		}

		let model = usage.model;
		if (usage.reasoning) {
			model =
				usage.reasoningEffort === "off" ? `${usage.model} • thinking off` : `${usage.model} • ${usage.reasoningEffort}`;
		}
		let right = model;
		if (view.availableProviderCount > 1) {
			right = `(${usage.provider}) ${model}`;
			if (statsLeftWidth + 2 + Tui.visibleWidth(right) > width) right = model;
		}

		const rightWidth = Tui.visibleWidth(right);
		let statsLine: string;
		if (statsLeftWidth + 2 + rightWidth <= width) {
			statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightWidth) + right;
		} else {
			const availableForRight = width - statsLeftWidth - 2;
			if (availableForRight > 0) {
				const truncatedRight = Tui.truncateToWidth(right, availableForRight, "");
				statsLine =
					statsLeft +
					" ".repeat(Math.max(0, width - statsLeftWidth - Tui.visibleWidth(truncatedRight))) +
					truncatedRight;
			} else statsLine = statsLeft;
		}
		lines.push(theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)));
	}

	const status = [...view.statuses.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, text]) => footerStatusText(text))
		.join(" ");
	if (status) lines.push(Tui.truncateToWidth(status, width, theme.fg("dim", "...")));
	return lines;
}

function eventBody(event: EvtItem): string {
	try {
		const payload = JSON.parse(event.payload) as Record<string, unknown>;
		if (event.evtKind === "thinking") return `thinking · ${sanitize(String(payload.text ?? ""))}`;
		if (event.evtKind === "assistant_text") return sanitize(String(payload.text ?? ""));
		if (event.evtKind === "tool_call")
			return `${sanitize(String(payload.tool ?? "tool"))} · ${sanitize(JSON.stringify(payload.args ?? {})).slice(0, 180)}`;
		if (event.evtKind === "tool_result")
			return `${sanitize(String(payload.tool ?? "tool"))} · ${payload.isError ? "error" : "done"}`;
		return `${sanitize(event.evtKind)} · ${sanitize(event.payload).slice(0, 240)}`;
	} catch {
		return sanitize(event.evtKind);
	}
}

function activityEventPayload(section: AgentActivityEventSection): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(section.detail) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function activityEventBody(section: AgentActivityEventSection, payload = activityEventPayload(section)): string {
	if (!payload) return `${sanitize(section.kind)} · ${sanitize(section.detail)}`;
	const tool = sanitize(String(payload.tool ?? "tool"));
	if (section.kind === "tool_call") return `${tool} · ${sanitize(JSON.stringify(payload.args ?? {}))}`;
	if (section.kind === "tool_result") return `${tool} · ${payload.isError ? "error" : "done"}`;
	if (section.kind === "markdown_sent") return `markdown sent · #${sanitize(String(payload.message_id ?? "?"))}`;
	if (section.kind === "plain_fallback") return `plain fallback · #${sanitize(String(payload.message_id ?? "?"))}`;
	if (section.kind === "send") {
		const sent = Array.isArray(payload.sent) ? payload.sent.map((id) => `#${sanitize(String(id))}`).join(", ") : "";
		return `sent${sent ? ` · ${sent}` : ""}`;
	}
	if (section.kind === "send_degraded") return `send degraded · ${sanitize(String(payload.outcome ?? "unknown"))}`;
	return `${sanitize(section.kind.replaceAll("_", " "))} · ${sanitize(section.detail)}`;
}

function nativeAssistantSection(section: AgentActivityAssistantSection, ts: number): AssistantMessageComponent {
	const message = {
		role: "assistant",
		content: section.content.map((content) =>
			content.type === "text"
				? { type: "text" as const, text: sanitize(content.text) }
				: { type: "thinking" as const, thinking: sanitize(content.thinking) },
		),
		api: "openai-completions",
		provider: "telegram",
		model: "telegram-activity",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: section.stopReason,
		timestamp: ts,
	} satisfies AssistantMessage;
	return new AssistantMessageComponent(message, false);
}

/** One Pi-native assistant/tool presentation for an entire daemon agent run. */
export function activityComponent(
	botId: string,
	botName: string,
	activity: AgentActivity,
	theme: Theme,
	status = "Activity",
	toolHost?: ToolPresentationHost,
): Tui.Component {
	const box = new Tui.Box(1, 0, (text) => theme.bg("customMessageBg", text));
	box.addChild(
		cardHeader(botName, `bot ${botId} · ${status} · ${fmtClock(activity.startedAt)}`, theme, identityColor(botId)),
	);
	const pendingTools = new Map<string, ToolExecutionComponent[]>();
	for (let index = 0; index < activity.sections.length; index++) {
		const section = activity.sections[index]!;
		if (section.type === "assistant") box.addChild(nativeAssistantSection(section, activity.startedAt));
		else {
			const payload = activityEventPayload(section);
			const tool = payload ? sanitize(String(payload.tool ?? "tool")) : "tool";
			if (toolHost && payload && section.kind === "tool_call") {
				const component = new ToolExecutionComponent(
					tool,
					`${activity.activityId}:${index}`,
					payload.args ?? {},
					{ showImages: false },
					undefined,
					toolHost.ui,
					toolHost.cwd,
				);
				const queue = pendingTools.get(tool) ?? [];
				queue.push(component);
				pendingTools.set(tool, queue);
				box.addChild(component);
				continue;
			}
			if (toolHost && payload && section.kind === "tool_result") {
				const component = pendingTools.get(tool)?.shift();
				if (component) {
					const isError = payload.isError === true;
					component.updateResult({
						content: isError ? [{ type: "text", text: "error" }] : [],
						isError,
					});
					continue;
				}
			}
			const color: ThemeColor =
				section.kind === "send_degraded"
					? "error"
					: section.kind === "send" || section.kind === "markdown_sent" || section.kind === "plain_fallback"
						? "success"
						: "muted";
			box.addChild(new Tui.Text(theme.fg(color, activityEventBody(section, payload)), 0, 0));
		}
	}
	if (activity.truncated) box.addChild(new Tui.Text(theme.fg("warning", "activity display truncated"), 0, 0));
	return box;
}

function parsedActivity(event: EvtItem): AgentActivity | null {
	if (event.evtKind !== "agent_activity") return null;
	try {
		const value = JSON.parse(event.payload) as Partial<AgentActivity>;
		if (value.version !== 1 || typeof value.activityId !== "string" || !Array.isArray(value.sections)) return null;
		return {
			version: 1,
			activityId: value.activityId,
			startedAt: typeof value.startedAt === "number" ? value.startedAt : event.ts,
			sections: value.sections as AgentActivity["sections"],
			truncated: value.truncated === true,
		};
	} catch {
		return null;
	}
}

function cardHeader(identity: string, metadata: string, theme: Theme, color: ThemeColor): Tui.Component {
	const left = theme.bold(theme.fg(color, sanitize(identity))),
		right = theme.fg("dim", metadata);
	return new Tui.HStack(
		[
			{ component: new Tui.TruncatedText(left), basis: Tui.visibleWidth(left), grow: 1, minSize: 8 },
			{ component: new Tui.TruncatedText(right), basis: Tui.visibleWidth(right), minSize: 12 },
		],
		{ gap: 2 },
	);
}

export type MediaImageResolver = (item: MsgItem) => MediaImage | null;

export function itemComponent(
	item: TimelineItem,
	theme: Theme,
	resolveMedia: MediaImageResolver = readMediaImage,
	toolHost?: ToolPresentationHost,
): Tui.Component {
	if (item.kind === "evt") {
		const activity = parsedActivity(item);
		if (activity) return activityComponent(item.botId, item.botName, activity, theme, "Activity", toolHost);
	}
	const box = new Tui.Box(1, 0, (text) =>
		theme.bg(item.kind === "msg" && !item.isBot ? "userMessageBg" : "customMessageBg", text),
	);
	if (item.kind === "evt") {
		box.addChild(
			cardHeader(item.botName, `bot ${item.botId} · Local · ${fmtClock(item.ts)}`, theme, identityColor(item.botId)),
		);
		box.addChild(new Tui.Text(theme.fg("customMessageText", eventBody(item)), 0, 0));
		return box;
	}

	const username = item.username?.trim().replace(/^@/, "");
	const normalizedName = item.senderName.trim().toLocaleLowerCase();
	const sender =
		username && normalizedName !== username.toLocaleLowerCase() && normalizedName !== `@${username.toLocaleLowerCase()}`
			? `${item.senderName} · @${username}`
			: item.senderName;
	const metadata = [
		`#${item.messageId}`,
		...(item.botId ? [`bot ${item.botId}`] : []),
		fmtClock(item.ts),
		...(item.edited ? ["edited"] : []),
	].join(" · ");
	box.addChild(cardHeader(sender, metadata, theme, identityColor(username || item.senderName)));
	if (item.replyTo != null)
		box.addChild(new Tui.Text(theme.fg("customMessageLabel", `↪ reply to #${item.replyTo}`), 0, 0));
	if (item.text)
		box.addChild(
			new Tui.Text(theme.fg(item.isBot ? "customMessageText" : "userMessageText", sanitize(item.text)), 0, 0),
		);
	if (item.mediaKind) {
		box.addChild(
			new Tui.Text(
				theme.fg(
					"customMessageLabel",
					`[${sanitize(item.mediaKind)}${item.stickerEmoji ? ` ${sanitize(item.stickerEmoji)}` : ""}]`,
				),
				0,
				0,
			),
		);
		const image = resolveMedia(item);
		const imageBounds =
			item.mediaKind === "sticker"
				? { maxWidthCells: 24, maxHeightCells: 12 }
				: { maxWidthCells: 56, maxHeightCells: 16 };
		if (image)
			box.addChild(
				new Tui.Image(
					image.base64,
					image.mime,
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ ...imageBounds, filename: basename(image.filename) },
				),
			);
		if (item.mediaDesc?.trim())
			box.addChild(
				new Tui.Text(
					`${theme.bold(theme.fg("customMessageLabel", "Vision"))}${theme.fg("muted", ` · ${sanitize(item.mediaDesc.trim())}`)}`,
					0,
					0,
				),
			);
	}
	return box;
}

export function streamComponent(
	stream: Extract<AgentStreamFrame, { phase: "update" }>,
	theme: Theme,
	toolHost?: ToolPresentationHost,
): Tui.Component {
	return activityComponent(stream.botId, stream.botName, stream.activity, theme, "Streaming", toolHost);
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
	private statusesValue: Record<string, RuntimeControlSnapshot> = {};
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
		private readonly toolHost?: ToolPresentationHost,
	) {
		super();
		this.mediaListener = this.createMediaListener();
		this.mediaResolver = (item) => this.mediaCache.resolve(item, this.mediaListener);
		this.addChild(this.content);
		this.addChild(this.streamContent);
		this.clientValue = factory(filter, { onEvent: (event) => this.onEvent(event) });
	}

	get client(): TimelinePort {
		return this.clientValue;
	}
	get stats(): Record<string, BotStats> {
		return this.statsValue;
	}
	get statuses(): Record<string, RuntimeControlSnapshot> {
		return this.statusesValue;
	}
	get status(): string {
		return this.statusValue;
	}
	start(): void {
		void this.clientValue.connect();
	}
	more(): boolean {
		return this.clientValue.requestOlder();
	}

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

	dispose(): void {
		this.detach();
	}

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
			this.statusesValue = event.statuses;
		} else if (event.type === "vision") {
			let updated = false;
			for (let index = 0; index < this.items.length; index++) {
				const item = this.items[index]!;
				if (item.kind !== "msg" || item.fileUniqueId !== event.fileUniqueId || item.mediaDesc === event.text) continue;
				this.items[index] = { ...item, mediaDesc: event.text };
				updated = true;
			}
			if (updated) this.rebuildItems();
		} else if (event.type === "media") {
			this.applyMediaReady(event.fileUniqueId, event.mediaPath);
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
		let previousDay =
			this.items.length > items.length ? fmtDay(this.items[this.items.length - items.length - 1]!.ts) : "";
		for (const item of items) {
			const day = fmtDay(item.ts);
			if (day !== previousDay)
				this.content.addChild(new Tui.Text(this.theme.fg("dim", `──────── ${day} ────────`), 1, 0));
			const slot = new Tui.Container();
			slot.addChild(itemComponent(item, this.theme, this.mediaResolver, this.toolHost));
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
		return item.evtId != null ? `e:${item.evtId}` : `e?:${item.botId}:${item.ts}:${item.evtKind}:${item.payload}`;
	}

	private refreshMedia(filename: string): void {
		let refreshed = false;
		for (const item of this.items) {
			if (item.kind !== "msg" || item.mediaPath !== filename) continue;
			const slot = this.cardSlots.get(this.itemKey(item));
			if (!slot) continue;
			slot.clear();
			slot.addChild(itemComponent(item, this.theme, this.mediaResolver, this.toolHost));
			refreshed = true;
		}
		if (refreshed) this.requestRender();
	}

	private applyMediaReady(fileUniqueId: string, mediaPath: string): void {
		let refreshed = false;
		for (let index = 0; index < this.items.length; index++) {
			const item = this.items[index]!;
			if (item.kind !== "msg" || item.fileUniqueId !== fileUniqueId || item.mediaPath === mediaPath) continue;
			const updated = { ...item, mediaPath };
			this.items[index] = updated;
			const slot = this.cardSlots.get(this.itemKey(updated));
			if (!slot) continue;
			slot.clear();
			slot.addChild(itemComponent(updated, this.theme, this.mediaResolver, this.toolHost));
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
		this.streams.set(
			key,
			stream.phase === "start"
				? {
						...stream,
						phase: "update",
						activity: {
							version: 1,
							activityId: stream.streamId,
							startedAt: stream.ts,
							sections: [],
							truncated: false,
						},
					}
				: stream,
		);
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
			this.streamContent.addChild(streamComponent(stream, this.theme, this.toolHost));
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
	box.addChild(
		new Tui.Text(
			theme.fg(
				"dim",
				supported ? "detached · run /tg attach to reconnect" : `requires Pi >= ${MIN_PI_VERSION} · run bun run pi`,
			),
			0,
			0,
		),
	);
	return box;
}

export function registerTelegramExtension(pi: ExtensionAPI, options: TelegramExtensionOptions = {}): void {
	const rootDir = options.rootDir ?? process.cwd();
	const hostVersion = options.hostVersion ?? VERSION;
	const supported = supportsPiVersion(hostVersion);
	const factory =
		options.timelineFactory ??
		((filter, hooks) => new TimelineClient(join(rootDir, "data", "daemon.sock"), filter, hooks));
	const mediaCache = options.mediaCache ?? new NativeMediaCache();
	const runProcess = options.processRunner ?? runChildProcess;
	const makeId = options.idFactory ?? randomUUID;
	const makeRequestId = options.requestIdFactory ?? randomUUID;
	const feeds = new Map<string, TelegramFeed>();
	let pending: { data: FeedEntry; changed: (event: TimelineEvent, feed: TelegramFeed) => void } | null = null;
	let active: TelegramFeed | null = null;
	let compose: ComposeMode | null = null;
	let composeGeneration = 0;
	let sending = false;
	let lastUi: ExtensionContext["ui"] | null = null;
	let completionBots: TgBotChoice[] | undefined;
	let statusBots: StatusBot[] | undefined;
	let requestHostRender: (() => void) | null = null;
	let toolHost: ToolPresentationHost | undefined;
	let composeIndicator: TelegramComposeIndicator | null = null;
	const getCompletionBots = (): TgBotChoice[] => {
		if (completionBots) return completionBots;
		try {
			completionBots = loadConfig(rootDir).bots.map(({ id, name }) => ({ id, name }));
			return completionBots;
		} catch {
			return [];
		}
	};
	const getStatusBots = (): StatusBot[] => {
		if (statusBots) return statusBots;
		try {
			statusBots = loadConfig(rootDir).bots.map(
				({ id, name, provider, model, reasoningEffort, routingP, samplingCooldownMs }) => ({
					id,
					name,
					provider,
					model,
					reasoningEffort,
					routingP,
					samplingCooldownMs,
				}),
			);
			return statusBots;
		} catch {
			return [];
		}
	};

	const composeLabel = (bot: ComposeIdentity) => (bot.name === bot.id ? bot.id : `${bot.id} (${bot.name})`);
	const scopeIdentities = (): ComposeIdentity[] => {
		const identities = getCompletionBots();
		return active?.filter ? identities.filter((identity) => identity.id === active?.filter) : identities;
	};
	const setComposeIndicator = (value: TelegramComposeIndicator | null) => {
		if (composeIndicator?.text === value?.text && composeIndicator?.color === value?.color) return;
		composeIndicator = value;
		requestHostRender?.();
	};
	const showComposeIndicator = (
		ui: ExtensionContext["ui"],
		busy?: { kind: "choosing" } | { kind: "sending"; identity: ComposeIdentity },
	) => {
		ui.setStatus("telegram-compose", undefined);
		if (!compose) {
			setComposeIndicator(null);
			return;
		}
		if (busy?.kind === "choosing") {
			setComposeIndicator({ text: "choosing bot", color: "warning" });
			return;
		}
		if (busy?.kind === "sending") {
			setComposeIndicator({ text: `sending as ${composeLabel(busy.identity)}`, color: "warning" });
			return;
		}
		if (compose.kind === "bot") {
			setComposeIndicator({ text: `send as ${composeLabel(compose.identity)}`, color: "accent" });
			return;
		}
		const identities = scopeIdentities();
		if (identities.length === 1) {
			setComposeIndicator({ text: `send as ${composeLabel(identities[0]!)}`, color: "accent" });
		} else if (identities.length > 1) {
			setComposeIndicator({ text: "choose bot on send", color: "accent" });
		} else {
			setComposeIndicator({ text: "send unavailable", color: "error" });
		}
	};
	const closeCompose = (ui: ExtensionContext["ui"] | null = lastUi) => {
		composeGeneration++;
		compose = null;
		setComposeIndicator(null);
		if (ui) ui.setStatus("telegram-compose", undefined);
	};
	const openScopeCompose = (ui: ExtensionContext["ui"]) => {
		composeGeneration++;
		compose = { kind: "scope" };
		showComposeIndicator(ui);
	};
	const openBotCompose = (ui: ExtensionContext["ui"], identity: ComposeIdentity) => {
		composeGeneration++;
		compose = { kind: "bot", identity };
		showComposeIndicator(ui);
	};
	const clearFeedUi = (ui: ExtensionContext["ui"] | null = lastUi) => {
		requestHostRender = null;
		toolHost = undefined;
		ui?.setWidget(FEED_WIDGET_KEY, undefined);
		ui?.setFooter(undefined);
	};
	const mountFeedUi = (filter: string | null, ctx: ExtensionContext) => {
		const scope = filter ? `bot ${filter}` : "all bots";
		ctx.ui.setWidget(
			FEED_WIDGET_KEY,
			(tui, theme) => {
				requestHostRender = () => tui.requestRender();
				toolHost = { ui: tui, cwd: ctx.cwd };
				return {
					render: (width) => [telegramFeedHeaderLine(width, theme, scope, composeIndicator)],
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const dispose = footerData.onBranchChange(() => tui.requestRender());
			return {
				render(width) {
					const feed = active?.filter === filter ? active : null;
					return telegramFooterLines(width, theme, {
						cwd: ctx.sessionManager.getCwd(),
						home: process.env.HOME || process.env.USERPROFILE,
						branch: footerData.getGitBranch(),
						sessionName: ctx.sessionManager.getSessionName(),
						usage: feed ? telegramFooterUsage(filter, feed.stats, feed.statuses, getStatusBots(), ctx) : undefined,
						availableProviderCount: footerData.getAvailableProviderCount(),
						statuses: footerData.getExtensionStatuses(),
					});
				},
				invalidate() {},
				dispose,
			};
		});
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
			ui.notify(
				`unknown bot id "${arg}"; configured bots: ${bots.map((candidate) => candidate.id).join(", ") || "(none)"}`,
				"error",
			);
		} catch (error) {
			ui.notify(`config error: ${(error as Error).message}`, "error");
		}
		return undefined;
	};
	const attachFeed = (filter: string | null, ctx: ExtensionContext) => {
		closeCompose(ctx.ui);
		active?.detach("replaced by a new /tg attach");
		clearFeedUi(ctx.ui);
		mountFeedUi(filter, ctx);
		const data = { instanceId: makeId(), filter };
		pending = {
			data,
			changed: (event, feed) => {
				requestHostRender?.();
				if (event.type === "disconnected" && active === feed) {
					closeCompose(ctx.ui);
					clearFeedUi(ctx.ui);
					ctx.ui.notify(`Telegram feed disconnected: ${event.reason}`, "error");
				}
			},
		};
		pi.appendEntry<FeedEntry>(ENTRY_TYPE, data);
		if (pending) {
			pending = null;
			clearFeedUi(ctx.ui);
			ctx.ui.notify("Pi did not mount the Telegram transcript entry", "error");
		} else {
			openScopeCompose(ctx.ui);
		}
	};

	pi.registerEntryRenderer<FeedEntry>(ENTRY_TYPE, (entry, _renderOptions, theme) => {
		const data = entry.data as FeedEntry | undefined;
		if (!data) return new Tui.Text(theme.fg("error", "invalid Telegram feed entry"), 1, 0);
		const existing = feeds.get(data.instanceId);
		if (existing) return existing;
		if (!supported || pending?.data.instanceId !== data.instanceId) return detachedEntry(data, theme, supported);
		const feed = new TelegramFeed(
			data.filter,
			theme,
			factory,
			pending.changed,
			mediaCache,
			() => requestHostRender?.(),
			toolHost,
		);
		pending = null;
		feeds.set(data.instanceId, feed);
		active = feed;
		feed.start();
		return feed;
	});

	pi.on("session_shutdown", () => {
		closeCompose();
		clearFeedUi();
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

		const mode = compose;
		const generation = composeGeneration;
		const feed = active;
		sending = true;
		try {
			let identity: ComposeIdentity;
			if (mode.kind === "bot") {
				identity = mode.identity;
			} else {
				const identities = scopeIdentities();
				if (identities.length === 0) {
					ctx.ui.setEditorText(original);
					ctx.ui.notify("No configured bot matches the active Telegram feed", "error");
					closeCompose(ctx.ui);
					return { action: "handled" };
				}
				if (identities.length === 1) {
					identity = identities[0]!;
				} else {
					showComposeIndicator(ctx.ui, { kind: "choosing" });
					let selected: string | undefined;
					try {
						selected = await ctx.ui.select("Send Telegram message as", identities.map(composeLabel));
					} catch {
						ctx.ui.setEditorText(original);
						ctx.ui.notify("Telegram bot selection failed; the message was restored and was not sent", "error");
						return { action: "handled" };
					}
					if (composeGeneration !== generation || compose !== mode || active !== feed || !feed.client.isConnected) {
						ctx.ui.setEditorText(original);
						ctx.ui.notify("Telegram feed changed while choosing a bot; the message was not sent", "warning");
						return { action: "handled" };
					}
					if (selected === undefined) {
						ctx.ui.setEditorText(original);
						ctx.ui.notify("Telegram send canceled; the message was restored", "info");
						return { action: "handled" };
					}
					const selectedIndex = identities.map(composeLabel).indexOf(selected);
					if (selectedIndex < 0) {
						ctx.ui.setEditorText(original);
						ctx.ui.notify("Telegram bot selection was invalid; the message was not sent", "error");
						return { action: "handled" };
					}
					identity = identities[selectedIndex]!;
				}
			}
			if (composeGeneration !== generation || compose !== mode || active !== feed || !feed.client.isConnected) {
				ctx.ui.setEditorText(original);
				ctx.ui.notify("Telegram feed changed before sending; the message was not sent", "warning");
				return { action: "handled" };
			}
			showComposeIndicator(ctx.ui, { kind: "sending", identity });
			const result = await feed.client.sendText(identity.id, original, makeRequestId());
			if (result.ok) {
				ctx.ui.notify(`Telegram sent as ${composeLabel(identity)} · #${result.messageId}`, "info");
			} else {
				ctx.ui.setEditorText(original);
				if (result.code === "unknown_outcome") {
					ctx.ui.notify(
						"Telegram send result is unknown. Check the group before retrying to avoid a duplicate.",
						"warning",
					);
					if (composeGeneration === generation && compose === mode) closeCompose(ctx.ui);
				} else {
					ctx.ui.notify(`Telegram send failed (${result.code}): ${result.error}`, "error");
					if (result.code === "service_unavailable" && composeGeneration === generation && compose === mode)
						closeCompose(ctx.ui);
				}
			}
		} catch (error) {
			ctx.ui.setEditorText(original);
			ctx.ui.notify(`Telegram send result is unknown. Check the group before retrying: ${String(error)}`, "warning");
			if (composeGeneration === generation && compose === mode) closeCompose(ctx.ui);
		} finally {
			sending = false;
			if (composeGeneration === generation && compose === mode) showComposeIndicator(ctx.ui);
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
				ctx.ui.notify(
					`Telegram native UI requires Pi >= ${MIN_PI_VERSION}; host is ${hostVersion}. Run: bun run pi`,
					"error",
				);
				return;
			}
			if (ctx.mode !== "tui" && !daemonSub) {
				ctx.ui.notify("Telegram UI requires interactive mode", "error");
				return;
			}
			if (sub === "config") {
				ctx.ui.setStatus("telegram-config", "TELEGRAM · CONFIGURING");
				try {
					const result = await runNativeConfigWizard(ctx.ui, {
						rootDir,
						preflightPiModel: options.piModelPreflight,
						restartDaemon: async () => {
							closeCompose(ctx.ui);
							active?.detach("configuration changed; waiting for daemon readiness");
							active = null;
							clearFeedUi(ctx.ui);
							ctx.ui.setStatus("telegram-config", "TELEGRAM · RESTARTING");
							let processResult: ProcessRunResult;
							try {
								processResult = await runProcess("bun", ["run", "src/main.ts", "restart"], { cwd: rootDir });
							} catch {
								return { ready: false, diagnostic: "failed to run the controlled daemon restart" };
							}
							const diagnostic = redactDaemonLog(
								[processResult.stdout, processResult.stderr].filter(Boolean).join("\n"),
							);
							const ready = processResult.status === 0 && /(^|\n)daemon ready(?:\s|$)/.test(diagnostic);
							return { ready, ...(ready || !diagnostic ? {} : { diagnostic }) };
						},
					});
					if (result.outcome === "ready") {
						completionBots = undefined;
						statusBots = undefined;
						attachFeed(null, ctx);
					}
				} finally {
					ctx.ui.setStatus("telegram-config", undefined);
				}
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
				attachFeed(filter, ctx);
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
				if (!botArg) {
					openScopeCompose(ctx.ui);
					ctx.ui.notify(
						"Telegram compose follows the active feed scope. Run /tg compose off to return to Pi.",
						"warning",
					);
					return;
				}
				const bot = resolveBot(botArg, ctx.ui);
				if (!bot) return;
				const identity = { id: bot.id, name: bot.name };
				openBotCompose(ctx.ui, identity);
				ctx.ui.notify(
					`Telegram compose enabled: editor sends as ${composeLabel(identity)}. Run /tg compose off to return to Pi.`,
					"warning",
				);
			} else if (sub === "more") {
				if (!active) ctx.ui.notify("no live Telegram feed; run /tg attach first", "warning");
				else if (!active.more())
					ctx.ui.notify(
						active.client.hasMore ? "Telegram history request already in progress" : "oldest Telegram record reached",
						"info",
					);
			} else if (sub === "detach") {
				if (!active) ctx.ui.notify("no live Telegram feed", "warning");
				else {
					closeCompose(ctx.ui);
					active.detach();
					active = null;
					clearFeedUi(ctx.ui);
				}
			} else if (sub === "status") {
				const filter = resolveFilter(botArg);
				if (filter === undefined) return;
				const statusBots = getStatusBots();
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
								const text = Object.entries(event.stats)
									.map(([id, stats]) =>
										statsText(
											id,
											stats,
											statusBots.find((bot) => bot.id === id),
											event.statuses[id],
											ctx,
										),
									)
									.join("\n\n");
								finish(text || "no telemetry yet", "info");
							} else if (event.type === "disconnected") finish(event.reason, "error");
						},
					});
					void client.connect();
				});
			} else if (daemonSub) {
				const command = sub === "status-daemon" ? "status" : sub;
				const restartFeed = sub === "restart" && ctx.mode === "tui" ? active : null;
				if (sub === "restart" && ctx.mode === "tui") {
					closeCompose(ctx.ui);
					restartFeed?.suspendForRestart();
					clearFeedUi(ctx.ui);
					ctx.ui.setStatus("telegram-daemon", "TELEGRAM · RESTARTING");
					ctx.ui.notify("Restarting every configured Telegram bot...", "info");
				}
				let result: ProcessRunResult;
				try {
					result = await runProcess("bun", ["run", "src/main.ts", command], { cwd: rootDir });
				} catch (error) {
					result = { status: null, stdout: "", stderr: `failed to run daemon command: ${String(error)}` };
				}
				let output = redactDaemonLog([result.stdout, result.stderr].filter(Boolean).join("\n")) || `daemon ${command}`;
				let level: "info" | "error" = result.status === 0 ? "info" : "error";
				if (sub === "restart" && result.status === 0 && output.includes("daemon ready")) {
					if (restartFeed) {
						mountFeedUi(restartFeed.filter, ctx);
						const connected = await restartFeed.reconnect();
						if (!connected) {
							clearFeedUi(ctx.ui);
							output += "\ndaemon is ready, but the previous feed could not reconnect; run /tg attach again";
							level = "error";
						}
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
