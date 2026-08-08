import { describe, expect, test } from "bun:test";
import {
	formatVisionBenchmarkReport,
	parseVisionBenchmarkArgs,
	runVisionBenchmark,
	VISION_BENCHMARK_MAX_RUNS,
} from "../src/media/vision-benchmark.ts";
import type { VisionExecutor, VisionKind, VisionTelemetry } from "../src/media/vision.ts";

function sample(kind: VisionKind, latencyMs: number, overrides: Partial<VisionTelemetry> = {}): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: "lt_32_kib",
		convertedBytesBucket: kind === "sticker" ? "lt_32_kib" : "unavailable",
		latencyMs,
		inputTokens: kind === "photo" ? 1000 : 300,
		outputTokens: 50,
		reasoningTokens: 0,
		cost: kind === "photo" ? 0.00028 : 0.00012,
		outcome: "ok",
		...overrides,
	};
}

describe("anonymous vision benchmark (REQ-VISION-0001 AC9)", () => {
	test("requires explicit photo/sticker fixtures and bounded canonical options", () => {
		expect(parseVisionBenchmarkArgs(["--photo", "a.jpg", "--sticker", "b.webp"])).toEqual({
			ok: true,
			value: {
				photoPath: "a.jpg",
				stickerPath: "b.webp",
				runs: 1,
				modelRef: "openai-codex/gpt-5.6-luna:low",
			},
		});
		expect(parseVisionBenchmarkArgs([
			"--photo", "a.jpg", "--sticker", "b.webp", "--runs", String(VISION_BENCHMARK_MAX_RUNS),
			"--model", "openai-codex/gpt-5.6-luna:low",
		]).ok).toBe(true);
		for (const invalid of [
			[],
			["--photo", "a.jpg"],
			["--photo", "a.jpg", "--sticker", "b.webp", "--runs", "0"],
			["--photo", "a.jpg", "--sticker", "b.webp", "--runs", "11"],
			["--photo", "a.jpg", "--sticker", "b.webp", "--model", "luna-low"],
			["--photo", "a.jpg", "--photo", "other.jpg", "--sticker", "b.webp"],
		]) {
			expect(parseVisionBenchmarkArgs(invalid).ok).toBe(false);
		}
		expect(parseVisionBenchmarkArgs(["--help"])).toEqual({ ok: false, help: true });
	});

	test("reports p50/p95, tokens, cost, outcome, and the two-times baseline gate without content", async () => {
		const privateResponse = "PRIVATE-VISION-RESPONSE";
		const privatePath = "/private/fixture-name.webp";
		const latencies = {
			photo: [1000, 3000, 2000],
			sticker: [900, 1100, 1000],
		};
		const executor: VisionExecutor = {
			modelRef: "openai-codex/gpt-5.6-luna:low",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			readinessFailure: null,
			describe: async (input) => ({
				text: privateResponse,
				telemetry: sample(input.kind, latencies[input.kind].shift()!),
			}),
		};
		const report = await runVisionBenchmark(executor, {
			photo: { bytes: new Uint8Array([1]), mimeType: "image/jpeg" },
			sticker: { bytes: new Uint8Array([2]), mimeType: "image/webp" },
		}, 3);
		const formatted = formatVisionBenchmarkReport(report);

		expect(report.passed).toBe(true);
		expect(report.photo).toMatchObject({
			attempts: 3,
			successes: 3,
			successRate: 1,
			latencyMs: { mean: 2000, p50: 2000, p95: 3000 },
			inputTokens: { mean: 1000, p50: 1000, p95: 1000 },
			reasoningTokens: { total: 0, max: 0 },
			cost: { total: 0.00084, mean: 0.00028 },
			outcomes: { ok: 3 },
			baselineLimitMs: 7738,
			baselineGatePassed: true,
		});
		expect(report.sticker).toMatchObject({ latencyMs: { mean: 1000, p50: 1000, p95: 1100 }, baselineLimitMs: 5376 });
		expect(formatted).not.toContain(privateResponse);
		expect(formatted).not.toContain(privatePath);
	});

	test("failed samples or reasoning tokens are reported honestly and fail the gate", async () => {
		let calls = 0;
		const executor: VisionExecutor = {
			modelRef: "openai-codex/gpt-5.6-luna:low",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			readinessFailure: null,
			describe: async (input) => {
				calls++;
				return {
					text: null,
					telemetry: sample(input.kind, input.kind === "photo" ? 8000 : 1000, {
						outcome: calls === 1 ? "provider_request_failed" : "ok",
						reasoningTokens: input.kind === "sticker" ? 1 : 0,
					}),
				};
			},
		};
		const report = await runVisionBenchmark(executor, {
			photo: { bytes: new Uint8Array([1]), mimeType: "image/png" },
			sticker: { bytes: new Uint8Array([2]), mimeType: "image/png" },
		}, 1);

		expect(report.passed).toBe(false);
		expect(report.photo).toMatchObject({ successes: 0, outcomes: { provider_request_failed: 1 }, baselineGatePassed: false });
		expect(report.sticker).toMatchObject({ reasoningTokens: { total: 1, max: 1 }, baselineGatePassed: false });
	});

	test("CLI fixture failures never echo the supplied local path", () => {
		const privatePath = "/tmp/PRIVATE-FIXTURE-NAME.jpg";
		const result = Bun.spawnSync([
			"bun", "run", "scripts/benchmark-vision.ts",
			"--photo", privatePath,
			"--sticker", "/tmp/OTHER-PRIVATE-FIXTURE.webp",
		], { cwd: process.cwd() });
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).toBe(1);
		expect(output).toContain("fixture_unavailable");
		expect(output).not.toContain(privatePath);
		expect(output).not.toContain("OTHER-PRIVATE-FIXTURE");
	});
});
