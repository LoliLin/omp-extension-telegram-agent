// Vision pipeline (lazy, cached, shared by both bots). See docs/requirement.md 三十八-四十一.
// Uses local Codex CLI auth; model from config (e.g. "gpt-5.6-luna-low" = model gpt-5.6-luna, reasoning low).

import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotApi } from "../telegram/api.ts";

export function parseModelEffort(envModel: string): { model: string; effort: string | null } {
	const m = envModel.match(/^(.*?)-(minimal|low|medium|high)$/);
	if (m) return { model: m[1], effort: m[2] };
	return { model: envModel, effort: null };
}

const PHOTO_PROMPT = `你在帮一个群聊 bot 理解图片。简短描述：实际可见内容、重要文字/OCR（尤其是界面和报错）、人物或物体、对聊天可能有用的信息、不确定的地方。2-3 句话以内，用中文，直接给描述不要客套。`;

const STICKER_PROMPT = `你在帮一个群聊 bot 理解一张 sticker（聊天表情贴图）。把它理解为一种聊天表达，输出短描述：communicative intent（想表达什么）、emotion、intensity、gesture/画面要点、可见文字。一两句话，用中文，例如"得意的赞同，smug/amused，中等强度"。直接给描述不要客套。`;

const VISION_TIMEOUT_MS = 90_000;

export type VisionUpdateSink = (fileUniqueId: string, text: string) => void;

export interface EnsureVisionOptions {
	/** Called exactly after a new non-empty description is persisted; cache hits do not emit. */
	onPersist?: VisionUpdateSink;
	/** Deterministic test seam; production uses describeImage. */
	describe?: typeof describeImage;
	/** Deterministic test seam; production uses data/media under cwd. */
	cacheDir?: string;
}

export async function describeImage(envModel: string, imagePath: string, kind: "photo" | "sticker"): Promise<string> {
	const { model, effort } = parseModelEffort(envModel);
	const dir = mkdtempSync(join(tmpdir(), "vision-"));
	try {
		const outPath = join(dir, "out.txt");
		const args = [
			"exec",
			"--skip-git-repo-check",
			"--ephemeral",
			"-s",
			"read-only",
			"-m",
			model,
			...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
			"-i",
			imagePath,
			"-o",
			outPath,
			kind === "sticker" ? STICKER_PROMPT : PHOTO_PROMPT,
		];
		await new Promise<void>((resolve, reject) => {
			const child = spawn("codex", args, { stdio: ["ignore", "ignore", "pipe"] });
			let err = "";
			child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
			const killer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("vision timeout"));
			}, VISION_TIMEOUT_MS);
			child.on("close", (codeNum) => {
				clearTimeout(killer);
				if (codeNum === 0 && existsSync(outPath)) resolve();
				else reject(new Error(`codex vision failed (${codeNum}): ${err.slice(-300)}`));
			});
		});
		return readFileSync(outPath, "utf8").trim();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Find this bot's file_id for a shared media identity. */
export function fileIdForBot(db: Database, botId: string, fileUniqueId: string): string | null {
	const row = db
		.query("SELECT file_id FROM media_file_ids WHERE bot_id = ? AND file_unique_id = ?")
		.get(botId, fileUniqueId) as { file_id: string } | null;
	return row?.file_id ?? null;
}

/**
 * Ensure a vision result exists for the media (lazy + persistent cache).
 * Downloads via the given bot's API if needed. Returns the description or null on failure.
 * Concurrent calls for the same media share one in-flight request.
 */
const inFlight = new Map<string, Promise<string | null>>();

export function ensureVision(
	db: Database,
	api: BotApi,
	botId: string,
	envModel: string,
	fileUniqueId: string,
	options: EnsureVisionOptions = {},
): Promise<string | null> {
	const existing = inFlight.get(fileUniqueId);
	if (existing) return existing;
	const promise = ensureVisionInner(db, api, botId, envModel, fileUniqueId, options).finally(() => {
		inFlight.delete(fileUniqueId);
	});
	inFlight.set(fileUniqueId, promise);
	return promise;
}

async function ensureVisionInner(
	db: Database,
	api: BotApi,
	botId: string,
	envModel: string,
	fileUniqueId: string,
	options: EnsureVisionOptions,
): Promise<string | null> {
	const media = db.query("SELECT kind, vision FROM media WHERE file_unique_id = ?").get(fileUniqueId) as
		| { kind: string; vision: string | null }
		| null;
	if (!media) return null;
	if (media.kind !== "photo" && media.kind !== "sticker") return null;
	if (media.vision) {
		const cached = JSON.parse(media.vision) as { text: string };
		return cached.text;
	}
	const fileId = fileIdForBot(db, botId, fileUniqueId);
	if (!fileId) return null;
	const cacheDir = options.cacheDir ?? join(process.cwd(), "data", "media");
	mkdirSync(cacheDir, { recursive: true });
	const file = await api.getFile(fileId);
	if (!file.file_path) return null;
	const ext = file.file_path.split(".").pop() ?? "bin";
	if (ext === "tgs" || ext === "webm") {
		// animated/video stickers: vision model can't read them; mark attempted, use emoji-only semantics
		db.query("UPDATE media SET vision = ? WHERE file_unique_id = ?").run(
			JSON.stringify({ model: "none", kind: media.kind, text: null, unsupported: true, at: Date.now() }),
			fileUniqueId,
		);
		return null;
	}
	const bytes = await api.downloadFile(file.file_path);
	const localPath = join(cacheDir, `${fileUniqueId}.${ext}`);
	writeFileSync(localPath, bytes);
	const text = (await (options.describe ?? describeImage)(envModel, localPath, media.kind as "photo" | "sticker")).trim();
	db.query("UPDATE media SET vision = ?, local_path = ? WHERE file_unique_id = ?").run(
		JSON.stringify({ model: envModel, kind: media.kind, text, at: Date.now() }),
		localPath,
		fileUniqueId,
	);
	if (text.trim() && options.onPersist) {
		try {
			options.onPersist(fileUniqueId, text);
		} catch (error) {
			// Persistence is authoritative; an observer failure must not turn a completed
			// vision request into a provider/agent failure or trigger another model call.
			console.error(`[vision] update sink failed media=${fileUniqueId}: ${String(error)}`);
		}
	}
	return text;
}
