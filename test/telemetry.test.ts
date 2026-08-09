process.env.TZ = "Asia/Singapore";

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsText } from "../.pi/extensions/tg-extension.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { openDb } from "../src/db/db.ts";
import { loadBotStats } from "../src/db/usage.ts";
import type { BotStats, UsageRun } from "../src/ipc.ts";
import { summarizeBotUsage } from "../src/observability/usage.ts";
import { TimelineClient, type TimelineEvent } from "../src/plugin/timeline.ts";

const directories = new Set<string>();

afterEach(() => {
	for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	directories.clear();
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "tg-telemetry-"));
	directories.add(directory);
	return directory;
}

function insertRun(
	db: Database,
	input: {
		ts: number;
		model: string;
		context: number;
		read: number;
		write: number;
		miss: number;
		output: number;
		reasoning: number;
		latency: number | null;
		cost: number;
		compaction: boolean;
	},
): number {
	const result = db
		.query(
			`INSERT INTO llm_runs
			 (bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			  output_tokens, reasoning_tokens, latency_ms, cost, compaction)
			 VALUES ('A', ?, ?, 3, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.ts,
			input.model,
			input.context,
			input.read,
			input.write,
			input.miss,
			input.output,
			input.reasoning,
			input.latency,
			input.cost,
			input.compaction ? 1 : 0,
		);
	return Number(result.lastInsertRowid);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), 1_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe("unified usage telemetry", () => {
	test("separates latest conversation context from retention totals", () => {
		const db = openDb(":memory:");
		try {
			const mainId = insertRun(db, {
				ts: 1_786_251_069_000,
				model: "chat-model",
				context: 1_000,
				read: 700,
				write: 50,
				miss: 250,
				output: 120,
				reasoning: 30,
				latency: 1_250,
				cost: 0.125,
				compaction: false,
			});
			insertRun(db, {
				ts: 1_786_251_070_000,
				model: "compact-model",
				context: 500,
				read: 0,
				write: 0,
				miss: 500,
				output: 50,
				reasoning: 0,
				latency: null,
				cost: 0.025,
				compaction: true,
			});

			const stats = loadBotStats(db, "A");
			const summary = summarizeBotUsage(stats, 128_000);
			const piStatus = statsText(
				"A",
				stats,
				{ id: "A", provider: "test", model: "chat-model", reasoningEffort: "medium" },
				{
					modelRegistry: {
						getAvailable: () => [
							{
								provider: "test",
								id: "chat-model",
								contextWindow: 128_000,
								reasoning: true,
							},
						],
					},
					model: undefined,
					thinkingLevel: "off",
					sessionManager: {},
				} as never,
			);

			expect(stats.runs).toBe(2);
			expect(stats.contextTokens).toBe(1_500);
			expect(stats.last?.id).toBe(mainId);
			expect(summary.context).toEqual({ tokens: 1_000, contextWindow: 128_000, percent: 0.78125 });
			expect(summary.cacheHitPercent).toBeCloseTo(46.666, 2);
			expect(summary.averageLatencyMs).toBe(1_250);
			expect(piStatus).toContain("test/chat-model:medium");
			expect(piStatus).toContain("ctx 1.00K/128.0K (0.8%)");
			expect(piStatus).toContain("CH46.7%");

			const empty = summarizeBotUsage(loadBotStats(db, "B"), 128_000);
			expect(empty.context).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
			expect(empty.cacheHitPercent).toBeNull();
		} finally {
			db.close();
		}
	});

	test("live compaction usage updates totals without replacing latest context", async () => {
		const directory = temporaryDirectory();
		const db = openDb(join(directory, "agent.db"));
		const mainId = insertRun(db, {
			ts: 1_786_251_069_000,
			model: "chat-model",
			context: 1_000,
			read: 700,
			write: 50,
			miss: 250,
			output: 120,
			reasoning: 30,
			latency: 1_250,
			cost: 0.125,
			compaction: false,
		});
		const socketPath = join(directory, "daemon.sock");
		const ipc = new IpcServer(db, socketPath, new Map([["A", "bot A"]]), new Map([["A", 1]]));
		ipc.start();
		let baselineResolve!: () => void;
		let updatedResolve!: (stats: BotStats) => void;
		const baseline = new Promise<void>((resolve) => {
			baselineResolve = resolve;
		});
		const updated = new Promise<BotStats>((resolve) => {
			updatedResolve = resolve;
		});
		const client = new TimelineClient(socketPath, "A", {
			onEvent: (event: TimelineEvent) => {
				if (event.type !== "stats" || !event.stats.A) return;
				if (event.stats.A.runs === 1) baselineResolve();
				if (event.stats.A.runs === 2) updatedResolve(event.stats.A);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			await withTimeout(baseline, "baseline stats timed out");
			const compaction: UsageRun = {
				id: mainId + 1,
				botId: "A",
				ts: 1_786_251_070_000,
				model: "compact-model",
				epoch: 3,
				contextTokens: 500,
				cacheRead: 0,
				cacheWrite: 0,
				cacheMiss: 500,
				outputTokens: 50,
				reasoningTokens: 0,
				latencyMs: null,
				cost: 0.025,
				compaction: true,
			};
			ipc.broadcastUsage(compaction);
			const stats = await withTimeout(updated, "live compaction stats timed out");
			expect(stats.runs).toBe(2);
			expect(stats.contextTokens).toBe(1_500);
			expect(stats.last?.id).toBe(mainId);
		} finally {
			client.dispose();
			ipc.stop();
			db.close();
		}
	});
});
