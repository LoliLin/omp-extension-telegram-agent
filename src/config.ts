// Central env/config loader. .env uses `key: value` (colon) format.
// Secrets must never be logged or sent to the provider.

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

function required(env: Record<string, string>, key: string): string {
	const v = env[key];
	if (!v) throw new Error(`missing required env var: ${key} (see .env.example)`);
	return v;
}

export function loadConfig(rootDir: string): AppConfig {
	const env = { ...parseEnvFile(join(rootDir, ".env")), ...process.env };
	const dataDir = join(rootDir, "data");
	return {
		dataDir,
		dbPath: join(dataDir, "agent.db"),
		groupPeerId: Number(required(env, "telegram_group_peer_id")),
		bots: [
			{
				id: "A",
				name: "小雪",
				usernameEnv: "teleram_hastuyuki_bot",
				token: required(env, "teleram_hastuyuki_bot"),
				personaPath: join(rootDir, "personas/xiaoxue.md"),
			},
			{
				id: "B",
				name: "小雨",
				usernameEnv: "telegram_kosamerobot",
				token: required(env, "telegram_kosamerobot"),
				personaPath: join(rootDir, "personas/xiaoyu.md"),
			},
		],
		deepseekApiKey: required(env, "deepseek_api_key"),
		deepseekModel: env.deepseek_model ?? "deepseek-v4-flash",
		deepseekReasoningEffort: env.deepseek_reasoning_effort ?? "medium",
		tinyfishApiKey: required(env, "tiny_fish_api_key"),
		auxiliaryVisualModel: env.auxiliary_visual_model ?? "",
		routerSecret: env.router_secret ?? null,
	};
}
