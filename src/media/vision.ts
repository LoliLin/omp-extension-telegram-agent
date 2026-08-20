// Lazy, persistent photo/sticker/video vision shared by every bot in one deployment.
// Provider execution uses the daemon's shared Pi ModelRuntime; this module never
// starts another CLI or reads provider credential material.

import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import { convertToPng, type ModelRuntime, resizeImage } from "@earendil-works/pi-coding-agent";
import { contentText, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { BotApi } from "../telegram/api.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import {
	classifyPiProviderFailure,
	PiModelConfigurationError,
	type PiProviderFailureCategory,
} from "../agent/model-runtime.ts";
import {
	bytesBucket,
	dedupeInFlight,
	ensureLocalMedia,
	isVideoMedia,
	isVisionMedia,
	staticMediaMimeForPath,
	type LocalMediaFailure,
	type MediaBytesBucket,
	type MediaDownloadApi,
} from "./local-cache.ts";
import { appendMediaUpdateEvents } from "../db/message-events.ts";
import type { VisionScheduler } from "./vision-scheduler.ts";
import {
	extractVideoFrames,
	inspectVideoTranscoder,
	type VideoFrameInput,
	type VideoFrameResult,
	type VideoFrameOutcome,
	type VideoTranscoderAvailability,
} from "./video-frames.ts";

export { fileIdForBot } from "./local-cache.ts";

const PHOTO_PROMPT = `你在帮一个群聊 bot 理解图片。简短描述：实际可见内容、重要文字/OCR（尤其是界面和报错）、人物或物体、对聊天可能有用的信息、不确定的地方。2-3 句话以内，用中文，直接给描述不要客套。`;

const STICKER_PROMPT = `你在帮一个群聊 bot 理解一张 sticker（聊天表情贴图）。把它理解为一种聊天表达，输出短描述：communicative intent（想表达什么）、emotion、intensity、gesture/画面要点、可见文字。一两句话，用中文，例如"得意的赞同，smug/amused，中等强度"。直接给描述不要客套。`;

const VIDEO_PROMPT = `你在帮一个群聊 bot 理解一段视频。下面是按时间顺序抽取的代表帧。综合描述动作或变化、人物与物体、重要文字/OCR、对聊天有用的信息和不确定处。2-3 句话以内，用中文，直接给描述不要客套；不要把单帧猜测说成确定的完整情节。`;

const VIDEO_STICKER_PROMPT = `你在帮一个群聊 bot 理解一个 video sticker。下面是按时间顺序抽取的代表帧。把它理解为聊天表达，概括动作变化、communicative intent、emotion、intensity、gesture/画面要点和可见文字。一两句话，用中文，直接给描述不要客套。`;

export const VISION_TIMEOUT_MS = 90_000;
export const VISION_MAX_OUTPUT_TOKENS = 256;

export type VisionKind = "photo" | "sticker" | "video";
export type VisionBytesBucket = MediaBytesBucket | "gte_512_kib";
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
	| VideoFrameOutcome
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
	frames?: number;
	providerCalled?: boolean;
}

export interface VisionDescriptionResult {
	text: string | null;
	telemetry: VisionTelemetry;
}

export interface VisionImageInput {
	bytes: Uint8Array;
	mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
	position?: number;
}

export interface VisionDescribeInput {
	kind: VisionKind;
	sourceBytes: number;
	images: VisionImageInput[];
	videoSticker?: boolean;
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
	/** Lets a routed bot reuse media received through another configured bot without crossing file_id ownership. */
	botApis?: ReadonlyMap<string, MediaDownloadApi>;
	/** Deterministic extraction seam; production uses ffprobe + ffmpeg. */
	extractFrames?: (input: VideoFrameInput) => Promise<VideoFrameResult>;
	/** Startup snapshot: missing optional tools skip before Telegram download and never block chat. */
	videoTranscoder?: VideoTranscoderAvailability;
}

interface PiVisionExecutorOptions {
	convert?: typeof convertToPng;
	resize?: typeof resizeImage;
	monotonicNow?: () => number;
}

