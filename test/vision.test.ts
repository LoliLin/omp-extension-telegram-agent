process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertPiVisionExecutorReady,
	createPiVisionExecutor,
	ensureVision,
	VISION_MAX_OUTPUT_TOKENS,
	VISION_TIMEOUT_MS,
	type VisionDescriptionResult,
	type VisionExecutor,
	type VisionKind,
	type VisionOutcome,
	type VisionTelemetry,
} from "../src/media/vision.ts";
import {
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	parsePiModelReference,
} from "../src/agent/model-ref.ts";

let db: Database;
let cacheDir: string;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	cacheDir = mkdtempSync(join(tmpdir(), "vision-update-test-"));
});

afterEach(() => {
	db.close();
	rmSync(cacheDir, { recursive: true, force: true });
});

function insertMedia(fileUniqueId: string, kind = "photo"): void {
	db.query("INSERT INTO media (file_unique_id, kind) VALUES (?, ?)").run(fileUniqueId, kind);
	db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES ('A', ?, ?)").run(`file-${fileUniqueId}`, fileUniqueId);
}

function telemetry(kind: VisionKind, outcome: VisionOutcome = "ok"): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: "lt_32_kib",
		convertedBytesBucket: "unavailable",
		latencyMs: 3,
		inputTokens: 11,
		outputTokens: 7,
		reasoningTokens: 0,
		cost: 0.001,
		outcome,
	};
}

function fakeExecutor(
	describe: VisionExecutor["describe"],
	modelRef = DEFAULT_AUXILIARY_VISUAL_MODEL,
): VisionExecutor {
	const ref = parsePiModelReference(modelRef)!;
	return {
		modelRef,
		provider: ref.provider,
		model: ref.model,
		readinessFailure: null,
		describe,
	};
}

