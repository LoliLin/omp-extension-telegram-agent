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
			try {
				unlinkSync(`${path}${suffix}`);
			} catch {}
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
		legacy
			.query(
				"INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, cost) VALUES ('A', 1, 'm', 1, 100, 80, 20, 5, 0.01)",
			)
			.run();
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

	test("backfills structural cache estimates only for exact payload prefixes", () => {
		const path = join(tmpdir(), `tg-cache-estimate-${process.pid}-${Date.now()}.db`);
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
			cache_write INTEGER NOT NULL DEFAULT 0,
			cache_miss INTEGER,
			output_tokens INTEGER,
			reasoning_tokens INTEGER,
			latency_ms INTEGER,
			cost REAL,
			compaction INTEGER NOT NULL DEFAULT 0,
			system_hash TEXT,
			tools_hash TEXT,
			messages_hash TEXT,
			provider TEXT,
			api TEXT,
			session_id_hash TEXT,
			cache_retention TEXT
		)`);
		const insert = legacy.query(`INSERT INTO llm_runs
			(bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			 output_tokens, cost, system_hash, tools_hash, messages_hash, provider, api,
			 session_id_hash, cache_retention)
			VALUES ('A', ?, 'm', 1, ?, 0, 0, ?, 1, 0.01, 'system', 'tools', ?,
			        'provider', 'openai-completions', 'session', 'short')`);
		insert.run(1, 1_000, 1_000, JSON.stringify(["a", "b"]));
		insert.run(2, 1_100, 1_100, JSON.stringify(["a", "b", "c"]));
		insert.run(3, 1_200, 1_200, JSON.stringify(["a", "changed", "c", "d"]));
		legacy
			.query(`INSERT INTO llm_runs
			(bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			 output_tokens, cost, system_hash, tools_hash, messages_hash, provider, api,
			 session_id_hash, cache_retention)
			VALUES ('A', 4, 'm', 1, 1300, 900, 0, 400, 1, 0.01, 'system', 'tools', ?,
			        'provider', 'openai-completions', 'session', 'short')`)
			.run(JSON.stringify(["a", "changed", "c", "d", "e"]));
		insert.run(5, 1_400, 1_400, JSON.stringify(["a", "changed", "c", "d", "e", "f"]));
		legacy
			.query(`INSERT INTO llm_runs
			(bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss,
			 output_tokens, cost, system_hash, tools_hash, messages_hash, provider, api,
			 session_id_hash, cache_retention)
			VALUES
			('A', 6, 'm', 1, 1000, 0, 0, 1000, 1, 0.01, 'system', 'tools', '["a"]',
			 'provider', 'openai-completions', 'no-cache-session', 'none'),
			('A', 7, 'm', 1, 1100, 0, 0, 1100, 1, 0.01, 'system', 'tools', '["a","b"]',
			 'provider', 'openai-completions', 'no-cache-session', 'none')`)
			.run();
		legacy.close();

		const db = openDb(path);
		try {
			const columns = db.query("PRAGMA table_info(llm_runs)").all() as { name: string }[];
			expect(columns.filter((column) => column.name === "cache_read_estimated")).toHaveLength(1);
			expect(db.query("SELECT id, cache_read_estimated FROM llm_runs ORDER BY id").all()).toEqual([
				{ id: 1, cache_read_estimated: null },
				{ id: 2, cache_read_estimated: 1_000 },
				{ id: 3, cache_read_estimated: null },
				{ id: 4, cache_read_estimated: null },
				{ id: 5, cache_read_estimated: 1_300 },
				{ id: 6, cache_read_estimated: null },
				{ id: 7, cache_read_estimated: null },
			]);
		} finally {
			db.close();
		}
	});
});
