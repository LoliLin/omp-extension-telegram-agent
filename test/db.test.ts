import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";

const cleanup = new Set<string>();

afterEach(() => {
	for (const path of cleanup) {
		for (const suffix of ["", "-wal", "-shm"]) {
			try { unlinkSync(`${path}${suffix}`); } catch {}
		}
	}
	cleanup.clear();
});

describe("database migrations", () => {
	test("REQ-UI-0009 adds cache_write once and preserves legacy telemetry", () => {
		const path = join(tmpdir(), `tg-legacy-telemetry-${process.pid}-${Date.now()}.db`);
		cleanup.add(path);
		const legacy = new Database(path, { create: true });
		legacy.exec(`CREATE TABLE llm_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			bot_id TEXT NOT NULL,
			ts INTEGER NOT NULL,
			model TEXT NOT NULL,
			epoch INTEGER NOT NULL,
			context_tokens INTEGER,
			cache_read INTEGER,
			cache_miss INTEGER,
			output_tokens INTEGER,
			reasoning_tokens INTEGER,
			latency_ms INTEGER,
			cost REAL,
			compaction INTEGER NOT NULL DEFAULT 0,
			system_hash TEXT,
			tools_hash TEXT,
			messages_hash TEXT
		)`);
		legacy.query("INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('A', 1, 'm', 1, 100, 80, 20, 5, 0.01)").run();
		legacy.close();

		for (let pass = 0; pass < 2; pass++) {
			const db = openDb(path);
			const columns = db.query("PRAGMA table_info(llm_runs)").all() as { name: string }[];
			expect(columns.filter((column) => column.name === "cache_write")).toHaveLength(1);
			expect(db.query("SELECT cache_read, cache_write, cache_miss FROM llm_runs WHERE id = 1").get()).toEqual({
				cache_read: 80,
				cache_write: 0,
				cache_miss: 20,
			});
			db.close();
		}
	});
});
