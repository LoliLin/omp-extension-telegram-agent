// Lazy, persistent photo/sticker vision shared by every bot in one deployment.
// Provider execution uses the daemon's shared Pi ModelRuntime; this module never
// starts another CLI or reads provider credential material.

import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import {
	convertToPng,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { BotApi } from "../telegram/api.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import {
	classifyPiProviderFailure,
	PiModelConfigurationError,
	type PiProviderFailureCategory,
} from "../agent/model-runtime.ts";
import {
	ensureLocalMedia,
	staticMediaMimeForPath,
	type LocalMediaFailure,
} from "./local-cache.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import { VisionBudgetExceededError, type VisionScheduler } from "./vision-scheduler.ts";

export { fileIdForBot } from "./local-cache.ts";

const PHOTO_PROMPT = `你在帮一个群聊 bot 理解图片。简短描述：实际可见内容、重要文字/OCR（尤其是界面和报错）、人物或物体、对聊天可能有用的信息、不确定的地方。2-3 句话以内，用中文，直接给描述不要客套。`;

const STICKER_PROMPT = `你在帮一个群聊 bot 理解一张 sticker（聊天表情贴图）。把它理解为一种聊天表达，输出短描述：communicative intent（想表达什么）、emotion、intensity、gesture/画面要点、可见文字。一两句话，用中文，例如"得意的赞同，smug/amused，中等强度"。直接给描述不要客套。`;

export const VISION_TIMEOUT_MS = 90_000;
export const VISION_MAX_OUTPUT_TOKENS = 256;

export type VisionKind = "photo" | "sticker";
export type VisionBytesBucket = "unavailable" | "lt_32_kib" | "32_128_kib" | "128_512_kib" | "gte_512_kib";
export type VisionOutcome =
	| "ok"
	| "empty_response"
	| "unsupported_format"
	| "conversion_failed"
	| "file_id_unavailable"
	| "telegram_file_unavailable"
	| "telegram_download_failed"
	| "media_unavailable"
	| "empty_file"
	| "download_oversize"
	| "media_download_aborted"
	| "budget_exceeded"
	| PiProviderFailureCategory;

export interface VisionTelemetry {
	kind: VisionKind;
	sourceBytesBucket: VisionBytesBucket;
	convertedBytesBucket: VisionBytesBucket;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cost: number;
	outcome: VisionOutcome;
}

export interface VisionDescriptionResult {
	text: string | null;
	telemetry: VisionTelemetry;
}

export interface VisionDescribeInput {
	kind: VisionKind;
	bytes: Uint8Array;
	mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export interface VisionExecutor {
	readonly modelRef: string;
	readonly provider: string;
	readonly model: string;
	readonly readinessFailure: "unknown_model" | "image_input_unsupported" | null;
	describe(input: VisionDescribeInput): Promise<VisionDescriptionResult>;
}

export type VisionUpdateSink = (fileUniqueId: string, text: string) => void;
export type VisionTelemetrySink = (telemetry: VisionTelemetry) => void;

export interface EnsureVisionOptions {
	/** Called exactly after a new non-empty description is persisted; cache hits do not emit. */
	onPersist?: VisionUpdateSink;
	/** Receives bounded aggregate fields only; never identity, path, prompt, or response text. */
	onTelemetry?: VisionTelemetrySink;
	/** Deterministic test seam; production uses data/media under cwd. */
	cacheDir?: string;
	/** Deterministic latency seam. */
	monotonicNow?: () => number;
	/** Shared deployment-wide provider gate; cache/local work remains outside the queue. */
	scheduler?: VisionScheduler;
	chatId?: number;
	foreground?: boolean;
}

interface PiVisionExecutorOptions {
	convert?: typeof convertToPng;
	monotonicNow?: () => number;
}

type VisionModelRuntime = Pick<ModelRuntime, "getModel" | "completeSimple">;

function bytesBucket(size: number): VisionBytesBucket {
	if (size < 32 * 1024) return "lt_32_kib";
	if (size < 128 * 1024) return "32_128_kib";
	if (size < 512 * 1024) return "128_512_kib";
	return "gte_512_kib";
}

function boundedNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function emptyTelemetry(kind: VisionKind, outcome: VisionOutcome, latencyMs: number): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: "unavailable",
		convertedBytesBucket: "unavailable",
		latencyMs: Math.max(0, Math.round(latencyMs)),
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cost: 0,
		outcome,
	};
}

