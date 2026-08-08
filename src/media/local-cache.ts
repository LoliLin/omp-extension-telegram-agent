import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";

export const MEDIA_CACHE_MAX_BYTES = 1024 * 1024;
export const MEDIA_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;

export type StaticMediaMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface MediaDownloadApi {
	getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }>;
	downloadFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export type LocalMediaFailure =
	| "aborted"
	| "media_unavailable"
	| "file_id_unavailable"
	| "telegram_file_unavailable"
	| "unsupported_format"
	| "telegram_download_failed"
	| "empty_file"
	| "download_oversize";

export type LocalMediaCacheOutcome = "cached" | "ready" | "oversize" | "install_failed";

export type LocalMediaResult =
	| {
			ok: true;
			kind: "photo" | "sticker";
			bytes: Uint8Array;
			mimeType: StaticMediaMime;
			mediaPath: string | null;
			cacheOutcome: LocalMediaCacheOutcome;
	  }
	| { ok: false; outcome: LocalMediaFailure };

export interface MediaCacheFileOps {
	mkdir(path: string): void;
	read(path: string): Uint8Array;
	stat(path: string): { isFile(): boolean; size: number };
	writeExclusive(path: string, bytes: Uint8Array): void;
	rename(from: string, to: string): void;
	chmod(path: string, mode: number): void;
	remove(path: string): void;
}

const defaultFileOps: MediaCacheFileOps = {
	mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o700 }),
	read: (path) => new Uint8Array(readFileSync(path)),
	stat: (path) => statSync(path),
	writeExclusive: (path, bytes) => {
		const fd = openSync(path, "wx", 0o600);
		try {
			writeFileSync(fd, bytes);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	},
	rename: renameSync,
	chmod: chmodSync,
	remove: (path) => rmSync(path, { force: true }),
};

export interface EnsureLocalMediaOptions {
	cacheDir?: string;
	signal?: AbortSignal;
	fileOps?: MediaCacheFileOps;
}

let temporarySequence = 0;

export function staticMediaMimeForPath(path: string): StaticMediaMime | null {
	const extension = extname(path).slice(1).toLowerCase();
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	if (extension === "png") return "image/png";
	if (extension === "webp") return "image/webp";
	if (extension === "gif") return "image/gif";
	return null;
}

function normalizedExtension(path: string): string | null {
	const extension = extname(path).slice(1).toLowerCase();
	return staticMediaMimeForPath(path) ? extension : null;
}

export function fileIdForBot(db: Database, botId: string, fileUniqueId: string): string | null {
	const row = db
		.query("SELECT file_id FROM media_file_ids WHERE bot_id = ? AND file_unique_id = ?")
		.get(botId, fileUniqueId) as { file_id: string } | null;
	return row?.file_id ?? null;
}

export function isDisplayReadyPath(path: string | null, fileOps: MediaCacheFileOps = defaultFileOps): boolean {
	if (!path || !staticMediaMimeForPath(path)) return false;
	try {
		const stat = fileOps.stat(path);
		return stat.isFile() && stat.size > 0 && stat.size <= MEDIA_CACHE_MAX_BYTES;
	} catch {
		return false;
	}
}

function readExisting(
	path: string,
	fileOps: MediaCacheFileOps,
): { bytes: Uint8Array; mimeType: StaticMediaMime } | null {
	const mimeType = staticMediaMimeForPath(path);
	if (!mimeType) return null;
	try {
		const stat = fileOps.stat(path);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MEDIA_DOWNLOAD_MAX_BYTES) return null;
		const bytes = fileOps.read(path);
		if (bytes.byteLength !== stat.size || bytes.byteLength === 0 || bytes.byteLength > MEDIA_DOWNLOAD_MAX_BYTES)
			return null;
		return { bytes, mimeType };
	} catch {
		return null;
	}
}

/** Install complete bytes with owner-only permissions, then expose them with one rename. */
export function installMediaCacheFile(
	cacheDir: string,
	fileUniqueId: string,
	extension: string,
	bytes: Uint8Array,
	fileOps: MediaCacheFileOps = defaultFileOps,
): string {
	fileOps.mkdir(cacheDir);
	const basename = createHash("sha256").update(fileUniqueId).digest("hex").slice(0, 32);
	const target = join(cacheDir, `${basename}.${extension}`);
	const temporary = `${target}.${process.pid}.${temporarySequence++}.tmp`;
	let renamed = false;
	try {
		fileOps.writeExclusive(temporary, bytes);
		fileOps.chmod(temporary, 0o600);
		fileOps.rename(temporary, target);
		renamed = true;
		fileOps.chmod(target, 0o600);
		return target;
	} catch {
		try {
			fileOps.remove(renamed ? target : temporary);
		} catch {
			// A failed cleanup must not expose the original filesystem error or media identity.
		}
		throw new Error("media cache install failed");
	}
}

