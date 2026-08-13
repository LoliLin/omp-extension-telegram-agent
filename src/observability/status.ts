import type { BotStats, RuntimeControlSnapshot } from "../ipc.ts";
import { summarizeBotUsage, type BotUsageSummary } from "./usage.ts";
import { fitContextBreakdown, type ContextBreakdown } from "./usage.ts";

const INTEGER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COST_FORMAT = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 4,
	maximumFractionDigits: 6,
});

/** Stable USD estimate formatting shared by Telegram status, Pi status, and the attached footer. */
export function formatUsdCost(value: number): string {
	return COST_FORMAT.format(value);
}

export interface BotStatusIdentity {
	id: string;
	name: string;
	provider: string;
	model: string;
	reasoningEffort: string;
	routingP: number;
	samplingCooldownMs: number;
}

export interface BotStatusView {
	id: string;
	name: string;
	state: RuntimeControlSnapshot["state"] | "unavailable";
	provider: string;
	model: string;
	reasoningEffort: string;
	epoch: number | null;
	routingP: number;
	samplingCooldownMs: number;
	lastCompact: RuntimeControlSnapshot["lastCompact"];
	stats: BotStats;
	usage: BotUsageSummary;
}

export const BOT_STATUS_FIELD_KEYS = [
	"state",
	"model",
	"context_current",
	"context_breakdown",
	"speed",
	"latest_request",
	"latest_usage",
	"lifetime",
	"lifetime_usage",
	"cache_and_cost",
	"routing",
	"last_compact",
] as const;

export type BotStatusFieldKey = (typeof BOT_STATUS_FIELD_KEYS)[number];

export interface BotStatusField {
	key: BotStatusFieldKey;
	label: string;
	value: string;
}

export function buildBotStatusView(
	bot: BotStatusIdentity,
	stats: BotStats,
	runtime: RuntimeControlSnapshot | undefined,
	contextWindowFallback = 0,
): BotStatusView {
	return {
		id: bot.id,
		name: bot.name,
		state: runtime?.state ?? "unavailable",
		provider: runtime?.provider ?? bot.provider,
		model: runtime?.model ?? bot.model,
		reasoningEffort: runtime?.reasoningEffort ?? bot.reasoningEffort,
		epoch: runtime?.epoch ?? stats.last?.epoch ?? (stats.runs > 0 ? stats.epoch : null),
		routingP: runtime?.routingP ?? bot.routingP,
		samplingCooldownMs: runtime?.samplingCooldownMs ?? bot.samplingCooldownMs,
		lastCompact: runtime?.lastCompact ?? null,
		stats,
		usage: summarizeBotUsage(stats, runtime?.contextWindow ?? contextWindowFallback, runtime?.currentContextTokens),
	};
}

export function botStatusFields(view: BotStatusView, visual = false): BotStatusField[] {
	const last = view.stats.last;
	const latestApprox = last?.cacheEstimated ? "≈" : "";
	const lifetimeApprox = view.usage.cacheEstimated ? "≈" : "";
	const fields: Record<BotStatusFieldKey, Omit<BotStatusField, "key">> = {
		state: { label: "状态", value: `${statusIcon(view.state)} ${statusLabel(view.state)}` },
		model: {
			label: "模型",
			value: `${view.provider}/${view.model} · reasoning ${view.reasoningEffort} · epoch ${view.epoch == null ? "—" : integer(view.epoch)}`,
		},
		context_current: { label: "当前上下文", value: formatContext(view.usage.context) },
		context_breakdown: { label: "上下文构成", value: formatContextBreakdown(view, visual) },
		speed: {
			label: "平均速度",
			value: `${rate(view.usage.averageTokensPerSecond)} tok/s · send ${duration(view.usage.averageSendMs)} · think ${duration(view.usage.averageThinkingMs)}`,
		},
		latest_request: {
			label: "最近请求",
			value: last ? `${time(last.ts)} · ${duration(last.latencyMs)} · $${formatUsdCost(last.cost)}` : "—",
		},
		latest_usage: {
			label: "最近用量",
			value: last
				? `↑miss ${latestApprox}${integer(last.cacheMiss)} · ↓output ${integer(last.outputTokens)} · R ${latestApprox}${integer(last.cacheRead)} · W ${integer(last.cacheWrite ?? 0)} · reasoning ${integer(last.reasoningTokens ?? 0)}`
				: "—",
		},
		lifetime: {
			label: "保留期",
			value: `${integer(view.stats.runs)} runs · since ${time(view.stats.firstRunTs)} · avg ${duration(view.usage.averageLatencyMs)}`,
		},
		lifetime_usage: {
			label: "累计用量",
			value: `prompt ${integer(view.stats.contextTokens)} · ↑miss ${lifetimeApprox}${integer(view.stats.cacheMiss)} · ↓output ${integer(view.stats.outputTokens)} · R ${lifetimeApprox}${integer(view.stats.cacheRead)} · W ${integer(view.usage.cacheWrite)} · reasoning ${integer(view.usage.reasoningTokens)}`,
		},
		cache_and_cost: {
			label: "缓存与费用",
			value: `CH ${lifetimeApprox}${percent(view.usage.cacheHitPercent)} · $${formatUsdCost(view.stats.cost)}`,
		},
		routing: {
			label: "路由",
			value: `routing ${view.routingP} · cooldown ${integer(view.samplingCooldownMs)} ms`,
		},
		last_compact: {
			label: "最近压缩",
			value: view.lastCompact ? `${view.lastCompact.outcome} · ${time(view.lastCompact.at)}` : "—",
		},
	};
	return BOT_STATUS_FIELD_KEYS.map((key) => ({ key, ...fields[key] }));
}

