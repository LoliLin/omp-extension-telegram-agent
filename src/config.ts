// Central env/config loader. .env uses `key: value` (colon) format.
// Secrets must never be logged or sent to the provider.
//
// Validation (REQ-OPS-0001 R2): all numeric env values are checked at startup and ALL
// errors are collected and reported together (stderr, one line per key), so a broken
// .env fails loudly instead of silently producing NaN routing/compaction behavior.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface BotConfig {
	id: "A" | "B";
	name: string; // 小雪 / 小雨
	usernameEnv: "teleram_hastuyuki_bot" | "telegram_kosamerobot";
	token: string;
	personaPath: string;
}

export interface AppConfig {
	dataDir: string;
	dbPath: string;
	groupPeerId: number;
	bots: [BotConfig, BotConfig];
	deepseekApiKey: string;
	deepseekModel: string;
	deepseekReasoningEffort: string;
	tinyfishApiKey: string;
	auxiliaryVisualModel: string;
	routerSecret: string | null; // generated+persisted by daemon if absent
	routingPA: number; // probability a plain human message triggers bot A
	routingPB: number; // same for bot B
	compactionThreshold: number; // context tokens per bot that trigger a new epoch (provisional 128K)
	compactionKeepRecent: number; // chars/4-estimated tokens of recent messages kept through compaction
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
export function normalizePeerId(raw: string): number {
	const t = raw.trim();
	let s = t.startsWith("-") ? t.slice(1) : t;
	if (s.startsWith("100") && s.length > 11) s = s.slice(3);
	const n = Number(s);
	return Number.isInteger(n) && n > 0 ? n : NaN;
}

export function loadConfig(rootDir: string): AppConfig {
	const env: Record<string, string> = { ...parseEnvFile(join(rootDir, ".env")) };
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	const errors: string[] = [];

	const need = (key: string): string => {
		const v = env[key];
		if (v === undefined || v === "") {
			errors.push(`[config] ${key}: missing required env var (see .env.example)`);
			return "";
		}
		return v;
	};
	const num = (key: string, fallback: number, min: number, max: number): number => {
		const v = env[key];
		if (v === undefined || v === "") return fallback;
		const n = Number(v);
		if (!Number.isFinite(n) || n < min || n > max) {
			errors.push(`[config] ${key}: expected a number in [${min}, ${max}], got "${v}"`);
			return fallback;
		}
		return n;
	};

	const dataDir = join(rootDir, "data");
	const routingPA = num("routing_p_a", 0.08, 0, 1);
	const routingPB = num("routing_p_b", 0.08, 0, 1);
	if (routingPA + routingPB > 1) {
		errors.push(`[config] routing_p_a + routing_p_b: probabilities must sum to <= 1, got ${routingPA} + ${routingPB}`);
	}
	const compactionThreshold = num("compaction_threshold", 128000, 1, Number.MAX_SAFE_INTEGER);
	const compactionKeepRecent = num("compaction_keep_recent", 20000, 1, Number.MAX_SAFE_INTEGER);

	const peerRaw = need("telegram_group_peer_id");
	let groupPeerId = NaN;
	if (peerRaw) {
		groupPeerId = normalizePeerId(peerRaw);
		if (!Number.isFinite(groupPeerId)) {
			errors.push(
				`[config] telegram_group_peer_id: expected a bare positive peer id (e.g. 4402809405, or -1004402809405), got "${peerRaw}"`,
			);
		}
	}

	const deepseekApiKey = need("deepseek_api_key");
	const tinyfishApiKey = need("tiny_fish_api_key");
	const botAToken = need("teleram_hastuyuki_bot");
	const botBToken = need("telegram_kosamerobot");

	if (errors.length > 0) throw new ConfigError(errors);

	return {
		dataDir,
		dbPath: join(dataDir, "agent.db"),
		groupPeerId,
		bots: [
			{
				id: "A",
				name: "小雪",
				usernameEnv: "teleram_hastuyuki_bot",
				token: botAToken,
				personaPath: join(rootDir, "personas/xiaoxue.md"),
			},
			{
				id: "B",
				name: "小雨",
				usernameEnv: "telegram_kosamerobot",
				token: botBToken,
				personaPath: join(rootDir, "personas/xiaoyu.md"),
			},
		],
		deepseekApiKey,
		deepseekModel: env.deepseek_model ?? "deepseek-v4-flash",
		deepseekReasoningEffort: env.deepseek_reasoning_effort ?? "medium",
		tinyfishApiKey,
		auxiliaryVisualModel: env.auxiliary_visual_model ?? "",
		routerSecret: env.router_secret ?? null,
		routingPA,
		routingPB,
		compactionThreshold,
		compactionKeepRecent,
	};
}
