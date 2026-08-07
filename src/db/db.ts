// SQLite access layer (bun:sqlite). See docs/data-model.md.

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_PATH = join(import.meta.dir, "schema.sql");

export function openDb(dbPath: string): Database {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(readFileSync(SCHEMA_PATH, "utf8"));
	migrate(db);
	return db;
}

/** Idempotent column migrations for existing dev databases. */
function migrate(db: Database): void {
	const mediaCols = (db.query("PRAGMA table_info(media)").all() as { name: string }[]).map((c) => c.name);
	if (!mediaCols.includes("short_id")) {
		db.exec("ALTER TABLE media ADD COLUMN short_id TEXT");
		db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_media_short_id ON media(short_id)");
	}
}

export function getDaemonState(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM daemon_state WHERE key = ?").get(key) as
		| { value: string }
		| null;
	return row?.value ?? null;
}

export function setDaemonState(db: Database, key: string, value: string): void {
	db.query("INSERT INTO daemon_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
		key,
		value,
	);
}

export function getBotState(db: Database, botId: string, key: string): string | null {
	const row = db.query("SELECT value FROM bot_state WHERE bot_id = ? AND key = ?").get(botId, key) as
		| { value: string }
		| null;
	return row?.value ?? null;
}

export function setBotState(db: Database, botId: string, key: string, value: string): void {
	db.query(
		"INSERT INTO bot_state (bot_id, key, value) VALUES (?, ?, ?) ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value",
	).run(botId, key, value);
}