function rate(value: number | null): string {
	return value == null ? "—" : value.toFixed(1);
}

function formatContextBreakdown(view: BotStatusView, visual: boolean): string {
	const breakdown = currentContextBreakdown(view);
	const window = view.usage.context.contextWindow;
	if (!breakdown || window <= 0) return "—";
	const parts = [
		["S", "🟥", "system prompt", breakdown.system],
		["T", "🟪", "tool desc", breakdown.tools],
		["C", "🟫", "compacted history", breakdown.compactedHistory],
		["M", "🟦", "message", breakdown.messages],
		[
			"F",
			"🟩",
			"free",
			Math.max(0, window - breakdown.system - breakdown.tools - breakdown.compactedHistory - breakdown.messages),
		],
	] as const;
	const values = parts.map(([short, square, label, tokens]) => ({
		short,
		square,
		label,
		tokens,
		percentage: `${((tokens / window) * 100).toFixed(1)}%`,
	}));
	if (!visual) return values.map(({ short, percentage }) => `${short} ${percentage}`).join(" · ");
	const bar = values.map(({ square, tokens }) => square.repeat(Math.round(tokens / 1024))).join("");
	// Monospace legend: one entry per line, label column padded so percentages align in the
	// Telegram pre block. Emoji squares are double-width but every line starts with exactly one.
	return [
		bar,
		...values.map(({ square, label, percentage }) => `${square} ${label.padEnd(17)} ${percentage.padStart(6)}`),
	].join("\n");
}

function currentContextBreakdown(view: BotStatusView): ContextBreakdown | null {
	const last = view.stats.last;
	const currentTokens = view.usage.context.tokens;
	if (!last?.contextBreakdown || last.epoch !== view.epoch || currentTokens == null) return null;
	if (currentTokens >= last.contextTokens) {
		return {
			...last.contextBreakdown,
			messages: last.contextBreakdown.messages + currentTokens - last.contextTokens,
		};
	}
	return fitContextBreakdown(last.contextBreakdown, currentTokens);
}

export function renderBotStatusPlain(view: BotStatusView): string {
	return [`${view.id} · ${view.name}`, ...botStatusFields(view).map((field) => `${field.key}=${field.value}`)].join(
		"\n",
	);
}

function integer(value: number): string {
	return INTEGER_FORMAT.format(value);
}

function percent(value: number | null): string {
	return value == null ? "—" : `${value.toFixed(1)}%`;
}

function duration(value: number | null | undefined): string {
	if (value == null) return "—";
	if (value < 1000) return `${integer(value)} ms`;
	if (value < 10_000) return `${(value / 1000).toFixed(2)} s`;
	return `${(value / 1000).toFixed(1)} s`;
}

function time(value: number | null | undefined): string {
	return value == null ? "—" : new Date(value).toISOString();
}

function formatContext(context: BotUsageSummary["context"]): string {
	const tokens = context.tokens == null ? "—" : integer(context.tokens);
	const window = context.contextWindow > 0 ? integer(context.contextWindow) : "—";
	return `${tokens} / ${window} (${percent(context.percent)})`;
}

function statusIcon(state: BotStatusView["state"]): string {
	if (state === "idle") return "🟢";
	if (state === "cooldown") return "🟡";
	if (state === "stopping" || state === "unavailable") return "🔴";
	return "🔵";
}

function statusLabel(state: BotStatusView["state"]): string {
	if (state === "idle") return "空闲";
	if (state === "busy") return "生成中";
	if (state === "cooldown") return "冷却中";
	if (state === "compacting") return "压缩中";
	if (state === "stopping") return "停止中";
	return "不可用";
}
