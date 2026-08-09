import type { BotStats, UsageRun } from "../ipc.ts";

export interface UsageContextSummary {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BotUsageSummary {
	cacheWrite: number;
	reasoningTokens: number;
	cacheHitPercent: number | null;
	averageLatencyMs: number | null;
	context: UsageContextSummary;
}

export function summarizeUsageContext(last: UsageRun | null, contextWindow: number): UsageContextSummary {
	const normalizedWindow = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0;
	const tokens = last?.contextTokens ?? null;
	return {
		tokens,
		contextWindow: normalizedWindow,
		percent: tokens != null && normalizedWindow > 0 ? (tokens / normalizedWindow) * 100 : null,
	};
}

/** Shared derived values for Pi and Telegram status. */
export function summarizeBotUsage(stats: BotStats, contextWindow: number): BotUsageSummary {
	const cacheWrite = stats.cacheWrite ?? 0;
	const cacheDenominator = stats.cacheMiss + stats.cacheRead + cacheWrite;
	const hasCacheSample = stats.cacheRead > 0 || cacheWrite > 0;
	return {
		cacheWrite,
		reasoningTokens: stats.reasoningTokens ?? 0,
		cacheHitPercent: hasCacheSample && cacheDenominator > 0 ? (stats.cacheRead / cacheDenominator) * 100 : null,
		averageLatencyMs:
			(stats.latencySamples ?? 0) > 0 ? (stats.totalLatencyMs ?? 0) / (stats.latencySamples ?? 1) : null,
		context: summarizeUsageContext(stats.last, contextWindow),
	};
}
