process.env.TZ = "Asia/Singapore";

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statsText, telegramUsageStatusText } from "../.pi/extensions/tg-extension.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { openDb } from "../src/db/db.ts";
import { loadBotStats } from "../src/db/usage.ts";
import type { BotStats, RuntimeControlSnapshot, UsageRun } from "../src/ipc.ts";
import { BOT_STATUS_FIELD_KEYS } from "../src/observability/status.ts";
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
			const runtime = {
				state: "idle",
				epoch: 3,
				provider: "test",
				model: "chat-model",
				reasoningEffort: "high",
				contextWindow: 128_000,
				routingP: 0.25,
				samplingCooldownMs: 2_000,
				lastCompact: null,
			} satisfies RuntimeControlSnapshot;
			const bot = {
				id: "A",
				name: "Bot A",
				provider: "test",
				model: "chat-model",
				reasoningEffort: "medium",
				routingP: 0.25,
				samplingCooldownMs: 2_000,
			} as const;
			const host = {
				modelRegistry: {
					getAvailable: () => [
						{
							provider: "test",
							id: "chat-model",
							contextWindow: 128_000,
						},
					],
				},
				model: undefined,
				thinkingLevel: "off" as const,
			};
			const piStatus = statsText("A", stats, bot, runtime, host);
			const footerStatus = telegramUsageStatusText(null, { A: stats }, { A: runtime });

			expect(stats.runs).toBe(2);
			expect(stats.contextTokens).toBe(1_500);
			expect(stats.last?.id).toBe(mainId);
			expect(summary.context).toEqual({ tokens: 1_000, contextWindow: 128_000, percent: 0.78125 });
			expect(summary.cacheHitPercent).toBeCloseTo(46.666, 2);
			expect(summary.averageLatencyMs).toBe(1_250);
			expect(piStatus).toContain("model=test/chat-model · reasoning high · epoch 3");
			expect(piStatus).not.toContain("reasoning medium");
			expect(piStatus).toContain("context_current=1,000 / 128,000 (0.8%)");
			expect(piStatus).toContain("cache_and_cost=CH 46.7% · $0.1500");
			expect(footerStatus).toBe("TG all ↑750 ↓170 R700 W50 CH46.7% $0.150 0.8%/128k chat-model");
			expect(
				piStatus
					.split("\n")
					.slice(1)
					.map((line) => line.slice(0, line.indexOf("="))),
			).toEqual([...BOT_STATUS_FIELD_KEYS]);

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
		const runtimeStatus = {
			state: "idle",
			epoch: 3,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoningEffort: "high",
			contextWindow: 1_000_000,
			routingP: 0.25,
			samplingCooldownMs: 2_000,
			lastCompact: null,
		} satisfies RuntimeControlSnapshot;
		const ipc = new IpcServer(
			db,
			socketPath,
			new Map([["A", "bot A"]]),
			new Map([["A", 1]]),
			null,
			() => runtimeStatus,
		);
		ipc.start();
		let baselineResolve!: () => void;
		let baselineStatus: RuntimeControlSnapshot | undefined;
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
				if (event.stats.A.runs === 1) {
					baselineStatus = event.statuses.A;
					baselineResolve();
				}
				if (event.stats.A.runs === 2) updatedResolve(event.stats.A);
			},
		});
		try {
			expect(await client.connect()).toBe(true);
			await withTimeout(baseline, "baseline stats timed out");
			expect(baselineStatus).toEqual(runtimeStatus);
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
