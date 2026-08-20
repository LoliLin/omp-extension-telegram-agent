import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { log } from "../observability/log.ts";
import {
	bytesBucket,
	ensureLocalMedia,
	isDisplayReadyPath,
	isVideoMedia,
	MEDIA_CACHE_MAX_BYTES,
	type MediaBytesBucket,
	resolveMediaCachePath,
	type EnsureLocalMediaOptions,
	type LocalMediaCacheOutcome,
	type LocalMediaFailure,
	type MediaDownloadApi,
} from "./local-cache.ts";
import { listReferencedMissingDisplayMediaIds } from "./lifecycle.ts";

export const MEDIA_CACHE_CONCURRENCY = 2;
export const MEDIA_CACHE_MAX_PENDING = 128;
export const MEDIA_CACHE_BACKFILL_LIMIT = 100;
const MEDIA_CACHE_STOP_TIMEOUT_MS = 5_000;

export type DisplayMediaKind = "photo" | "sticker";
export type MediaCacheBytesBucket = MediaBytesBucket | "512_kib_1_mib";
export type MediaCacheOutcome = LocalMediaFailure | LocalMediaCacheOutcome | "queue_overflow" | "observer_failed";

export interface MediaCacheTelemetry {
	event: "media_cache_ready" | "media_cache_skip" | "media_cache_error";
	kind: DisplayMediaKind;
	outcome: MediaCacheOutcome;
	bytesBucket: MediaCacheBytesBucket;
	queueDepth: number;
}

export interface MediaCacheOptions extends EnsureLocalMediaOptions {
	onReady?: (fileUniqueId: string, mediaPath: string) => void;
	onTelemetry?: (telemetry: MediaCacheTelemetry) => void;
}

interface MediaJob {
	botId: string;
	fileUniqueId: string;
	kind: DisplayMediaKind;
}

/** Bounded, sender-agnostic display cache queue for Telegram photos and stickers. */
export class MediaCacheQueue {
	private readonly queue: MediaJob[] = [];
	private readonly scheduled = new Set<string>();
	private readonly activeTasks = new Set<Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
	private readonly controller = new AbortController();
	private active = 0;
	private stopped = false;

	constructor(
		private readonly db: Database,
		private readonly apis: ReadonlyMap<string, MediaDownloadApi>,
		private readonly options: MediaCacheOptions = {},
	) {}

	/** Queue one canonical display-media identity. Returns immediately and never blocks polling. */
	schedule(botId: string, fileUniqueId: string): boolean {
		if (this.stopped || !fileUniqueId || !this.apis.has(botId) || this.scheduled.has(fileUniqueId)) return false;
		const row = this.db
			.query("SELECT kind, mime, local_path FROM media WHERE file_unique_id = ?")
			.get(fileUniqueId) as {
			kind: string;
			mime: string | null;
			local_path: string | null;
		} | null;
		if (
			!row ||
			(row.kind !== "photo" && row.kind !== "sticker") ||
			isVideoMedia(row.kind, row.mime) ||
			row.mime === "application/x-tgsticker"
		)
			return false;
		const kind = row.kind as DisplayMediaKind;
		const cacheDir = this.options.cacheDir ?? join(process.cwd(), "data", "media");
		if (isDisplayReadyPath(resolveMediaCachePath(cacheDir, row.local_path), this.options.fileOps)) return false;
		if (this.queue.length >= MEDIA_CACHE_MAX_PENDING) {
			this.emit(kind, "media_cache_skip", "queue_overflow", "unavailable");
			return false;
		}
		this.scheduled.add(fileUniqueId);
		this.queue.push({ botId, fileUniqueId, kind });
		queueMicrotask(() => this.pump());
		return true;
	}

	/** Schedule display media referenced by one already-durable canonical message row. */
	scheduleMessage(botId: string, message: { media: string | null }): boolean {
		if (!message.media) return false;
		try {
			const media = JSON.parse(message.media) as { kind?: unknown; file_unique_id?: unknown };
			return (media.kind === "photo" || media.kind === "sticker") && typeof media.file_unique_id === "string"
				? this.schedule(botId, media.file_unique_id)
				: false;
		} catch {
			return false;
		}
	}