const inFlightByDb = new WeakMap<Database, Map<string, Promise<LocalMediaResult>>>();

/** Share Telegram download and atomic cache installation across UI precache and vision. */
export function ensureLocalMedia(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions = {},
): Promise<LocalMediaResult> {
	let inFlight = inFlightByDb.get(db);
	if (!inFlight) {
		inFlight = new Map();
		inFlightByDb.set(db, inFlight);
	}
	const existing = inFlight.get(fileUniqueId);
	if (existing) return existing;
	const promise = ensureLocalMediaInner(db, api, botId, fileUniqueId, options).finally(() => {
		inFlight!.delete(fileUniqueId);
	});
	inFlight.set(fileUniqueId, promise);
	return promise;
}

async function ensureLocalMediaInner(
	db: Database,
	api: MediaDownloadApi,
	botId: string,
	fileUniqueId: string,
	options: EnsureLocalMediaOptions,
): Promise<LocalMediaResult> {
	const fileOps = options.fileOps ?? defaultFileOps;
	const signal = options.signal;
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	const media = db.query("SELECT kind, local_path FROM media WHERE file_unique_id = ?").get(fileUniqueId) as {
		kind: string;
		local_path: string | null;
	} | null;
	if (!media || (media.kind !== "photo" && media.kind !== "sticker")) {
		return { ok: false, outcome: "media_unavailable" };
	}
	const kind = media.kind;
	if (media.local_path) {
		const existing = readExisting(media.local_path, fileOps);
		if (existing) {
			return {
				ok: true,
				kind,
				...existing,
				mediaPath: existing.bytes.byteLength <= MEDIA_CACHE_MAX_BYTES ? media.local_path : null,
				cacheOutcome: existing.bytes.byteLength <= MEDIA_CACHE_MAX_BYTES ? "cached" : "oversize",
			};
		}
	}

	const fileId = fileIdForBot(db, botId, fileUniqueId);
	if (!fileId) return { ok: false, outcome: "file_id_unavailable" };
	let remotePath: string | null = null;
	try {
		remotePath = (await api.getFile(fileId, signal)).file_path ?? null;
	} catch {
		return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_file_unavailable" };
	}
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	if (!remotePath) return { ok: false, outcome: "telegram_file_unavailable" };
	const mimeType = staticMediaMimeForPath(remotePath);
	const extension = normalizedExtension(remotePath);
	if (!mimeType || !extension) return { ok: false, outcome: "unsupported_format" };

	let bytes: Uint8Array;
	try {
		bytes = await api.downloadFile(remotePath, signal);
	} catch {
		return { ok: false, outcome: signal?.aborted ? "aborted" : "telegram_download_failed" };
	}
	if (signal?.aborted) return { ok: false, outcome: "aborted" };
	if (bytes.byteLength === 0) return { ok: false, outcome: "empty_file" };
	if (bytes.byteLength > MEDIA_DOWNLOAD_MAX_BYTES) return { ok: false, outcome: "download_oversize" };
	if (bytes.byteLength > MEDIA_CACHE_MAX_BYTES) {
		return { ok: true, kind, bytes, mimeType, mediaPath: null, cacheOutcome: "oversize" };
	}

	let mediaPath: string | null = null;
	try {
		mediaPath = installMediaCacheFile(
			options.cacheDir ?? join(process.cwd(), "data", "media"),
			fileUniqueId,
			extension,
			bytes,
			fileOps,
		);
		if (signal?.aborted) {
			fileOps.remove(mediaPath);
			return { ok: false, outcome: "aborted" };
		}
		db.query("UPDATE media SET local_path = ? WHERE file_unique_id = ?").run(mediaPath, fileUniqueId);
	} catch {
		if (mediaPath) {
			try {
				fileOps.remove(mediaPath);
			} catch {
				// The DB remains authoritative; cleanup failure is intentionally non-sensitive.
			}
		}
		return { ok: true, kind, bytes, mimeType, mediaPath: null, cacheOutcome: "install_failed" };
	}
	return { ok: true, kind, bytes, mimeType, mediaPath, cacheOutcome: "ready" };
}
