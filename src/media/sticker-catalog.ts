// Fixed sticker catalog per bot (REQ-STICKER-0001).
// Each bot can configure Telegram sticker set names; at startup the sets are fetched, media
// identity + per-bot file_id persisted, short_ids assigned (same s<rowid> namespace as the
// dynamic candidates), and vision pre-recognized via the shared lazy vision cache.
// The catalog serializes as a STABLE block inside the system prompt (stable prefix), so a
// catalog change is a cache-visible protocol change: bump CACHE_SCHEMA_VERSION (docs/cache.md).

import type { Database } from "bun:sqlite";
import type { BotApi } from "../telegram/api.ts";
import { ensureVision } from "./vision.ts";

export const STICKER_CATALOG_MAX = 120; // R5: bounded catalog keeps the prefix cheap

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
 * Load the catalog for one bot: persist media identity + per-bot file_id, assign short_ids,
 * then pre-recognize vision with bounded concurrency (cached results skip downloads/codex).
 * A failed set (bad name / network) logs and is skipped — startup must not be blocked.
 * Returns the number of catalog stickers.
 */
export async function ensureStickerCatalog(
	db: Database,
	api: BotApi,
	botId: string,
	sets: string[],
	envModel: string,
): Promise<{ total: number; truncated: boolean }> {
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
			console.error(`[sticker-catalog] ${botId}: failed to fetch set "${setName}": ${err}`);
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
			// short_id from rowid: stable, unique, race-free — same namespace as dynamic candidates
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
		console.warn(`[sticker-catalog] ${botId}: catalog truncated at ${STICKER_CATALOG_MAX} stickers (REQ-STICKER-0001 R5)`);
	}
	// Pre-recognize vision: bounded concurrency (4); ensureVision dedupes in-flight and skips cache.
	const pending = db
		.query(
			`SELECT file_unique_id FROM media
			 WHERE kind = 'sticker' AND sticker_set IN (SELECT value FROM json_each(?))
			   AND (vision IS NULL OR json_extract(vision, '$.text') IS NULL OR json_extract(vision, '$.unsupported') = 1)`,
		)
		.all(JSON.stringify(sets)) as { file_unique_id: string }[];
	const workers = Math.min(4, pending.length);
	let next = 0;
	const results = await Promise.all(
		Array.from({ length: workers }, async () => {
			while (next < pending.length) {
				const fid = pending[next++]!.file_unique_id;
				try {
					await ensureVision(db, api, botId, envModel, fid);
				} catch (err) {
					console.error(`[sticker-catalog] ${botId}: vision failed for ${fid}: ${err}`);
				}
			}
		}),
	);
	void results;
	return { total, truncated };
}

/**
 * Deterministic catalog block for the system prompt (stable prefix, REQ-STICKER-0001 R2).
 * Order = configured set order, then rowid. Stickers without vision text are marked [未识别]
 * (tgs/webm or vision failure). Empty string when the bot has no catalog.
 */
export function stickerCatalogBlock(db: Database, sets: string[]): string {
	const lines: string[] = [];
	for (const setName of sets) {
		const rows = db
			.query(
				`SELECT short_id, sticker_emoji, vision FROM media
				 WHERE kind = 'sticker' AND sticker_set = ? AND short_id IS NOT NULL
				 ORDER BY rowid`,
			)
			.all(setName) as { short_id: string; sticker_emoji: string | null; vision: string | null }[];
		for (const r of rows) {
			let semantic = "[未识别]";
			if (r.vision) {
				const parsed = JSON.parse(r.vision) as { text: string | null };
				if (parsed.text) semantic = parsed.text.replace(/\s+/g, " ").slice(0, 60);
			}
			lines.push(`${r.short_id} = ${r.sticker_emoji ?? ""} ${semantic}`.trim());
		}
	}
	if (lines.length === 0) return "";
	return `\n---\n\n# Sticker 目录\n\n可用 sticker（short_id = 语义，可直接发送）：\n${lines.join("\n")}`;
}