function assistant(
	content: unknown[],
	overrides: Record<string, unknown> = {},
) {
	return {
		role: "assistant",
		content,
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 101,
			output: 23,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 124,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

describe("Pi vision executor (REQ-VISION-0001 R7)", () => {
	test("parses only canonical provider/model:effort references", () => {
		expect(parsePiModelReference(DEFAULT_AUXILIARY_VISUAL_MODEL)).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			thinkingLevel: "low",
			canonical: DEFAULT_AUXILIARY_VISUAL_MODEL,
		});
		expect(parsePiModelReference("openrouter/anthropic/claude:high")?.model).toBe("anthropic/claude");
		for (const invalid of ["gpt-5.6-luna-low", "provider/model", "/model:low", "provider/:low", "provider/model:off", " provider/model:low"]) {
			expect(parsePiModelReference(invalid)).toBeNull();
		}
	});

	test("uses the selected shared Pi model with fixed bounds and extracts text only", async () => {
		let selected: unknown[] = [];
		let captured: { model: unknown; context: any; options: any } | null = null;
		let convertCalls = 0;
		let now = 100;
		const model = { input: ["text", "image"] };
		const runtime = {
			getModel: (provider: string, modelId: string) => {
				selected = [provider, modelId];
				return model;
			},
			completeSimple: async (selectedModel: unknown, context: unknown, options: unknown) => {
				captured = { model: selectedModel, context, options };
				now = 123;
				return assistant([
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: " 第一段 " },
					{ type: "text", text: "第二段" },
				]);
			},
		};
		const executor = createPiVisionExecutor(runtime as never, DEFAULT_AUXILIARY_VISUAL_MODEL, {
			convert: async () => {
				convertCalls++;
				return null;
			},
			monotonicNow: () => now,
		});
		assertPiVisionExecutorReady(executor);

		const result = await executor.describe({ kind: "photo", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" });

		expect(selected).toEqual(["openai-codex", "gpt-5.6-luna"]);
		expect(convertCalls).toBe(0);
		expect(result.text).toBe("第一段 \n第二段");
		expect(result.telemetry).toEqual({
			kind: "photo",
			sourceBytesBucket: "lt_32_kib",
			convertedBytesBucket: "unavailable",
			latencyMs: 23,
			inputTokens: 101,
			outputTokens: 23,
			reasoningTokens: 0,
			cost: 0.003,
			outcome: "ok",
		});
		expect(captured!.model).toBe(model);
		expect(captured!.options).toMatchObject({
			cacheRetention: "none",
			maxTokens: VISION_MAX_OUTPUT_TOKENS,
			maxRetries: 0,
			reasoning: "low",
			timeoutMs: VISION_TIMEOUT_MS,
		});
		expect(captured!.context.messages).toHaveLength(1);
		const content = captured!.context.messages[0].content;
		expect(content[0]).toMatchObject({ type: "text" });
		expect(content[1]).toEqual({ type: "image", data: "AQID", mimeType: "image/png" });
	});

	test("converts static WebP/GIF to PNG but sends JPEG/PNG directly", async () => {
		const conversions: string[] = [];
		const providerImages: unknown[] = [];
		const runtime = {
			getModel: () => ({ input: ["text", "image"] }),
			completeSimple: async (_model: unknown, context: any) => {
				providerImages.push(context.messages[0].content[1]);
				return assistant([{ type: "text", text: "ok" }]);
			},
		};
		const executor = createPiVisionExecutor(runtime as never, DEFAULT_AUXILIARY_VISUAL_MODEL, {
			convert: async (_data, mimeType) => {
				conversions.push(mimeType);
				return { data: Buffer.from([9, 8]).toString("base64"), mimeType: "image/png" };
			},
		});

		for (const mimeType of ["image/webp", "image/gif", "image/jpeg", "image/png"] as const) {
			await executor.describe({ kind: "sticker", bytes: new Uint8Array([1]), mimeType });
		}

		expect(conversions).toEqual(["image/webp", "image/gif"]);
		expect(providerImages).toEqual([
			{ type: "image", data: "CQg=", mimeType: "image/png" },
			{ type: "image", data: "CQg=", mimeType: "image/png" },
			{ type: "image", data: "AQ==", mimeType: "image/jpeg" },
			{ type: "image", data: "AQ==", mimeType: "image/png" },
		]);
	});

	test("unknown and text-only models fail with fixed startup categories and no provider call", async () => {
		let providerCalls = 0;
		for (const fixture of [
			{ model: undefined, category: "unknown_model" },
			{ model: { input: ["text"] }, category: "image_input_unsupported" },
		] as const) {
			const executor = createPiVisionExecutor({
				getModel: () => fixture.model as never,
				completeSimple: async () => {
					providerCalls++;
					return assistant([{ type: "text", text: "must not run" }]) as never;
				},
			} as never, DEFAULT_AUXILIARY_VISUAL_MODEL);
			expect(() => assertPiVisionExecutorReady(executor)).toThrow(fixture.category);
			const result = await executor.describe({ kind: "photo", bytes: new Uint8Array([1]), mimeType: "image/png" });
			expect(result).toMatchObject({ text: null, telemetry: { outcome: fixture.category } });
		}
		expect(providerCalls).toBe(0);
	});

	test("provider errors and empty responses become bounded outcomes without upstream text", async () => {
		const privateBody = "PRIVATE-UPSTREAM-BODY-401";
		const rejected = createPiVisionExecutor({
			getModel: () => ({ input: ["text", "image"] }) as never,
			completeSimple: async () => { throw new Error(privateBody); },
		} as never, DEFAULT_AUXILIARY_VISUAL_MODEL);
		const rejectedResult = await rejected.describe({ kind: "photo", bytes: new Uint8Array([1]), mimeType: "image/png" });
		expect(rejectedResult.telemetry.outcome).toBe("provider_auth_failed");
		expect(JSON.stringify(rejectedResult)).not.toContain(privateBody);

		const empty = createPiVisionExecutor({
			getModel: () => ({ input: ["text", "image"] }) as never,
			completeSimple: async () => assistant([{ type: "thinking", thinking: privateBody }]) as never,
		} as never, DEFAULT_AUXILIARY_VISUAL_MODEL);
		const emptyResult = await empty.describe({ kind: "sticker", bytes: new Uint8Array([1]), mimeType: "image/png" });
		expect(emptyResult).toMatchObject({ text: null, telemetry: { outcome: "empty_response" } });
		expect(JSON.stringify(emptyResult)).not.toContain(privateBody);
	});
});

describe("vision persistence and sharing (REQ-UI-0006 / REQ-VISION-0001)", () => {
	test("a new description downloads/describes/persists once and emits bounded side channels", async () => {
		insertMedia("photo-1");
		let getFileCalls = 0;
		let downloadCalls = 0;
		let describeCalls = 0;
		const updates: { fileUniqueId: string; text: string }[] = [];
		const telemetryEvents: VisionTelemetry[] = [];
		const api = {
			getFile: async () => {
				getFileCalls++;
				return { file_path: "photos/source.png" };
			},
			downloadFile: async () => {
				downloadCalls++;
				return new Uint8Array([1, 2, 3]);
			},
		};
		const executor = fakeExecutor(async (input) => {
			describeCalls++;
			return { text: "  一只猫坐在窗边  ", telemetry: telemetry(input.kind) };
		});
		const options = {
			cacheDir,
			onPersist: (fileUniqueId: string, text: string) => updates.push({ fileUniqueId, text }),
			onTelemetry: (event: VisionTelemetry) => telemetryEvents.push(event),
		};

		const [first, concurrent] = await Promise.all([
			ensureVision(db, api as never, "A", "photo-1", executor, options),
			ensureVision(db, api as never, "A", "photo-1", executor, options),
		]);
		const cached = await ensureVision(db, api as never, "A", "photo-1", executor, options);

		expect(first).toBe("一只猫坐在窗边");
		expect(concurrent).toBe(first);
		expect(cached).toBe(first);
		expect({ getFileCalls, downloadCalls, describeCalls }).toEqual({ getFileCalls: 1, downloadCalls: 1, describeCalls: 1 });
		expect(updates).toEqual([{ fileUniqueId: "photo-1", text: "一只猫坐在窗边" }]);
		expect(telemetryEvents).toEqual([telemetry("photo")]);
		expect(JSON.stringify(telemetryEvents)).not.toContain("photo-1");
		const stored = db.query("SELECT local_path, vision FROM media WHERE file_unique_id = 'photo-1'").get() as { local_path: string; vision: string };
		expect(stored.local_path.startsWith(`${cacheDir}/`)).toBe(true);
		expect(stored.local_path.endsWith(".png")).toBe(true);
		expect(stored.local_path).not.toContain("photo-1");
		expect(JSON.parse(stored.vision)).toMatchObject({
			model: DEFAULT_AUXILIARY_VISUAL_MODEL,
			text: "一只猫坐在窗边",
			outcome: "ok",
		});
	});

	test("empty/provider failures and unsupported animation persist one terminal fallback", async () => {
		insertMedia("empty-photo");
		insertMedia("animated-sticker", "sticker");
		let describes = 0;
		const updates: unknown[] = [];
		const events: VisionTelemetry[] = [];
		const executor = fakeExecutor(async (input): Promise<VisionDescriptionResult> => {
			describes++;
			return { text: null, telemetry: telemetry(input.kind, "empty_response") };
		});
		const photoApi = {
			getFile: async () => ({ file_path: "photos/source.png" }),
			downloadFile: async () => new Uint8Array([1, 2, 3]),
		};
		await ensureVision(db, photoApi as never, "A", "empty-photo", executor, {
			cacheDir,
			onPersist: (...args) => updates.push(args),
			onTelemetry: (event) => events.push(event),
		});
		await ensureVision(db, photoApi as never, "A", "empty-photo", executor, { cacheDir });
		await ensureVision(db, {
			getFile: async () => ({ file_path: "stickers/animated.tgs" }),
		} as never, "A", "animated-sticker", executor, {
			cacheDir,
			onPersist: (...args) => updates.push(args),
			onTelemetry: (event) => events.push(event),
		});

		expect(describes).toBe(1);
		expect(updates).toEqual([]);
		expect(events.map((event) => event.outcome)).toEqual(["empty_response", "unsupported_format"]);
		expect(db.query("SELECT json_extract(vision, '$.outcome') outcome FROM media WHERE file_unique_id = 'empty-photo'").get()).toEqual({ outcome: "empty_response" });
		expect(db.query("SELECT json_extract(vision, '$.unsupported') unsupported FROM media WHERE file_unique_id = 'animated-sticker'").get()).toEqual({ unsupported: 1 });
	});
});
