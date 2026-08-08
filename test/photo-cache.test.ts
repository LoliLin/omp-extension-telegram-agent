process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import {
	MEDIA_CACHE_MAX_BYTES,
	type MediaCacheFileOps,
	type MediaDownloadApi,
} from "../src/media/local-cache.ts";
import {
	PHOTO_CACHE_BACKFILL_LIMIT,
	PHOTO_CACHE_CONCURRENCY,
	PHOTO_CACHE_MAX_PENDING,
	PhotoCacheQueue,
	type PhotoCacheTelemetry,
} from "../src/media/photo-cache.ts";
import {
	ensureVision,
	type VisionExecutor,
} from "../src/media/vision.ts";

let db: Database;
let cacheDir: string;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	cacheDir = mkdtempSync(join(tmpdir(), "photo-cache-test-"));
});

afterEach(() => {
	db.close();
	rmSync(cacheDir, { recursive: true, force: true });
});

function insertPhoto(fileUniqueId: string, index: number, botIds: readonly string[] = ["A"]): void {
	db.query("INSERT INTO media (file_unique_id, kind) VALUES (?, 'photo')").run(fileUniqueId);
	for (const botId of botIds) {
		db.query("INSERT INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)")
			.run(botId, `file-${botId}-${fileUniqueId}`, fileUniqueId);
	}
	db.query(
		`INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, media, first_seen_by)
		 VALUES (-1001, ?, ?, 111, 'Alice', 0, ?, ?)`,
	).run(index, index, JSON.stringify({ kind: "photo", file_unique_id: fileUniqueId }), botIds[0] ?? "A");
}

function messageRow(messageId: number): { media: string | null } {
	return db.query("SELECT media FROM messages WHERE chat_id = -1001 AND message_id = ?").get(messageId) as { media: string | null };
}

function realFileOps(): MediaCacheFileOps {
	return {
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
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
		await Bun.sleep(1);
	}
}