type VisionModelRuntime = Pick<ModelRuntime, "getModel" | "completeSimple">;

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
	frames?: number,
	providerCalled = false,
): VisionTelemetry {
	return {
		kind,
		sourceBytesBucket: bytesBucket(sourceBytes, "gte_512_kib"),
		convertedBytesBucket: convertedBytes == null ? "unavailable" : bytesBucket(convertedBytes, "gte_512_kib"),
		latencyMs: Math.max(0, Math.round(latencyMs)),
		inputTokens: boundedNumber(message?.usage.input),
		outputTokens: boundedNumber(message?.usage.output),
		reasoningTokens: boundedNumber(message?.usage.reasoning),
		cost: boundedNumber(message?.usage.cost.total),
		outcome,
		...(frames == null ? {} : { frames }),
		...(providerCalled ? { providerCalled: true } : {}),
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
	const readinessFailure = !model ? "unknown_model" : !model.input.includes("image") ? "image_input_unsupported" : null;
	const convert = options.convert ?? convertToPng;
	const resize = options.resize ?? resizeImage;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());

	return {
		modelRef: selection.canonical,
		provider: selection.provider,
		model: selection.model,
		readinessFailure,
		async describe(input): Promise<VisionDescriptionResult> {
			const startedAt = monotonicNow();
			const sourceBytes = input.sourceBytes;

			const images: Array<{ data: string; mimeType: string; position?: number }> = [];
			let convertedBytes = 0;
			let converted = input.kind === "video";
			for (const source of input.images) {
				let bytes: Uint8Array = source.bytes;
				let mimeType: string = source.mimeType;
				if (source.mimeType === "image/webp" || source.mimeType === "image/gif") {
					try {
						const convertedImage = await convert(Buffer.from(bytes).toString("base64"), source.mimeType);
						if (!convertedImage) throw new Error("conversion failed");
						bytes = new Uint8Array(Buffer.from(convertedImage.data, "base64"));
						mimeType = convertedImage.mimeType;
						converted = true;
					} catch {
						return {
							text: null,
							telemetry: usageTelemetry(
								input.kind,
								sourceBytes,
								converted ? convertedBytes : null,
								monotonicNow() - startedAt,
								"conversion_failed",
								undefined,
								input.images.length,
							),
						};
					}
				}
				if (input.kind !== "video") {
					// Video frames are already bounded by ffmpeg scale=1280; only static images need a cap.
					// A resize failure falls back to the original image rather than failing the description.
					const resized = await resize(bytes, mimeType).catch(() => null);
					if (resized) {
						bytes = new Uint8Array(Buffer.from(resized.data, "base64"));
						mimeType = resized.mimeType;
						converted = converted || resized.wasResized;
					}
				}
				convertedBytes += bytes.byteLength;
				images.push({
					data: Buffer.from(bytes).toString("base64"),
					mimeType,
					...(source.position == null ? {} : { position: source.position }),
				});
			}

			const prompt =
				input.kind === "video"
					? input.videoSticker
						? VIDEO_STICKER_PROMPT
						: VIDEO_PROMPT
					: input.kind === "sticker"
						? STICKER_PROMPT
						: PHOTO_PROMPT;
			const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
				{ type: "text", text: prompt },
			];
			for (let index = 0; index < images.length; index++) {
				const image = images[index]!;
				if (input.kind === "video") {
					const percent = Math.round((image.position ?? 0) * 100);
					content.push({ type: "text", text: `Frame ${index + 1}/${images.length} · ${percent}%` });
				}
				content.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}

			const context: Context = {
				messages: [
					{
						role: "user",
						content,
						timestamp: Date.now(),
					},
				],
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
						converted ? convertedBytes : null,
						monotonicNow() - startedAt,
						classifyPiProviderFailure(error),
						undefined,
						input.images.length,
						true,
					),
				};
			}

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const category = classifyPiProviderFailure(new Error(message.errorMessage ?? message.stopReason));
				return {
					text: null,
					telemetry: usageTelemetry(
						input.kind,
						sourceBytes,
						converted ? convertedBytes : null,
						monotonicNow() - startedAt,
						category,
						message,
						input.images.length,
						true,
					),
				};
			}

			const text = contentText(message.content).trim();
			const outcome: VisionOutcome = text ? "ok" : "empty_response";
			return {
				text: text || null,
				telemetry: usageTelemetry(
					input.kind,
					sourceBytes,
					converted ? convertedBytes : null,
					monotonicNow() - startedAt,
					outcome,
					message,
					input.images.length,
					true,
				),
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
	return dedupeInFlight(inFlightByDb, db, fileUniqueId, () =>
		ensureVisionInner(db, api, botId, fileUniqueId, executor, options),
	);
}

