#!/usr/bin/env bun

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parsePiModelReference } from "../src/agent/model-ref.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import {
	assertPiVisionExecutorReady,
	createPiVisionExecutor,
	visionMimeForPath,
} from "../src/media/vision.ts";
import {
	formatVisionBenchmarkReport,
	parseVisionBenchmarkArgs,
	runVisionBenchmark,
	VISION_BENCHMARK_MAX_FIXTURE_BYTES,
	visionBenchmarkUsage,
	type VisionBenchmarkFixture,
} from "../src/media/vision-benchmark.ts";

type FailureCategory = "fixture_unavailable" | "fixture_too_large" | "unsupported_fixture" | "runtime_unavailable";

class BenchmarkFailure extends Error {
	constructor(readonly category: FailureCategory) {
		super(category);
	}
}

function loadFixture(path: string): VisionBenchmarkFixture {
	const mimeType = visionMimeForPath(path);
	if (!mimeType) throw new BenchmarkFailure("unsupported_fixture");
	let bytes: Uint8Array;
	try {
		if (statSync(resolve(path)).size > VISION_BENCHMARK_MAX_FIXTURE_BYTES) {
			throw new BenchmarkFailure("fixture_too_large");
		}
		bytes = readFileSync(resolve(path));
	} catch (error) {
		if (error instanceof BenchmarkFailure) throw error;
		throw new BenchmarkFailure("fixture_unavailable");
	}
	if (bytes.byteLength > VISION_BENCHMARK_MAX_FIXTURE_BYTES) throw new BenchmarkFailure("fixture_too_large");
	return { bytes, mimeType };
}

async function main(args = process.argv.slice(2)): Promise<number> {
	const parsed = parseVisionBenchmarkArgs(args);
	if (!parsed.ok) {
		(parsed.help ? process.stdout : process.stderr).write(visionBenchmarkUsage());
		return parsed.help ? 0 : 2;
	}
	try {
		const fixtures = {
			photo: loadFixture(parsed.value.photoPath),
			sticker: loadFixture(parsed.value.stickerPath),
		};
		const selection = parsePiModelReference(parsed.value.modelRef)!;
		const runtime = await createSharedModelRuntime([selection]);
		const executor = createPiVisionExecutor(runtime, selection.canonical);
		assertPiVisionExecutorReady(executor);
		const report = await runVisionBenchmark(executor, fixtures, parsed.value.runs);
		process.stdout.write(formatVisionBenchmarkReport(report));
		return report.passed ? 0 : 1;
	} catch (error) {
		const category = error instanceof BenchmarkFailure ? error.category : "runtime_unavailable";
		process.stderr.write(`Vision benchmark unavailable (${category}).\n`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await main();