	/** Enqueue only the newest bounded set; daemon ready never awaits these jobs. */
	scheduleBackfill(): number {
		if (this.stopped) return 0;
		const fileUniqueIds = listReferencedMissingDisplayMediaIds(
			this.db,
			[...this.apis.keys()],
			MEDIA_CACHE_BACKFILL_LIMIT,
		);
		let count = 0;
		for (const fileUniqueId of fileUniqueIds) {
			const mappings = this.db
				.query("SELECT bot_id FROM media_file_ids WHERE file_unique_id = ? ORDER BY rowid")
				.all(fileUniqueId) as { bot_id: string }[];
			const mapping = mappings.find((candidate) => this.apis.has(candidate.bot_id));
			if (mapping && this.schedule(mapping.bot_id, fileUniqueId)) count++;
		}
		return count;
	}

	whenIdle(): Promise<void> {
		if (this.queue.length === 0 && this.active === 0) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.add(resolve));
	}

	/** Stop accepting work, abort network I/O, and never write after this returns. */
	async stop(): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.controller.abort();
			for (const job of this.queue) this.scheduled.delete(job.fileUniqueId);
			this.queue.length = 0;
		}
		if (this.activeTasks.size === 0) {
			this.notifyIdle();
			return;
		}
		await Promise.race([
			Promise.allSettled([...this.activeTasks]),
			new Promise<void>((resolve) => setTimeout(resolve, MEDIA_CACHE_STOP_TIMEOUT_MS)),
		]);
	}

	private pump(): void {
		if (this.stopped) return;
		while (this.active < MEDIA_CACHE_CONCURRENCY && this.queue.length > 0) {
			const job = this.queue.shift()!;
			this.active++;
			const task = this.run(job).finally(() => {
				this.active--;
				this.scheduled.delete(job.fileUniqueId);
				this.activeTasks.delete(task);
				if (!this.stopped) this.pump();
				this.notifyIdle();
			});
			this.activeTasks.add(task);
		}
	}

	private async run(job: MediaJob): Promise<void> {
		if (this.stopped) return;
		// schedule() already verified the bot mapping and `apis` never changes after construction.
		const api = this.apis.get(job.botId)!;
		const result = await ensureLocalMedia(this.db, api, job.botId, job.fileUniqueId, {
			cacheDir: this.options.cacheDir,
			fileOps: this.options.fileOps,
			signal: this.controller.signal,
			botApis: this.apis,
		});
		if (this.stopped || this.controller.signal.aborted) return;
		if (!result.ok) {
			this.emit(
				job.kind,
				result.outcome === "unsupported_format" || result.outcome === "download_oversize"
					? "media_cache_skip"
					: "media_cache_error",
				result.outcome,
				"unavailable",
			);
			return;
		}
		const bucket = bytesBucket(Math.min(result.bytes.byteLength, MEDIA_CACHE_MAX_BYTES), "512_kib_1_mib");
		if (!result.mediaPath) {
			this.emit(
				job.kind,
				result.cacheOutcome === "install_failed" ? "media_cache_error" : "media_cache_skip",
				result.cacheOutcome,
				bucket,
			);
			return;
		}
		try {
			this.options.onReady?.(job.fileUniqueId, result.mediaPath);
		} catch {
			this.emit(job.kind, "media_cache_error", "observer_failed", bucket);
			return;
		}
		this.emit(job.kind, "media_cache_ready", result.cacheOutcome, bucket);
	}

	private emit(
		kind: DisplayMediaKind,
		event: MediaCacheTelemetry["event"],
		outcome: MediaCacheOutcome,
		bucket: MediaCacheBytesBucket,
	): void {
		try {
			this.options.onTelemetry?.({ event, kind, outcome, bytesBucket: bucket, queueDepth: this.queue.length });
		} catch {
			log.error("media_cache", "telemetry_sink_failed", { category: "observer_failed" });
		}
	}

	private notifyIdle(): void {
		if (this.queue.length !== 0 || this.active !== 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}
