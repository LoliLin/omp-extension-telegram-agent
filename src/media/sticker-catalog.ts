// Fixed sticker catalog per bot (REQ-STICKER-0001).
// Each bot can configure Telegram sticker set names; at startup the sets are fetched, media
// identity + per-bot file_id persisted, short_ids assigned (same s<rowid> namespace as the
// dynamic candidates), and background vision started through the shared lazy cache.
// Catalog identities remain persistent, but retrieval is a bounded local top-K dynamic suffix;
// catalog bytes no longer inflate or invalidate the stable system prefix (cache schema v8).

import type { Database } from "bun:sqlite";
import { errorCategory, log } from "../observability/log.ts";
import { createHash } from "node:crypto";
import type { BotApi } from "../telegram/api.ts";
import {
	ensureVision,
	type EnsureVisionOptions,
	type VisionExecutor,
	type VisionTelemetrySink,
	type VisionUpdateSink,
} from "./vision.ts";

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
 * Load the catalog for one bot (blocking part): persist media identity + per-bot file_id,
 * assign short_ids. A failed set (bad name / network) logs and is skipped — startup must
 * not be blocked. Returns the number of catalog stickers and how many lack vision yet.
 */
export async function ensureStickerCatalog(
	db: Database,
	api: BotApi,
	botId: string,
	sets: string[],
): Promise<{ total: number; sendable: number; missingMapping: number; truncated: boolean; pendingVision: number }> {
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
	const pendingVision = db
		.query(
			`SELECT COUNT(*) c FROM media
			 WHERE kind = 'sticker' AND sticker_set IN (SELECT value FROM json_each(?))
			   AND EXISTS (
			     SELECT 1 FROM media_file_ids f
			      WHERE f.bot_id = ? AND f.file_unique_id = media.file_unique_id
			   )
			   AND vision IS NULL`,
		)
		.get(JSON.stringify(sets), botId) as { c: number };
	return { total, sendable, missingMapping, truncated, pendingVision: pendingVision.c };
}

/**
 * Background vision pre-recognition (REQ-STICKER-0001 R1). NOT awaited during startup:
 * Pi vision calls are slow (minutes for a full set) and must not hold the poller offline.
 * Unrecognized stickers serialize as [未识别] in this prompt snapshot; background results
 * persist for UI and a future restart. Bounded concurrency; errors are safely categorized.
 */
export function preRecognizeCatalogVision(
	db: Database,
	api: BotApi,
	botId: string,
	sets: string[],
	executor: VisionExecutor,
	onVision?: VisionUpdateSink,
	onTelemetry?: VisionTelemetrySink,
	options: Pick<EnsureVisionOptions, "cacheDir" | "monotonicNow" | "scheduler" | "chatId"> = {},
): Promise<void> {
	const pending = db
		.query(
			`SELECT file_unique_id FROM media
			 WHERE kind = 'sticker' AND sticker_set IN (SELECT value FROM json_each(?))
			   AND EXISTS (
			     SELECT 1 FROM media_file_ids f
			      WHERE f.bot_id = ? AND f.file_unique_id = media.file_unique_id
			   )
			   AND vision IS NULL`,
		)
		.all(JSON.stringify(sets), botId) as { file_unique_id: string }[];
	if (pending.length === 0) return Promise.resolve();
	log.info("sticker_catalog", "vision_backfill_started", { bot_id: botId, pending: pending.length, concurrency: Math.min(2, pending.length) });
	const workers = Math.min(2, pending.length);
	let next = 0;
	let doneCount = 0;
	return (async () => {
		await Promise.all(
			Array.from({ length: workers }, async () => {
				while (next < pending.length) {
					const fid = pending[next++]!.file_unique_id;
					try {
						await ensureVision(db, api, botId, fid, executor, {
							onPersist: onVision,
							onTelemetry,
							...options,
						});
					} catch {
						log.error("sticker_catalog", "vision_failed", { bot_id: botId, category: "request_failed" });
					}
					doneCount++;
					if (doneCount % 10 === 0) {
						log.info("sticker_catalog", "vision_progress", { bot_id: botId, completed: doneCount, total: pending.length });
					}
				}
			}),
		);
	})();
}

