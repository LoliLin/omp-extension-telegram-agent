// Context window threshold analysis (docs/cache.md, docs/requirement.md 五十七).
// Reads real telemetry from llm_runs and simulates candidate compaction thresholds.
// Model: replay each bot's context growth; when simulated context exceeds T, a compaction
// resets context to EPOCH_BASE and adds a one-time rebuild miss + summary call cost.
//
// Real compactions are honored (REQ-TEST-0001 R5): when telemetry shows an epoch change or
// a compaction flag, the simulated context is synced to the real post-compaction size
// instead of blindly accumulating — otherwise real resets are read as "0 growth" and the
// next threshold crossing is a phantom compaction that overcounts cost.
// Output annotates intervals containing real compactions.
//
// Usage: bun run scripts/analyze-context-window.ts [db-path]

import type { Database } from "bun:sqlite";
import { openDb } from "../src/db/db.ts";

// deepseek-v4-flash prices ($/M tokens); move to config when adding models
const PRICE = { input: 0.14, cacheRead: 0.0028, output: 0.28 };
const EPOCH_BASE = 16_000; // post-compaction context: base + summary (tokens)
const SUMMARY_COST = { input: 10_000, output: 800 }; // estimated summary call

export interface RunRow {
	bot_id: string;
	ts: number;
	context_tokens: number;
	cache_read: number;
	cache_miss: number;
	output_tokens: number;
	epoch: number;
	compaction: number;
}

export function loadRuns(db: Database): RunRow[] {
	return db
		.query(
			"SELECT bot_id, ts, context_tokens, cache_read, cache_miss, output_tokens, epoch, compaction FROM llm_runs ORDER BY ts",
		)
		.all() as RunRow[];
}

export const CANDIDATES = [64_000, 96_000, 128_000, 160_000, 192_000, 256_000];

export interface SimResult {
	threshold: number;
	compactions: number;
	realCompactions: number;
	avgMiss: number;
	avgRead: number;
	costPerTurn: number;
	turnsBetweenCompactions: number;
}

/**
 * Simulate one candidate threshold across all bots' run traces. When a run carries a real
 * compaction (compaction flag set, epoch changed vs the previous run, or a context drop
 * from a session restart) the simulated context is synced to that run's real context_tokens
 * and no simulated compaction is counted for it — the telemetry already reflects the reset.
 * Without the sync, the pre-reset peak lingers in the simulation and crossing a candidate
 * threshold shortly after a real reset counts a phantom rebuild + summary cost.
 */
export function simulate(threshold: number, byBot: Map<string, RunRow[]>): SimResult {
	let compactions = 0;
	let realCompactions = 0;
	let totalMiss = 0;
	let totalRead = 0;
	let totalOutput = 0;
	let totalTurns = 0;
	for (const [, botRuns] of byBot) {
		let context = botRuns[0]?.context_tokens ?? EPOCH_BASE;
		for (let i = 0; i < botRuns.length; i++) {
			const r = botRuns[i];
			const prev = i > 0 ? botRuns[i - 1] : null;
			// flag / epoch bump / >30% context fall (restart without telemetry markers)
			const realReset =
				i > 0 &&
				prev != null &&
				(r.compaction === 1 || r.epoch !== prev.epoch || r.context_tokens < prev.context_tokens * 0.7);
			if (realReset) {
				// telemetry shows the provider context actually reset: sync, don't simulate
				context = r.context_tokens;
				realCompactions++;
			} else {
				const growth = i === 0 ? 0 : Math.max(0, r.context_tokens - (prev?.context_tokens ?? 0));
				context += growth;
			}
			if (context > threshold && !realReset) {
				compactions++;
				totalMiss += EPOCH_BASE; // full prefix rebuild after compaction
				totalMiss += SUMMARY_COST.input;
				totalOutput += SUMMARY_COST.output;
				context = EPOCH_BASE;
			}
			totalMiss += r.cache_miss;
			totalRead += r.cache_read;
			totalOutput += r.output_tokens;
			totalTurns++;
		}
	}
	const costPerTurn =
		(totalMiss * PRICE.input + totalRead * PRICE.cacheRead + totalOutput * PRICE.output) / 1_000_000 / Math.max(1, totalTurns);
	return {
		threshold,
		compactions,
		realCompactions,
		avgMiss: Math.round(totalMiss / Math.max(1, totalTurns)),
		avgRead: Math.round(totalRead / Math.max(1, totalTurns)),
		costPerTurn,
		turnsBetweenCompactions: compactions === 0 ? Infinity : Math.round(totalTurns / compactions),
	};
}

export function main(dbPath: string): void {
	const db = openDb(dbPath);
	const runs = loadRuns(db);

	if (runs.length === 0) {
		console.log("no telemetry yet");
		db.close();
		return;
	}

	const byBot = new Map<string, RunRow[]>();
	for (const r of runs) {
		if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
		byBot.get(r.bot_id)!.push(r);
	}

	console.log(`telemetry: ${runs.length} runs, bots: ${[...byBot.keys()].join(", ")}`);
	console.log(`prices ($/M): input=${PRICE.input} cacheRead=${PRICE.cacheRead} output=${PRICE.output}; epoch base=${EPOCH_BASE}`);
	// annotate intervals with real compactions (REQ-TEST-0001 R5)
	for (const [botId, botRuns] of byBot) {
		const resets = botRuns
			.map((r, i) => (i > 0 && (r.compaction === 1 || r.epoch !== botRuns[i - 1]!.epoch) ? i : -1))
			.filter((i) => i >= 0);
		if (resets.length > 0) {
			console.log(`  real compactions for ${botId} at run indexes: ${resets.join(", ")} (epochs: ${botRuns.map((r) => r.epoch).join("→")})`);
		}
	}
	console.log("");
	console.log(
		"threshold".padEnd(10),
		"simulated".padEnd(10),
		"real".padEnd(6),
		"interval".padEnd(10),
		"miss/turn".padEnd(10),
		"read/turn".padEnd(10),
		"$/turn",
	);
	for (const t of CANDIDATES) {
		const r = simulate(t, byBot);
		console.log(
			String(t / 1000 + "K").padEnd(10),
			String(r.compactions).padEnd(10),
			String(r.realCompactions).padEnd(6),
			(r.turnsBetweenCompactions === Infinity ? "never" : String(r.turnsBetweenCompactions)).padEnd(10),
			String(r.avgMiss).padEnd(10),
			String(r.avgRead).padEnd(10),
			r.costPerTurn.toFixed(6),
		);
	}

	// observed cache behavior so far
	const totalRead = runs.reduce((s, r) => s + r.cache_read, 0);
	const totalMiss = runs.reduce((s, r) => s + r.cache_miss, 0);
	console.log("");
	console.log(`observed: read=${totalRead} miss=${totalMiss} hit ratio=${(totalRead / Math.max(1, totalRead + totalMiss) * 100).toFixed(1)}%`);
	db.close();
}

if (import.meta.main) {
	main(process.argv[2] ?? "data/agent.db");
}
