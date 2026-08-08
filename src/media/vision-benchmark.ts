import {
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	parsePiModelReference,
} from "../agent/model-ref.ts";
import type {
	VisionDescribeInput,
	VisionExecutor,
	VisionKind,
	VisionOutcome,
	VisionTelemetry,
} from "./vision.ts";

export const VISION_BENCHMARK_MAX_RUNS = 10;
export const VISION_BENCHMARK_MAX_FIXTURE_BYTES = 8 * 1024 * 1024;

const BASELINE_LIMIT_MS: Record<VisionKind, number> = {
	photo: 3_869 * 2,
	sticker: 2_688 * 2,
};

export interface VisionBenchmarkArgs {
	photoPath: string;
	stickerPath: string;
	runs: number;
	modelRef: string;
}

export type VisionBenchmarkArgsResult =
	| { ok: true; value: VisionBenchmarkArgs }
	| { ok: false; help: boolean };

export function visionBenchmarkUsage(): string {
	return "Usage: bun run scripts/benchmark-vision.ts --photo <local-static-image> --sticker <local-static-image> [--runs 1..10] [--model provider/model:effort]\n";
}

/** Strict CLI parser; paths remain local inputs and are never copied into reports. */
export function parseVisionBenchmarkArgs(args: readonly string[]): VisionBenchmarkArgsResult {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { ok: false, help: true };
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag || !["--photo", "--sticker", "--runs", "--model"].includes(flag) || !value || values.has(flag)) {
			return { ok: false, help: false };
		}
		values.set(flag, value);
	}
	const photoPath = values.get("--photo");
	const stickerPath = values.get("--sticker");
	const runsText = values.get("--runs") ?? "1";
	const modelRef = values.get("--model") ?? DEFAULT_AUXILIARY_VISUAL_MODEL;
	const runs = Number(runsText);
	const parsedModel = parsePiModelReference(modelRef);
	if (
		!photoPath ||
		!stickerPath ||
		!Number.isSafeInteger(runs) ||
		runs < 1 ||
		runs > VISION_BENCHMARK_MAX_RUNS ||
		!parsedModel
	) {
		return { ok: false, help: false };
	}
	return {
		ok: true,
		value: { photoPath, stickerPath, runs, modelRef: parsedModel.canonical },
	};
}

export interface VisionBenchmarkFixture {
	bytes: Uint8Array;
	mimeType: VisionDescribeInput["mimeType"];
}

interface MetricDistribution {
	mean: number;
	p50: number;
	p95: number;
}

export interface VisionBenchmarkAggregate {
	attempts: number;
	successes: number;
	successRate: number;
	latencyMs: MetricDistribution;
	inputTokens: MetricDistribution;
	outputTokens: MetricDistribution;
	reasoningTokens: { total: number; max: number };
	cost: { total: number; mean: number };
	outcomes: Partial<Record<VisionOutcome, number>>;
	sourceBytesBuckets: string[];
	convertedBytesBuckets: string[];
	baselineLimitMs: number;
	baselineGatePassed: boolean;
}

export interface VisionBenchmarkReport {
	model: string;
	runsPerKind: number;
	photo: VisionBenchmarkAggregate;
	sticker: VisionBenchmarkAggregate;
	passed: boolean;
}

function rounded(value: number, places = 6): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function distribution(values: readonly number[]): MetricDistribution {
	return {
		mean: rounded(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length), 3),
		p50: percentile(values, 0.5),
		p95: percentile(values, 0.95),
	};
}

function aggregate(kind: VisionKind, samples: readonly VisionTelemetry[]): VisionBenchmarkAggregate {
	const outcomes: Partial<Record<VisionOutcome, number>> = {};
	for (const sample of samples) outcomes[sample.outcome] = (outcomes[sample.outcome] ?? 0) + 1;
	const successes = outcomes.ok ?? 0;
	const reasoning = samples.map((sample) => sample.reasoningTokens);
	const costs = samples.map((sample) => sample.cost);
	const latencyMs = distribution(samples.map((sample) => sample.latencyMs));
	const baselineLimitMs = BASELINE_LIMIT_MS[kind];
	return {
		attempts: samples.length,
		successes,
		successRate: rounded(successes / Math.max(1, samples.length), 4),
		latencyMs,
		inputTokens: distribution(samples.map((sample) => sample.inputTokens)),
		outputTokens: distribution(samples.map((sample) => sample.outputTokens)),
		reasoningTokens: {
			total: reasoning.reduce((sum, value) => sum + value, 0),
			max: reasoning.length > 0 ? Math.max(...reasoning) : 0,
		},
		cost: {
			total: rounded(costs.reduce((sum, value) => sum + value, 0)),
			mean: rounded(costs.reduce((sum, value) => sum + value, 0) / Math.max(1, costs.length)),
		},
		outcomes,
		sourceBytesBuckets: [...new Set(samples.map((sample) => sample.sourceBytesBucket))].sort(),
		convertedBytesBuckets: [...new Set(samples.map((sample) => sample.convertedBytesBucket))].sort(),
		baselineLimitMs,
		baselineGatePassed: samples.length > 0 && successes === samples.length && latencyMs.p95 <= baselineLimitMs && reasoning.every((value) => value === 0),
	};
}

/** Run photo/sticker fixtures sequentially so provider concurrency cannot skew the comparison. */
export async function runVisionBenchmark(
	executor: VisionExecutor,
	fixtures: Record<VisionKind, VisionBenchmarkFixture>,
	runs: number,
): Promise<VisionBenchmarkReport> {
	if (!Number.isSafeInteger(runs) || runs < 1 || runs > VISION_BENCHMARK_MAX_RUNS) {
		throw new Error("invalid benchmark run count");
	}
	const samples: Record<VisionKind, VisionTelemetry[]> = { photo: [], sticker: [] };
	for (const kind of ["photo", "sticker"] as const) {
		for (let index = 0; index < runs; index++) {
			const fixture = fixtures[kind];
			const result = await executor.describe({ kind, bytes: fixture.bytes, mimeType: fixture.mimeType });
			samples[kind].push(result.telemetry);
		}
	}
	const photo = aggregate("photo", samples.photo);
	const sticker = aggregate("sticker", samples.sticker);
	return {
		model: executor.modelRef,
		runsPerKind: runs,
		photo,
		sticker,
		passed: photo.baselineGatePassed && sticker.baselineGatePassed,
	};
}

export function formatVisionBenchmarkReport(report: VisionBenchmarkReport): string {
	return `${JSON.stringify(report, null, 2)}\n`;
}
