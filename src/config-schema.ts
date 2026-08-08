export interface TelegramToolsConfigInput {
	send?: boolean;
	search?: boolean;
	run_js?: boolean;
}

export type TelegramAdminInput = number | `@${string}`;

export interface TelegramBotConfigInput {
	/** Stable local id used by commands, sessions, routing, and telemetry. */
	id: string;
	/** Display name and explicit name trigger. Defaults to id. */
	name?: string;
	/** Name of the .env entry containing this Telegram bot token. */
	token_env: string;
	/** Absolute, home-relative, or project-relative trusted local Markdown file. */
	persona_path: string;
	/** Probability for unaddressed human messages; all bots together must total <= 1. */
	routing_p?: number;
	/** Probability-route cooldown after a completed turn. */
	sampling_cooldown_ms?: number;
	provider?: string;
	model?: string;
	/** Name of the .env entry containing this bot's provider credential. */
	api_key_env?: string;
	reasoning_effort?: string;
	compaction_threshold?: number;
	compaction_keep_recent?: number;
	tools?: TelegramToolsConfigInput;
	sticker_sets?: readonly string[];
}

/** Trusted local deployment config. Secret values belong in .env, never in this object. */
export interface TelegramConfigInput {
	group_peer_id: string | number;
	router_secret_env?: string;
	db_path?: string;
	tinyfish_key_env?: string;
	/** Legacy DeepSeek-only alias; prefer api_key_env. */
	deepseek_key_env?: string;
	auxiliary_visual_model?: string;
	provider?: string;
	model?: string;
	api_key_env?: string;
	reasoning_effort?: string;
	compaction_threshold?: number;
	compaction_keep_recent?: number;
	sampling_cooldown_ms?: number;
	telegram_admins?: readonly TelegramAdminInput[];
	bots: readonly TelegramBotConfigInput[];
}

/** Identity helper that supplies editor types without changing runtime configuration bytes. */
export function defineConfig<const T extends TelegramConfigInput>(config: T): T {
	return config;
}