describe("durable-first photo cache (REQ-UI-0014)", () => {
	test("AC1: a durable placeholder becomes one owner-only cached path and additive ready event", async () => {
		insertPhoto("private-photo-1", 1);
		const before = new IpcServer(db, "/tmp/unused-photo-cache.sock", new Map(), new Map())
			.msgToItem(db.query("SELECT * FROM messages WHERE message_id = 1").get() as never);
		expect(before.mediaPath).toBeNull();

		const calls = { getFile: 0, download: 0 };
		const ready: { fileUniqueId: string; mediaPath: string }[] = [];
		const telemetry: PhotoCacheTelemetry[] = [];
		const api: MediaDownloadApi = {
			getFile: async () => {
				calls.getFile++;
				return { file_path: "photos/source.jpg" };
			},
			downloadFile: async () => {
				calls.download++;
				return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
			},
		};
		const queue = new PhotoCacheQueue(db, new Map([["A", api]]), {
			cacheDir,
			onReady: (fileUniqueId, mediaPath) => ready.push({ fileUniqueId, mediaPath }),
			onTelemetry: (event) => telemetry.push(event),
		});

		expect(queue.scheduleMessage("A", messageRow(1))).toBe(true);
		expect((db.query("SELECT local_path FROM media WHERE file_unique_id = 'private-photo-1'").get() as { local_path: string | null }).local_path).toBeNull();
		await queue.whenIdle();

		expect(calls).toEqual({ getFile: 1, download: 1 });
		expect(ready).toHaveLength(1);
		const path = ready[0]!.mediaPath;
		expect(path.startsWith(cacheDir)).toBe(true);
		expect(path).not.toContain("private-photo-1");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(new Uint8Array(readFileSync(path))).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
		const after = new IpcServer(db, "/tmp/unused-photo-cache.sock", new Map(), new Map())
			.msgToItem(db.query("SELECT * FROM messages WHERE message_id = 1").get() as never);
		expect(after.mediaPath).toBe(path);
		expect(queue.schedule("A", "private-photo-1")).toBe(false);
		expect(telemetry).toEqual([{
			event: "media_cache_ready",
			kind: "photo",
			outcome: "ready",
			bytesBucket: "lt_32_kib",
			queueDepth: 0,
		}]);
		await queue.stop();
	});

	test("AC2: duplicate bot schedules and concurrent vision share one Telegram download", async () => {
		insertPhoto("shared-photo", 2, ["A", "B"]);
		let getFileCalls = 0;
		let downloadCalls = 0;
		let describeCalls = 0;
		const ready: string[] = [];
		const api: MediaDownloadApi = {
			getFile: async () => {
				getFileCalls++;
				return { file_path: "photos/shared.png" };
			},
			downloadFile: async () => {
				downloadCalls++;
				await Bun.sleep(5);
				return new Uint8Array([1, 2, 3]);
			},
		};
		const executor: VisionExecutor = {
			modelRef: "openai-codex/gpt-5.6-luna:low",
			provider: "openai-codex",
			model: "gpt-5.6-luna",
			readinessFailure: null,
			describe: async () => {
				describeCalls++;
				return {
					text: "cached vision",
					telemetry: {
						kind: "photo", sourceBytesBucket: "lt_32_kib", convertedBytesBucket: "unavailable",
						latencyMs: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cost: 0, outcome: "ok",
					},
				};
			},
		};
		const queue = new PhotoCacheQueue(db, new Map([["A", api], ["B", api]]), {
			cacheDir,
			onReady: (_identity, path) => ready.push(path),
		});

		expect(queue.schedule("A", "shared-photo")).toBe(true);
		expect(queue.schedule("B", "shared-photo")).toBe(false);
		const vision = ensureVision(db, api as never, "B", "shared-photo", executor, { cacheDir });
		await Promise.all([vision, queue.whenIdle()]);
		const cachedVision = await ensureVision(db, api as never, "A", "shared-photo", executor, { cacheDir });

		expect(cachedVision).toBe("cached vision");
		expect({ getFileCalls, downloadCalls, describeCalls }).toEqual({ getFileCalls: 1, downloadCalls: 1, describeCalls: 1 });
		expect(ready).toHaveLength(1);
		expect((db.query("SELECT local_path FROM media WHERE file_unique_id = 'shared-photo'").get() as { local_path: string | null }).local_path).toBe(ready[0]!);
		await queue.stop();
	});

	test("AC3: backfill takes the newest 100 and workers never exceed two", async () => {
		for (let index = 0; index <= PHOTO_CACHE_BACKFILL_LIMIT; index++) insertPhoto(`backfill-${index}`, index + 10);
		let activeDownloads = 0;
		let peakDownloads = 0;
		const downloaded = new Set<string>();
		const api: MediaDownloadApi = {
			getFile: async (fileId) => ({ file_path: `photos/${fileId}.jpg` }),
			downloadFile: async (path) => {
				activeDownloads++;
				peakDownloads = Math.max(peakDownloads, activeDownloads);
				downloaded.add(path);
				await Bun.sleep(1);
				activeDownloads--;
				return new Uint8Array([1]);
			},
		};
		const queue = new PhotoCacheQueue(db, new Map([["A", api]]), { cacheDir });

		expect(queue.scheduleBackfill()).toBe(PHOTO_CACHE_BACKFILL_LIMIT);
		await queue.whenIdle();

		expect(downloaded.size).toBe(PHOTO_CACHE_BACKFILL_LIMIT);
		expect([...downloaded].some((path) => path.includes("backfill-0"))).toBe(false);
		expect([...downloaded].some((path) => path.includes(`backfill-${PHOTO_CACHE_BACKFILL_LIMIT}`))).toBe(true);
		expect(peakDownloads).toBe(PHOTO_CACHE_CONCURRENCY);
		expect(queue.peakActiveCount).toBe(PHOTO_CACHE_CONCURRENCY);
		expect((db.query("SELECT COUNT(*) count FROM media WHERE local_path IS NOT NULL").get() as { count: number }).count).toBe(PHOTO_CACHE_BACKFILL_LIMIT);
		await queue.stop();
	});

	test("R3: pending overflow is bounded before any worker starts", async () => {
		for (let index = 0; index < 4; index++) insertPhoto(`pending-${index}`, index + 200);
		const telemetry: PhotoCacheTelemetry[] = [];
		const api: MediaDownloadApi = {
			getFile: async () => ({ file_path: "photos/pending.jpg" }),
			downloadFile: async () => new Uint8Array([1]),
		};
		const queue = new PhotoCacheQueue(db, new Map([["A", api]]), {
			cacheDir,
			maxPending: 3,
			onTelemetry: (event) => telemetry.push(event),
		});

		expect([0, 1, 2].map((index) => queue.schedule("A", `pending-${index}`))).toEqual([true, true, true]);
		expect(queue.pendingCount).toBe(3);
		expect(queue.schedule("A", "pending-3")).toBe(false);
		expect(telemetry).toContainEqual({
			event: "media_cache_skip", kind: "photo", outcome: "queue_overflow", bytesBucket: "unavailable", queueDepth: 3,
		});
		expect(PHOTO_CACHE_MAX_PENDING).toBe(128);
		await queue.stop();
	});

	test("AC5/R8: network, format, size, write, and rename failures leave no partial path or identity telemetry", async () => {
		const privateIdentity = "private-media-identity";
		const privateRemotePath = "photos/private-remote-path.jpg";
		const cases: {
			name: string;
			api: MediaDownloadApi;
			fileOps?: MediaCacheFileOps;
			expected: PhotoCacheTelemetry["outcome"];
		}[] = [
			{
				name: "get-file",
				api: { getFile: async () => { throw new Error(privateIdentity); }, downloadFile: async () => new Uint8Array([1]) },
				expected: "telegram_file_unavailable",
			},
			{
				name: "missing-path",
				api: { getFile: async () => ({}), downloadFile: async () => new Uint8Array([1]) },
				expected: "telegram_file_unavailable",
			},
			{
				name: "extension",
				api: { getFile: async () => ({ file_path: "photos/private.webm" }), downloadFile: async () => new Uint8Array([1]) },
				expected: "unsupported_format",
			},
			{
				name: "download",
				api: { getFile: async () => ({ file_path: privateRemotePath }), downloadFile: async () => { throw new Error(privateRemotePath); } },
				expected: "telegram_download_failed",
			},
			{
				name: "oversize",
				api: { getFile: async () => ({ file_path: privateRemotePath }), downloadFile: async () => new Uint8Array(MEDIA_CACHE_MAX_BYTES + 1) },
				expected: "oversize",
			},
			{
				name: "write",
				api: { getFile: async () => ({ file_path: privateRemotePath }), downloadFile: async () => new Uint8Array([1]) },
				fileOps: { ...realFileOps(), writeExclusive: () => { throw new Error(privateIdentity); } },
				expected: "install_failed",
			},
			{
				name: "rename",
				api: { getFile: async () => ({ file_path: privateRemotePath }), downloadFile: async () => new Uint8Array([1]) },
				fileOps: { ...realFileOps(), rename: () => { throw new Error(privateIdentity); } },
				expected: "install_failed",
			},
		];

		const allTelemetry: PhotoCacheTelemetry[] = [];
		for (let index = 0; index < cases.length; index++) {
			const fixture = cases[index]!;
			const identity = `${privateIdentity}-${fixture.name}`;
			insertPhoto(identity, index + 400);
			const queue = new PhotoCacheQueue(db, new Map([["A", fixture.api]]), {
				cacheDir,
				fileOps: fixture.fileOps,
				onTelemetry: (event) => allTelemetry.push(event),
			});
			expect(queue.schedule("A", identity)).toBe(true);
			await queue.whenIdle();
			expect(allTelemetry.at(-1)?.outcome).toBe(fixture.expected);
			expect((db.query("SELECT local_path FROM media WHERE file_unique_id = ?").get(identity) as { local_path: string | null }).local_path).toBeNull();
			await queue.stop();
		}

		expect(readdirSync(cacheDir)).toEqual([]);
		const encoded = JSON.stringify(allTelemetry);
		expect(encoded).not.toContain(privateIdentity);
		expect(encoded).not.toContain(privateRemotePath);
		expect(allTelemetry.every((event) => Object.keys(event).sort().join(",") === "bytesBucket,event,kind,outcome,queueDepth")).toBe(true);
	});

	test("R7: shutdown aborts active work and suppresses every late DB/IPC side effect", async () => {
		insertPhoto("shutdown-photo", 500);
		let release!: (bytes: Uint8Array) => void;
		const download = new Promise<Uint8Array>((resolve) => { release = resolve; });
		const ready: unknown[] = [];
		const api: MediaDownloadApi = {
			getFile: async () => ({ file_path: "photos/shutdown.jpg" }),
			downloadFile: async () => await download,
		};
		const queue = new PhotoCacheQueue(db, new Map([["A", api]]), {
			cacheDir,
			stopTimeoutMs: 0,
			onReady: (...args) => ready.push(args),
		});
		queue.schedule("A", "shutdown-photo");
		await waitUntil(() => queue.activeCount === 1);
		await queue.stop();
		release(new Uint8Array([1, 2, 3]));
		await waitUntil(() => queue.activeCount === 0);

		expect(ready).toEqual([]);
		expect((db.query("SELECT local_path FROM media WHERE file_unique_id = 'shutdown-photo'").get() as { local_path: string | null }).local_path).toBeNull();
		expect(readdirSync(cacheDir)).toEqual([]);
		expect(queue.schedule("A", "shutdown-photo")).toBe(false);
	});
});
