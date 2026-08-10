import type { Database } from "bun:sqlite";
import type { BotStats, UsageRun } from "../ipc.ts";

/** One bot's retention-window totals plus its latest main-conversation provider response. */
export function loadBotStats(db: Database, botId: string): BotStats {
	const aggregate = db
		.query(
			`SELECT COUNT(*) runs,
			        COALESCE(SUM(context_tokens), 0) contextTokens,
			        COALESCE(SUM(COALESCE(cache_read_estimated, cache_read)), 0) cacheRead,
			        COALESCE(SUM(cache_write), 0) cacheWrite,
			        COALESCE(SUM(CASE WHEN cache_read_estimated IS NOT NULL
			                          THEN context_tokens - cache_read_estimated - cache_write
			                          ELSE cache_miss END), 0) cacheMiss,
			        COUNT(cache_read_estimated) estimatedCacheRuns,
			        COALESCE(SUM(output_tokens), 0) outputTokens,
			        COALESCE(SUM(reasoning_tokens), 0) reasoningTokens,
			        COALESCE(SUM(latency_ms), 0) totalLatencyMs,
			        COUNT(latency_ms) latencySamples,
			        MIN(ts) firstRunTs,
			        COALESCE(SUM(cost), 0) cost,
			        COALESCE(MAX(epoch), 0) epoch
			   FROM llm_runs WHERE bot_id = ?`,
		)
		.get(botId) as Omit<BotStats, "last">;
	const lastRow = db
		.query(
			`SELECT id, bot_id botId, ts, model, epoch, context_tokens contextTokens,
			        COALESCE(cache_read_estimated, cache_read) cacheRead, cache_write cacheWrite,
			        CASE WHEN cache_read_estimated IS NOT NULL
			             THEN context_tokens - cache_read_estimated - cache_write
			             ELSE cache_miss END cacheMiss,
			        cache_read_estimated IS NOT NULL cacheEstimated,
			        output_tokens outputTokens, reasoning_tokens reasoningTokens,
			        latency_ms latencyMs, cost
			   FROM llm_runs
			  WHERE bot_id = ? AND compaction = 0
			  ORDER BY ts DESC, id DESC LIMIT 1`,
		)
		.get(botId) as (Omit<UsageRun, "cacheEstimated"> & { cacheEstimated: number }) | null;
	const last = lastRow ? { ...lastRow, cacheEstimated: lastRow.cacheEstimated === 1 } : null;
	return { ...aggregate, last };
}