function emitTelemetry(options: EnsureVisionOptions, telemetry: VisionTelemetry): void {
	try {
		options.onTelemetry?.(telemetry);
	} catch {
		log.error("vision", "telemetry_sink_failed", { category: "observer_failed" });
	}
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
	const media = db.query("SELECT kind, mime, vision FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		mime: string | null;
		vision: string | null;
	} | null;
	if (!media || !isVisionMedia(media.kind, media.mime)) return null;
	const video = isVideoMedia(media.kind, media.mime);
	const kind: VisionKind = video ? "video" : (media.kind as "photo" | "sticker");
	if (media.vision) {
		const cached = JSON.parse(media.vision) as { text?: string | null };
		return cached.text?.trim() || null;
	}
	if (video) {
		const transcoder =
			options.videoTranscoder ?? (options.extractFrames ? { ffmpeg: true, ffprobe: true } : inspectVideoTranscoder());
		if (!transcoder.ffmpeg || !transcoder.ffprobe) {
			emitTelemetry(options, emptyTelemetry(kind, "video_transcoder_unavailable", monotonicNow() - startedAt));
			return null;
		}
		if (options.scheduler) {
			return options.scheduler.schedule(() =>
				ensureVisionPrepared(db, api, botId, fileUniqueId, executor, options, media, video, kind, startedAt, true),
			);
		}
	}
	return ensureVisionPrepared(db, api, botId, fileUniqueId, executor, options, media, video, kind, startedAt, false);
}

async function ensureVisionPrepared(
	db: Database,
	api: BotApi,
	botId: string,
	fileUniqueId: string,
	executor: VisionExecutor,
	options: EnsureVisionOptions,
	media: { kind: string; mime: string | null; vision: string | null },
	initialVideo: boolean,
	initialKind: VisionKind,
	startedAt: number,
	providerSlotReserved: boolean,
): Promise<string | null> {
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	let video = initialVideo;
	let kind = initialKind;
	const local = await ensureLocalMedia(db, api, botId, fileUniqueId, {
		cacheDir: options.cacheDir,
		botApis: options.botApis,
	});
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
	if (!video && media.kind === "sticker" && local.mimeType.startsWith("video/")) {
		video = true;
		kind = "video";
	}

	let images: VisionImageInput[];
	if (video) {
		const prepared = await (options.extractFrames ?? extractVideoFrames)({
			sourcePath: local.sourcePath,
			sourceBytes: local.bytes,
			sourceExtension: local.sourceExtension,
		});
		if (!prepared.ok) {
			if (prepared.outcome !== "video_transcoder_unavailable") {
				db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
					JSON.stringify({ model: "none", kind, text: null, outcome: prepared.outcome, at: Date.now() }),
					fileUniqueId,
				);
			}
			emitTelemetry(
				options,
				usageTelemetry(kind, local.bytes.byteLength, null, monotonicNow() - startedAt, prepared.outcome),
			);
			return null;
		}
		images = prepared.frames;
	} else {
		if (!staticMediaMimeForPath(`source.${local.sourceExtension}`)) {
			emitTelemetry(options, emptyTelemetry(kind, "unsupported_format", monotonicNow() - startedAt));
			return null;
		}
		images = [{ bytes: local.bytes, mimeType: local.mimeType as VisionImageInput["mimeType"] }];
	}

	const describe = () =>
		executor.describe({
			kind,
			sourceBytes: local.bytes.byteLength,
			images,
			...(video && media.kind === "sticker" ? { videoSticker: true } : {}),
		});
	const result: VisionDescriptionResult =
		options.scheduler && !providerSlotReserved ? await options.scheduler.schedule(describe) : await describe();
	const text = result.text?.trim() || null;
	db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
		JSON.stringify({ model: executor.modelRef, kind, text, outcome: result.telemetry.outcome, at: Date.now() }),
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
