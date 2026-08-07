// Context window threshold analysis (docs/cache.md, docs/requirement.md 五十七).
// Reads real telemetry from llm_runs and simulates candidate compaction thresholds.
// Model: replay each bot's context growth; when simulated context exceeds T, a compaction
// resets context to EPOCH_BASE and adds a one-time rebuild miss + summary call cost.
// This is an estimate — output is for threshold selection, not accounting.
//
// Usage: bun run scripts/analyze-context-window.ts [db-path]

import { openDb } from "../src/db/db.ts";

const dbPath = process.argv[2] ?? "data/agent.db";
const db = openDb(dbPath);

// deepseek-v4-flash prices ($/M tokens); move to config when adding models
const PRICE = { input: 0.14, cacheRead: 0.0028, output: 0.28 };
const EPOCH_BASE = 16_000; // post-compaction context: base + summary (tokens)
const SUMMARY_COST = { input: 10_000, output: 800 }; // estimated summary call

const runs = db
	.query("SELECT bot_id, ts, context_tokens, cache_read, cache_miss, output_tokens FROM llm_runs ORDER BY ts")
	.all() as { bot_id: string; ts: number; context_tokens: number; cache_read: number; cache_miss: number; output_tokens: number }[];

if (runs.length === 0) {
	console.log("no telemetry yet");
	process.exit(0);
}

const byBot = new Map<string, typeof runs>();
for (const r of runs) {
	if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
	byBot.get(r.bot_id)!.push(r);
}

const CANDIDATES = [64_000, 96_000, 128_000, 160_000, 192_000, 256_000];

interface SimResult {
	threshold: number;
	compactions: number;
	avgMiss: number;
	avgRead: number;
	costPerTurn: number;
	turnsBetweenCompactions: number;
}

function simulate(threshold: number): SimResult {
	let compactions = 0;
	let totalMiss = 0;
	let totalRead = 0;
	let totalOutput = 0;
	let totalTurns = 0;
	for (const [, botRuns] of byBot) {
		let context = botRuns[0]?.context_tokens ?? EPOCH_BASE;
		for (let i = 0; i < botRuns.length; i++) {
			const r = botRuns[i];
			const growth = i === 0 ? 0 : Math.max(0, r.context_tokens - botRuns[i - 1].context_tokens);
			context += growth;
			if (context > threshold) {
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
		avgMiss: Math.round(totalMiss / Math.max(1, totalTurns)),
		avgRead: Math.round(totalRead / Math.max(1, totalTurns)),
		costPerTurn,
		turnsBetweenCompactions: compactions === 0 ? Infinity : Math.round(totalTurns / compactions),
	};
}

console.log(`telemetry: ${runs.length} runs, bots: ${[...byBot.keys()].join(", ")}`);
console.log(`prices ($/M): input=${PRICE.input} cacheRead=${PRICE.cacheRead} output=${PRICE.output}; epoch base=${EPOCH_BASE}`);
console.log("");
console.log(
	"threshold".padEnd(10),
	"compactions".padEnd(12),
	"interval".padEnd(10),
	"miss/turn".padEnd(10),
	"read/turn".padEnd(10),
	"$/turn",
);
for (const t of CANDIDATES) {
	const r = simulate(t);
	console.log(
		String(r.threshold / 1000 + "K").padEnd(10),
		String(r.compactions).padEnd(12),
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
