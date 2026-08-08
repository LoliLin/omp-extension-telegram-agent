import { defineConfig } from "./src/config.ts";

export default defineConfig({
	// Telegram supergroup id. Bare, negative, and -100-prefixed forms are accepted.
	group_peer_id: 1234567890,

	// Cost-first fixed profile. Authentication remains exclusively in Pi's auth storage.
	provider: "openai-codex",
	model: "gpt-5.6-luna",
	reasoning_effort: "off",
	cache_retention: "short",
	compaction_model: "openai-codex/gpt-5.6-luna:low",

	// Deterministic local behavior. These defaults keep context and background work bounded.
	compaction_threshold: 128_000,
	compaction_keep_recent: 20_000,
	sampling_cooldown_ms: 2_000,
	db_path: "data/agent.db",
	router_secret_env: "router_secret",
	tinyfish_key_env: "tiny_fish_api_key",
	auxiliary_visual_model: "openai-codex/gpt-5.6-luna:low",
	max_suffix_tokens: 12_000,
	max_message_tokens: 4_096,
	vision: {
		enabled: false,
		foreground_media_limit: 2,
		concurrency: 2,
		per_chat_hourly_limit: 24,
		daily_limit: 200,
	},
	telemetry_retention_days: 90,
	raw_update_retention_days: 30,
	message_event_retention_days: 365,

	// Empty means the admin-only Telegram group commands (/compact, /set) are denied.
	telegram_admins: [],

	bots: [
		{
			// Stable id for Pi commands, sessions, routing, and telemetry.
			id: "friend",
			name: "Mochi",
			// .env holds the token value; this file contains only its key name.
			token_env: "telegram_bot_token",
			// Copy a public template to an ignored local file before personalizing it.
			persona_path: "personas/template.en.md",
			// Chance of joining an unaddressed human conversation. Explicit replies still route.
			routing_p: 0.1,
			sticker_sets: [],
			tools: {
				send: true,
				// Enable only after adding tiny_fish_api_key to .env.
				search: false,
				run_js: true,
			},
		},
	],
});