function usageTelemetry(
	kind: VisionKind,
	sourceBytes: number,
	convertedBytes: number | null,
	latencyMs: number,
	outcome: VisionOutcome,
	message?: AssistantMessage,
): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: bytesBucket(sourceBytes),
		convertedBytesBucket: convertedBytes == null ? "unavailable" : bytesBucket(convertedBytes),
		latencyMs: Math.max(0, Math.round(latencyMs)),
		inputTokens: boundedNumber(message?.usage.input),
		outputTokens: boundedNumber(message?.usage.output),
		reasoningTokens: boundedNumber(message?.usage.reasoning),
		cost: boundedNumber(message?.usage.cost.total),
		outcome,
	};
}

/** Create a lightweight vision adapter over the already-owned Pi runtime/auth snapshot. */
export function createPiVisionExecutor(
	runtime: VisionModelRuntime,
	modelRef: string,
	options: PiVisionExecutorOptions = {},
): VisionExecutor {
	const selection = parsePiModelReference(modelRef);
	if (!selection) {
		throw new Error("invalid auxiliary_visual_model; expected provider/model:effort");
	}
	const model = runtime.getModel(selection.provider, selection.model);
	const readinessFailure = !model
		? "unknown_model"
		: !model.input.includes("image")
			? "image_input_unsupported"
			: null;
	const convert = options.convert ?? convertToPng;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());

	return {
		modelRef: selection.canonical,
		provider: selection.provider,
		model: selection.model,
		readinessFailure,
		async describe(input): Promise<VisionDescriptionResult> {
			const startedAt = monotonicNow();
			const sourceBytes = input.bytes.byteLength;
			if (readinessFailure) {
				return {
					text: null,
					telemetry: usageTelemetry(input.kind, sourceBytes, null, monotonicNow() - startedAt, readinessFailure),
				};
			}

			let image: { data: string; mimeType: string } = {
				data: Buffer.from(input.bytes).toString("base64"),
				mimeType: input.mimeType,
			};
			let convertedBytes: number | null = null;
			if (input.mimeType === "image/webp" || input.mimeType === "image/gif") {
				try {
					const converted = await convert(image.data, input.mimeType);
					if (!converted) {
						return {
							text: null,
							telemetry: usageTelemetry(input.kind, sourceBytes, null, monotonicNow() - startedAt, "conversion_failed"),
						};
					}
					image = converted;
					convertedBytes = Buffer.from(converted.data, "base64").byteLength;
				} catch {
					return {
						text: null,
						telemetry: usageTelemetry(input.kind, sourceBytes, null, monotonicNow() - startedAt, "conversion_failed"),
					};
				}
			}

			const context: Context = {
				messages: [{
					role: "user",
					content: [
						{ type: "text", text: input.kind === "sticker" ? STICKER_PROMPT : PHOTO_PROMPT },
						{ type: "image", data: image.data, mimeType: image.mimeType },
					],
					timestamp: Date.now(),
				}],
			};
			let message: AssistantMessage;
			try {
				// Single timeout layer: the SDK enforces VISION_TIMEOUT_MS inside completeSimple.
				message = await runtime.completeSimple(model!, context, {
					cacheRetention: "none",
					maxTokens: VISION_MAX_OUTPUT_TOKENS,
					maxRetries: 0,
					reasoning: selection.thinkingLevel,
					timeoutMs: VISION_TIMEOUT_MS,
				});
			} catch (error) {
				return {
					text: null,
					telemetry: usageTelemetry(
						input.kind,
						sourceBytes,
						convertedBytes,
						monotonicNow() - startedAt,
						classifyPiProviderFailure(error),
					),
				};
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const category = classifyPiProviderFailure(new Error(message.errorMessage ?? message.stopReason));
				return {
					text: null,
					telemetry: usageTelemetry(input.kind, sourceBytes, convertedBytes, monotonicNow() - startedAt, category, message),
				};
			}

			const text = message.content
				.filter((content): content is Extract<(typeof message.content)[number], { type: "text" }> => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim();
			const outcome: VisionOutcome = text ? "ok" : "empty_response";
			return {
				text: text || null,
				telemetry: usageTelemetry(input.kind, sourceBytes, convertedBytes, monotonicNow() - startedAt, outcome, message),
			};
		},
	};
}

