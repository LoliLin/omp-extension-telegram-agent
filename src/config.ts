// Central configuration loader (REQ-CONF-0001).
//
// Three sources:
//   1. `telegram.config.ts` (preferred) or legacy `bots.config.json` (project root, or env
//      `bots_config` path) — trusted local bot list:
//      arbitrary number of bots, persona paths (abs / ~ / relative to project root), optional
//      Pi provider/model selection, routing & tool switches.
//   2. `.env` (`key: value` colon format) — Telegram/TinyFish/router secrets only. LLM
//      credentials belong exclusively to Pi's auth storage (REQ-PLAT-0002).
//
// Validation collects ALL errors and throws ConfigError listing each one (REQ-OPS-0001 R2
// framework, shared with the JSON schema checks per REQ-CONF-0001 R6).

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createJiti } from "jiti";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	isPiThinkingLevel,
	loadPiModelDefaults,
	type PiModelDefaults,
} from "./agent/model-settings.ts";
import {
	DEFAULT_AUXILIARY_VISUAL_MODEL,
	normalizeAuxiliaryVisualModel,
} from "./agent/model-ref.ts";

export { defineConfig } from "./config-schema.ts";
export type {
	TelegramAdminInput,
	TelegramBotConfigInput,
	TelegramConfigInput,
	TelegramToolsConfigInput,
	TelegramVisionConfigInput,
} from "./config-schema.ts";

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
	provider: string;
	model: string;
	reasoningEffort: ThinkingLevel;
	compactionThreshold: number;
	compactionKeepRecent: number;
	compactionModel?: string;
	cacheRetention?: "none" | "short" | "long";
	maxSuffixTokens?: number;
	maxMessageTokens?: number;
	tools: BotToolsConfig;
	/** Telegram sticker set names; locally retrieved into a bounded per-turn suffix. */
	stickerSets: string[];
}

export interface VisionConfig {
	enabled: boolean;
	foregroundMediaLimit: number;
	concurrency: number;
	perChatHourlyLimit: number;
	dailyLimit: number;
}

export interface RetentionConfig {
	telemetryDays: number;
	rawUpdateDays: number;
	messageEventDays: number;
}

export interface AppConfig {
	dataDir: string;
	dbPath: string;
	groupPeerId: number;
	bots: BotConfig[];
	tinyfishApiKey: string;
	auxiliaryVisualModel: string;
	vision?: VisionConfig;
	retention?: RetentionConfig;
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
	provider?: unknown;
	model?: unknown;
	api_key_env?: unknown;
	reasoning_effort?: unknown;
	compaction_threshold?: unknown;
	compaction_keep_recent?: unknown;
	compaction_model?: unknown;
	cache_retention?: unknown;
	max_suffix_tokens?: unknown;
	max_message_tokens?: unknown;
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
	provider?: unknown;
	model?: unknown;
	api_key_env?: unknown;
	reasoning_effort?: unknown;
	compaction_threshold?: unknown;
	compaction_keep_recent?: unknown;
	compaction_model?: unknown;
	cache_retention?: unknown;
	max_suffix_tokens?: unknown;
	max_message_tokens?: unknown;
	sampling_cooldown_ms?: unknown;
	vision?: unknown;
	telemetry_retention_days?: unknown;
	raw_update_retention_days?: unknown;
	message_event_retention_days?: unknown;
	telegram_admins?: unknown;
	bots?: unknown;
}

const TYPESCRIPT_CONFIG = "telegram.config.ts";
const LEGACY_JSON_CONFIG = "bots.config.json";
const configJiti = createJiti(import.meta.url, { interopDefault: false, moduleCache: false });

export function defaultConfigPath(rootDir: string, override = process.env.bots_config): string {
	if (override?.trim()) {
		const path = isAbsolute(override) ? resolve(override) : resolve(rootDir, override);
		if (!path.endsWith(".ts") && !path.endsWith(".json")) {
			throw new ConfigError([`[config] bots_config: unsupported extension for ${path}; expected .ts or .json`]);
		}
		return path;
	}
	const typedPath = join(rootDir, TYPESCRIPT_CONFIG);
	const legacyPath = join(rootDir, LEGACY_JSON_CONFIG);
	if (existsSync(typedPath) && existsSync(legacyPath)) {
		throw new ConfigError([
			`[config] multiple configuration files found: ${typedPath}`,
			`[config] multiple configuration files found: ${legacyPath}`,
			`[config] keep exactly one, or set bots_config to an explicit .ts/.json path`,
		]);
	}
	if (existsSync(typedPath)) return typedPath;
	if (existsSync(legacyPath)) return legacyPath;
	return typedPath;
}

