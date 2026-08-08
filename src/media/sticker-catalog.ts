// Fixed sticker catalog per bot (REQ-STICKER-0001).
// Each bot can configure Telegram sticker set names; at startup the sets are fetched, media
// identity + per-bot file_id persisted, and short_ids assigned from rowids. The catalog is
// serialized identity-only (set + emoji + short_id, no vision text) into the stable system
// prompt, so the prefix is fully determined by config + DB catalog and stays stable across
// restarts (cache schema v9). Photo/foreground vision is unrelated and lives in vision.ts.

import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { createHash } from "node:crypto";
import type { BotApi } from "../telegram/api.ts";

export const STICKER_CATALOG_MAX = 120; // bounded local inventory and startup work

export interface CatalogSticker {
	file_unique_id: string;
	file_id: string;
	emoji: string | null;
	width?: number;
	height?: number;
}

/** Fetch one Telegram sticker set (public sets work for any bot token). */
export async function fetchStickerSet(api: BotApi, setName: string): Promise<CatalogSticker[]> {
	const result = await api.call<{
		name: string;
		title: string;
		stickers: { file_id: string; file_unique_id: string; emoji?: string; width?: number; height?: number }[];
	}>("getStickerSet", { name: setName });
	return result.stickers.map((s) => ({
		file_unique_id: s.file_unique_id,
		file_id: s.file_id,
		emoji: s.emoji ?? null,
		width: s.width,
		height: s.height,
	}));
}

/**
 * Load the catalog for one bot: persist media identity + per-bot file_id, assign short_ids.
 * A failed set (bad name / network) logs and is skipped — startup must not be blocked.
 */
export async function ensureStickerCatalog(
	db: Database,
	api: BotApi,
	botId: string,
	sets: string[],
): Promise<{ total: number; sendable: number; missingMapping: number; truncated: boolean }> {
	let total = 0;
	let truncated = false;
	for (const setName of sets) {
		if (total >= STICKER_CATALOG_MAX) {
			truncated = true;
			break;
		}
		let stickers: CatalogSticker[];
		try {
			stickers = await fetchStickerSet(api, setName);
		} catch (err) {
			log.error("sticker_catalog", "set_fetch_failed", { bot_id: botId, set_name: setName, category: errorCategory(err) });
			continue;
		}
		for (const s of stickers) {
			if (total >= STICKER_CATALOG_MAX) {
				truncated = true;
				break;
			}
			db.query(
				`INSERT INTO media (file_unique_id, kind, sticker_set, sticker_emoji, width, height)
				 VALUES (?, 'sticker', ?, ?, ?, ?)
				 ON CONFLICT(file_unique_id) DO NOTHING`,
			).run(s.file_unique_id, setName, s.emoji, s.width ?? null, s.height ?? null);
			db.query("INSERT OR IGNORE INTO media_file_ids (bot_id, file_id, file_unique_id) VALUES (?, ?, ?)").run(
				botId,
				s.file_id,
				s.file_unique_id,
			);
			// short_id from rowid: stable, unique, race-free
			const row = db.query("SELECT rowid FROM media WHERE file_unique_id = ?").get(s.file_unique_id) as
				| { rowid: number }
				| null;
			if (row) {
				db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ? AND short_id IS NULL").run(
					`s${row.rowid}`,
					s.file_unique_id,
				);
			}
			total++;
		}
	}
	if (truncated) {
		log.warn("sticker_catalog", "catalog_truncated", { bot_id: botId, limit: STICKER_CATALOG_MAX });
	}
	const counts = db
		.query(
			`SELECT
			   COUNT(*) AS catalog_rows,
			   SUM(CASE WHEN EXISTS (
			     SELECT 1 FROM media_file_ids f
			      WHERE f.bot_id = ? AND f.file_unique_id = media.file_unique_id
			   ) THEN 1 ELSE 0 END) AS sendable
			 FROM media
			 WHERE kind = 'sticker' AND sticker_set IN (SELECT value FROM json_each(?))`,
		)
		.get(botId, JSON.stringify(sets)) as { catalog_rows: number; sendable: number | null };
	const sendable = counts.sendable ?? 0;
	const missingMapping = counts.catalog_rows - sendable;
	log.info("sticker_catalog", "catalog_ready", {
		bot_id: botId, fetched: total, catalog: counts.catalog_rows, sendable, missing_file_id: missingMapping,
	});
	if (missingMapping > 0) {
		log.warn("sticker_catalog", "mapping_incomplete", {
			bot_id: botId, catalog: counts.catalog_rows, sendable, missing_file_id: missingMapping,
		});
	}
	return { total, sendable, missingMapping, truncated };
}

interface CatalogRow {
	sticker_set: string | null;
	sticker_emoji: string | null;
	short_id: string;
}

/** Sendable catalog stickers for this bot in its configured sets, deterministically ordered. */
function catalogRows(db: Database, botId: string, sets: readonly string[]): CatalogRow[] {
	return db.query(`
		SELECT sticker_set, sticker_emoji, short_id
		  FROM media m
		 WHERE kind = 'sticker' AND short_id IS NOT NULL
		   AND sticker_set IN (SELECT value FROM json_each(?))
		   AND EXISTS (
		     SELECT 1 FROM media_file_ids f
		      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
		   )
		 ORDER BY sticker_set, rowid
	`).all(JSON.stringify([...sets]), botId) as CatalogRow[];
}

/**
 * Identity-only catalog block for the stable system prompt: one line per sticker
 * (set + emoji + short_id), no vision description text. Deterministic for a given
 * config + DB catalog, so the prefix stays stable across restarts. Empty string when
 * the bot has no sendable catalog stickers.
 */
export function stickerCatalogPromptBlock(db: Database, botId: string, sets: readonly string[]): string {
	const rows = catalogRows(db, botId, sets);
	if (rows.length === 0) return "";
	const lines = rows.map((row) => `- [${row.sticker_set ?? ""}] ${row.sticker_emoji ?? ""} ${row.short_id}`);
	return `# Sticker 目录\n\n你可以用 send 的 sticker 参数发送以下 sticker（填 short_id，不得编造其他 id）：\n\n${lines.join("\n")}`;
}

/** Fingerprint the exact identity state that shapes the prompt block; vision text never participates. */
export function stickerCatalogSnapshotHash(db: Database, botId: string, sets: readonly string[]): string {
	return createHash("sha256")
		.update(JSON.stringify({ sets: [...sets], rows: catalogRows(db, botId, sets) }))
		.digest("hex");
}