/** Fail startup with a fixed category before Telegram if the selected task model cannot see images. */
export function assertPiVisionExecutorReady(executor: VisionExecutor): void {
	if (executor.readinessFailure) {
		throw new PiModelConfigurationError(executor.readinessFailure, executor.provider, executor.model);
	}
}

const inFlightByDb = new WeakMap<Database, Map<string, Promise<string | null>>>();

/** Ensure a terminal vision result exists; same-identity calls share one provider request. */
export function ensureVision(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions = {},
): Promise<string | null> {
	let inFlight = inFlightByDb.get(db);
	if (!inFlight) {
		inFlight = new Map();
		inFlightByDb.set(db, inFlight);
	}
	const existing = inFlight.get(fileUniqueId);
	if (existing) return existing;
	const promise = ensureVisionInner(db, api, botId, fileUniqueId, executor, options).finally(() => {
		inFlight!.delete(fileUniqueId);
	});
	inFlight.set(fileUniqueId, promise);
	return promise;
}

function emitTelemetry(options: EnsureVisionOptions, telemetry: VisionTelemetry): void {
	try {
		options.onTelemetry?.(telemetry);
	} catch {
		log.error("vision", "telemetry_sink_failed", { category: "observer_failed" });
	}
}

export function visionMimeForPath(filePath: string): VisionDescribeInput["mimeType"] | null {
	return staticMediaMimeForPath(filePath);
}

function localMediaVisionOutcome(outcome: LocalMediaFailure): VisionOutcome {
	if (outcome === "aborted") return "media_download_aborted";
	return outcome;
}

async function ensureVisionInner(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
): Promise<string | null> {
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const startedAt = monotonicNow();
	const media = db.query("SELECT kind, vision FROM media WHERE file_unique_id = ?").get(fileUniqueId) as
		| { kind: string; vision: string | null }
		| null;
	if (!media || (media.kind !== "photo" && media.kind !== "sticker")) return null;
	const kind = media.kind as VisionKind;
	if (media.vision) {
		const cached = JSON.parse(media.vision) as { text?: string | null };
		return cached.text?.trim() || null;
	}
	const local = await ensureLocalMedia(db, api, botId, fileUniqueId, { cacheDir: options.cacheDir });
	if (!local.ok) {
		const outcome = localMediaVisionOutcome(local.outcome);
		if (outcome === "unsupported_format") {
			db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
				JSON.stringify({ model: "none", kind, text: null, unsupported: true, outcome, at: Date.now() }),
				fileUniqueId,
			);
		}
		emitTelemetry(options, emptyTelemetry(kind, outcome, monotonicNow() - startedAt));
		return null;
	}
	if (local.kind !== kind) {
		db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
			JSON.stringify({ model: "none", kind, text: null, outcome: "media_unavailable", at: Date.now() }),
			fileUniqueId,
		);
		emitTelemetry(options, emptyTelemetry(kind, "media_unavailable", monotonicNow() - startedAt));
		return null;
	}

	let result: VisionDescriptionResult;
	try {
		const describe = () => executor.describe({ kind, bytes: local.bytes, mimeType: local.mimeType });
		result = options.scheduler
			? await options.scheduler.schedule(options.chatId ?? 0, options.foreground ?? false, describe)
			: await describe();
	} catch (error) {
		if (!(error instanceof VisionBudgetExceededError)) throw error;
		emitTelemetry(options, emptyTelemetry(kind, "budget_exceeded", monotonicNow() - startedAt));
		return null;
	}
	const text = result.text?.trim() || null;
	db.query("UPDATE media SET vision = ?, local_path = COALESCE(?, local_path) WHERE file_unique_id = ?").run(
		JSON.stringify({ model: executor.modelRef, kind, text, outcome: result.telemetry.outcome, at: Date.now() }),
		local.mediaPath,
		fileUniqueId,
	);
	if (text) appendMediaUpdateEvents(db, fileUniqueId, text);
	emitTelemetry(options, result.telemetry);
	if (text && options.onPersist) {
		try {
			options.onPersist(fileUniqueId, text);
		} catch {
			// Persistence is authoritative; observer failures cannot retry provider work.
			log.error("vision", "update_sink_failed", { category: "observer_failed" });
		}
	}
	return text;
}