/**
 * Legacy deterministic catalog projection retained for compatibility and migration tests.
 * Production context uses `stickerCandidatesForTurn`; this block never enters schema-v8 system
 * prompts. Order = configured set order, then rowid, filtered by this bot's file_id mapping.
 */
export function stickerCatalogBlock(db: Database, botId: string, sets: string[]): string {
	const lines: string[] = [];
	for (const setName of sets) {
		const rows = db
			.query(
				`SELECT short_id, sticker_emoji, vision FROM media m
				 WHERE kind = 'sticker' AND sticker_set = ? AND short_id IS NOT NULL
				   AND EXISTS (
				     SELECT 1 FROM media_file_ids f
				      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
				   )
				 ORDER BY rowid`,
			)
			.all(setName, botId) as { short_id: string; sticker_emoji: string | null; vision: string | null }[];
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

interface StickerCandidateRow {
	rowid: number;
	short_id: string;
	sticker_emoji: string | null;
	vision: string;
}

function searchTerms(value: string): Set<string> {
	const normalized = value.normalize("NFKC").toLocaleLowerCase();
	const terms = new Set(normalized.match(/[\p{L}\p{N}]{2,}|\p{Extended_Pictographic}/gu) ?? []);
	for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
		for (const char of run) terms.add(char);
		for (let index = 0; index + 1 < run.length; index++) terms.add(run.slice(index, index + 2));
	}
	return terms;
}

/** Local deterministic retrieval; candidates are a bounded dynamic suffix, never system prefix. */
export function stickerCandidatesForTurn(
	db: Database,
	botId: string,
	turnText: string,
	limit = 8,
): string {
	if (limit <= 0 || !turnText.trim()) return "";
	const queryTerms = searchTerms(turnText);
	if (queryTerms.size === 0) return "";
	const rows = db.query(`
		SELECT rowid, short_id, sticker_emoji, vision
		  FROM media m
		 WHERE kind = 'sticker'
		   AND short_id IS NOT NULL
		   AND json_extract(vision, '$.text') IS NOT NULL
		   AND EXISTS (
		     SELECT 1 FROM media_file_ids f
		      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
		   )
		 ORDER BY rowid DESC
		 LIMIT 512
	`).all(botId) as StickerCandidateRow[];
	const ranked = rows
		.map((row) => {
			const description = (JSON.parse(row.vision) as { text?: string }).text?.replace(/\s+/g, " ").trim() ?? "";
			const terms = searchTerms(`${row.sticker_emoji ?? ""} ${description}`);
			let score = 0;
			for (const term of queryTerms) {
				if (terms.has(term)) score += term.length > 1 ? 3 : 1;
			}
			if (row.sticker_emoji && turnText.includes(row.sticker_emoji)) score += 12;
			return { row, description, score };
		})
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score || right.row.rowid - left.row.rowid)
		.slice(0, Math.min(8, limit));
	if (ranked.length === 0) return "";
	return `Available stickers:\n${ranked.map(({ row, description }) =>
		`${row.short_id} = ${row.sticker_emoji ?? ""} ${description.slice(0, 60)}`.trim()
	).join("\n")}`;
}

/** Fingerprint only local catalog/config state; plaintext descriptions never leave this hash. */
export function stickerCatalogSnapshotHash(db: Database, botId: string, sets: readonly string[]): string {
	const rows = db.query(`
		SELECT short_id, sticker_set, sticker_emoji,
		       COALESCE(json_extract(vision, '$.text'), '') AS description
		  FROM media m
		 WHERE kind = 'sticker' AND short_id IS NOT NULL
		   AND EXISTS (
		     SELECT 1 FROM media_file_ids f
		      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
		   )
		 ORDER BY rowid
	`).all(botId);
	return createHash("sha256")
		.update(JSON.stringify({ sets: [...sets], rows }))
		.digest("hex");
}
