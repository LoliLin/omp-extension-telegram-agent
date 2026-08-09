import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import {
	ensureLocalMedia,
	isDisplayReadyPath,
	MEDIA_CACHE_MAX_BYTES,
	type EnsureLocalMediaOptions,
	type LocalMediaCacheOutcome,
	type LocalMediaFailure,
	type MediaDownloadApi,
} from "./local-cache.ts";

export const PHOTO_CACHE_CONCURRENCY = 2;
export const PHOTO_CACHE_MAX_PENDING = 128;
export const PHOTO_CACHE_BACKFILL_LIMIT = 100;

export type PhotoCacheBytesBucket = "unavailable" | "lt_32_kib" | "32_128_kib" | "128_512_kib" | "512_kib_1_mib";
export type PhotoCacheOutcome = LocalMediaFailure | LocalMediaCacheOutcome | "queue_overflow" | "observer_failed";

export interface PhotoCacheTelemetry {
	event: "media_cache_ready" | "media_cache_skip" | "media_cache_error";
	kind: "photo";
	outcome: PhotoCacheOutcome;
	bytesBucket: PhotoCacheBytesBucket;
	queueDepth: number;
}

export interface PhotoCacheOptions extends EnsureLocalMediaOptions {
	concurrency?: number;
	maxPending?: number;
	backfillLimit?: number;
	onReady?: (fileUniqueId: string, mediaPath: string) => void;
	onTelemetry?: (telemetry: PhotoCacheTelemetry) => void;
	stopTimeoutMs?: number;
}

interface PhotoJob {
	botId: string;
	fileUniqueId: string;
}

function bytesBucket(bytes: number): PhotoCacheBytesBucket {
	if (bytes < 32 * 1024) return "lt_32_kib";
	if (bytes < 128 * 1024) return "32_128_kib";
	if (bytes < 512 * 1024) return "128_512_kib";
	return "512_kib_1_mib";
}

/** Bounded, non-blocking photo cache queue owned by the daemon lifecycle. */
export class PhotoCacheQueue {
	private readonly queue: PhotoJob[] = [];
	private readonly scheduled = new Set<string>();
	private readonly activeTasks = new Set<Promise<void>>();
	private readonly idleWaiters = new Set<() => void>();
	private readonly controller = new AbortController();
	private readonly concurrency: number;
	private readonly maxPending: number;
	private readonly backfillLimit: number;
	private readonly stopTimeoutMs: number;
	private active = 0;
	private peak = 0;
	private stopped = false;

	constructor(
		private readonly db: Database,
		private readonly apis: ReadonlyMap<string, MediaDownloadApi>,
		private readonly options: PhotoCacheOptions = {},
	) {
		this.concurrency = Math.min(
			PHOTO_CACHE_CONCURRENCY,
			Math.max(1, Math.floor(options.concurrency ?? PHOTO_CACHE_CONCURRENCY)),
		);
		this.maxPending = Math.min(
			PHOTO_CACHE_MAX_PENDING,
			Math.max(1, Math.floor(options.maxPending ?? PHOTO_CACHE_MAX_PENDING)),
		);
		this.backfillLimit = Math.min(
			PHOTO_CACHE_BACKFILL_LIMIT,
			Math.max(1, Math.floor(options.backfillLimit ?? PHOTO_CACHE_BACKFILL_LIMIT)),
		);
		this.stopTimeoutMs = Math.max(0, Math.floor(options.stopTimeoutMs ?? 5_000));
	}

	get pendingCount(): number {
		return this.queue.length;
	}
	get activeCount(): number {
		return this.active;
	}
	get peakActiveCount(): number {
		return this.peak;
	}

	/** Queue one canonical photo identity. Returns immediately and never blocks polling. */
	schedule(botId: string, fileUniqueId: string): boolean {
		if (this.stopped || !fileUniqueId || !this.apis.has(botId) || this.scheduled.has(fileUniqueId)) return false;
		const row = this.db.query("SELECT kind, local_path FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
			kind: string;
			local_path: string | null;
		} | null;
		if (!row || row.kind !== "photo") return false;
		if (isDisplayReadyPath(row.local_path, this.options.fileOps)) return false;
		if (this.queue.length >= this.maxPending) {
			this.emit("media_cache_skip", "queue_overflow", "unavailable");
			return false;
		}
		this.scheduled.add(fileUniqueId);
		this.queue.push({ botId, fileUniqueId });
		queueMicrotask(() => this.pump());
		return true;
	}

	/** Schedule a photo referenced by one already-durable canonical message row. */
	scheduleMessage(botId: string, message: { media: string | null }): boolean {
		if (!message.media) return false;
		try {
			const media = JSON.parse(message.media) as { kind?: unknown; file_unique_id?: unknown };
			return media.kind === "photo" && typeof media.file_unique_id === "string"
				? this.schedule(botId, media.file_unique_id)
				: false;
		} catch {
			return false;
		}
	}

	/** Enqueue only the newest bounded set; daemon ready never awaits these jobs. */
	scheduleBackfill(): number {
		if (this.stopped) return 0;
		const rows = this.db
			.query("SELECT file_unique_id FROM media WHERE kind = 'photo' AND local_path IS NULL ORDER BY rowid DESC LIMIT ?")
			.all(this.backfillLimit) as { file_unique_id: string }[];
		let count = 0;
		for (const row of rows) {
			const mappings = this.db
				.query("SELECT bot_id FROM media_file_ids WHERE file_unique_id = ? ORDER BY rowid")
				.all(row.file_unique_id) as { bot_id: string }[];
			const mapping = mappings.find((candidate) => this.apis.has(candidate.bot_id));
			if (mapping && this.schedule(mapping.bot_id, row.file_unique_id)) count++;
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
			new Promise<void>((resolve) => setTimeout(resolve, this.stopTimeoutMs)),
		]);
	}

	private pump(): void {
		if (this.stopped) return;
		while (this.active < this.concurrency && this.queue.length > 0) {
			const job = this.queue.shift()!;
			this.active++;
			this.peak = Math.max(this.peak, this.active);
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

	private async run(job: PhotoJob): Promise<void> {
		const api = this.apis.get(job.botId);
		if (!api || this.stopped) return;
		const result = await ensureLocalMedia(this.db, api, job.botId, job.fileUniqueId, {
			cacheDir: this.options.cacheDir,
			fileOps: this.options.fileOps,
			signal: this.controller.signal,
			botApis: this.apis,
		});
		if (this.stopped || this.controller.signal.aborted) return;
		if (!result.ok) {
			this.emit(
				result.outcome === "unsupported_format" || result.outcome === "download_oversize"
					? "media_cache_skip"
					: "media_cache_error",
				result.outcome,
				"unavailable",
			);
			return;
		}
		const bucket = bytesBucket(Math.min(result.bytes.byteLength, MEDIA_CACHE_MAX_BYTES));
		if (!result.mediaPath) {
			this.emit(
				result.cacheOutcome === "install_failed" ? "media_cache_error" : "media_cache_skip",
				result.cacheOutcome,
				bucket,
			);
			return;
		}
		try {
			this.options.onReady?.(job.fileUniqueId, result.mediaPath);
		} catch {
			this.emit("media_cache_error", "observer_failed", bucket);
			return;
		}
		this.emit("media_cache_ready", result.cacheOutcome, bucket);
	}

	private emit(event: PhotoCacheTelemetry["event"], outcome: PhotoCacheOutcome, bucket: PhotoCacheBytesBucket): void {
		try {
			this.options.onTelemetry?.({ event, kind: "photo", outcome, bytesBucket: bucket, queueDepth: this.queue.length });
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
