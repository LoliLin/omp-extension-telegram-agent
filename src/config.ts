// Central configuration loader (REQ-CONF-0001).
//
// Two sources:
//   1. `bots.config.json` (project root, or env `bots_config` path) — declarative bot list:
//      arbitrary number of bots, persona paths (abs / ~ / relative to project root), per-bot
//      model & routing & tool switches. NO secrets here: tokens are referenced by env key name.
//   2. `.env` (`key: value` colon format) — secrets and API keys only.
//
// Validation collects ALL errors and throws ConfigError listing each one (REQ-OPS-0001 R2
// framework, shared with the JSON schema checks per REQ-CONF-0001 R6).

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

export interface BotToolsConfig {
	send: boolean;
	search: boolean;
	runJs: boolean;
}

export type TelegramAdmin = number | `@${string}`;

/** Normalize the only two trusted Telegram admin identities accepted by deployment config. */
export function normalizeTelegramAdmin(value: unknown): TelegramAdmin | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value > 0 ? value : null;
	}
	if (typeof value !== "string") return null;
	const username = value.trim().toLowerCase();
	return /^@[a-z0-9_]{5,32}$/.test(username) ? username as `@${string}` : null;
}

export interface BotConfig {
	id: string;
	name: string; // display name + name-keyword trigger; defaults to id
	token: string; // resolved from token_env
	personaPath: string; // resolved absolute path
	routingP: number; // probability a plain human message triggers this bot (cumulative thresholds)
	samplingCooldownMs: number; // probability-only cooldown after a completed run (REQ-ROUTE-0001)
	model: string;
	reasoningEffort: string;
	compactionThreshold: number;
	compactionKeepRecent: number;
	tools: BotToolsConfig;
	/** Telegram sticker set names; loaded into the stable prefix at startup (REQ-STICKER-0001). */
	stickerSets: string[];
}

export interface AppConfig {
	dataDir: string;
	dbPath: string;
	groupPeerId: number;
	bots: BotConfig[];
	deepseekApiKey: string;
	tinyfishApiKey: string;
	auxiliaryVisualModel: string;
	routerSecret: string | null; // generated+persisted by daemon if absent
	telegramAdmins: TelegramAdmin[]; // deny-by-default deterministic control allowlist
}

export class ConfigError extends Error {
	constructor(public readonly errors: string[]) {
		super(`invalid configuration:\n${errors.join("\n")}`);
		this.name = "ConfigError";
	}
}

export function parseEnvFile(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(path)) return out;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
		if (m) out[m[1]] = m[2].trim();
	}
	return out;
}

/**
 * Normalize a group peer id: accepts bare positive ("4402809405"), negative ("-4402809405")
 * and full telegram form ("-1004402809405"); all normalize to the bare positive peer id used
 * internally. The "-100" prefix is only stripped when the remaining digits are long enough to
 * be a real peer id (>= 9 digits), so a genuine chat id starting with "100" is not corrupted.
 * Returns NaN when the value is not a positive integer.
 */
export function normalizePeerId(raw: string | number): number {
	const t = String(raw).trim();
	let s = t.startsWith("-") ? t.slice(1) : t;
	if (s.startsWith("100") && s.length > 11) s = s.slice(3);
	const n = Number(s);
	return Number.isInteger(n) && n > 0 ? n : NaN;
}

export interface RawBotConfig {
	id?: unknown;
	name?: unknown;
	token_env?: unknown;
	persona_path?: unknown;
	routing_p?: unknown;
	sampling_cooldown_ms?: unknown;
	model?: unknown;
	reasoning_effort?: unknown;
	compaction_threshold?: unknown;
	compaction_keep_recent?: unknown;
	tools?: unknown;
	sticker_sets?: unknown;
}

export interface RawConfig {
	group_peer_id?: unknown;
	router_secret_env?: unknown;
	db_path?: unknown;
	tinyfish_key_env?: unknown;
	deepseek_key_env?: unknown;
	auxiliary_visual_model?: unknown;
	model?: unknown;
	reasoning_effort?: unknown;
	compaction_threshold?: unknown;
	compaction_keep_recent?: unknown;
	sampling_cooldown_ms?: unknown;
	telegram_admins?: unknown;
	bots?: unknown;
}

export function defaultConfigPath(rootDir: string): string {
	return process.env.bots_config ?? join(rootDir, "bots.config.json");
}

