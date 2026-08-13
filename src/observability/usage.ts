import type { BotStats, UsageRun } from "../ipc.ts";

export interface ContextBreakdown {
	system: number;
	tools: number;
	compactedHistory: number;
	messages: number;
}

/** Scale adapter-shape estimates to the provider's authoritative total token count. */
export function fitContextBreakdown(estimate: ContextBreakdown, total: number): ContextBreakdown {
	const keys = ["system", "tools", "compactedHistory", "messages"] as const;
	const estimateTotal = keys.reduce((sum, key) => sum + Math.max(0, estimate[key]), 0);
	if (estimateTotal === 0 || total <= 0) return { system: 0, tools: 0, compactedHistory: 0, messages: total };
	const exact = keys.map((key) => ({ key, value: (Math.max(0, estimate[key]) * total) / estimateTotal }));
	const result: ContextBreakdown = { system: 0, tools: 0, compactedHistory: 0, messages: 0 };
	for (const item of exact) result[item.key] = Math.floor(item.value);
	let remainder = total - keys.reduce((sum, key) => sum + result[key], 0);
	for (const item of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
		if (remainder-- <= 0) break;
		result[item.key]++;
	}
	return result;
}

export interface UsageContextSummary {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BotUsageSummary {
	cacheWrite: number;
	reasoningTokens: number;
	cacheHitPercent: number | null;
	cacheEstimated: boolean;
	averageLatencyMs: number | null;
	averageThinkingMs: number | null;
	averageSendMs: number | null;
	averageTokensPerSecond: number | null;
	context: UsageContextSummary;
}

export function summarizeUsageContext(
	last: UsageRun | null,
	contextWindow: number,
	currentTokens?: number | null,
): UsageContextSummary {
	const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
	const tokens = currentTokens === undefined ? (last?.contextTokens ?? null) : currentTokens;
	return {
		tokens,
		contextWindow: normalizedWindow,
		percent: tokens != null && normalizedWindow > 0 ? (tokens / normalizedWindow) * 100 : null,
	};
}

/** Shared derived values for Pi and Telegram status. */
export function summarizeBotUsage(
	stats: BotStats,
	contextWindow: number,
	currentContextTokens?: number | null,
): BotUsageSummary {
	const cacheWrite = stats.cacheWrite ?? 0;
	const cacheDenominator = stats.cacheMiss + stats.cacheRead + cacheWrite;
	const hasCacheSample = stats.cacheRead > 0 || cacheWrite > 0;
	return {
		cacheWrite,
		cacheEstimated: (stats.estimatedCacheRuns ?? 0) > 0,
		reasoningTokens: stats.reasoningTokens ?? 0,
		cacheHitPercent: hasCacheSample && cacheDenominator > 0 ? (stats.cacheRead / cacheDenominator) * 100 : null,
		averageLatencyMs:
			(stats.latencySamples ?? 0) > 0 ? (stats.totalLatencyMs ?? 0) / (stats.latencySamples ?? 1) : null,
		averageThinkingMs:
			(stats.thinkingSamples ?? 0) > 0 ? (stats.totalThinkingMs ?? 0) / (stats.thinkingSamples ?? 1) : null,
		averageSendMs: (stats.sendSamples ?? 0) > 0 ? (stats.totalSendMs ?? 0) / (stats.sendSamples ?? 1) : null,
		averageTokensPerSecond:
			(stats.totalLatencyMs ?? 0) > 0
				? ((stats.speedOutputTokens ?? stats.outputTokens) * 1000) / (stats.totalLatencyMs ?? 1)
				: null,
		context: summarizeUsageContext(stats.last, contextWindow, currentContextTokens),
	};
}
