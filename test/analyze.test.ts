// REQ-TEST-0001 R5/AC5: the analysis script honors REAL compactions from telemetry instead of
// counting phantom ones. Synthetic data: a bot whose context crosses a 64K candidate threshold
// but whose telemetry shows a real compaction (epoch bump + reset) before the crossing —
// the old script read the reset as "0 growth" and counted a phantom compaction.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRuns, simulate } from "../scripts/analyze-context-window.ts";

function makeDb(runs: unknown[]): Database {
	const db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	const ins = db.prepare(
		`INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, compaction)
		 VALUES (?, ?, 'test-model', ?, ?, ?, ?, ?, ?)`,
	);
	for (const r of runs as { bot_id: string; ts: number; epoch: number; context_tokens: number; compaction: number }[]) {
		ins.run(r.bot_id, r.ts, r.epoch, r.context_tokens, 1000, 100, 50, r.compaction);
	}
	return db;
}

describe("analyze-context-window real-compaction sync (R5)", () => {
	function byBotOf(db: Database): Map<string, ReturnType<typeof loadRuns>> {
		const byBot = new Map<string, ReturnType<typeof loadRuns>>();
		for (const r of loadRuns(db)) {
			if (!byBot.has(r.bot_id)) byBot.set(r.bot_id, []);
			byBot.get(r.bot_id)!.push(r);
		}
		return byBot;
	}

	test("AC5: no phantom compaction when telemetry shows a real epoch reset before the crossing", () => {
		// epoch 1 grows to a 60K peak (below the 70K candidate); a real compaction resets to
		// 16K and post-reset runs stay below the candidate. Without sync, the stale 60K peak
		// plus post-reset growth crosses 70K at the 30K run -> phantom rebuild + summary cost.
		const runs = [
			{ bot_id: "A", ts: 1, epoch: 1, context_tokens: 10_000, compaction: 0 },
			{ bot_id: "A", ts: 2, epoch: 1, context_tokens: 20_000, compaction: 0 },
			{ bot_id: "A", ts: 3, epoch: 1, context_tokens: 30_000, compaction: 0 },
			{ bot_id: "A", ts: 4, epoch: 1, context_tokens: 40_000, compaction: 0 },
			{ bot_id: "A", ts: 5, epoch: 1, context_tokens: 50_000, compaction: 0 },
			{ bot_id: "A", ts: 6, epoch: 1, context_tokens: 60_000, compaction: 0 },
			// real compaction between run 6 and 7
			{ bot_id: "A", ts: 7, epoch: 2, context_tokens: 16_000, compaction: 1 },
			{ bot_id: "A", ts: 8, epoch: 2, context_tokens: 30_000, compaction: 0 },
			{ bot_id: "A", ts: 9, epoch: 2, context_tokens: 40_000, compaction: 0 },
		];
		const db = makeDb(runs);
		const res = simulate(70_000, byBotOf(db));
		expect(res.realCompactions).toBe(1);
		expect(res.compactions).toBe(0); // no phantom: synced context never crosses 70K
	});

	test("AC5: compaction flag without epoch bump also syncs", () => {
		const runs = [
			{ bot_id: "A", ts: 1, epoch: 1, context_tokens: 10_000, compaction: 0 },
			{ bot_id: "A", ts: 2, epoch: 1, context_tokens: 40_000, compaction: 0 },
			{ bot_id: "A", ts: 3, epoch: 1, context_tokens: 60_000, compaction: 0 },
			{ bot_id: "A", ts: 4, epoch: 1, context_tokens: 16_000, compaction: 1 }, // reset, same epoch
			{ bot_id: "A", ts: 5, epoch: 1, context_tokens: 30_000, compaction: 0 },
			{ bot_id: "A", ts: 6, epoch: 1, context_tokens: 40_000, compaction: 0 },
		];
		const db = makeDb(runs);
		const res = simulate(70_000, byBotOf(db));
		expect(res.realCompactions).toBe(1);
		expect(res.compactions).toBe(0);
	});

	test("AC5: context drop without flag/epoch change (restart) is treated as a real reset", () => {
		const runs = [
			{ bot_id: "A", ts: 1, epoch: 1, context_tokens: 10_000, compaction: 0 },
			{ bot_id: "A", ts: 2, epoch: 1, context_tokens: 40_000, compaction: 0 },
			{ bot_id: "A", ts: 3, epoch: 1, context_tokens: 80_000, compaction: 0 },
			// session restart: context fell from 80K to 5K with no telemetry markers
			{ bot_id: "A", ts: 4, epoch: 1, context_tokens: 5_000, compaction: 0 },
			{ bot_id: "A", ts: 5, epoch: 1, context_tokens: 6_000, compaction: 0 },
			{ bot_id: "A", ts: 6, epoch: 1, context_tokens: 10_000, compaction: 0 },
		];
		const db = makeDb(runs);
		const res = simulate(85_000, byBotOf(db));
		expect(res.realCompactions).toBe(1);
		expect(res.compactions).toBe(0); // stale 80K peak would have crossed 85K at the 10K run
	});

	test("simulated compactions still fire when no real reset exists", () => {
		const runs = [
			{ bot_id: "A", ts: 1, epoch: 1, context_tokens: 10_000, compaction: 0 },
			{ bot_id: "A", ts: 2, epoch: 1, context_tokens: 30_000, compaction: 0 },
			{ bot_id: "A", ts: 3, epoch: 1, context_tokens: 60_000, compaction: 0 },
			{ bot_id: "A", ts: 4, epoch: 1, context_tokens: 90_000, compaction: 0 },
			{ bot_id: "A", ts: 5, epoch: 1, context_tokens: 120_000, compaction: 0 },
		];
		const db = makeDb(runs);
		const res = simulate(64_000, byBotOf(db));
		expect(res.compactions).toBeGreaterThanOrEqual(1); // 90K and 120K cross 64K
	});
});