/** Load + validate the bots.config.json. Errors are collected, not thrown one-by-one. */
export function loadBotConfig(rootDir: string, env: Record<string, string>): RawConfig {
	const errors: string[] = [];
	const path = defaultConfigPath(rootDir);
	if (!existsSync(path)) {
		throw new ConfigError([`[config] ${path}: missing bots.config.json (copy bots.config.example.json and edit it)`]);
	}
	let raw: RawConfig;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as RawConfig;
	} catch (err) {
		throw new ConfigError([`[config] ${path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`]);
	}
	// bot-level validation needs the env for token_env presence
	if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
		errors.push(`[config] bots: must be a non-empty array`);
	}
	const botList = (Array.isArray(raw.bots) ? raw.bots : []) as RawBotConfig[];
	const seen = new Map<string, number>();
	for (let i = 0; i < botList.length; i++) {
		const b = botList[i] ?? {};
		const at = `bots[${i}]`;
		if (b == null || typeof b !== "object") {
			errors.push(`[config] ${at}: must be an object`);
			continue;
		}
		const id = b.id;
		// REQ-CONF-0001: ids are unique strings; the charset excludes special characters. Note:
		// uppercase is allowed so the historical "A"/"B" ids keep working (migration is
		// id-agnostic; example config uses A/B).
		if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
			errors.push(`[config] ${at}.id: expected [A-Za-z0-9_-]+ string, got ${JSON.stringify(id)}`);
		} else {
			if (seen.has(id)) {
				errors.push(`[config] ${at}.id: duplicate bot id "${id}" (also bots[${seen.get(id)}])`);
			}
			seen.set(id, Number(i));
		}
		const tokenEnv = b.token_env;
		if (typeof tokenEnv !== "string" || !tokenEnv) {
			errors.push(`[config] ${at}.token_env: required (env key name holding the bot token)`);
		} else if (!env[tokenEnv]) {
			errors.push(`[config] ${at}.token_env: env key "${tokenEnv}" not found in .env`);
		}
		const personaPath = b.persona_path;
		if (typeof personaPath !== "string" || !personaPath) {
			errors.push(`[config] ${at}.persona_path: required`);
		} else {
			const resolved = resolvePath(rootDir, personaPath);
			if (!existsSync(resolved) || !statSync(resolved).isFile()) {
				errors.push(`[config] ${at}.persona_path: file not readable: ${resolved}`);
			}
		}
		const p = b.routing_p;
		if (p !== undefined && (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1)) {
			errors.push(`[config] ${at}.routing_p: expected number in [0, 1], got ${JSON.stringify(p)}`);
		}
		const cooldown = b.sampling_cooldown_ms;
		if (cooldown !== undefined && (typeof cooldown !== "number" || !Number.isFinite(cooldown) || cooldown < 0)) {
			errors.push(`[config] ${at}.sampling_cooldown_ms: expected finite number >= 0, got ${JSON.stringify(cooldown)}`);
		}
		for (const key of ["compaction_threshold", "compaction_keep_recent"] as const) {
			const v = b[key];
			if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
				errors.push(`[config] ${at}.${key}: expected positive finite number, got ${JSON.stringify(v)}`);
			}
		}
		if (b.tools !== undefined) {
			const t = b.tools;
			if (t == null || typeof t !== "object") {
				errors.push(`[config] ${at}.tools: expected object {send?, search?, run_js?}`);
			} else {
				for (const key of ["send", "search", "run_js"] as const) {
					const v = (t as Record<string, unknown>)[key];
					if (v !== undefined && typeof v !== "boolean") {
						errors.push(`[config] ${at}.tools.${key}: expected boolean, got ${JSON.stringify(v)}`);
					}
				}
			}
		}
		if (b.sticker_sets !== undefined) {
			if (!Array.isArray(b.sticker_sets) || b.sticker_sets.some((s) => typeof s !== "string" || !s)) {
				errors.push(`[config] ${at}.sticker_sets: expected array of Telegram sticker set names, got ${JSON.stringify(b.sticker_sets)}`);
			}
		}
	}
	// sum of routing probabilities must be <= 1
	let sum = 0;
	for (const b of botList) {
		const p = b?.routing_p;
		if (typeof p === "number" && Number.isFinite(p)) sum += p;
	}
	if (sum > 1) {
		errors.push(`[config] bots routing_p: probabilities must sum to <= 1, got ${sum.toFixed(3)}`);
	}
	// global numeric params
	for (const key of ["compaction_threshold", "compaction_keep_recent"] as const) {
		const v = raw[key];
		if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
			errors.push(`[config] ${key}: expected positive finite number, got ${JSON.stringify(v)}`);
		}
	}
	if (
		raw.sampling_cooldown_ms !== undefined &&
		(typeof raw.sampling_cooldown_ms !== "number" || !Number.isFinite(raw.sampling_cooldown_ms) || raw.sampling_cooldown_ms < 0)
	) {
		errors.push(`[config] sampling_cooldown_ms: expected finite number >= 0, got ${JSON.stringify(raw.sampling_cooldown_ms)}`);
	}
	if (raw.telegram_admins !== undefined) {
		if (!Array.isArray(raw.telegram_admins)) {
			errors.push(`[config] telegram_admins: expected an array of positive user ids or @usernames`);
		} else {
			const seenAdmins = new Set<TelegramAdmin>();
			for (let index = 0; index < raw.telegram_admins.length; index++) {
				const admin = normalizeTelegramAdmin(raw.telegram_admins[index]);
				if (admin == null) {
					errors.push(`[config] telegram_admins[${index}]: expected a positive integer user id or @username`);
					continue;
				}
				if (seenAdmins.has(admin)) errors.push(`[config] telegram_admins[${index}]: duplicate identity ${admin}`);
				seenAdmins.add(admin);
			}
		}
	}
	if (raw.group_peer_id !== undefined) {
		const n = normalizePeerId(String(raw.group_peer_id));
		if (!Number.isFinite(n)) {
			errors.push(`[config] group_peer_id: expected a bare positive peer id (e.g. 4402809405, or -1004402809405), got ${JSON.stringify(raw.group_peer_id)}`);
		}
	}
	if (errors.length > 0) throw new ConfigError(errors);
	return raw;
}

