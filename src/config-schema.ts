import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface TelegramToolsConfigInput {
	send?: boolean;
	search?: boolean;
	run_js?: boolean;
}

export interface TelegramVisionConfigInput {
	enabled?: boolean;
	foreground_media_limit?: number;
	concurrency?: number;
	per_chat_hourly_limit?: number;
	daily_limit?: number;
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
	reasoning_effort?: ThinkingLevel;
	compaction_threshold?: number;
	compaction_keep_recent?: number;
	/** Cheap task model used only for compaction: provider/model:effort. */
	compaction_model?: string;
	cache_retention?: "none" | "short" | "long";
	max_suffix_tokens?: number;
	max_message_tokens?: number;
	tools?: TelegramToolsConfigInput;
	sticker_sets?: readonly string[];
}

/** Trusted local deployment config. Secret values belong in .env, never in this object. */
export interface TelegramConfigInput {
	group_peer_id: string | number;
	router_secret_env?: string;
	db_path?: string;
	tinyfish_key_env?: string;
	/** Pi task model reference for photo/sticker vision: provider/model:effort. */
	auxiliary_visual_model?: string;
	provider?: string;
	model?: string;
	reasoning_effort?: ThinkingLevel;
	compaction_threshold?: number;
	compaction_keep_recent?: number;
	compaction_model?: string;
	cache_retention?: "none" | "short" | "long";
	max_suffix_tokens?: number;
	max_message_tokens?: number;
	sampling_cooldown_ms?: number;
	vision?: TelegramVisionConfigInput;
	telemetry_retention_days?: number;
	raw_update_retention_days?: number;
	message_event_retention_days?: number;
	telegram_admins?: readonly TelegramAdminInput[];
	bots: readonly TelegramBotConfigInput[];
}

/** Identity helper that supplies editor types without changing runtime configuration bytes. */
export function defineConfig<const T extends TelegramConfigInput>(config: T): T {
	return config;
}
