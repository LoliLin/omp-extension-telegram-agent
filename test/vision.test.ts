process.env.TZ = "Asia/Singapore";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVision } from "../src/media/vision.ts";

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

function fakeApi() {
	return {
		getFile: async () => ({ file_path: "photos/source.png" }),
		downloadFile: async () => new Uint8Array([1, 2, 3]),
	};
}

describe("vision persistence updates (REQ-UI-0006)", () => {
	test("a new description persists once and emits one identity-only update", async () => {
		insertMedia("photo-1");
		let describeCalls = 0;
		const updates: { fileUniqueId: string; text: string }[] = [];
		const options = {
			cacheDir,
			describe: async () => {
				describeCalls++;
				return "  一只猫坐在窗边  ";
			},
			onPersist: (fileUniqueId: string, text: string) => updates.push({ fileUniqueId, text }),
		};

		const [first, concurrent] = await Promise.all([
			ensureVision(db, fakeApi() as never, "A", "model", "photo-1", options),
			ensureVision(db, fakeApi() as never, "A", "model", "photo-1", options),
		]);
		const cached = await ensureVision(db, fakeApi() as never, "A", "model", "photo-1", options);

		expect(first).toBe("一只猫坐在窗边");
		expect(concurrent).toBe(first);
		expect(cached).toBe(first);
		expect(describeCalls).toBe(1);
		expect(updates).toEqual([{ fileUniqueId: "photo-1", text: "一只猫坐在窗边" }]);
		const stored = db.query("SELECT local_path, vision FROM media WHERE file_unique_id = 'photo-1'").get() as { local_path: string; vision: string };
		expect(stored.local_path).toBe(join(cacheDir, "photo-1.png"));
		expect(JSON.parse(stored.vision).text).toBe("一只猫坐在窗边");
	});

	test("empty and unsupported results never publish a vision update", async () => {
		insertMedia("empty-photo");
		insertMedia("animated-sticker", "sticker");
		const updates: unknown[] = [];
		await ensureVision(db, fakeApi() as never, "A", "model", "empty-photo", {
			cacheDir,
			describe: async () => "   ",
			onPersist: (...args) => updates.push(args),
		});
		await ensureVision(db, {
			getFile: async () => ({ file_path: "stickers/animated.tgs" }),
		} as never, "A", "model", "animated-sticker", {
			cacheDir,
			onPersist: (...args) => updates.push(args),
		});

		expect(updates).toEqual([]);
		expect(db.query("SELECT json_extract(vision, '$.unsupported') unsupported FROM media WHERE file_unique_id = 'animated-sticker'").get()).toEqual({ unsupported: 1 });
	});
});