/** Resolve a persona path: absolute / ~ / relative to project root. */
export function resolvePath(rootDir: string, p: string): string {
	if (isAbsolute(p)) return resolve(p);
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return resolve(rootDir, p);
}

export function loadConfig(rootDir: string): AppConfig {
	const env: Record<string, string> = { ...parseEnvFile(join(rootDir, ".env")) };
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	const raw = loadBotConfig(rootDir, env);
	const errors: string[] = [];

	const num = (key: string, fallback: number, min: number, max: number): number => {
		const v = (raw as Record<string, unknown>)[key];
		if (v === undefined) return fallback;
		const n = Number(v);
		if (!Number.isFinite(n) || n < min || n > max) {
			errors.push(`[config] ${key}: expected a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
			return fallback;
		}
		return n;
	};
	const needEnv = (key: string, label: string): string => {
		const v = env[key];
		if (v === undefined || v === "") {
			errors.push(`[config] ${label}: env key "${key}" is empty or missing in .env`);
			return "";
		}
		return v;
	};

	const dataDir = join(rootDir, "data");
	const groupPeerId = normalizePeerId(String(raw.group_peer_id ?? ""));
	if (!Number.isFinite(groupPeerId)) errors.push(`[config] group_peer_id: required (bare positive peer id, see .env.example)`);
	const deepseekKeyEnv = typeof raw.deepseek_key_env === "string" ? raw.deepseek_key_env : "deepseek_api_key";
	const tinyfishKeyEnv = typeof raw.tinyfish_key_env === "string" ? raw.tinyfish_key_env : "tiny_fish_api_key";
	const routerSecretEnv = typeof raw.router_secret_env === "string" ? raw.router_secret_env : "router_secret";
	const deepseekApiKey = needEnv(deepseekKeyEnv, `deepseek_key_env "${deepseekKeyEnv}"`);
	const tinyfishApiKey = needEnv(tinyfishKeyEnv, `tinyfish_key_env "${tinyfishKeyEnv}"`);

	if (errors.length > 0) throw new ConfigError(errors);

	const defaultModel = typeof raw.model === "string" ? raw.model : "deepseek-v4-flash";
	const defaultEffort = typeof raw.reasoning_effort === "string" ? raw.reasoning_effort : "medium";
	const defaultThreshold = num("compaction_threshold", 128000, 1, Number.MAX_SAFE_INTEGER);
	const defaultKeepRecent = num("compaction_keep_recent", 20000, 1, Number.MAX_SAFE_INTEGER);
	const defaultSamplingCooldown = num("sampling_cooldown_ms", 2000, 0, Number.MAX_SAFE_INTEGER);
	const botList = raw.bots as RawBotConfig[];
	const telegramAdmins = Array.isArray(raw.telegram_admins)
		? raw.telegram_admins.map((value) => normalizeTelegramAdmin(value)!)
		: [];

	const bots: BotConfig[] = botList.map((b) => {
		const tokenEnv = b.token_env as string;
		const toolsRaw = (b.tools ?? {}) as Record<string, unknown>;
		return {
			id: b.id as string,
			name: typeof b.name === "string" && b.name ? b.name : (b.id as string),
			token: env[tokenEnv] ?? "",
			personaPath: resolvePath(rootDir, b.persona_path as string),
			routingP: typeof b.routing_p === "number" ? b.routing_p : 0,
			samplingCooldownMs: typeof b.sampling_cooldown_ms === "number" ? b.sampling_cooldown_ms : defaultSamplingCooldown,
			model: typeof b.model === "string" ? b.model : defaultModel,
			reasoningEffort: typeof b.reasoning_effort === "string" ? b.reasoning_effort : defaultEffort,
			compactionThreshold: typeof b.compaction_threshold === "number" ? b.compaction_threshold : defaultThreshold,
			compactionKeepRecent: typeof b.compaction_keep_recent === "number" ? b.compaction_keep_recent : defaultKeepRecent,
			tools: {
				send: toolsRaw.send !== false,
				search: toolsRaw.search !== false,
				runJs: toolsRaw.run_js !== false,
			},
			stickerSets: Array.isArray(b.sticker_sets) ? (b.sticker_sets as string[]) : [],
		};
	});

	return {
		dataDir,
		dbPath: typeof raw.db_path === "string" ? resolvePath(rootDir, raw.db_path) : join(dataDir, "agent.db"),
		groupPeerId,
		bots,
		deepseekApiKey,
		tinyfishApiKey,
		auxiliaryVisualModel: typeof raw.auxiliary_visual_model === "string" ? raw.auxiliary_visual_model : "",
		routerSecret: env[routerSecretEnv] || null,
		telegramAdmins,
	};
}
