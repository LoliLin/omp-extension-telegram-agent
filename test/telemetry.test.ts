process.env.TZ = "Asia/Singapore";

import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { statsText, telegramFooterLines, telegramFooterUsage } from "../.pi/extensions/tg-extension.ts";
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
							reasoning: true,
						},
					],
				},
				model: undefined,
				thinkingLevel: "off" as const,
			};
			const piStatus = statsText("A", stats, bot, runtime, host);
			const footerUsage = telegramFooterUsage(null, { A: stats }, { A: runtime }, [bot], host);
			const footerLines = telegramFooterLines(
				100,
				{ fg: (_color, text) => text },
				{
					cwd: "/home/test/project",
					home: "/home/test",
					branch: "main",
					sessionName: "ops",
					usage: footerUsage,
					availableProviderCount: 2,
					statuses: new Map([["telegram-compose", "TELEGRAM · CHOOSE BOT ON SEND"]]),
				},
			);

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
			expect(footerLines[0]).toBe("~/project (main) • ops");
			expect(footerLines[1]).toStartWith("↑750 ↓170 R700 W50 CH46.7% $0.1500 0.8%/128k (auto)");
			expect(footerLines[1]).toEndWith("(test) chat-model • high");
			expect(visibleWidth(footerLines[1]!)).toBe(100);
			expect(footerLines[2]).toBe("TELEGRAM · CHOOSE BOT ON SEND");
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

	test("sums immutable per-run costs across model switches in status and footer", () => {
		const db = openDb(":memory:");
		try {
			insertRun(db, {
				ts: 1_786_251_069_000,
				model: "deepseek-v4-flash",
				context: 1_000,
				read: 700,
				write: 0,
				miss: 300,
				output: 120,
				reasoning: 30,
				latency: 1_250,
				cost: 0.720_977_83,
				compaction: false,
			});
			insertRun(db, {
				ts: 1_786_251_070_000,
				model: "glm-5.2",
				context: 8_076,
				read: 0,
				write: 0,
				miss: 8_076,
				output: 66,
				reasoning: 0,
				latency: 7_500,
				cost: 0.033_866_2,
				compaction: false,
			});

			const stats = loadBotStats(db, "A");
			const runtime = {
				state: "idle",
				epoch: 4,
				provider: "ollama-cloud",
				model: "glm-5.2",
				reasoningEffort: "high",
				contextWindow: 1_000_000,
				routingP: 1,
				samplingCooldownMs: 2_000,
				lastCompact: null,
			} satisfies RuntimeControlSnapshot;
			const bot = {
				id: "A",
				name: "Bot A",
				provider: "ollama-cloud",
				model: "glm-5.2",
				reasoningEffort: "high",
				routingP: 1,
				samplingCooldownMs: 2_000,
			} as const;
			const host = {
				modelRegistry: {
					getAvailable: () => [{ provider: "ollama-cloud", id: "glm-5.2", contextWindow: 1_000_000, reasoning: true }],
				},
				model: undefined,
				thinkingLevel: "off" as const,
			};
			const status = statsText("A", stats, bot, runtime, host);
			const footer = telegramFooterLines(
				100,
				{ fg: (_color, text) => text },
				{
					cwd: "/tmp/project",
					home: "/tmp",
					branch: null,
					sessionName: undefined,
					usage: telegramFooterUsage("A", { A: stats }, { A: runtime }, [bot], host),
					availableProviderCount: 1,
					statuses: new Map(),
				},
			);

			expect(stats.cost).toBeCloseTo(0.754_844_03, 10);
			expect(stats.last?.model).toBe("glm-5.2");
			expect(status).toContain("cache_and_cost=CH 7.7% · $0.754844");
			expect(footer[1]).toContain("$0.754844");
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