function loadConfigSource(path: string): unknown {
	if (path.endsWith(".json")) {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new ConfigError([`[config] ${path}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`]);
		}
	}
	try {
		const loaded = configJiti(path) as unknown;
		return loaded && typeof loaded === "object" && "default" in loaded
			? (loaded as { default: unknown }).default
			: loaded;
	} catch (error) {
		throw new ConfigError([`[config] ${path}: unable to load trusted TypeScript: ${error instanceof Error ? error.message : String(error)}`]);
	}
}

/** Load + validate the preferred TypeScript or legacy JSON config. */
export function loadBotConfig(rootDir: string, env: Record<string, string>): RawConfig {
	const errors: string[] = [];
	const path = defaultConfigPath(rootDir, env.bots_config);
	if (!existsSync(path)) {
		throw new ConfigError([
			`[config] missing configuration: ${path}`,
			`[config] copy telegram.config.example.ts to ${TYPESCRIPT_CONFIG}, use legacy ${LEGACY_JSON_CONFIG}, or run /tg config`,
		]);
	}
	const source = loadConfigSource(path);
	if (source == null || typeof source !== "object" || Array.isArray(source)) {
		throw new ConfigError([`[config] ${path}: default export must be a configuration object`]);
	}
	const raw = source as RawConfig;
	// bot-level validation needs the env for token_env presence
	if (!Array.isArray(raw.bots) || raw.bots.length === 0) {
		errors.push(`[config] bots: must be a non-empty array`);
	}
	const botList = (Array.isArray(raw.bots) ? raw.bots : []) as RawBotConfig[];
	for (const key of ["provider", "model"] as const) {
		const value = raw[key];
		if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
			errors.push(`[config] ${key}: expected a non-empty string, got ${JSON.stringify(value)}`);
		}
	}
	if (
		raw.auxiliary_visual_model !== undefined &&
		(typeof raw.auxiliary_visual_model !== "string" || !normalizeAuxiliaryVisualModel(raw.auxiliary_visual_model))
	) {
		errors.push(
			`[config] auxiliary_visual_model: expected provider/model:effort, got ${JSON.stringify(raw.auxiliary_visual_model)}`,
		);
	}
	if (
		raw.compaction_model !== undefined &&
		(typeof raw.compaction_model !== "string" || !normalizeAuxiliaryVisualModel(raw.compaction_model))
	) {
		errors.push(`[config] compaction_model: expected provider/model:effort, got ${JSON.stringify(raw.compaction_model)}`);
	}
	if (raw.cache_retention !== undefined && !["none", "short", "long"].includes(String(raw.cache_retention))) {
		errors.push(`[config] cache_retention: expected none, short, or long, got ${JSON.stringify(raw.cache_retention)}`);
	}
	if (raw.reasoning_effort !== undefined && !isPiThinkingLevel(raw.reasoning_effort)) {
		errors.push(`[config] reasoning_effort: expected a Pi thinking level, got ${JSON.stringify(raw.reasoning_effort)}`);
	}
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
		for (const key of ["provider", "model"] as const) {
			const value = b[key];
			if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
				errors.push(`[config] ${at}.${key}: expected a non-empty string, got ${JSON.stringify(value)}`);
			}
		}
		if (b.reasoning_effort !== undefined && !isPiThinkingLevel(b.reasoning_effort)) {
			errors.push(`[config] ${at}.reasoning_effort: expected a Pi thinking level, got ${JSON.stringify(b.reasoning_effort)}`);
		}
		if (
			b.compaction_model !== undefined &&
			(typeof b.compaction_model !== "string" || !normalizeAuxiliaryVisualModel(b.compaction_model))
		) {
			errors.push(`[config] ${at}.compaction_model: expected provider/model:effort, got ${JSON.stringify(b.compaction_model)}`);
		}
		if (b.cache_retention !== undefined && !["none", "short", "long"].includes(String(b.cache_retention))) {
			errors.push(`[config] ${at}.cache_retention: expected none, short, or long, got ${JSON.stringify(b.cache_retention)}`);
		}
		for (const key of ["compaction_threshold", "compaction_keep_recent", "max_suffix_tokens", "max_message_tokens"] as const) {
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
	for (const key of [
		"compaction_threshold",
		"compaction_keep_recent",
		"max_suffix_tokens",
		"max_message_tokens",
		"telemetry_retention_days",
		"raw_update_retention_days",
		"message_event_retention_days",
	] as const) {
		const v = raw[key];
		if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v <= 0)) {
			errors.push(`[config] ${key}: expected positive finite number, got ${JSON.stringify(v)}`);
		}
	}
	if (raw.vision !== undefined) {
		if (raw.vision == null || typeof raw.vision !== "object" || Array.isArray(raw.vision)) {
			errors.push(`[config] vision: expected object`);
		} else {
			const vision = raw.vision as Record<string, unknown>;
			if (vision.enabled !== undefined && typeof vision.enabled !== "boolean") {
				errors.push(`[config] vision.enabled: expected boolean, got ${JSON.stringify(vision.enabled)}`);
			}
			for (const key of ["foreground_media_limit", "concurrency", "per_chat_hourly_limit", "daily_limit"] as const) {
				const value = vision[key];
				if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
					errors.push(`[config] vision.${key}: expected non-negative integer, got ${JSON.stringify(value)}`);
				}
			}
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

export interface LoadConfigOptions {
	/** Explicit trusted local .ts/.json source, primarily for validating an editor draft. */
	configPath?: string;
	/** In-memory values used by onboarding validation; values override file/process env. */
	env?: Record<string, string>;
	/** Deterministic injection for tests/embedders; production reads merged Pi settings. */
	piModelDefaults?: PiModelDefaults;
}

export function loadConfig(rootDir: string, options: LoadConfigOptions = {}): AppConfig {
	const env: Record<string, string> = { ...parseEnvFile(join(rootDir, ".env")) };
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	Object.assign(env, options.env);
	if (options.configPath) env.bots_config = options.configPath;
	const raw = loadBotConfig(rootDir, env);
	const rawBots = raw.bots as RawBotConfig[];
	const needsPiDefaults = rawBots.some((bot) =>
		(bot.provider === undefined && raw.provider === undefined)
		|| (bot.model === undefined && raw.model === undefined && bot.provider === undefined)
	);
	const piDefaults = options.piModelDefaults
		?? (needsPiDefaults
			? loadPiModelDefaults(rootDir)
			: { provider: undefined, model: undefined, thinkingLevel: "medium" as const });
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
	const tinyfishKeyEnv = typeof raw.tinyfish_key_env === "string" ? raw.tinyfish_key_env : "tiny_fish_api_key";
	const routerSecretEnv = typeof raw.router_secret_env === "string" ? raw.router_secret_env : "router_secret";
	const explicitDefaultProvider = typeof raw.provider === "string" ? raw.provider.trim() : undefined;
	const defaultProvider = explicitDefaultProvider ?? piDefaults.provider;
	const defaultModel = typeof raw.model === "string"
		? raw.model.trim()
		: explicitDefaultProvider && explicitDefaultProvider !== piDefaults.provider
			? undefined
			: piDefaults.model;
	const defaultEffort = isPiThinkingLevel(raw.reasoning_effort) ? raw.reasoning_effort : "off";
	const defaultThreshold = num("compaction_threshold", 128000, 1, Number.MAX_SAFE_INTEGER);
	const defaultKeepRecent = num("compaction_keep_recent", 20000, 1, Number.MAX_SAFE_INTEGER);
	const defaultCompactionModel = typeof raw.compaction_model === "string"
		? normalizeAuxiliaryVisualModel(raw.compaction_model)!
		: DEFAULT_AUXILIARY_VISUAL_MODEL;
	const defaultCacheRetention = (["none", "short", "long"] as const).includes(raw.cache_retention as never)
		? raw.cache_retention as "none" | "short" | "long"
		: "short";
	const defaultMaxSuffixTokens = num("max_suffix_tokens", 12_000, 512, Number.MAX_SAFE_INTEGER);
	const defaultMaxMessageTokens = num("max_message_tokens", 4_096, 128, Number.MAX_SAFE_INTEGER);
	const defaultSamplingCooldown = num("sampling_cooldown_ms", 2000, 0, Number.MAX_SAFE_INTEGER);
	const botList = rawBots;
	const telegramAdmins = Array.isArray(raw.telegram_admins)
		? raw.telegram_admins.map((value) => normalizeTelegramAdmin(value)!)
		: [];
	if (needsPiDefaults && !defaultProvider && !defaultModel) {
		errors.push("[config] Pi default provider/model is missing; run Pi /login and select both with /model, or set them explicitly in telegram.config.ts");
	}

	const bots: BotConfig[] = botList.map((b) => {
		const tokenEnv = b.token_env as string;
		const toolsRaw = (b.tools ?? {}) as Record<string, unknown>;
		const explicitProvider = typeof b.provider === "string" ? b.provider.trim() : undefined;
		const provider = explicitProvider ?? (defaultProvider ?? "");
		const model = typeof b.model === "string"
			? b.model.trim()
			: explicitProvider && explicitProvider !== defaultProvider
				? ""
					: (defaultModel ?? "");
		if (!provider) {
			errors.push(`[config] bot "${String(b.id)}" has no provider; select one in config or Pi /model`);
		}
		if (!model) {
			errors.push(`[config] bot "${String(b.id)}" selects provider "${provider}" without a model; select both in config or Pi /model`);
		}
		return {
			id: b.id as string,
			name: typeof b.name === "string" && b.name ? b.name : (b.id as string),
			token: env[tokenEnv] ?? "",
			personaPath: resolvePath(rootDir, b.persona_path as string),
			routingP: typeof b.routing_p === "number" ? b.routing_p : 0,
			samplingCooldownMs: typeof b.sampling_cooldown_ms === "number" ? b.sampling_cooldown_ms : defaultSamplingCooldown,
			provider,
			model,
			reasoningEffort: isPiThinkingLevel(b.reasoning_effort) ? b.reasoning_effort : defaultEffort,
			compactionThreshold: typeof b.compaction_threshold === "number" ? b.compaction_threshold : defaultThreshold,
			compactionKeepRecent: typeof b.compaction_keep_recent === "number" ? b.compaction_keep_recent : defaultKeepRecent,
			compactionModel: typeof b.compaction_model === "string"
				? normalizeAuxiliaryVisualModel(b.compaction_model)!
				: defaultCompactionModel,
			cacheRetention: (["none", "short", "long"] as const).includes(b.cache_retention as never)
				? b.cache_retention as "none" | "short" | "long"
				: defaultCacheRetention,
			maxSuffixTokens: typeof b.max_suffix_tokens === "number" ? b.max_suffix_tokens : defaultMaxSuffixTokens,
			maxMessageTokens: typeof b.max_message_tokens === "number" ? b.max_message_tokens : defaultMaxMessageTokens,
			tools: {
				send: toolsRaw.send !== false,
				search: toolsRaw.search === true,
				runJs: toolsRaw.run_js === true,
			},
			stickerSets: Array.isArray(b.sticker_sets) ? (b.sticker_sets as string[]) : [],
		};
	});
	const tinyfishApiKey = bots.some((bot) => bot.tools.search)
		? needEnv(tinyfishKeyEnv, `tinyfish_key_env "${tinyfishKeyEnv}"`)
		: env[tinyfishKeyEnv] ?? "";

	const visionRaw = raw.vision && typeof raw.vision === "object" ? raw.vision as Record<string, unknown> : {};
	const visionNumber = (key: string, fallback: number, max: number): number => {
		const value = visionRaw[key];
		return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : fallback;
	};
	const retention: RetentionConfig = {
		telemetryDays: num("telemetry_retention_days", 90, 1, 3650),
		rawUpdateDays: num("raw_update_retention_days", 30, 1, 3650),
		messageEventDays: num("message_event_retention_days", 365, 1, 3650),
	};
	if (errors.length > 0) throw new ConfigError(errors);

	return {
		dataDir,
		dbPath: typeof raw.db_path === "string" ? resolvePath(rootDir, raw.db_path) : join(dataDir, "agent.db"),
		groupPeerId,
		bots,
		tinyfishApiKey,
		auxiliaryVisualModel: typeof raw.auxiliary_visual_model === "string"
			? normalizeAuxiliaryVisualModel(raw.auxiliary_visual_model)!
			: DEFAULT_AUXILIARY_VISUAL_MODEL,
		vision: {
			enabled: typeof visionRaw.enabled === "boolean" ? visionRaw.enabled : raw.auxiliary_visual_model !== undefined,
			foregroundMediaLimit: visionNumber("foreground_media_limit", 2, 16),
			concurrency: Math.max(1, visionNumber("concurrency", 2, 16)),
			perChatHourlyLimit: visionNumber("per_chat_hourly_limit", 24, 10_000),
			dailyLimit: visionNumber("daily_limit", 200, 1_000_000),
		},
		retention,
		routerSecret: env[routerSecretEnv] || null,
		telegramAdmins,
	};
}
